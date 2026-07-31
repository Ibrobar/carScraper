// Rescue cars that were marked Interested but never got onto the Flips board.
//
// A listing with status `interested` and no flip row is invisible everywhere:
// the sticky status keeps it off the listings page, and with no flip it isn't
// on the board either. That happened for real while the CRM lived on its own
// branch — the dashboard set the status but had no CRM to hand the car to, so
// clicking Interested looked like the car just vanished.
//
//   npm run backfill:flips          fix them
//   npm run backfill:flips:dry      show what would change, write nothing
//
// Safe to run any time. It only touches listings that have no flip.

import { openDb, closeDb } from '../lib/db.js';
import { backfillMissingFlips } from '../lib/crm/db.js';
import { formatMoney } from '../lib/offers.js';

const dryRun = process.argv.includes('--dry');
const db = openDb();

const opened = backfillMissingFlips(db, { dryRun });

if (!opened.length) {
  console.log('Nothing stranded — every Interested car is on the board.');
} else {
  console.log(
    dryRun
      ? `${opened.length} car(s) marked Interested are NOT on the board:`
      : `Put ${opened.length} car(s) back on the board:`,
  );
  for (const car of opened) {
    const price = car.priceCents ? formatMoney(car.priceCents) : '—';
    console.log(`  ${price.padStart(7)}  ${car.title ?? '(untitled)'}`);
    console.log(`           https://www.facebook.com/marketplace/item/${car.fbId}/`);
  }
  if (dryRun) console.log('\nDry run — nothing written. Re-run without --dry to fix.');
  else console.log('\nThey are at http://localhost:5174/crm under "Chasing".');
}

closeDb();
