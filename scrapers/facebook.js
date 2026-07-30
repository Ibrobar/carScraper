// Playwright scraper for Facebook Marketplace vehicles.
//
// Read docs/SCRAPER.md before touching this. The short version:
//   - Auth is a saved storageState from `npm run login`. Never a scripted login.
//   - Parse the embedded JSON first, DOM anchors second. NEVER select on CSS
//     class names -- Facebook's are generated and change without notice.
//   - Zero listings parsed is a FAILURE. Snapshot the page and say so.

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config, SESSION_PATH, DEBUG_DIR } from '../lib/config.js';
import {
  buildSearchUrl, itemUrl, extractFbId, parsePriceToCents, parseMileage,
  parseRelativeTime, parseTitleStatus, cleanSellerName, sleep, classifyPageProblem,
} from './base.js';

export class ScrapeProblem extends Error {
  constructor(status, message, debugPath = null) {
    super(message);
    this.name = 'ScrapeProblem';
    this.status = status; // 'login_wall' | 'blocked' | 'no_listings' | 'error'
    this.debugPath = debugPath;
  }
}

/**
 * Pull listing objects out of the JSON Facebook embeds in <script> tags.
 *
 * Window-and-regex rather than full JSON parsing on purpose: the blobs are
 * megabytes of minified, deeply nested state and a strict parse breaks on any
 * shape change. Key names are the stable part, so we anchor on those.
 */
