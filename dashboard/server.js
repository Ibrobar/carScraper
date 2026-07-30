// Local dashboard server. Queries SQLite, hands rows to render.js, serves HTML.
// Binds 127.0.0.1 only — nothing here is authenticated because nothing here
// should ever be reachable off this machine. Don't put it behind a tunnel.
//
// There is deliberately NO route that talks to Facebook. See Core rule 1 in
// CLAUDE.md and docs/DASHBOARD.md.

import { createServer } from 'node:http';
import {
  openDb, queryListings, countListings, latestRuns, setListingStatus, countUnchecked,
  SORTS, SORT_GROUP_FIELD, DEFAULT_SORT,
  openFlip, getFlip, getListing, updateFlip, queryFlips, partsForFlips,
  addPart, markPartBought, deletePart, deleteFlip,
} from '../lib/db.js';
import { config } from '../lib/config.js';
import { validateTransition, inferStatus } from '../lib/flips.js';
import { renderPage } from './render.js';
import { renderCrm } from './crm.js';

const VALID_STATUSES = new Set(['interested', 'hidden', 'passed']);

function parseFilters(url) {
  const p = url.searchParams;
  const int = (key) => {
    const raw = p.get(key);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const min = int('min');
  const max = int('max');
  return {
    metro: p.get('metro') || null,
    origin: p.get('origin') || null,
    q: p.get('q') || null,
    min, max,
    minCents: min === null ? null : min * 100,
    maxCents: max === null ? null : max * 100,
    // `days=0` (the "all time" option) is a deliberate choice, not a missing
    // value, so `?? default` would wrongly override it.
    days: int('days') ?? config.dashboardMaxAgeDays,
    rejected: p.get('rejected') === '1',
    page: Math.max(1, int('page') ?? 1),
    // Validated against the known sorts — this string is interpolated straight
    // into an ORDER BY, so it must never come from the query string unchecked.
    sort: SORTS[p.get('sort')] ? p.get('sort') : DEFAULT_SORT,
  };
}

/** Dollars from a form field -> integer cents. Money is never a float here. */
function dollarsToCents(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseFloat(String(value).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100);
}

async function readFormBody(req, limit = 100_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

/** Forms post and redirect back, so a refresh doesn't re-submit. */
function seeOther(res, location = '/crm') {
  res.writeHead(303, { location });
  res.end();
}

async function readJsonBody(req, limit = 10_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const db = openDb();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.dashboardPort}`);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const filters = parseFilters(url);
      const pageSize = config.dashboardPageSize;
      const total = countListings(db, filters);
      // Clamp past-the-end pages back to the last real one. Hiding cars shrinks
      // the result set under you, so deep-linking to page 5 and then clearing
      // rows would otherwise leave you staring at an empty page.
      const lastPage = Math.max(1, Math.ceil(total / pageSize));
      const page = Math.min(filters.page, lastPage);

      const html = renderPage({
        listings: queryListings(db, { ...filters, limit: pageSize, offset: (page - 1) * pageSize }),
        runs: latestRuns(db),
        unchecked: countUnchecked(db),
        filters: { ...filters, page },
        page,
        pageSize,
        total,
        groupField: SORT_GROUP_FIELD[filters.sort] ?? 'posted_at',
      });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(latestRuns(db), null, 2));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/status') {
      const { fbId, status } = await readJsonBody(req);
      if (!fbId || !VALID_STATUSES.has(status)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'fbId and a valid status are required' }));
        return;
      }
      setListingStatus(db, fbId, status);

      // Marking a car Interested is the moment it enters the pipeline. Opening
      // the flip here means the CRM is never missing a car you said yes to.
      // openFlip is idempotent by listing, so clicking twice — or re-marking a
      // car that's already `bought` — never resets it.
      let flip = null;
      if (status === 'interested') {
        const listing = getListing(db, fbId);
        if (listing) flip = openFlip(db, listing.id).flip;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, flipId: flip?.id ?? null }));
      return;
    }

    // --- CRM ---------------------------------------------------------------

    if (req.method === 'GET' && url.pathname === '/crm') {
      const flips = queryFlips(db, {});
      const parts = partsForFlips(db, flips.map((f) => f.id));
      const html = renderCrm({
        rows: flips.map((flip) => ({ flip, parts: parts.get(flip.id) ?? [] })),
      });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    const statusMatch = url.pathname.match(/^\/crm\/(\d+)\/status$/);
    if (req.method === 'POST' && statusMatch) {
      const flip = getFlip(db, Number(statusMatch[1]));
      if (!flip) { res.writeHead(404); res.end('No such flip'); return; }

      const form = await readFormBody(req);
      const values = {
        purchase_price_cents: dollarsToCents(form.purchase) ?? undefined,
        sale_price_cents: dollarsToCents(form.sale) ?? undefined,
      };
      // If a purchase price is being recorded, the car is bought — even if the
      // dropdown was left alone. Otherwise you get cars sitting at "Interested"
      // with money against them.
      const status = inferStatus(flip, form.status, values);

      // The pipeline refuses to record a sale with no purchase price — a
      // profit number you can't trust is worse than no number.
      const check = validateTransition(flip, status, values);
      if (!check.ok) {
        res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<p>${check.error}</p><p><a href="/crm">Back</a></p>`);
        return;
      }
      updateFlip(db, flip.id, { status, ...values });
      seeOther(res);
      return;
    }

    const deleteFlipMatch = url.pathname.match(/^\/crm\/(\d+)\/delete$/);
    if (req.method === 'POST' && deleteFlipMatch) {
      // Returns the listing to `passed` so the car doesn't disappear from both
      // the board and the listings page. See deleteFlip in lib/db.js.
      deleteFlip(db, Number(deleteFlipMatch[1]));
      seeOther(res);
      return;
    }

    const addPartMatch = url.pathname.match(/^\/crm\/(\d+)\/part$/);
    if (req.method === 'POST' && addPartMatch) {
      const form = await readFormBody(req);
      if (form.name?.trim()) {
        addPart(db, Number(addPartMatch[1]), {
          name: form.name.trim(),
          costCents: dollarsToCents(form.cost),
        });
      }
      seeOther(res);
      return;
    }

    const boughtMatch = url.pathname.match(/^\/crm\/part\/(\d+)\/bought$/);
    if (req.method === 'POST' && boughtMatch) {
      const form = await readFormBody(req);
      markPartBought(db, Number(boughtMatch[1]), dollarsToCents(form.cost));
      seeOther(res);
      return;
    }

    const deleteMatch = url.pathname.match(/^\/crm\/part\/(\d+)\/delete$/);
    if (req.method === 'POST' && deleteMatch) {
      deletePart(db, Number(deleteMatch[1]));
      seeOther(res);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`Error: ${err.message}`);
  }
});

server.listen(config.dashboardPort, '127.0.0.1', () => {
  console.log(`Dashboard: http://localhost:${config.dashboardPort}`);
  console.log('Ctrl+C to stop.');
});
