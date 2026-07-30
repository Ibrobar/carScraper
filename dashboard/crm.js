// CRM board rendering. Pure — a function of rows, same split as render.js.
// See docs/CRM.md.

import { escapeHtml } from './render.js';
import { formatMoney } from '../lib/offers.js';
import {
  FLIP_STATUSES, FLIP_STATUS_LABELS, BOARD_COLUMNS,
  flipTotals, portfolioTotals,
} from '../lib/flips.js';

const STATUS_CLASS = {
  interested: 'chasing', contacted: 'chasing', replied: 'attention',
  bought: 'active', repairing: 'active', ready_to_sell: 'ready',
  sold: 'sold', dead: 'dead',
};

function titleCase(str) {
  if (!str) return '';
  return str.split(/[\s-]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function carName(flip) {
  return [flip.year, titleCase(flip.make_norm), flip.model].filter(Boolean).join(' ')
    || flip.title
    || 'Unknown vehicle';
}

/** The money line. Shows profit once sold, invested-so-far before that. */
function renderMoney(flip, totals) {
  const rows = [];
  if (totals.purchaseCents) rows.push(['Paid', formatMoney(totals.purchaseCents)]);
  if (totals.partsCents) rows.push(['Parts', formatMoney(totals.partsCents)]);
  if (totals.plannedPartsCents) {
    rows.push(['Parts planned', `${formatMoney(totals.plannedPartsCents)} (not bought)`]);
  }
  if (totals.investedCents) rows.push(['In it', formatMoney(totals.investedCents)]);
  if (totals.saleCents) rows.push(['Sold for', formatMoney(totals.saleCents)]);

  if (!rows.length && flip.asking_price_cents) {
    rows.push(['Asking', formatMoney(flip.asking_price_cents)]);
  }

  const profit = totals.profitCents === null
    ? ''
    : `<p class="profit ${totals.profitCents >= 0 ? 'good' : 'bad'}">
         ${totals.profitCents >= 0 ? 'Profit' : 'Loss'}
         <strong>${escapeHtml(formatMoney(Math.abs(totals.profitCents)))}</strong>
         ${totals.marginPct !== null ? `<span class="margin">${totals.marginPct}% margin</span>` : ''}
       </p>`;

  return `
    <dl class="money">
      ${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}
    </dl>
    ${profit}`;
}

function renderParts(flip, parts) {
  const items = parts.map((part) => `
    <li class="part ${part.status}">
      <span class="pname">${escapeHtml(part.name)}</span>
      <span class="pcost">${part.cost_cents ? escapeHtml(formatMoney(part.cost_cents)) : '&mdash;'}</span>
      ${part.status === 'bought'
        ? '<span class="ptag">bought</span>'
        : `<form class="inline" method="post" action="/crm/part/${part.id}/bought">
             <input type="number" name="cost" step="1" min="0" placeholder="$"
                    value="${part.cost_cents ? Math.round(part.cost_cents / 100) : ''}">
             <button type="submit">Bought</button>
           </form>`}
      <form class="inline" method="post" action="/crm/part/${part.id}/delete">
        <button type="submit" class="link" title="Remove">&times;</button>
      </form>
    </li>`).join('');

  return `
    <details class="parts"${parts.length ? ' open' : ''}>
      <summary>Parts (${parts.length})</summary>
      <ul class="partlist">${items || '<li class="none">Nothing listed yet.</li>'}</ul>
      <form class="addpart" method="post" action="/crm/${flip.id}/part">
        <input type="text" name="name" placeholder="Part or job" required>
        <input type="number" name="cost" step="1" min="0" placeholder="est $">
        <button type="submit">Add</button>
      </form>
    </details>`;
}

function renderStatusForm(flip) {
  const options = FLIP_STATUSES
    .map((s) => `<option value="${s}"${flip.status === s ? ' selected' : ''}>${FLIP_STATUS_LABELS[s]}</option>`)
    .join('');

  // The amount fields are always present but only required by the server for
  // the stages that need them (bought / sold) — see validateTransition.
  return `
    <form class="statusform" method="post" action="/crm/${flip.id}/status">
      <select name="status">${options}</select>
      <input type="number" name="purchase" step="1" min="0" placeholder="paid $"
             value="${flip.purchase_price_cents ? Math.round(flip.purchase_price_cents / 100) : ''}">
      <input type="number" name="sale" step="1" min="0" placeholder="sold $"
             value="${flip.sale_price_cents ? Math.round(flip.sale_price_cents / 100) : ''}">
      <button type="submit">Update</button>
    </form>`;
}

function renderCard(flip, parts) {
  const totals = flipTotals(flip, parts);
  return `
  <article class="flip ${STATUS_CLASS[flip.status] ?? ''}">
    ${flip.image_url
      ? `<img class="thumb" src="${escapeHtml(flip.image_url)}" alt="" loading="lazy">`
      : '<div class="thumb placeholder"></div>'}
    <div class="body">
      <header>
        <h3>${escapeHtml(carName(flip))}</h3>
        <span class="badge status">${escapeHtml(FLIP_STATUS_LABELS[flip.status] ?? flip.status)}</span>
      </header>
      <p class="meta">
        ${[flip.location_text, flip.metro].filter(Boolean).map((s) => escapeHtml(s)).join(' &middot; ')}
      </p>
      ${flip.status === 'replied' && flip.last_reply_at
        ? '<p class="reply">The seller replied &mdash; your move.</p>'
        : ''}
      ${renderMoney(flip, totals)}
      ${renderParts(flip, parts)}
      ${renderStatusForm(flip)}
      <div class="actions">
        ${flip.url
          ? `<a class="btn" href="${escapeHtml(flip.url)}" target="_blank" rel="noreferrer">Open listing</a>`
          : ''}
        ${flip.thread_url
          ? `<a class="btn" href="${escapeHtml(flip.thread_url)}" target="_blank" rel="noreferrer">Open chat</a>`
          : `<a class="btn" href="https://www.facebook.com/marketplace/inbox" target="_blank" rel="noreferrer">Messenger</a>`}
        <form class="inline" method="post" action="/crm/${flip.id}/delete"
              onsubmit="return confirm('Remove ${escapeHtml(carName(flip).replace(/'/g, ''))} from the board? Its parts and prices go with it. The car returns to your listings.');">
          <button type="submit" class="btn danger">Remove</button>
        </form>
      </div>
    </div>
  </article>`;
}

/** @returns {string} a complete HTML document */
export function renderCrm({ rows = [], filterStatus = null } = {}) {
  const totals = portfolioTotals(rows);

  const board = BOARD_COLUMNS.map(({ label, statuses }) => {
    const group = rows.filter(({ flip }) => statuses.includes(flip.status));
    return `
      <section class="col">
        <h2>${escapeHtml(label)} <span class="count">${group.length}</span></h2>
        ${group.length
          ? group.map(({ flip, parts }) => renderCard(flip, parts)).join('')
          : '<p class="none">Nothing here.</p>'}
      </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flips &mdash; Car Scraper</title>
<style>
  :root { color-scheme: dark; --bg:#14161a; --panel:#1c1f26; --line:#2b303a;
          --text:#e8eaed; --dim:#9aa3ad; --good:#4ade80; --bad:#f87171;
          --accent:#60a5fa; --warn:#eab308; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--text);
         font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  a { color:var(--accent); }
  h1 { margin:0 0 4px; font-size:20px; }
  .sub { color:var(--dim); margin:0 0 18px; font-size:13px; }
  .totals { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:22px; }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:8px;
          padding:10px 16px; min-width:130px; }
  .stat b { display:block; font-size:19px; }
  .stat span { color:var(--dim); font-size:12px; }
  .stat.profit b { color:var(--good); }
  .stat.profit.negative b { color:var(--bad); }
  .stat.risk b { color:var(--warn); }
  .board { display:grid; gap:18px; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); align-items:start; }
  .col h2 { font-size:14px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim);
            border-bottom:1px solid var(--line); padding-bottom:8px; margin:0 0 12px; }
  .col .count { color:var(--dim); font-weight:400; }
  .flip { background:var(--panel); border:1px solid var(--line); border-left-width:4px;
          border-radius:10px; overflow:hidden; margin-bottom:14px; }
  .flip.chasing   { border-left-color:#64748b; }
  .flip.attention { border-left-color:var(--accent); }
  .flip.active    { border-left-color:var(--warn); }
  .flip.ready     { border-left-color:#a78bfa; }
  .flip.sold      { border-left-color:var(--good); }
  .flip.dead      { border-left-color:#475569; opacity:.6; }
  .thumb { width:100%; height:140px; object-fit:cover; background:#0f1115; display:block; }
  .thumb.placeholder { background:repeating-linear-gradient(45deg,#1a1d23,#1a1d23 10px,#20242b 10px,#20242b 20px); }
  .body { padding:12px 14px 14px; display:flex; flex-direction:column; gap:8px; }
  .body header { display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .flip h3 { margin:0; font-size:16px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:999px; background:#2a2f3a; color:var(--dim); }
  .meta { margin:0; color:var(--dim); font-size:12px; }
  .reply { margin:0; font-size:13px; color:var(--accent); font-weight:600; }
  .money { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; margin:0; font-size:13px; }
  .money dt { color:var(--dim); }
  .money dd { margin:0; text-align:right; }
  .profit { margin:4px 0 0; font-size:14px; }
  .profit.good strong { color:var(--good); }
  .profit.bad strong { color:var(--bad); }
  .margin { color:var(--dim); font-size:12px; margin-left:6px; }
  .parts summary { cursor:pointer; font-size:12px; color:var(--accent); }
  .partlist { list-style:none; margin:8px 0; padding:0; display:flex; flex-direction:column; gap:4px; }
  .part { display:flex; align-items:center; gap:8px; font-size:13px; }
  .part.bought .pname { color:var(--dim); text-decoration:line-through; }
  .pname { flex:1; }
  .pcost { color:var(--dim); }
  .ptag { font-size:11px; color:var(--good); }
  .part .none, .col .none { color:var(--dim); font-size:13px; }
  form.inline { display:inline-flex; gap:4px; margin:0; }
  input, select, button { background:#252a33; color:var(--text); border:1px solid var(--line);
                          border-radius:6px; padding:5px 8px; font-size:13px; font-family:inherit; }
  input[type=number] { width:82px; }
  button { cursor:pointer; }
  button:hover { border-color:var(--accent); }
  button.link { border:none; background:none; color:var(--dim); padding:2px 4px; }
  .addpart, .statusform { display:flex; gap:6px; flex-wrap:wrap; margin:0; }
  .addpart input[type=text] { flex:1; min-width:120px; }
  .actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; }
  .btn { background:#252a33; border:1px solid var(--line); border-radius:6px;
         padding:6px 10px; font-size:13px; text-decoration:none; color:var(--text); }
  .btn:hover { border-color:var(--accent); }
  .btn.danger { color:var(--dim); }
  .btn.danger:hover { border-color:var(--bad); color:var(--bad); }
  .filters { margin-bottom:16px; }
</style>
</head>
<body>
<h1>Flips</h1>
<p class="sub">
  <a href="/">&larr; back to listings</a>
  &middot; ${rows.length} car${rows.length === 1 ? '' : 's'} tracked
  &middot; nothing here posts or messages anyone
</p>

<div class="totals">
  <div class="stat"><b>${escapeHtml(formatMoney(totals.invested))}</b><span>total invested</span></div>
  <div class="stat risk"><b>${escapeHtml(formatMoney(totals.atRisk))}</b><span>tied up in ${totals.active} unsold</span></div>
  <div class="stat"><b>${escapeHtml(formatMoney(totals.realized))}</b><span>sales (${totals.sold})</span></div>
  <div class="stat profit${totals.profit < 0 ? ' negative' : ''}">
    <b>${escapeHtml(formatMoney(totals.profit))}</b><span>realized profit</span>
  </div>
</div>

<div class="board">${board}</div>
</body>
</html>`;
}
