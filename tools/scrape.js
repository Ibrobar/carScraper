// The scrape orchestrator. Two-phase by design — see docs/SCRAPER.md.
//
//   Phase 1  page the search results, get card data (cheap, unremarkable traffic)
//   filter   apply price + make/origin to the CARD, before spending a detail fetch
//   Phase 2  fetch detail pages only for listings that are new AND already passed
//
// That ordering is both the biggest anti-detection lever and the biggest speed
// win: most listings are the wrong make or over the cap, and we now know that
// without ever opening them.
//
// Usage: node tools/scrape.js [--metro dfw] [--limit N] [--no-detail]

import { config, METROS } from '../lib/config.js';
import {
  openDb, upsertListing, knownFbIds, pendingDetail, startRun, finishRun,
  updateListingVerdict, getListing, recordRunDetails, descriptionSeenElsewhere,
} from '../lib/db.js';
import { evaluateCard, evaluateFull, needsAiReview } from '../lib/filters.js';
import { reviewDescription, translateDescription, aiEnabled } from '../lib/ai.js';
import { detectLanguage } from '../lib/lang.js';
import { sleep } from '../scrapers/base.js';
import { FacebookProvider, ScrapeProblem } from '../scrapers/facebook.js';

function parseArgs(argv) {
  const args = { metro: null, limit: null, detail: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--metro') args.metro = argv[++i];
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--no-detail') args.detail = false;
  }
  return args;
}

async function makeProvider() {
  if (config.provider === 'apify') {
    const { ApifyProvider } = await import('../scrapers/apify.js');
    return new ApifyProvider();
  }
  return new FacebookProvider();
}

/** Phase 1 + cheap filters for one metro. */
async function scrapeMetro(db, provider, metro, args) {
  const runId = startRun(db, { provider: provider.name, metro });
  const known = knownFbIds(db);
  let seen = 0;
  let added = 0;

  try {
    const cards = [];
    for (const citySlug of METROS[metro].cities) {
      const found = await provider.searchListings({
        metro,
        citySlug,
        maxPages: args.limit ? 1 : config.maxSearchPages,
      });
      cards.push(...found);
      await sleep(...config.searchDelayMs);
    }

    // A car visible from both DFW city searches is one car.
    const deduped = new Map();
    for (const card of cards) if (!deduped.has(card.fbId)) deduped.set(card.fbId, card);
    let batch = [...deduped.values()];
    if (args.limit) batch = batch.slice(0, args.limit);
    seen = batch.length;

    for (const card of batch) {
      const { verdict, reasons, derived } = evaluateCard(card);
      const isNew = !known.has(card.fbId);
      if (isNew) added++;

      // Don't knock an already-checked listing back to `pending_detail`. The
      // detail queue only picks up rows with detail_fetched_at IS NULL, so
      // downgrading one here stranded it: invisible on the dashboard and never
      // re-queued. Only a fresh rejection may overwrite an existing verdict.
      let status = verdict;
      let rejectReasons = reasons;
      if (!isNew && verdict === 'pending_detail') {
        const existing = getListing(db, card.fbId);
        if (existing?.detail_fetched_at) {
          // Leave both alone — the cheap pass can't see the description, so its
          // empty reason list would erase a defect rejection the detail pass made.
          status = undefined;
          rejectReasons = undefined;
        }
      }

      upsertListing(db, {
        fb_id: card.fbId,
        url: card.url,
        title: card.title,
        price_cents: card.priceCents,
        metro,
        location_text: card.locationText,
        image_url: card.imageUrl,
        status,
        reject_reasons: rejectReasons,
        raw_json: card.raw,
        ...derived,
      });
    }

    const status = finishRun(db, runId, {
      status: 'ok', listingsSeen: seen, listingsNew: added, detailsFetched: 0,
    });
    return { metro, seen, added, status, runId };
  } catch (err) {
    const status = err instanceof ScrapeProblem ? err.status : 'error';
    finishRun(db, runId, {
      status, listingsSeen: seen, listingsNew: added, detailsFetched: 0,
      error: err.message, debugPath: err.debugPath ?? null,
    });
    return { metro, seen, added, status, runId, error: err.message };
  }
}

/**
 * Phase 2: detail pages for listings that passed the cheap filters.
 *
 * Runs `config.detailConcurrency` workers over a shared queue. Each worker
 * keeps its own jittered delay, so raising concurrency multiplies throughput
 * without shortening the gap between any one worker's requests.
 *
 * A `blocked` or `login_wall` from any worker aborts the whole pass — pushing
 * more requests through a block is how a temporary restriction becomes a
 * permanent one.
 */
async function fetchDetails(db, provider, metro, budget) {
  const queue = pendingDetail(db, metro, budget);
  const workers = Math.min(config.detailConcurrency, Math.max(1, queue.length));
  let cursor = 0;
  let fetched = 0;
  let aborted = null;

  const runWorker = async () => {
    while (!aborted) {
      const index = cursor++;
      if (index >= queue.length || fetched >= budget) return;
      try {
        await fetchOneDetail(db, provider, queue[index]);
        fetched++;
      } catch (err) {
        if (err instanceof ScrapeProblem && (err.status === 'blocked' || err.status === 'login_wall')) {
          aborted = err;
          return;
        }
        console.warn(`  detail fetch failed for ${queue[index].fb_id}: ${err.message}`);
      }
      await sleep(...config.detailDelayMs);
    }
  };

  await Promise.all(Array.from({ length: workers }, runWorker));
  if (aborted) throw aborted;
  return fetched;
}

