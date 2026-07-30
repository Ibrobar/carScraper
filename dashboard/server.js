// Local dashboard server. Queries SQLite, hands rows to render.js, serves HTML.
// Binds 127.0.0.1 only — nothing here is authenticated because nothing here
// should ever be reachable off this machine. Don't put it behind a tunnel.
//
// There is deliberately NO route that talks to Facebook. See Core rule 1 in
// CLAUDE.md and docs/DASHBOARD.md.
//
// The CRM is a mounted module (dashboard/crm/). Everything it owns is reached
// through the three marked lines below.

import { createServer } from 'node:http';
import {
  openDb, queryListings, countListings, latestRuns, setListingStatus, countUnchecked,
  SORTS, SORT_GROUP_FIELD, DEFAULT_SORT,
} from '../lib/db.js';
import { config } from '../lib/config.js';
import { renderPage } from './render.js';
// --- CRM module ------------------------------------------------------------
import { handleCrmRequest, onListingMarkedInterested, NAV_LINK } from './crm/routes.js';
const CRM = { handleCrmRequest, onListingMarkedInterested, NAV_LINK };
// ---------------------------------------------------------------------------

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
        navLinks: CRM ? [CRM.NAV_LINK] : [],
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

      // Interested is the moment a car enters the pipeline. Without the CRM
      // mounted the status alone still takes it off this page, which is the
      // behaviour that matters here.
      const flipId = status === 'interested' && CRM
        ? CRM.onListingMarkedInterested(db, fbId)
        : null;

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, flipId }));
      return;
    }

    if (CRM && await CRM.handleCrmRequest(req, res, { db, url })) return;

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
