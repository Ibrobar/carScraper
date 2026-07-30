// Apify provider — the maintained, paid alternative to our own scraper.
//
// Why this exists and when to use it (docs/SCRAPER.md -> Providers):
//   - Someone else maintains the selectors. Facebook breaking their markup
//     becomes their problem, not an afternoon of ours.
//   - `includeListingDetails` returns the DESCRIPTION IN THE SAME RUN. That
//     removes the per-listing page load entirely, which is the whole reason a
//     detail pass takes ~20 minutes on the Playwright path.
//   - It scrapes publicly visible data from Apify's infrastructure, so no
//     Facebook session of ours is involved and there's no account to restrict.
//
// Cost: $2.60 per 1,000 listings. Apify's free tier includes $5/month, roughly
// 1,900 listings. DFW at ~155 listings twice a day is ~9,300/month, about $24 —
// call it $19 after the free credit. One run a day roughly halves that.
//
// Switch on with PROVIDER=apify and APIFY_TOKEN=... in .env.
//
// NOTE: written against the documented API but NOT yet run against a live
// token — nobody has exercised this path. Expect to adjust field names on the
// first real run; `ACTOR_FIELD_NOTES` at the bottom records what to check.

import { config, radiusKm } from '../lib/config.js';
import {
  buildSearchUrl, itemUrl, parsePriceToCents, parseMileage, parseTitleStatus,
} from './base.js';

const ACTOR = process.env.APIFY_ACTOR || 'apify/facebook-marketplace-scraper';
const TOKEN = process.env.APIFY_TOKEN || null;
const BASE = 'https://api.apify.com/v2';

/** Actor ids go over the wire with `~` instead of `/`. */
const actorPath = (actor) => actor.replace('/', '~');

export class ApifyProvider {
  name = 'apify';

  constructor() {
    if (!TOKEN) {
      throw new Error(
        'APIFY_TOKEN is not set. Add it to .env, or set PROVIDER=facebook to use the built-in scraper.',
      );
    }
    // Details arrive with the search results, so fetchDetail() has nothing left
    // to do. Cached here per run.
    this.detailsByFbId = new Map();
  }

  /** Input for the actor. Reuses our own search URL so filters stay in one place. */
  static buildInput(citySlug, resultsLimit) {
    return {
      startUrls: [{ url: buildSearchUrl(citySlug) }],
      resultsLimit,
      // The whole point: descriptions come back inline. Without this we'd be
      // right back to fetching every listing page one at a time.
      includeListingDetails: true,
    };
  }

  async runActor(input) {
    const url = `${BASE}/acts/${actorPath(ACTOR)}/run-sync-get-dataset-items?token=${encodeURIComponent(TOKEN)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      // Actor runs are minutes, not seconds.
      signal: AbortSignal.timeout(10 * 60_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Apify run failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`);
    }
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error('Apify returned a non-array dataset');
    return items;
  }

  async searchListings({ metro, citySlug, maxPages = config.maxSearchPages }) {
    // The actor counts listings, not pages. ~24 listings a page is Marketplace's
    // usual density.
    const resultsLimit = Math.max(24, maxPages * 24);
    const items = await this.runActor(ApifyProvider.buildInput(citySlug, resultsLimit));

    const cards = [];
    for (const item of items) {
      const card = ApifyProvider.toCard(item, metro);
      if (!card) continue;
      cards.push(card);
      this.detailsByFbId.set(card.fbId, ApifyProvider.toDetail(item));
    }

    if (!cards.length) {
      // Same rule as the Playwright provider: an empty result for a real search
      // is a failure, not a quiet market.
      const { ScrapeProblem } = await import('./facebook.js');
      throw new ScrapeProblem('no_listings', `Apify returned 0 listings for ${citySlug}`);
    }
    return cards;
  }

  /**
   * No network call — the description already arrived with the search results.
   * Returning it here keeps the two-phase orchestrator in tools/scrape.js
   * working unchanged.
   */
  async fetchDetail(fbId) {
    return this.detailsByFbId.get(String(fbId)) ?? null;
  }

  static toCard(item, metro) {
    const fbId = String(item.id ?? item.listingId ?? item.listing_id ?? '');
    if (!fbId) return null;
    return {
      fbId,
      url: item.url ?? itemUrl(fbId),
      title: item.title ?? item.marketplace_listing_title ?? null,
      priceCents: parsePriceToCents(
        item.priceAmount ?? item.price?.amount ?? item.price ?? null,
      ),
      locationText: [item.location?.city ?? item.city, item.location?.state ?? item.state]
        .filter(Boolean).join(', ') || null,
      imageUrl: item.primaryPhotoUrl ?? item.image ?? item.photo ?? null,
      metro,
      raw: { source: 'apify' },
    };
  }

  static toDetail(item) {
    // Vehicle specifics live in the free-form `attributes` bag when
    // includeListingDetails is on.
    const attrs = normalizeAttributes(item.attributes);
    return {
      description: item.description ?? item.redactedDescription ?? null,
      mileage: parseMileage(attrs.mileage ?? attrs.odometer ?? item.mileage),
      transmission: attrs.transmission ?? null,
      titleStatus: parseTitleStatus(
        attrs.title_status ?? attrs['title status'] ?? item.description ?? '',
      ),
      sellerName: item.sellerName ?? item.seller?.name ?? null,
      sellerUrl: item.sellerUrl ?? item.seller?.url ?? null,
      year: toInt(attrs.year),
      make: attrs.make ?? null,
      model: attrs.model ?? null,
      postedAt: item.creationTime
        ? new Date(Number(item.creationTime) * 1000).toISOString()
        : (item.timestamp ?? null),
      raw: { source: 'apify' },
    };
  }

  async close() {
    this.detailsByFbId.clear();
  }
}

/** `attributes` may be an object or an array of {label,value} — accept both. */
function normalizeAttributes(attributes) {
  if (!attributes) return {};
  if (Array.isArray(attributes)) {
    const out = {};
    for (const entry of attributes) {
      const key = String(entry?.label ?? entry?.name ?? '').toLowerCase().trim();
      if (key) out[key] = entry?.value ?? null;
    }
    return out;
  }
  if (typeof attributes === 'object') {
    return Object.fromEntries(
      Object.entries(attributes).map(([k, v]) => [k.toLowerCase().trim(), v]),
    );
  }
  return {};
}

function toInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * What to verify on the first live run — dump one raw item and check:
 *   1. the id field name (`id` vs `listingId`)
 *   2. price shape (`priceAmount` vs nested `price.amount`)
 *   3. whether `attributes` is an object or an array of {label,value}
 *   4. that `description` is populated (proves includeListingDetails worked)
 * Adjust toCard/toDetail accordingly; nothing above this file changes.
 *
 * Also note `radiusKM` is not an actor input — radius is encoded in the search
 * URL we pass as startUrls, which is why buildSearchUrl is reused above.
 */
export const ACTOR_FIELD_NOTES = { actor: ACTOR, radiusKm: radiusKm() };
