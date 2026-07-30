// Re-run the filters over every stored listing. No Facebook traffic, instant, free.
//
// This is the point of keeping rejected listings in the database (docs/DATA.md):
// you get to test a filter change against months of real listings in about a
// second, instead of guessing and waiting for tomorrow's scrape.
//
// Run it after ANY change to lib/makes.js, lib/defects.js, or lib/filters.js.
//
// Usage: node tools/reprocess.js [--dry]

import {
  openDb, allListings, updateListingVerdict, clearSharedDescriptions,
  backfillLanguages, clearJunkSellerNames,
} from '../lib/db.js';
import { evaluateCard, evaluateFull } from '../lib/filters.js';
import { detectLanguage } from '../lib/lang.js';
import { cleanSellerName } from '../scrapers/base.js';

const STICKY = new Set(['hidden', 'interested']);

function main() {
  const dry = process.argv.includes('--dry');
  const db = openDb();

  // Repair before re-judging. A description shared by several listings came
  // from page furniture (a sidebar ad, a "similar listings" block), not from
  // the seller — judging a car on it is worse than not judging it at all.
  if (!dry) {
    const { cleared, blocks } = clearSharedDescriptions(db);
    if (cleared) {
      console.log(
        `\nDropped ${cleared} descriptions shared across listings (${blocks} distinct blocks).` +
        `\nThose listings are hidden and re-queued — run \`npm run scrape\` to refetch them.`,
      );
    }
  }

  if (!dry) {
    const junk = clearJunkSellerNames(db, (name) => cleanSellerName(name) === null);
    if (junk) console.log(`\nCleared ${junk} seller names that were page headings, not people.`);

    const tally = backfillLanguages(db, detectLanguage);
    const detected = Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ');
    if (detected) console.log(`\nDetected language on ${detected} listing(s).`);
  }

  const listings = allListings(db);

  const changes = {
    passedNow: [], rejectedNow: [], unchanged: 0, skipped: 0,
    // Every other transition, counted by "before -> after". Without this the
    // numbers didn't add up to the row count: a rejected listing that becomes
    // `pending_detail` is neither newly passing nor newly rejected, and 117 of
    // them vanished from the report.
    other: new Map(),
  };

  for (const listing of listings) {
    if (STICKY.has(listing.status)) {
      // Your call outranks the filters. Never reprocess these.
      changes.skipped++;
      continue;
    }

    // Gate on the description, not on detail_fetched_at: a detail page that
    // yielded no usable description leaves nothing for defect detection to
    // read, so such a listing can only be judged on price and make — and must
    // not be promoted to `passed`.
    const hasDescription = Boolean(listing.description);
    const result = hasDescription
      ? evaluateFull(listing)
      : (() => {
          const cheap = evaluateCard({
            title: listing.title,
            make: listing.make_raw,
            model: listing.model,
            year: listing.year,
            priceCents: listing.price_cents,
          });
          return { ...cheap, flags: [] };
        })();

    const before = listing.status;
    const after = result.verdict;

    if (before !== after) {
      if (after === 'passed') changes.passedNow.push({ listing, result });
      // Only count it as newly rejected if it actually got REJECTED. A car that
      // went from `passed` to `pending_detail` lost its description and is
      // waiting to be re-checked — calling that "rejected" reads as though the
      // filters found something wrong with it.
      else if (before === 'passed' && after === 'rejected') {
        changes.rejectedNow.push({ listing, result });
      } else {
        const key = `${before} -> ${after}`;
        changes.other.set(key, (changes.other.get(key) ?? 0) + 1);
      }
    } else {
      changes.unchanged++;
    }

    if (!dry) {
      updateListingVerdict(db, listing.id, {
        status: after,
        reasons: result.reasons,
        flags: result.flags ?? [],
        derived: result.derived,
      });
    }
  }

  console.log(`\nReprocessed ${listings.length} listings${dry ? ' (dry run, nothing written)' : ''}.`);
  console.log(`  now passing:  ${changes.passedNow.length}`);
  console.log(`  now rejected: ${changes.rejectedNow.length}`);
  console.log(`  unchanged:    ${changes.unchanged}`);
  console.log(`  skipped:      ${changes.skipped} (hidden/interested — your call wins)`);
  for (const [transition, count] of [...changes.other].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${transition}: ${count}`);
  }

  const queued = changes.other.get('rejected -> pending_detail') ?? 0;
  if (queued) {
    console.log(
      `\n  ${queued} listings need their description read before they can show up.` +
      `\n  Run \`npm run scrape\` to fetch them.`,
    );
  }

  // Both directions matter. A filter change that newly rejects cars you were
  // seeing is exactly as important as one that surfaces new ones, and it's the
  // direction you'd otherwise never notice.
  const sample = (rows, label) => {
    if (!rows.length) return;
    console.log(`\n  ${label}:`);
    for (const { listing, result } of rows.slice(0, 10)) {
      const price = listing.price_cents ? `$${Math.round(listing.price_cents / 100)}` : '?';
      const why = result.reasons?.length ? ` [${result.reasons.join(', ')}]` : '';
      console.log(`    ${price.padStart(6)}  ${(listing.title ?? '').slice(0, 60)}${why}`);
    }
    if (rows.length > 10) console.log(`    ...and ${rows.length - 10} more`);
  };
  sample(changes.passedNow, 'Newly passing');
  sample(changes.rejectedNow, 'Newly rejected');
}

main();
