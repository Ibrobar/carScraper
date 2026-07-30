// Re-queue listings whose detail page was fetched but produced no description.
//
// Use this after fixing a detail-page extractor. Those listings have
// `detail_fetched_at` set, so the normal queue skips them forever — they'd stay
// unchecked and invisible on the dashboard no matter how many times you scrape.
//
//   npm run requeue
//
// Then run `npm run scrape` to actually refetch them.

import { openDb, requeueDetailless, countUnchecked } from '../lib/db.js';

const db = openDb();
const before = countUnchecked(db);
const changed = requeueDetailless(db);

console.log(`Re-queued ${changed} listings that had no description.`);
console.log(`Unchecked backlog: ${before} -> ${countUnchecked(db)}`);
if (changed) {
  console.log('\nRun `npm run scrape` to refetch them. At the current detail budget');
  console.log('that may take more than one run.');
}
