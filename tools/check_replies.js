// Check the Marketplace inbox for seller replies and move cards to "They
// replied".
//
// READ ONLY. Reads the thread list; never opens a thread, types, or sends.
// Core rule 1 stands — see docs/REPLIES.md.
//
// Usage:
//   npm run replies              apply
//   npm run replies:dry          report only, write nothing
//   node tools/check_replies.js --debug    dump every thread and its best match

import { config } from '../lib/config.js';
import {
  openDb, flipsAwaitingReply, linkThread, recordReply, markRepliesChecked, getFlip,
} from '../lib/db.js';
import { matchThread, sellerSpokeLast, scoreThread } from '../lib/matching.js';
import { FacebookProvider, ScrapeProblem } from '../scrapers/facebook.js';

function parseArgs(argv) {
  return {
    dry: argv.includes('--dry'),
    debug: argv.includes('--debug'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = openDb();

  const candidates = flipsAwaitingReply(db);
  if (!candidates.length) {
    console.log('No cars waiting on a seller. Nothing to check.');
    return;
  }
  console.log(`Checking ${candidates.length} car${candidates.length === 1 ? '' : 's'} waiting on a reply...`);

  const provider = new FacebookProvider();
  let threads;
  try {
    threads = await provider.fetchInboxThreads({ debug: args.debug });
  } catch (err) {
    if (err instanceof ScrapeProblem) {
      console.error(`\n${err.status}: ${err.message}`);
      if (err.status === 'login_wall') console.error('Fix: npm run login');
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await provider.close();
  }

  if (!threads.length) {
    // Same rule as the scraper: nothing parsed is a failure, not an empty
    // inbox. Reporting "no replies" when the reader is broken is the worst
    // outcome here.
    console.error('\nParsed 0 threads. That is a broken reader, not an empty inbox.');
    console.error('Run with --debug, or see docs/REPLIES.md.');
    process.exitCode = 1;
    return;
  }
  console.log(`Read ${threads.length} threads.\n`);

  // Threads already pinned to a car are matched by id — no guessing after the
  // first time.
  const byThreadId = new Map(
    candidates.filter((f) => f.thread_id).map((f) => [String(f.thread_id), f]),
  );
  const unpinned = candidates.filter((f) => !f.thread_id);

  const replied = [];
  const linked = [];
  const unmatched = [];

  for (const thread of threads) {
    let flip = byThreadId.get(String(thread.threadId)) ?? null;
    let method = 'pinned';
    let score = 1;

    if (!flip) {
      const match = matchThread(thread, unpinned);
      if (match) {
        flip = match.flip;
        method = match.method;
        score = match.score;
      }
    }

    if (args.debug) {
      const best = unpinned
        .map((f) => ({ f, ...scoreThread(thread, f) }))
        .sort((a, b) => b.score - a.score)[0];
      console.log(`  thread "${(thread.name ?? '?').slice(0, 28)}" unread=${thread.unread}`);
      console.log(`    preview: ${(thread.preview ?? '').slice(0, 60)}`);
      console.log(`    best   : ${best ? `${(best.f.title ?? '?').slice(0, 40)} (${best.score.toFixed(2)} ${best.method})` : 'none'}`);
      console.log(`    taken  : ${flip ? `${(flip.title ?? '?').slice(0, 40)} via ${method}` : 'NO MATCH'}`);
    }

    if (!flip) {
      unmatched.push(thread);
      continue;
    }

    // Marketplace rows carry no thread id — there is nothing stable to pin to,
    // so those re-match on every run. That's safe rather than fragile: the
    // matcher needs 0.55 confidence and refuses outright when two cars score
    // within 0.1 of each other. Messenger-style rows do have ids and get pinned.
    if (!flip.thread_id && thread.threadId) {
      if (!args.dry) {
        linkThread(db, flip.id, {
          threadId: thread.threadId, threadUrl: thread.url, matchedBy: method,
        });
      }
      linked.push({ flip, thread, method, score, pinned: true });
    } else if (!flip.thread_id) {
      linked.push({ flip, thread, method, score, pinned: false });
    }

    if (sellerSpokeLast(thread)) {
      if (!args.dry) recordReply(db, flip.id);
      replied.push({ flip, thread });
    }
  }

  if (!args.dry) markRepliesChecked(db, candidates.map((f) => f.id));

  console.log(`\n Threads matched to a car : ${linked.length}`);
  console.log(` Sellers who replied      : ${replied.length}`);
  console.log(` Threads not matched      : ${unmatched.length}`);

  if (replied.length) {
    console.log('\nReplies waiting on you:');
    for (const { flip, thread } of replied) {
      console.log(`  ${(flip.title ?? '?').slice(0, 45)}`);
      console.log(`     ${(thread.preview ?? '').slice(0, 70)}`);
    }
  }

  if (linked.length && args.debug) {
    console.log('\nMatches:');
    for (const { flip, method, score, pinned } of linked) {
      console.log(
        `  ${(flip.title ?? '?').slice(0, 40)} <- ${method} (${score.toFixed(2)})` +
        `${pinned ? ' [pinned]' : ' [re-matched each run — no thread id available]'}`,
      );
    }
  }

  if (unmatched.length && !args.debug) {
    console.log('\n(Unmatched threads are usually personal chats. --debug to see them.)');
  }
  if (args.dry) console.log('\nDry run — nothing was written.');
  if (!config.metros.length) console.log('');
}

main().catch((err) => {
  console.error(`\nReply check failed: ${err.stack || err.message}`);
  process.exitCode = 1;
});
