// Every tunable knob, resolved once from .env with defaults. See .env.example for
// what each one does. Nothing else in the repo should read process.env directly.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = join(ROOT, 'data');
export const DB_PATH = join(DATA_DIR, 'carscraper.db');
export const SESSION_PATH = join(DATA_DIR, 'session', 'storage_state.json');
export const DEBUG_DIR = join(DATA_DIR, 'debug');
export const LOG_DIR = join(DATA_DIR, 'logs');

// Minimal .env reader — avoids a dependency for ~15 lines of parsing.
function loadDotenv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotenv();

const num = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const list = (key, fallback) => {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
};
const bool = (key, fallback) => {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
};

// A metro is one dashboard-facing bucket that may fan out to several city
// searches. DFW needs two: a single Dallas search at 60mi under-covers the west
// side of the metroplex. Results dedupe by fbId, so overlap is free.
// `center` and `radiusMiles` are OUR filter, applied after scraping. Facebook
// ignores the radius in the search URL and serves the account's saved
// Marketplace location instead, so a DFW search comes back full of Houston,
// San Antonio, Austin and Oklahoma listings. See lib/geo.js.
export const METROS = {
  dfw: {
    label: 'Dallas-Fort Worth',
    cities: ['dallas', 'fortworth'],
    center: [32.8140, -96.9489],   // Irving, TX
    radiusMiles: num('DFW_RADIUS_MILES', 150),
  },
  houston: {
    label: 'Houston',
    cities: ['houston'],
    center: [29.7604, -95.3698],   // Houston, TX
    radiusMiles: num('HOUSTON_RADIUS_MILES', 150),
  },
};

export const config = {
  // Money is handled in cents everywhere. Floats and money don't mix, and
  // 2499.9999 sorting under 2500 is a bug waiting to happen.
  scrapeMaxPriceCents: num('SCRAPE_MAX_PRICE', 3200) * 100,
  filterMaxPriceCents: num('FILTER_MAX_PRICE', 2500) * 100,
  filterMinPriceCents: num('FILTER_MIN_PRICE', 300) * 100,

  // Blocklist, not an allowlist. An allowlist rejected everything whose make we
  // failed to parse — 142 of the first 219 listings — which hid far more good
  // cars than it saved. Only origins we're CONFIDENT about get cut; unknown
  // stays in and Ibrahim eyeballs it.
  blockedOrigins: list('BLOCKED_ORIGINS', ['german']),

  offerDiscountPct: num('OFFER_DISCOUNT_PCT', 15),
  offerRoundToCents: num('OFFER_ROUND_TO', 25) * 100,

  metros: list('METROS', ['dfw']).filter((m) => m in METROS),
  // Sent in the search URL. Facebook largely ignores it — the real filtering is
  // the per-metro radius above, applied on our side.
  searchRadiusMiles: num('SEARCH_RADIUS_MILES', 150),

  maxSearchPages: num('MAX_SEARCH_PAGES', 6),
  // Must exceed the daily intake or the backlog only grows. DFW brings in
  // roughly 350-450 new listings a day; at 250 a run, listings from Tuesday
  // and Wednesday never got checked at all and the dashboard still showed
  // Monday. At 5 concurrent fetches this is about half an hour, which is fine
  // for a twice-daily run.
  maxDetailFetches: num('MAX_DETAIL_FETCHES', 800),
  searchDelayMs: [num('SEARCH_DELAY_MIN_MS', 4000), num('SEARCH_DELAY_MAX_MS', 8000)],
  detailDelayMs: [num('DETAIL_DELAY_MIN_MS', 6000), num('DETAIL_DELAY_MAX_MS', 15000)],
  // How many detail pages to fetch at once. Each worker keeps its own jittered
  // delay, so this multiplies throughput without removing the pacing.
  // 5 turns a ~20 minute detail pass into ~4 minutes.
  detailConcurrency: Math.max(1, num('DETAIL_CONCURRENCY', 5)),
  headful: bool('HEADFUL', false),

  provider: (process.env.PROVIDER || 'facebook').toLowerCase(),

  aiKey: process.env.ANTHROPIC_API_KEY || null,
  aiModel: process.env.AI_MODEL || 'claude-opus-5',

  dashboardPort: num('DASHBOARD_PORT', 5174),
  // Cars shown per page. Small on purpose: the dashboard is a review queue, not
  // a catalogue. Hide a car and the next refresh refills the page.
  dashboardPageSize: Math.max(1, num('DASHBOARD_PAGE_SIZE', 10)),
  // Only show cars first seen in the last N days. Marketplace turns over fast
  // and a backlog you'll never work through is worse than no backlog. Anything
  // marked `interested` is exempt — see queryListings.
  // 0 means no limit.
  dashboardMaxAgeDays: Math.max(0, num('DASHBOARD_MAX_AGE_DAYS', 2)),
};

export const radiusKm = () => Math.round(config.searchRadiusMiles * 1.609);
