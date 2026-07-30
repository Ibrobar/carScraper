// Diagnostic: dump the text of one listing detail page so we can see where the
// description actually lives. READ ONLY, one page load.
//
//   node tools/probe_detail.js            picks a pending listing
//   node tools/probe_detail.js <fb_id>    a specific one
//
// Temporary-ish tooling, but kept: description extraction has broken twice now
// and this is how you see the page instead of guessing at it.

import { openDb } from '../lib/db.js';
import { FacebookProvider } from '../scrapers/facebook.js';
import { itemUrl, sleep } from '../scrapers/base.js';

const db = openDb();
const argId = process.argv[2];

const row = argId
  ? db.prepare('SELECT * FROM listings WHERE fb_id = ?').get(argId)
  : db.prepare(
      "SELECT * FROM listings WHERE status='pending_detail' AND description IS NULL ORDER BY first_seen_at DESC LIMIT 1",
    ).get();

if (!row) {
  console.log('No listing to probe.');
  process.exit(0);
}
console.log(`Probing ${row.fb_id}: ${(row.title ?? '').slice(0, 60)}\n`);

const provider = new FacebookProvider();
try {
  const context = await provider.ensureContext();
  const page = await context.newPage();
  await page.goto(itemUrl(row.fb_id), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(3500, 5000);

  // Expand the description if Facebook collapsed it.
  const seeMore = page.getByText(/see more/i).first();
  if (await seeMore.isVisible({ timeout: 3000 }).catch(() => false)) {
    await seeMore.click().catch(() => {});
    await sleep(800, 1400);
  }

  const bodyText = await page.evaluate(() => document.body.innerText || '');
  const lines = bodyText.split('\n').map((s) => s.trim());

  console.log('--- lines 0..70, numbered (looking for the description heading) ---');
  lines.slice(0, 70).forEach((l, i) => {
    if (l) console.log(`${String(i).padStart(3)} | ${l.slice(0, 110)}`);
  });

  console.log('\n--- any line that looks like a heading we might anchor on ---');
  lines.forEach((l, i) => {
    if (/^(description|details|about this vehicle|seller information|seller details|condition)$/i.test(l)) {
      console.log(`  line ${i}: "${l}"  ->  next: "${(lines[i + 1] ?? '').slice(0, 80)}"`);
    }
  });

  console.log('\n--- longest lines (the description is usually among them) ---');
  [...lines.entries()]
    .filter(([, l]) => l.length > 80)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 5)
    .forEach(([i, l]) => console.log(`  line ${i} (${l.length} chars): ${l.slice(0, 130)}`));

  await page.close();
} finally {
  await provider.close();
}
