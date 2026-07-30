// Save a Facebook session for the scraper to reuse.
//
// You log in BY HAND in the window this opens. That's deliberate, not laziness:
// no password is ever stored (nothing to leak), 2FA and checkpoints just work
// because a human is there, and a scripted password login is one of the
// strongest bot signals Facebook has. See docs/SCRAPER.md -> Authentication.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { SESSION_PATH } from '../lib/config.js';

async function main() {
  console.log('Opening a browser window.\n');
  console.log('  1. Log into Facebook.');
  console.log('  2. Finish any 2FA or checkpoint it shows you.');
  console.log('  3. Browse to Marketplace once so the session is fully established.');
  console.log('  4. Come back here and press Enter.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/Chicago',
  });
  const page = await context.newPage();
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });

  const rl = createInterface({ input: stdin, output: stdout });
  await rl.question('Press Enter once you are logged in... ');
  rl.close();

  mkdirSync(dirname(SESSION_PATH), { recursive: true });
  await context.storageState({ path: SESSION_PATH });
  await browser.close();

  console.log(`\nSession saved to ${SESSION_PATH}`);
  console.log('That file is effectively a password. It is gitignored — keep it that way.');
  console.log('\nNext: npm run scrape');
}

main().catch((err) => {
  console.error(`\nLogin failed: ${err.message}`);
  process.exitCode = 1;
});
