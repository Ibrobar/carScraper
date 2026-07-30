// Thread-to-car matching. The cost asymmetry here is sharp: refusing to match
// costs one manual click, while a WRONG match silently moves the wrong car
// through the pipeline and tells you a seller replied when they didn't.
// Everything below is biased toward refusing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, tokenOverlap, scoreThread, matchThread, sellerSpokeLast, MIN_CONFIDENCE,
} from '../lib/matching.js';

const flip = (over = {}) => ({
  id: 1, fb_id: '111', title: '2007 Honda Accord · DX Sedan 4D',
  year: 2007, seller_name: null, ...over,
});
const thread = (over = {}) => ({
  threadId: 't1', name: 'Maria Gonzalez', preview: null, unread: false,
  itemId: null, lines: [], ...over,
});

describe('tokenize', () => {
  test('drops noise words that match everything', () => {
    const tokens = tokenize('2007 Honda Accord for sale clean title runs great');
    assert.ok(tokens.includes('honda'));
    assert.ok(tokens.includes('accord'));
    assert.ok(!tokens.includes('sale'));
    assert.ok(!tokens.includes('clean'));
  });

  test('folds accents so Spanish titles match', () => {
    assert.deepEqual(tokenize('Camión'), ['camion']);
  });

  test('is safe on empty input', () => {
    assert.deepEqual(tokenize(null), []);
  });
});

describe('tokenOverlap', () => {
  test('scales by the smaller set, so a short preview can still match', () => {
    assert.equal(tokenOverlap(['honda', 'accord'], ['honda', 'accord', 'sedan', 'silver']), 1);
  });

  test('no shared tokens is zero', () => {
    assert.equal(tokenOverlap(['honda'], ['ford']), 0);
  });

  test('empty is zero, not NaN', () => {
    assert.equal(tokenOverlap([], ['honda']), 0);
  });
});

describe('scoreThread', () => {
  test('a listing id on the thread is conclusive', () => {
    const result = scoreThread(thread({ itemId: '111' }), flip());
    assert.equal(result.score, 1);
    assert.equal(result.method, 'listing_id');
  });

  test('a matching seller name scores very high', () => {
    const result = scoreThread(
      thread({ name: 'Maria Gonzalez' }),
      flip({ seller_name: 'Maria Gonzalez' }),
    );
    assert.ok(result.score >= 0.9);
    assert.equal(result.method, 'seller_name');
  });

  test('the title in the thread text carries the match', () => {
    const result = scoreThread(
      thread({ preview: 'Is the 2007 Honda Accord still available?' }),
      flip(),
    );
    assert.ok(result.score >= MIN_CONFIDENCE, `scored ${result.score}`);
  });

  test('a matching year strengthens it', () => {
    const withYear = scoreThread(thread({ preview: '2007 Honda Accord?' }), flip());
    const without = scoreThread(thread({ preview: 'Honda Accord?' }), flip());
    assert.ok(withYear.score > without.score);
  });

  test('a contradicting year nearly kills it', () => {
    // "2007 Accord" and "2012 Accord" otherwise look identical.
    const result = scoreThread(thread({ preview: 'the 2012 Honda Accord' }), flip());
    assert.ok(result.score < MIN_CONFIDENCE, `scored ${result.score}, should be rejected`);
  });

  test('an unrelated thread scores near zero', () => {
    const result = scoreThread(
      thread({ name: 'Mom', preview: 'call me when you get a chance' }),
      flip(),
    );
    assert.ok(result.score < 0.2, `scored ${result.score}`);
  });
});

describe('matchThread', () => {
  const accord07 = flip({ id: 1, title: '2007 Honda Accord DX Sedan', year: 2007 });
  const accord12 = flip({ id: 2, fb_id: '222', title: '2012 Honda Accord EX', year: 2012 });
  const ram = flip({ id: 3, fb_id: '333', title: '2003 Dodge Ram 1500', year: 2003 });

  test('picks the right car among similar ones', () => {
    const match = matchThread(
      thread({ preview: 'still have the 2012 Honda Accord?' }),
      [accord07, accord12, ram],
    );
    assert.equal(match?.flip.id, 2);
  });

  test('refuses when two cars are too close to call', () => {
    // Two identical titles: picking one would move the wrong car.
    const twinA = flip({ id: 10, fb_id: 'a', title: '2007 Honda Accord' });
    const twinB = flip({ id: 11, fb_id: 'b', title: '2007 Honda Accord' });
    assert.equal(matchThread(thread({ preview: '2007 Honda Accord' }), [twinA, twinB]), null);
  });

  test('refuses a personal chat rather than forcing a match', () => {
    assert.equal(
      matchThread(thread({ name: 'Talat', preview: 'happy birthday' }), [accord07, ram]),
      null,
    );
  });

  test('an empty candidate list is not an error', () => {
    assert.equal(matchThread(thread(), []), null);
  });

  test('a listing id wins over everything', () => {
    const match = matchThread(
      thread({ itemId: '333', preview: 'about the Honda Accord' }),
      [accord07, ram],
    );
    assert.equal(match?.flip.id, 3);
    assert.equal(match?.method, 'listing_id');
  });
});

describe('sellerSpokeLast', () => {
  test('unread means they wrote', () => {
    assert.equal(sellerSpokeLast(thread({ unread: true })), true);
  });

  test('a preview prefixed "You:" means you wrote last', () => {
    assert.equal(sellerSpokeLast(thread({ preview: 'You: is this still available?' })), false);
  });

  test('a read thread is not a reply, whatever the preview says', () => {
    // The Marketplace inbox does NOT prefix your own messages with "You:".
    // A real thread previewed "yes I am but my budget is 2000" — that's
    // Ibrahim's own message. Calling it a reply would flag cars as waiting on
    // him purely because he spoke last.
    assert.equal(sellerSpokeLast(thread({ preview: 'yes I am but my budget is 2000' })), false);
    assert.equal(sellerSpokeLast(thread({ preview: 'yes it is, come by today' })), false);
  });

  test('unread beats everything', () => {
    assert.equal(
      sellerSpokeLast(thread({ unread: true, preview: 'You: still available?' })),
      true,
    );
  });

  test('no preview and not unread is not a reply', () => {
    assert.equal(sellerSpokeLast(thread({ preview: null })), false);
  });
});
