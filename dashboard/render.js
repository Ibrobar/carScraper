// Pure HTML rendering. No I/O, no DB, no server — rendering is a function of
// rows so it can be unit-tested without a browser. server.js does the querying.
// See docs/DASHBOARD.md.

import { formatMoney, draftOfferMessage, offerPriceCents } from '../lib/offers.js';
import { METROS } from '../lib/config.js';
import { languageName } from '../lib/lang.js';

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "Today" / "Yesterday" / "Mon, Jul 21" from an ISO timestamp. */
export function dayLabel(iso, now = new Date()) {
  if (!iso) return 'Unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Unknown';

  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(date)) / 86_400_000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Group listings into day buckets, preserving the order they arrived in.
 *
 * The field follows the active sort: grouping by "first seen" while sorting by
 * "recently posted" would produce headings that jump around.
 */
export function groupByDay(listings, now = new Date(), field = 'posted_at') {
  const groups = new Map();
  for (const listing of listings) {
    const value = listing[field];
    const key = value ? dayLabel(value, now) : 'Posted date unknown';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(listing);
  }
  return [...groups.entries()].map(([label, rows]) => ({ label, listings: rows }));
}

const FLAG_LABELS = {
  check_engine_light: 'check engine light',
  sold_as_is: 'as-is',
  needs_work: 'needs work',
  engine_mentioned: 'engine mentioned',
  transmission_mentioned: 'trans mentioned',
  smoking: 'smokes',
  burns_oil: 'burns oil',
  oil_leak: 'oil leak',
  timing: 'timing',
  salvage_title: 'salvage title',
  rebuilt_title: 'rebuilt title',
  ai_questionable: 'AI: questionable',
};

