// Diagnostic: does the Marketplace search payload carry coordinates?
//
// If it does we can filter by real distance instead of trusting Facebook's
// radius, which it demonstrably ignores. READ ONLY, one page load.
//
//   node tools/probe_search.js [citySlug]

import { FacebookProvider } from '../scrapers/facebook.js';
import { buildSearchUrl, sleep } from '../scrapers/base.js';

const city = process.argv[2] ?? 'dallas';
const provider = new FacebookProvider();

try {
  const context = await provider.ensureContext();
  const page = await context.newPage();
  const url = buildSearchUrl(city);
  console.log(`Loading ${url}\n`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(7000, 9000);

  const html = await page.content();

  for (const [label, re] of [
    ['"latitude":<num>', /"latitude"\s*:\s*(-?\d+\.\d+)/g],
    ['"longitude":<num>', /"longitude"\s*:\s*(-?\d+\.\d+)/g],
    ['lat/lng short form', /"lat"\s*:\s*(-?\d+\.\d+)/g],
    ['reverse_geocode', /"reverse_geocode[^"]*"\s*:\s*\{[^}]{0,160}/g],
    ['city name field', /"city"\s*:\s*"([^"]{2,40})"/g],
  ]) {
    const hits = [...html.matchAll(re)].slice(0, 5).map((m) => m[1] ?? m[0]);
    const total = [...html.matchAll(re)].length;
    console.log(`${label.padEnd(22)} matches=${String(total).padStart(4)}  e.g. ${JSON.stringify(hits.slice(0, 3))}`);
  }

  // Does a coordinate sit near a listing id? That's what makes it usable.
  const near = html.match(/"id"\s*:\s*"(\d{10,})"[\s\S]{0,600}?"latitude"\s*:\s*(-?\d+\.\d+)[\s\S]{0,80}?"longitude"\s*:\s*(-?\d+\.\d+)/);
  console.log('\nlisting id adjacent to coordinates:',
    near ? `YES  id=${near[1]} lat=${near[2]} lng=${near[3]}` : 'no');

  await page.close();
} finally {
  await provider.close();
}