/** Fetch one listing's detail page, then re-run the full filters on it. */
async function fetchOneDetail(db, provider, listing) {
  const detail = await provider.fetchDetail(listing.fb_id);

  if (detail) {
    // Guard against page furniture being attributed to this car. If another
    // listing already stores this exact text, it came from a sidebar, not from
    // this seller — drop it rather than mark the car checked against someone
    // else's ad.
    let { description } = detail;
    if (description && descriptionSeenElsewhere(db, listing.fb_id, description)) {
      console.warn(`  ${listing.fb_id}: description matches another listing — discarding`);
      description = null;
    }

    // Detected from the original text, always — it's free and offline. The
    // translation below is optional and display-only.
    const language = description ? detectLanguage(description) : null;
    const descriptionEn = language && language !== 'en' && aiEnabled()
      ? await translateDescription(description)
      : null;

    upsertListing(db, {
      fb_id: listing.fb_id,
      description,
      language,
      description_en: descriptionEn,
      mileage: detail.mileage,
      transmission: detail.transmission,
      title_status: detail.titleStatus,
      seller_name: detail.sellerName,
      seller_url: detail.sellerUrl,
      posted_at: detail.postedAt,
      year: detail.year,
      make_raw: detail.make,
      model: detail.model,
      detail_fetched_at: new Date().toISOString(),
    });
  } else {
    // Mark it fetched anyway so a permanently unparseable listing doesn't get
    // retried forever, burning detail budget every single run.
    upsertListing(db, {
      fb_id: listing.fb_id,
      detail_fetched_at: new Date().toISOString(),
    });
  }

  const fresh = getListing(db, listing.fb_id);
  let ai = null;
  if (needsAiReview(fresh)) ai = await reviewDescription(fresh);

  const merged = ai
    ? { ...fresh, ai_verdict: ai.verdict, ai_confidence: ai.confidence }
    : fresh;
  const result = evaluateFull(merged);

  // A car can only be called good if we actually read what the seller wrote.
  // With no description, defect detection had nothing to scan, so `passed`
  // would mean "vetted" when nothing was vetted. Hold it in `pending_detail`:
  // hidden from the dashboard, surfaced in the "awaiting check" count.
  // `detail_fetched_at` is still set, so it won't be re-fetched forever.
  const status = !fresh.description && result.verdict === 'passed'
    ? 'pending_detail'
    : result.verdict;

  updateListingVerdict(db, fresh.id, {
    status,
    reasons: result.reasons,
    flags: result.flags,
    derived: result.derived,
    ai,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const metros = args.metro ? [args.metro] : config.metros;

  for (const metro of metros) {
    if (!METROS[metro]) {
      console.error(`Unknown metro "${metro}". Known: ${Object.keys(METROS).join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  const db = openDb();
  const provider = await makeProvider();
  const results = [];

  try {
    for (const metro of metros) {
      console.log(`\n${METROS[metro].label} — searching...`);
      const result = await scrapeMetro(db, provider, metro, args);

      if (result.status === 'ok' && args.detail) {
        const budget = args.limit
          ? Math.min(args.limit, config.maxDetailFetches)
          : Math.floor(config.maxDetailFetches / metros.length);
        console.log(
          `  ${result.seen} seen, ${result.added} new — fetching up to ${budget} details ` +
          `(${config.detailConcurrency} at a time)...`,
        );
        try {
          result.details = await fetchDetails(db, provider, metro, budget);
        } catch (err) {
          result.status = err instanceof ScrapeProblem ? err.status : 'error';
          result.error = err.message;
        }
        recordRunDetails(db, result.runId, result.details ?? 0);
      }
      results.push(result);
      if (result.status === 'blocked') {
        console.error('\nBLOCKED. Stopping now — do not retry. See docs/OPERATIONS.md.');
        break;
      }
    }
  } finally {
    await provider.close();
  }

  console.log('\n Metro    | Seen | New  | Details | Status');
  console.log('----------|------|------|---------|--------');
  for (const r of results) {
    console.log(
      ` ${r.metro.padEnd(8)} | ${String(r.seen).padStart(4)} | ${String(r.added).padStart(4)} | ` +
      `${String(r.details ?? 0).padStart(7)} | ${r.status}`,
    );
  }

  const failed = results.filter((r) => r.status !== 'ok');
  if (failed.length) {
    console.log('');
    for (const r of failed) console.error(`${r.metro}: ${r.status} — ${r.error ?? 'see data/debug/'}`);
    if (failed.some((r) => r.status === 'login_wall')) console.error('\nFix: npm run login');
    process.exitCode = 1;
  } else if (!aiEnabled()) {
    console.log('\n(AI description review is off — set ANTHROPIC_API_KEY to enable it.)');
  }
}

main().catch((err) => {
  console.error(`\nScrape failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