export function extractEmbeddedListings(html) {
  const found = new Map();
  const titleKey = /"marketplace_listing_title"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;

  while ((match = titleKey.exec(html)) !== null) {
    const title = decodeJsonString(match[1]);
    const start = Math.max(0, match.index - 2500);
    const window = html.slice(start, match.index + 2500);

    const id = firstMatch(window, /"id"\s*:\s*"(\d{8,})"/);
    if (!id || found.has(id)) continue;

    const amount = firstMatch(window, /"amount"\s*:\s*"?([\d.]+)"?/);
    const city = firstMatch(window, /"(?:city|reverse_geocode_detailed|location_text)"[^}]{0,120}?"name"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      ?? firstMatch(window, /"city"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const image = firstMatch(window, /"uri"\s*:\s*"(https:\\?\/\\?\/[^"]*?(?:scontent|fbcdn)[^"]*?)"/);

    found.set(id, {
      fbId: id,
      url: itemUrl(id),
      title,
      priceCents: parsePriceToCents(amount),
      locationText: city ? decodeJsonString(city) : null,
      imageUrl: image ? decodeJsonString(image).replace(/\\\//g, '/') : null,
      raw: { source: 'embedded_json' },
    });
  }
  return [...found.values()];
}

function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? m[1] : null;
}


function decodeJsonString(str) {
  try {
    return JSON.parse(`"${str}"`);
  } catch {
    return str.replace(/\\u([\da-f]{4})/gi, (_, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    ).replace(/\\(.)/g, '$1');
  }
}

export class FacebookProvider {
  name = 'facebook';

  constructor(options = {}) {
    this.headful = options.headful ?? config.headful;
    this.browser = null;
    this.context = null;
  }

  async ensureContext() {
    if (this.context) return this.context;
    if (!existsSync(SESSION_PATH)) {
      throw new ScrapeProblem(
        'login_wall',
        'No saved session. Run `npm run login` and log in by hand.',
      );
    }

    this.browser = await chromium.launch({ headless: !this.headful });
    this.context = await this.browser.newContext({
      storageState: SESSION_PATH,
      viewport: { width: 1440, height: 900 },
      // Match the metros we search. A Texas Marketplace search from a UTC
      // browser is a mismatch worth not having.
      locale: 'en-US',
      timezoneId: 'America/Chicago',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    // Trim the most obvious automation tell.
    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return this.context;
  }

  async saveDebug(page, metro, stage) {
    try {
      mkdirSync(DEBUG_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const base = join(DEBUG_DIR, `${stamp}_${metro}_${stage}`);
      writeFileSync(`${base}.html`, await page.content(), 'utf8');
      await page.screenshot({ path: `${base}.png`, fullPage: false });
      return `${base}.html`;
    } catch {
      return null;
    }
  }

  /** Phase 1: page through search results and return card-level data. */
  async searchListings({ metro, citySlug, maxPages = config.maxSearchPages }) {
    const context = await this.ensureContext();
    const page = await context.newPage();
    const url = buildSearchUrl(citySlug);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(2500, 4500);

      const problem = classifyPageProblem({
        url: page.url(),
        html: await page.content(),
      });
      if (problem) {
        const debugPath = await this.saveDebug(page, metro, 'search');
        throw new ScrapeProblem(problem, `Search blocked for ${citySlug} (${problem})`, debugPath);
      }

      // Pagination is scroll-driven with jitter, not URL offsets — offsets are
      // a pattern no human produces. Marketplace lazy-loads on approach to the
      // bottom, so we scroll until the listing count stops growing rather than
      // scrolling a fixed number of times: a fixed count silently under-collects
      // (the first version topped out around 19 listings a city).
      const collected = new Map();
      const maxRounds = maxPages * 5;
      let stableRounds = 0;

      for (let round = 0; round < maxRounds && stableRounds < 3; round++) {
        const before = collected.size;
        const html = await page.content();

        for (const card of extractEmbeddedListings(html)) {
          if (!collected.has(card.fbId)) collected.set(card.fbId, { ...card, metro });
        }
        for (const card of await this.extractCardsFromDom(page)) {
          const existing = collected.get(card.fbId);
          if (existing) {
            // DOM fills gaps the JSON scan missed; never overwrite good data.
            existing.title ??= card.title;
            existing.priceCents ??= card.priceCents;
            existing.imageUrl ??= card.imageUrl;
            existing.locationText ??= card.locationText;
          } else {
            collected.set(card.fbId, { ...card, metro });
          }
        }

        if (round > 0 && collected.size === before) stableRounds++;
        else stableRounds = 0;

        await this.scrollForMore(page);
        await sleep(...config.searchDelayMs);
      }

      const cards = [...collected.values()];
      if (!cards.length) {
        const debugPath = await this.saveDebug(page, metro, 'search');
        throw new ScrapeProblem(
          'no_listings',
          `Parsed 0 listings for ${citySlug}. A real search is never empty — selectors likely broke.`,
          debugPath,
        );
      }
      return cards;
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Scroll far enough that Marketplace lazy-loads the next batch. */
  async scrollForMore(page) {
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
      // Marketplace sometimes scrolls an inner container rather than the window.
      // Find the tall scrollable panes and drive those too.
      const panes = [...document.querySelectorAll('div')].filter(
        (el) => el.scrollHeight > el.clientHeight + 200 && el.clientHeight > 400,
      );
      for (const pane of panes.slice(0, 3)) pane.scrollTop = pane.scrollHeight;
    }).catch(() => {});
  }

  /**
   * DOM fallback. Anchors are matched structurally by href, never by class name.
   * Facebook's class names are build-generated and change constantly.
   */
  async extractCardsFromDom(page) {
    return page.evaluate(() => {
      // A card's text lines look like:
      //   ["Just listed", "$2,500", "2008 Chevy Silverado", "Dallas, TX", "150K miles"]
      // Taking the first non-price line yields the BADGE, not the title. That
      // bug classified 142 of the first 219 listings as "Just listed" -> unknown
      // make -> rejected.
      const BADGE = /^(just listed|new|sponsored|featured|free|sold|pending|reduced|price drop|shipping available|local pickup)$/i;
      const LOCATION = /,\s*[A-Z]{2}\.?$/;
      const MILEAGE = /^[\d,.]+\s*[km]?\s*(miles|mi|km)\b/i;
      const PRICE = /^\$[\d,]/;

      const out = [];
      const seen = new Set();

      for (const anchor of document.querySelectorAll('a[href*="/marketplace/item/"]')) {
        const match = anchor.getAttribute('href')?.match(/\/marketplace\/item\/(\d+)/);
        if (!match) continue;
        const fbId = match[1];
        if (seen.has(fbId)) continue;
        seen.add(fbId);

        const lines = (anchor.innerText || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);

        const priceLine = lines.find((l) => PRICE.test(l)) ?? null;
        const locationLine = [...lines].reverse().find((l) => LOCATION.test(l)) ?? null;

        const titleCandidates = lines.filter(
          (l) =>
            !PRICE.test(l) && !BADGE.test(l) && !MILEAGE.test(l) &&
            l !== locationLine && l.length > 3,
        );
        // A vehicle title almost always starts with the year. Prefer that;
        // otherwise take the longest remaining line.
        const titleLine =
          titleCandidates.find((l) => /^(19|20)\d{2}\b/.test(l)) ??
          titleCandidates.sort((a, b) => b.length - a.length)[0] ??
          null;

        const img = anchor.querySelector('img');
        out.push({
          fbId,
          url: `https://www.facebook.com/marketplace/item/${fbId}/`,
          title: titleLine,
          priceRaw: priceLine,
          locationText: locationLine,
          imageUrl: img?.getAttribute('src') ?? null,
        });
      }
      return out;
    }).then((rows) =>
      rows.map((row) => ({
        fbId: row.fbId,
        url: row.url,
        title: row.title,
        priceCents: parsePriceToCents(row.priceRaw),
        locationText: row.locationText,
        imageUrl: row.imageUrl,
        raw: { source: 'dom' },
      })),
    );
  }

  /** Phase 2: the expensive fetch. Only called for listings that already passed. */
  async fetchDetail(fbId) {
    const context = await this.ensureContext();
    const page = await context.newPage();

    try {
      await page.goto(itemUrl(fbId), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(1800, 3200);

      const html = await page.content();
      const problem = classifyPageProblem({ url: page.url(), html });
      if (problem) {
        const debugPath = await this.saveDebug(page, 'detail', fbId);
        throw new ScrapeProblem(problem, `Detail page blocked (${problem})`, debugPath);
      }

      // Try to open the "See more" description expander if it's there.
      const seeMore = page.getByText(/see more/i).first();
      if (await seeMore.isVisible().catch(() => false)) {
        await seeMore.click().catch(() => {});
        await sleep(400, 900);
      }

      const bodyText = await page.evaluate(() => document.body.innerText || '');
      const description = this.constructor.extractDescription(bodyText);

      return {
        description,
        mileage: parseMileage(firstMatch(bodyText, /([\d,.]+\s*k?)\s*miles/i)),
        transmission: firstMatch(bodyText, /\b(automatic|manual)\s*transmission/i)
          ?? firstMatch(bodyText, /transmission[:\s]+(automatic|manual)/i),
        titleStatus: parseTitleStatus(bodyText),
        // The name sits two lines below "Seller information", under a "Seller
        // details" sub-heading. Taking the line straight after the first
        // heading captured the literal text "Seller details" for 453 listings.
        // Each pattern is cleaned independently and the first real name wins —
        // chaining with `??` before cleaning meant a junk first match blocked
        // the good second one.
        sellerName: [
          /\n\s*seller details\s*\n\s*(.+)/i,
          /\n\s*seller information\s*\n\s*(?:seller details\s*\n\s*)?(.+)/i,
        ].map((re) => cleanSellerName(firstMatch(bodyText, re))).find(Boolean) ?? null,
        sellerUrl: null,
        year: null,
        make: firstMatch(bodyText, /\bmake[:\s]+([A-Za-z-]+)/i),
        model: firstMatch(bodyText, /\bmodel[:\s]+([A-Za-z0-9 -]+)/i),
        // Facebook words this several ways ("Listed 3 hours ago", "Posted
        // about a week ago", "Just listed"). Only ~38% of listings matched the
        // original "listed ... ago" pattern, which left the recently-listed
        // sort working on a minority of the data.
        postedAt: parseRelativeTime(
          firstMatch(bodyText, /(?:listed|posted)\s+(?:about\s+|over\s+|around\s+)?([^\n]{0,30}?\bago)/i)
          ?? firstMatch(bodyText, /\b(just listed|just posted)\b/i),
        ),
        raw: { source: 'detail', length: bodyText.length },
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Marketplace detail pages are mostly chrome. The description sits between the
   * "Description"/"Details" heading and the seller block, so slice on those
   * anchors rather than trying to select the element.
   *
   * There used to be a "longest paragraph on the page" fallback for when the
   * heading wasn't found. It was actively harmful: it grabbed the *sidebar*,
   * so 113 of 291 listings ended up storing some other seller's ad — 85 of them
   * the same flea-market listing. Defect detection then ran engine and
   * transmission checks against a Star Trek figurine ad and passed the car.
   *
   * Returning null is strictly better than guessing. A listing with no
   * description stays in `pending_detail`, hidden and re-queued; a listing with
   * the WRONG description gets marked `passed` and shown as vetted when nobody
   * checked anything.
   */
  static extractDescription(bodyText) {
    if (!bodyText) return null;

    // The heading is "Seller's description" — NOT "Description". Requiring the
    // bare word matched nothing on 500 consecutive detail fetches, so every
    // listing scraped after that change was stuck unchecked and invisible.
    const startMatch = bodyText.match(
      /\n\s*(?:seller'?s\s+description|description|details)\s*\n/i,
    );
    if (!startMatch) return null;

    const from = startMatch.index + startMatch[0].length;
    const rest = bodyText.slice(from);
    const endMatch = rest.match(
      /\n\s*(?:seller information|seller details|location is approximate|message|send seller a message|similar listings|related|more like this|you might also like|sponsored)/i,
    );
    let body = (endMatch ? rest.slice(0, endMatch.index) : rest).trim();

    // A trailing "City, ST · Location is approximate" line isn't description.
    body = body.replace(/\n[^\n]*Location is approximate\s*$/i, '').trim();
    // Facebook appends its expander control to the end of a LINE, not
    // necessarily the end of the block — anchoring to end-of-string missed it.
    body = body.replace(/[ \t]*\bSee (?:less|more)\s*$/gim, '').trim();

    if (body.length < 2) return null;
    return body.slice(0, 8000);
  }

  /**
   * Read the Marketplace inbox thread list.
   *
   * READ ONLY. This navigates and reads; it never opens a thread, types, or
   * sends. Core rule 1 forbids writing to Facebook — reading your own inbox is
   * the same category as reading listings.
   *
   * Only ever reads MARKETPLACE folders. It deliberately does NOT fall back to
   * the main Messenger list: that inbox is personal correspondence, no seller
   * thread will be in it, and scanning family conversations for car sellers is
   * both useless and invasive. If no Marketplace folder yields threads, that's
   * a failure to report — not something to paper over.
   *
   * @returns {Promise<Array<{threadId,url,name,preview,unread,itemId,lines}>>}
   */
  async fetchInboxThreads({ debug = false } = {}) {
    const context = await this.ensureContext();
    const page = await context.newPage();

    const urls = [
      'https://www.facebook.com/messages/marketplace',
      'https://www.facebook.com/marketplace/inbox',
      'https://www.facebook.com/marketplace/you/buying',
    ];

    try {
      for (const url of urls) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        // The inbox hydrates well after domcontentloaded.
        await sleep(7000, 9000);
        await page.mouse.wheel(0, 500).catch(() => {});
        await sleep(2500, 4000);

        const problem = classifyPageProblem({ url: page.url(), html: await page.content() });
        if (problem) {
          throw new ScrapeProblem(problem, `Inbox blocked (${problem})`);
        }

        // Read what's showing BEFORE touching anything — a tab click that goes
        // wrong must not cost us the threads we can already see.
        const shown = await this.extractThreads(page);

        // The inbox opens on "Selling". Cars we're chasing are conversations
        // where we're the BUYER, so switch and read again, then merge.
        // Navigation only: no thread is opened, nothing is typed or sent.
        let buying = [];
        if (await this.openBuyingTab(page)) {
          buying = await this.extractThreads(page);
        }

        const merged = new Map();
        for (const t of [...shown, ...buying]) {
          const key = t.threadId ?? `${t.name}|${t.preview}`;
          if (!merged.has(key)) merged.set(key, t);
        }
        const threads = [...merged.values()];
        if (debug) {
          console.log(`  ${url} -> ${threads.length} threads`);
          if (!threads.length) {
            // Distinguish "you have no Marketplace conversations" from "the
            // selectors broke". Those need completely different fixes, and
            // guessing wrong wastes an afternoon. A screenshot settles it
            // faster than any amount of DOM archaeology.
            const probe = await page.evaluate(() => ({
              landed: location.href,
              anyThreadLinks: document.querySelectorAll('a[href*="/t/"]').length,
              roleRows: document.querySelectorAll('[role="row"],[role="listitem"],[role="gridcell"]').length,
              iframes: document.querySelectorAll('iframe').length,
              text: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
            }));
            console.log(`     landed on : ${probe.landed.slice(0, 70)}`);
            console.log(`     /t/ links=${probe.anyThreadLinks} roleRows=${probe.roleRows} iframes=${probe.iframes}`);
            console.log(`     page text : ${probe.text}`);

            mkdirSync(DEBUG_DIR, { recursive: true });
            const shot = join(DEBUG_DIR, `inbox_${url.replace(/[^a-z0-9]+/gi, '-').slice(-40)}.png`);
            await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
            console.log(`     screenshot: ${shot}`);
          }
        }
        if (threads.length) return threads;
      }
      return [];
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Thread rows, matched structurally — never by class name.
   *
   * Two strategies, because the Marketplace inbox and the Messenger list are
   * built differently: Messenger rows are anchors to /t/<id>, while the
   * Marketplace inbox renders rows with no link at all (0 anchors on a page
   * that otherwise loads fine). The second pass reads ARIA rows for that case.
   */
  async extractThreads(page) {
    // Marketplace inbox first — its rows are plain divs with no link and no
    // ARIA role, so it needs the text-shape reader. Anchors and ARIA rows are
    // fallbacks for the Messenger-style layouts.
    const byShape = await this.extractMarketplaceRows(page);
    if (byShape.length) return byShape;
    const byAnchor = await this.extractThreadAnchors(page);
    if (byAnchor.length) return byAnchor;
    return this.extractThreadRows(page);
  }

  /**
   * Switch the Marketplace inbox to the "Buying" tab.
   *
   * Navigation only — it selects a tab. Nothing is opened, typed, or sent.
   * Safe to fail: if the tab isn't found we read whatever is showing.
   */
  async openBuyingTab(page) {
    const before = page.url();

    // Scoped to a real tab. Plain text matching hits the sidebar nav link of
    // the same name, which navigates to /marketplace/you and loses the inbox
    // entirely — that cost a whole debugging round.
    // Most reliable: find the "Buying" that sits next to "Selling" — that's
    // the tab strip. Role-based locators don't match it (Facebook gives these
    // no tab role), and plain text matching hits the sidebar link instead.
    const clickedTab = await page.evaluate(() => {
      const leaves = [...document.querySelectorAll('span,div,a,button')]
        .filter((el) => (el.textContent || '').trim().toLowerCase() === 'buying'
          && el.children.length === 0);
      for (const el of leaves) {
        // Walk up a couple of levels and check a "Selling" sibling is present.
        let scope = el.parentElement;
        for (let i = 0; i < 3 && scope; i++, scope = scope.parentElement) {
          if (/selling/i.test(scope.innerText || '')) {
            el.click();
            return true;
          }
        }
      }
      return false;
    }).catch(() => false);

    if (clickedTab) {
      await sleep(3000, 4500);
      if (page.url().includes('/marketplace/inbox')) return true;
      await page.goto(before, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await sleep(5000, 7000);
      return false;
    }

    const candidates = [
      page.getByRole('tab', { name: /^buying$/i }),
      page.getByRole('button', { name: /^buying$/i }),
    ];

    for (const tab of candidates) {
      try {
        const el = tab.first();
        if (!(await el.isVisible({ timeout: 3000 }).catch(() => false))) continue;
        await el.click({ timeout: 4000 });
        await sleep(3000, 4500);

        // If it navigated away anyway, undo it — a tab switch shouldn't leave
        // the inbox.
        if (!page.url().includes('/marketplace/inbox')) {
          await page.goto(before, { waitUntil: 'domcontentloaded', timeout: 45_000 });
          await sleep(5000, 7000);
          return false;
        }
        return true;
      } catch {
        // Try the next locator shape.
      }
    }
    return false;
  }

  /**
   * Marketplace inbox rows.
   *
   * They carry no href and no role, so we find them by SHAPE instead:
   *   "<Name> · <Listing title>  <last message>  <MM/DD/YY>"
   * and take the innermost element matching it, so we get one row rather than
   * the whole list container.
   *
   * The listing title being right there is what makes matching work — it's the
   * strongest signal lib/matching.js has.
   */
  async extractMarketplaceRows(page) {
    return page.evaluate(() => {
      // Facebook stamps older threads with a date and recent ones with a clock
      // time or a relative age. Accepting only MM/DD/YY made every fresh
      // conversation invisible — which is exactly the set that matters.
      const DATE = /\b(\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}\s*[AP]M|\d+[mhdw])\b/i;
      const looksLikeRow = (text) => text.includes(' · ') && DATE.test(text);

      const all = [...document.querySelectorAll('div')].filter((el) => {
        const text = el.innerText || '';
        if (!looksLikeRow(text) || text.length > 400) return false;
        // Innermost only: skip containers that hold another row inside them.
        return ![...el.querySelectorAll('div')]
          .some((child) => looksLikeRow(child.innerText || ''));
      });

      const seen = new Set();
      const out = [];
      for (const el of all) {
        const raw = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (seen.has(raw)) continue;
        seen.add(raw);

        const [namePart, ...rest] = raw.split(' · ');
        const remainder = rest.join(' · ');
        const dateMatch = remainder.match(DATE);
        const beforeDate = dateMatch ? remainder.slice(0, dateMatch.index).trim() : remainder;

        // "<Listing title> <preview>" — the title is the run up to the point
        // the sentence changes, which we can't split reliably, so hand the
        // whole thing to the matcher as thread text and let token overlap work.
        const itemId = el.querySelector('a[href*="/marketplace/item/"]')
          ?.getAttribute('href')?.match(/\/marketplace\/item\/(\d+)/)?.[1] ?? null;

        // Unread rows are rendered bold; there's no "Unread message:" text
        // here the way there is in Messenger.
        const weight = Number.parseInt(getComputedStyle(el).fontWeight, 10) || 400;
        const boldChild = [...el.querySelectorAll('span,div')].some((c) => {
          const w = Number.parseInt(getComputedStyle(c).fontWeight, 10) || 400;
          return w >= 600 && (c.innerText || '').trim().length > 2;
        });

        out.push({
          threadId: null,
          url: 'https://www.facebook.com/marketplace/inbox',
          name: namePart.trim() || null,
          preview: beforeDate || null,
          unread: weight >= 600 || boldChild,
          itemId,
          lines: [namePart.trim(), beforeDate].filter(Boolean),
          date: dateMatch?.[0] ?? null,
        });
      }
      return out;
    });
  }

  /** Fallback: rows exposed through ARIA rather than as links. */
  async extractThreadRows(page) {
    return page.evaluate(() => {
      const rows = [...document.querySelectorAll('[role="row"], [role="listitem"], [role="gridcell"]')];
      const out = [];
      let index = 0;

      for (const row of rows) {
        const lines = (row.innerText || '')
          .split('\n').map((s) => s.trim()).filter(Boolean);
        // A thread row has a name and something else; nav items have one line.
        if (lines.length < 2) continue;

        const unreadIndex = lines.findIndex((l) => /^unread message:?$/i.test(l));
        const clean = lines.filter((l) => !/^unread message:?$/i.test(l));
        const itemId = row.querySelector('a[href*="/marketplace/item/"]')
          ?.getAttribute('href')?.match(/\/marketplace\/item\/(\d+)/)?.[1] ?? null;
        const link = row.querySelector('a[href*="/t/"]')?.getAttribute('href') ?? null;

        out.push({
          threadId: link?.match(/\/t\/(\d+)/)?.[1] ?? `row-${index++}`,
          url: link
            ? (link.startsWith('http') ? link : `https://www.facebook.com${link}`)
            : 'https://www.facebook.com/marketplace/inbox',
          name: clean[0] ?? null,
          preview: clean.slice(1).find((l) =>
            !/^·$/.test(l) && !/^\d+[hdwmy]$/.test(l)
            && !/end-to-end encryption/i.test(l)) ?? null,
          unread: unreadIndex !== -1,
          itemId,
          lines: clean.slice(0, 6),
        });
      }
      return out;
    });
  }

  /** Primary: Messenger-style rows that are links to /t/<id>. */
  async extractThreadAnchors(page) {
    return page.evaluate(() => {
      const seen = new Set();
      const out = [];

      for (const anchor of document.querySelectorAll('a[href*="/t/"]')) {
        const href = anchor.getAttribute('href') ?? '';
        const idMatch = href.match(/\/t\/(\d+)/);
        if (!idMatch) continue;
        const threadId = idMatch[1];
        if (seen.has(threadId)) continue;
        seen.add(threadId);

        const lines = (anchor.innerText || '')
          .split('\n').map((s) => s.trim()).filter(Boolean);

        // Facebook writes this literal string on unread rows — the direct
        // "they replied" signal.
        const unreadIndex = lines.findIndex((l) => /^unread message:?$/i.test(l));
        const unread = unreadIndex !== -1;
        const clean = lines.filter((l) => !/^unread message:?$/i.test(l));

        // Marketplace rows sometimes carry the item id in a nested link.
        const itemLink = anchor.querySelector('a[href*="/marketplace/item/"]')
          ?? anchor.closest('div')?.querySelector('a[href*="/marketplace/item/"]');
        const itemId = itemLink?.getAttribute('href')?.match(/\/marketplace\/item\/(\d+)/)?.[1] ?? null;

        out.push({
          threadId,
          url: href.startsWith('http') ? href : `https://www.facebook.com${href}`,
          name: clean[0] ?? null,
          // Skip the E2EE boilerplate Facebook puts where a preview would be.
          preview: clean.slice(1).find((l) =>
            !/^·$/.test(l) && !/^\d+[hdwmy]$/.test(l)
            && !/end-to-end encryption/i.test(l)) ?? null,
          unread,
          itemId,
          lines: clean.slice(0, 6),
        });
      }
      return out;
    });
  }

  async close() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.context = null;
    this.browser = null;
  }
}
