// Every HTTP route the CRM owns, plus the form helpers only it uses.
//
// dashboard/server.js mounts this with a single call. That's deliberate: the
// CRM used to be 30 route lines interleaved with the listings routes, which
// made "ship the scraper without the CRM" a rewrite of server.js instead of a
// deletion. See lib/crm/README.md for the module contract.
//
// Nothing here talks to Facebook — it links out. Core rule 1 in CLAUDE.md.

import {
  getFlip, updateFlip, queryFlips, partsForFlips,
  addPart, markPartBought, deletePart, deleteFlip, openFlip,
} from '../../lib/crm/db.js';
import { validateTransition, inferStatus } from '../../lib/crm/flips.js';
import { getListing } from '../../lib/db.js';
import { renderCrm } from './render.js';

/** Shown in the listings-page header. Absent when the module isn't mounted. */
export const NAV_LINK = { href: '/crm', label: 'Flips &rarr;' };

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

/**
 * Marking a car Interested is the moment it enters the pipeline. Opening the
 * flip here means the CRM is never missing a car you said yes to. `openFlip` is
 * idempotent by listing, so clicking twice — or re-marking a car that's already
 * `bought` — never resets it.
 *
 * Called by the core /api/status route. Without the CRM mounted, marking a car
 * Interested still hides it from the listings page (the status is sticky); it
 * just doesn't open a file.
 *
 * @returns {number|null} the flip id, for the JSON response
 */
export function onListingMarkedInterested(db, fbId) {
  const listing = getListing(db, fbId);
  if (!listing) return null;
  return openFlip(db, listing.id).flip?.id ?? null;
}

/**
 * Handle a CRM request.
 *
 * @returns {Promise<boolean>} true if this module served the request. False
 *   means "not mine" and the caller should carry on to its own 404.
 */
export async function handleCrmRequest(req, res, { db, url }) {
  if (req.method === 'GET' && url.pathname === '/crm') {
    const flips = queryFlips(db, {});
    const parts = partsForFlips(db, flips.map((f) => f.id));
    const html = renderCrm({
      rows: flips.map((flip) => ({ flip, parts: parts.get(flip.id) ?? [] })),
    });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return true;
  }

  const statusMatch = url.pathname.match(/^\/crm\/(\d+)\/status$/);
  if (req.method === 'POST' && statusMatch) {
    const flip = getFlip(db, Number(statusMatch[1]));
    if (!flip) { res.writeHead(404); res.end('No such flip'); return true; }

    const form = await readFormBody(req);
    const values = {
      purchase_price_cents: dollarsToCents(form.purchase) ?? undefined,
      sale_price_cents: dollarsToCents(form.sale) ?? undefined,
    };
    // If a purchase price is being recorded, the car is bought — even if the
    // dropdown was left alone. Otherwise you get cars sitting at "Interested"
    // with money against them.
    const status = inferStatus(flip, form.status, values);

    // The pipeline refuses to record a sale with no purchase price — a profit
    // number you can't trust is worse than no number.
    const check = validateTransition(flip, status, values);
    if (!check.ok) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<p>${check.error}</p><p><a href="/crm">Back</a></p>`);
      return true;
    }
    updateFlip(db, flip.id, { status, ...values });
    seeOther(res);
    return true;
  }

  const deleteFlipMatch = url.pathname.match(/^\/crm\/(\d+)\/delete$/);
  if (req.method === 'POST' && deleteFlipMatch) {
    // Returns the listing to `passed` so the car doesn't disappear from both
    // the board and the listings page. See deleteFlip in lib/crm/db.js.
    deleteFlip(db, Number(deleteFlipMatch[1]));
    seeOther(res);
    return true;
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
    return true;
  }

  const boughtMatch = url.pathname.match(/^\/crm\/part\/(\d+)\/bought$/);
  if (req.method === 'POST' && boughtMatch) {
    const form = await readFormBody(req);
    markPartBought(db, Number(boughtMatch[1]), dollarsToCents(form.cost));
    seeOther(res);
    return true;
  }

  const deleteMatch = url.pathname.match(/^\/crm\/part\/(\d+)\/delete$/);
  if (req.method === 'POST' && deleteMatch) {
    deletePart(db, Number(deleteMatch[1]));
    seeOther(res);
    return true;
  }

  return false;
}