const REASON_LABELS = {
  price_too_high: 'over cap',
  price_too_low: 'suspiciously cheap',
  origin_not_allowed: 'wrong origin',
  too_far: 'too far away',
  origin_unknown: 'unknown make',
  defect_engine: 'engine trouble',
  defect_transmission: 'transmission trouble',
  defect_not_running: "doesn't run",
  defect_parts_only: 'parts / project car',
  ai_flagged: 'AI flagged',
  not_a_car: 'not a car',
};

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function titleCase(str) {
  if (!str) return '';
  return str.split(/[\s-]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Cut to a word boundary so the preview doesn't end mid-word. */
export function truncate(text, max = 220) {
  if (!text) return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

const TITLE_STATUS_LABELS = {
  clean: 'clean title',
  salvage: 'SALVAGE title',
  rebuilt: 'rebuilt title',
};

/**
 * The seller's own words, on the card.
 *
 * A preview is always visible; the full text sits behind a native <details>
 * toggle so ten cards stay skimmable. <details> needs no JavaScript, which
 * keeps this consistent with the rest of the zero-dep dashboard.
 */
function renderDescription(listing) {
  const original = listing.description;
  if (!original) {
    return '<p class="desc none">No description scraped.</p>';
  }

  // Show the translation when we have one; the seller's own words stay one
  // click away, because a translation can soften or drop a detail that decides
  // whether the car is worth a drive.
  const translated = listing.description_en && listing.description_en !== original
    ? listing.description_en
    : null;
  const shown = translated ?? original;
  const foreign = listing.language && listing.language !== 'en';

  const preview = truncate(shown);
  const full = shown.replace(/\s+$/, '');
  const isTruncated = preview.replace(/…$/, '') !== full.replace(/\s+/g, ' ').trim();

  const tag = translated
    ? `<span class="lang">translated from ${escapeHtml(languageName(listing.language) ?? listing.language)}</span>`
    : foreign
      ? `<span class="lang untranslated">${escapeHtml(languageName(listing.language) ?? listing.language)} &mdash; set ANTHROPIC_API_KEY to translate</span>`
      : '';

  return `
      ${tag}
      <p class="desc">${escapeHtml(preview)}</p>
      ${isTruncated
        ? `<details class="more">
             <summary>Full ${translated ? 'translation' : 'description'}</summary>
             <div class="full">${escapeHtml(full)}</div>
           </details>`
        : ''}
      ${translated
        ? `<details class="more">
             <summary>Original ${escapeHtml(languageName(listing.language) ?? 'text')}</summary>
             <div class="full original">${escapeHtml(original)}</div>
           </details>`
        : ''}`;
}

/** Mileage / transmission / title / seller — the spec line under the price. */
function renderSpecs(listing) {
  const specs = [
    listing.mileage ? `${listing.mileage.toLocaleString('en-US')} mi` : null,
    listing.transmission ? String(listing.transmission).toLowerCase() : null,
    listing.title_status && listing.title_status !== 'unknown'
      ? TITLE_STATUS_LABELS[listing.title_status] ?? listing.title_status
      : null,
    listing.seller_name ? `seller: ${listing.seller_name}` : null,
  ].filter(Boolean);
  if (!specs.length) return '';
  return `<p class="specs">${specs.map((s) => escapeHtml(s)).join(' &middot; ')}</p>`;
}

function timeAgo(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const days = Math.round((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  if (days < 30) return `${days} days ago`;
  return `${Math.round(days / 30)} mo ago`;
}

function renderCard(listing) {
  const flags = parseJsonArray(listing.defect_flags);
  const reasons = parseJsonArray(listing.reject_reasons);
  const rejected = listing.status === 'rejected';

  const descriptor =
    [listing.year, titleCase(listing.make_norm), listing.model].filter(Boolean).join(' ') ||
    listing.title ||
    'Unknown vehicle';

  const dropped =
    Number.isFinite(listing.first_price_cents) &&
    Number.isFinite(listing.price_cents) &&
    listing.price_cents < listing.first_price_cents;

  const offer = listing.offer_price_cents ?? offerPriceCents(listing.price_cents);
  const message = draftOfferMessage(listing, { offerPriceCents: offer }) ?? '';

  const badges = [
    ...flags.map((f) => `<span class="badge">${escapeHtml(FLAG_LABELS[f] ?? f)}</span>`),
    ...(rejected
      ? reasons.map((r) => `<span class="badge bad">${escapeHtml(REASON_LABELS[r] ?? r)}</span>`)
      : []),
    ...(dropped ? ['<span class="badge drop">price dropped</span>'] : []),
    ...(listing.status === 'interested' ? ['<span class="badge good">interested</span>'] : []),
  ].join('');

  const meta = [
    listing.location_text,
    timeAgo(listing.posted_at),
    listing.metro,
  ].filter(Boolean).map((m) => escapeHtml(m)).join(' &middot; ');

  return `
  <article class="card${rejected ? ' rejected' : ''}" data-fb="${escapeHtml(listing.fb_id)}">
    ${listing.image_url
      ? `<img class="thumb" src="${escapeHtml(listing.image_url)}" alt="" loading="lazy">`
      : '<div class="thumb placeholder"></div>'}
    <div class="body">
      <h3>${escapeHtml(descriptor)}</h3>
      <p class="raw-title">${escapeHtml(listing.title ?? '')}</p>
      <p class="price">
        ${escapeHtml(formatMoney(listing.price_cents))}
        ${dropped ? `<s>${escapeHtml(formatMoney(listing.first_price_cents))}</s>` : ''}
      </p>
      <p class="meta">${meta}</p>
      ${renderSpecs(listing)}
      ${badges ? `<p class="badges">${badges}</p>` : ''}
      ${renderDescription(listing)}
      ${listing.ai_evidence
        ? `<p class="ai">AI noted: &ldquo;${escapeHtml(listing.ai_evidence)}&rdquo;</p>`
        : ''}
      <p class="offer">Offer: <strong>${escapeHtml(formatMoney(offer))}</strong></p>
      <div class="actions">
        <a class="btn" href="${escapeHtml(listing.url)}" target="_blank" rel="noreferrer">Open on Facebook</a>
        <button class="btn copy" data-message="${escapeHtml(message)}">Copy offer</button>
        <button class="btn" data-status="interested">Interested</button>
        <button class="btn subtle" data-status="hidden">Hide</button>
      </div>
    </div>
  </article>`;
}

function renderHealth(runs, unchecked = 0) {
  // Unchecked listings are hidden from the list on purpose — their descriptions
  // were never read, so nobody looked for engine or transmission trouble. Show
  // the count so a growing backlog is obvious instead of silent. Rendered
  // before the no-runs early return: a backlog can outlive the run history.
  const backlog = unchecked
    ? `<div class="run pending">
         <strong>${unchecked} awaiting check</strong>
         <span class="counts">description not read yet &mdash; hidden until it is</span>
         <span class="when">run again to clear</span>
       </div>`
    : '';

  if (!runs.length) {
    return `<div class="health">${backlog}<div class="run">No scrape has run yet. Run <code>npm run scrape</code>.</div></div>`;
  }

  const cells = runs.map((run) => {
    const ok = run.status === 'ok';
    const when = run.finished_at || run.started_at;
    return `
      <div class="run ${ok ? 'ok' : 'bad'}">
        <strong>${escapeHtml(METROS[run.metro]?.label ?? run.metro)}</strong>
        <span class="status">${escapeHtml(run.status)}</span>
        <span class="counts">${run.listings_seen} seen &middot; ${run.listings_new} new &middot; ${run.details_fetched} details</span>
        <span class="when">${escapeHtml(timeAgo(when) ?? '')}</span>
        ${run.error ? `<span class="err">${escapeHtml(run.error)}</span>` : ''}
        ${run.debug_path ? `<span class="err">snapshot: ${escapeHtml(run.debug_path)}</span>` : ''}
      </div>`;
  }).join('');
  return `<div class="health">${cells}${backlog}</div>`;
}

/** Rebuild the current URL with some params replaced. Keeps filters across pages. */
export function pageUrl(filters, overrides = {}) {
  const params = new URLSearchParams();
  const merged = { ...filters, ...overrides };
  for (const key of ['metro', 'origin', 'min', 'max', 'q', 'days', 'sort']) {
    if (merged[key] !== null && merged[key] !== undefined && merged[key] !== '') {
      params.set(key, String(merged[key]));
    }
  }
  if (merged.rejected) params.set('rejected', '1');
  if (merged.page && merged.page > 1) params.set('page', String(merged.page));
  const query = params.toString();
  return query ? `/?${query}` : '/';
}

function renderPager(filters, page, pageSize, total, shown) {
  if (total <= pageSize) return '';
  const pages = Math.ceil(total / pageSize);
  const from = (page - 1) * pageSize + 1;
  // Count what actually rendered rather than assuming a full page — the last
  // page is short, and rows can vanish between the count and the query when
  // you're hiding cars as you go.
  const to = from + Math.max(0, shown) - 1;

  const prev = page > 1
    ? `<a class="btn" href="${pageUrl(filters, { page: page - 1 })}">&larr; Previous</a>`
    : '<span class="btn disabled">&larr; Previous</span>';
  const next = page < pages
    ? `<a class="btn" href="${pageUrl(filters, { page: page + 1 })}">Next ${Math.min(pageSize, total - to)} &rarr;</a>`
    : '<span class="btn disabled">Next &rarr;</span>';

  return `
  <nav class="pager">
    ${prev}
    <span class="pos">${from}&ndash;${to} of ${total}${pages > 1 ? ` &middot; page ${page}/${pages}` : ''}</span>
    ${next}
  </nav>`;
}

function renderFilterBar(filters) {
  const metroOptions = ['', ...Object.keys(METROS)]
    .map((key) => `<option value="${key}"${filters.metro === key ? ' selected' : ''}>${key ? escapeHtml(METROS[key].label) : 'All metros'}</option>`)
    .join('');
  const originOptions = ['', 'american', 'japanese', 'korean', 'german', 'other', 'unknown']
    .map((key) => `<option value="${key}"${filters.origin === key ? ' selected' : ''}>${key || 'All origins'}</option>`)
    .join('');

  const sortOptions = [
    ['posted', 'Most recent'],
    ['price', 'Cheapest first'],
    ['drop', 'Biggest price drop'],
  ].map(([value, label]) =>
    `<option value="${value}"${(filters.sort ?? 'posted') === value ? ' selected' : ''}>${label}</option>`,
  ).join('');

  // Age window. Older cars aren't deleted — this brings them back.
  const dayOptions = [
    [1, 'Last 24 hours'], [2, 'Last 2 days'], [3, 'Last 3 days'],
    [7, 'Last week'], [30, 'Last month'], [0, 'All time'],
  ].map(([value, label]) =>
    `<option value="${value}"${Number(filters.days) === value ? ' selected' : ''}>${label}</option>`,
  ).join('');

  return `
  <form class="filters" method="get">
    <select name="sort">${sortOptions}</select>
    <select name="days">${dayOptions}</select>
    <select name="metro">${metroOptions}</select>
    <select name="origin">${originOptions}</select>
    <input type="number" name="min" placeholder="min $" value="${filters.min ?? ''}">
    <input type="number" name="max" placeholder="max $" value="${filters.max ?? ''}">
    <input type="search" name="q" placeholder="search title" value="${escapeHtml(filters.q ?? '')}">
    <label class="toggle">
      <input type="checkbox" name="rejected" value="1"${filters.rejected ? ' checked' : ''}>
      Show rejected
    </label>
    <button type="submit">Apply</button>
    <a class="reset" href="/">Reset</a>
  </form>`;
}

/** @returns {string} a complete HTML document */
export function renderPage({
  listings = [], runs = [], filters = {}, unchecked = 0,
  page = 1, pageSize = 10, total = null, groupField = 'posted_at',
  now = new Date(),
} = {}) {
  const matched = total ?? listings.length;
  const groups = groupByDay(listings, now, groupField);
  const missingPostedDate = groupField === 'posted_at'
    ? listings.filter((l) => !l.posted_at).length
    : 0;
  const body = groups.length
    ? groups.map((group) => `
      <section class="day">
        <h2>${escapeHtml(group.label)} <span class="count">${group.listings.length}</span></h2>
        <div class="grid">${group.listings.map(renderCard).join('')}</div>
      </section>`).join('')
    : `<p class="empty">${
        page > 1
          ? `Nothing on page ${page}. <a href="${pageUrl(filters, { page: 1 })}">Back to the first page</a>.`
          : `Nothing matches. ${filters.rejected ? '' : 'Try <strong>Show rejected</strong> to see what got cut and why.'}`
      }</p>`;
  const pager = renderPager(filters, page, pageSize, matched, listings.length);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Car Scraper${filters.rejected ? ' — rejected' : ''}</title>
<style>
  :root { color-scheme: dark; --bg:#14161a; --panel:#1c1f26; --line:#2b303a;
          --text:#e8eaed; --dim:#9aa3ad; --good:#4ade80; --bad:#f87171; --accent:#60a5fa; }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; background:var(--bg); color:var(--text);
         font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  h1 { margin:0 0 4px; font-size:20px; }
  .crmlink { font-size:13px; font-weight:400; margin-left:10px; color:var(--accent);
             text-decoration:none; }
  .sub { color:var(--dim); margin:0 0 20px; font-size:13px; }
  .health { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:20px; }
  .health.empty { color:var(--dim); }
  .run { background:var(--panel); border:1px solid var(--line); border-left-width:4px;
         border-radius:8px; padding:10px 14px; display:flex; flex-direction:column; gap:2px; font-size:13px; }
  .run.ok  { border-left-color:var(--good); }
  .run.bad { border-left-color:var(--bad); }
  .run.pending { border-left-color:#eab308; }
  .run .status { text-transform:uppercase; font-size:11px; letter-spacing:.06em; color:var(--dim); }
  .run.bad .status { color:var(--bad); }
  .run .counts, .run .when { color:var(--dim); font-size:12px; }
  .run .err { color:var(--bad); font-size:12px; }
  .filters { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:24px; }
  .filters select, .filters input[type=number], .filters input[type=search], .filters button {
    background:var(--panel); color:var(--text); border:1px solid var(--line);
    border-radius:6px; padding:7px 10px; font-size:14px; }
  .filters input[type=number] { width:90px; }
  .filters button { cursor:pointer; border-color:var(--accent); color:var(--accent); }
  .filters .toggle { display:flex; align-items:center; gap:6px; color:var(--dim); font-size:14px; }
  .filters .reset { color:var(--dim); font-size:13px; }
  .day { margin-bottom:32px; }
  .day h2 { font-size:15px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim);
            border-bottom:1px solid var(--line); padding-bottom:8px; }
  .day .count { color:var(--dim); font-weight:400; }
  /* Wider than a thumbnail grid — these cards carry the seller's description
     now, and narrow columns make prose unreadable. */
  .grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fill,minmax(420px,1fr)); margin-top:14px; align-items:start; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px;
          overflow:hidden; display:flex; flex-direction:column; }
  .card.rejected { opacity:.55; }
  .thumb { width:100%; height:170px; object-fit:cover; background:#0f1115; display:block; }
  .thumb.placeholder { background:repeating-linear-gradient(45deg,#1a1d23,#1a1d23 10px,#20242b 10px,#20242b 20px); }
  .body { padding:12px 14px 14px; display:flex; flex-direction:column; gap:6px; }
  .card h3 { margin:0; font-size:16px; }
  .raw-title { margin:0; color:var(--dim); font-size:12px;
               overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .price { margin:0; font-size:20px; font-weight:600; }
  .price s { color:var(--dim); font-size:14px; font-weight:400; margin-left:8px; }
  .meta { margin:0; color:var(--dim); font-size:12px; }
  .specs { margin:0; font-size:13px; color:var(--text); }
  .desc { margin:6px 0 0; font-size:13px; line-height:1.45; color:#c6ccd4;
          border-left:2px solid var(--line); padding-left:10px; }
  .desc.none { color:var(--dim); font-style:italic; border-left-color:transparent; }
  .more { margin:0; }
  .more summary { cursor:pointer; font-size:12px; color:var(--accent); padding:2px 0; }
  .more summary::marker { color:var(--dim); }
  .lang { display:inline-block; font-size:11px; color:var(--accent);
          background:#182338; border-radius:999px; padding:2px 8px; margin-top:6px; }
  .lang.untranslated { color:var(--dim); background:#22262e; }
  .more .full.original { color:var(--dim); }
  .more .full { white-space:pre-wrap; font-size:13px; line-height:1.5; color:#c6ccd4;
                background:#171a20; border:1px solid var(--line); border-radius:6px;
                padding:10px; margin-top:6px; max-height:340px; overflow-y:auto; }
  .badges { margin:2px 0 0; display:flex; gap:6px; flex-wrap:wrap; }
  .badge { font-size:11px; padding:2px 8px; border-radius:999px;
           background:#2a2f3a; color:var(--dim); }
  .badge.bad  { background:#3a2226; color:var(--bad); }
  .badge.good { background:#1e3a2b; color:var(--good); }
  .badge.drop { background:#1e3145; color:var(--accent); }
  .ai { margin:0; font-size:12px; color:var(--dim); font-style:italic; }
  .offer { margin:4px 0 0; font-size:14px; }
  .actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
  .btn { background:#252a33; color:var(--text); border:1px solid var(--line);
         border-radius:6px; padding:6px 10px; font-size:13px; cursor:pointer; text-decoration:none; }
  .btn:hover { border-color:var(--accent); }
  .btn.subtle { color:var(--dim); }
  .empty { color:var(--dim); }
  .note { color:var(--dim); font-size:13px; background:var(--panel);
          border-left:3px solid #eab308; border-radius:6px; padding:8px 12px; margin:0 0 16px; }
  code { background:var(--panel); padding:2px 6px; border-radius:4px; }
  .pager { display:flex; align-items:center; gap:12px; margin:18px 0; }
  .pager .pos { color:var(--dim); font-size:13px; }
  .btn.disabled { opacity:.35; cursor:default; }
  .btn.disabled:hover { border-color:var(--line); }
</style>
</head>
<body>
<h1>Car Scraper <a class="crmlink" href="/crm">Flips &rarr;</a></h1>
<p class="sub">
  ${matched} ${filters.rejected ? 'rejected' : 'good'} listing${matched === 1 ? '' : 's'}${
    Number(filters.days) > 0
      ? ` from the last ${filters.days === 1 ? '24 hours' : `${filters.days} days`}`
      : ''
  }${matched > pageSize ? `, showing ${listings.length}` : ''}
  &middot; older cars age off automatically; <strong>Interested</strong> ones never do
  &middot; nothing here messages anyone &mdash; Copy offer puts text on your clipboard, you send it
</p>
${renderHealth(runs, unchecked)}
${renderFilterBar(filters)}
${missingPostedDate
  ? `<p class="note">${missingPostedDate} of these ${missingPostedDate === 1 ? 'has' : 'have'} no
     posted date &mdash; Facebook didn't show one we could read. They sort last and group under
     &ldquo;Posted date unknown&rdquo; rather than pretending to be fresh.</p>`
  : ''}
${pager}
${body}
${pager}
<script>
document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.classList.contains('copy')) {
    await navigator.clipboard.writeText(button.dataset.message || '');
    const original = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = original; }, 1200);
    return;
  }

  const status = button.dataset.status;
  if (!status) return;
  const card = button.closest('.card');
  await fetch('/api/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fbId: card.dataset.fb, status }),
  });
  // Reload rather than just removing the card: a hidden car leaves a gap, and
  // reloading refills the page with the next one. That's what makes this a
  // queue you work through instead of a list that slowly empties.
  location.reload();
});
</script>
</body>
</html>`;
}
