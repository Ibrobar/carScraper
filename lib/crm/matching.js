// Matching a Messenger thread back to a car on the board.
//
// This is the hard half of reply detection. Knowing "someone replied" is
// useless unless we can say WHICH car, and Facebook doesn't hand us a listing
// id on the thread row.
//
// The design that makes it tractable: match once, then pin. The first match is
// heuristic; after that the thread id is stored on the flip and every later
// check is an exact lookup. So a heuristic that's right most of the time —
// with a confidence floor so it stays quiet when unsure — is good enough.
//
// Pure logic, no I/O. See docs/REPLIES.md.

/** Below this we refuse to guess. A wrong match moves the wrong car. */
export const MIN_CONFIDENCE = 0.55;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'for', 'sale', 'and', 'with', 'in', 'on', 'of', 'to',
  'car', 'truck', 'suv', 'van', 'sedan', 'coupe', 'pickup', 'vehicle',
  'clean', 'title', 'runs', 'good', 'great', 'nice', 'low', 'miles',
  'venta', 'vendo', 'carro', 'troca', 'camioneta',
]);

/** Lowercase, strip accents and punctuation, drop noise words. */
export function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
}

/**
 * Overlap between two token sets, scaled by the smaller set.
 *
 * Scaled by the smaller side on purpose: a thread preview is short and a
 * listing title is long, and dividing by the union would punish every match
 * for that mismatch in length.
 */
export function tokenOverlap(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

/** A year in the thread text that also appears on the car is a strong signal. */
function yearOf(text) {
  const match = String(text ?? '').match(/\b(19[6-9]\d|20[0-4]\d)\b/);
  return match ? match[1] : null;
}

/**
 * Score one thread against one candidate flip.
 *
 * @returns {{ score: number, method: string }}
 */
export function scoreThread(thread, flip) {
  // 1. The listing id, if Facebook put one on the thread. Unambiguous.
  if (thread.itemId && flip.fb_id && String(thread.itemId) === String(flip.fb_id)) {
    return { score: 1, method: 'listing_id' };
  }

  const threadText = [thread.name, thread.preview, ...(thread.lines ?? [])]
    .filter(Boolean).join(' ');
  const threadTokens = tokenize(threadText);

  // 2. Seller name. Exact, and only trustworthy because cleanSellerName()
  //    refuses to store page headings as names.
  if (flip.seller_name && thread.name) {
    const a = tokenize(flip.seller_name);
    const b = tokenize(thread.name);
    if (a.length && tokenOverlap(a, b) === 1) {
      return { score: 0.95, method: 'seller_name' };
    }
  }

  // 3. Title overlap — the workhorse, since Marketplace threads carry the
  //    item title and seller names are mostly missing.
  const titleTokens = tokenize(flip.title);
  let score = tokenOverlap(titleTokens, threadTokens);
  let method = 'title';

  // A matching year is worth a lot on car listings; a contradicting one is
  // near-fatal, because "2007 Accord" and "2012 Accord" otherwise look alike.
  const flipYear = flip.year ? String(flip.year) : yearOf(flip.title);
  const threadYear = yearOf(threadText);
  if (flipYear && threadYear) {
    if (flipYear === threadYear) { score = Math.min(1, score + 0.25); method = 'title+year'; }
    else score *= 0.4;
  }

  return { score, method };
}

/**
 * Best candidate for a thread, or null when nothing is convincing.
 *
 * Refuses on a tie: two cars scoring the same means we can't tell them apart,
 * and picking one at random moves the wrong car through the pipeline.
 *
 * @returns {{ flip: object, score: number, method: string }|null}
 */
export function matchThread(thread, candidates, { minConfidence = MIN_CONFIDENCE } = {}) {
  const scored = candidates
    .map((flip) => ({ flip, ...scoreThread(thread, flip) }))
    .filter((row) => row.score >= minConfidence)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;
  if (scored.length > 1 && scored[0].score - scored[1].score < 0.1) {
    return null; // too close to call
  }
  return scored[0];
}

/**
 * Did the seller write the most recent message?
 *
 * Facebook renders "Unread message:" on the thread row, which is the direct
 * signal. Failing that, its own previews prefix your messages with "You: ", so
 * a preview without that prefix came from them.
 */
export function sellerSpokeLast(thread) {
  // Unread is the only signal that means "they wrote and you haven't seen it".
  if (thread.unread) return true;

  // Messenger prefixes your own messages with "You: ", so its absence used to
  // be treated as evidence the seller spoke. The MARKETPLACE inbox has no such
  // prefix — a real thread showed the preview "yes I am but my budget is 2000",
  // which is Ibrahim's own message. Treating that as a reply would move cars to
  // "They replied" purely because he was the last to speak.
  const preview = String(thread.preview ?? '').trim();
  if (/^(you|tú|tu)\s*:/i.test(preview)) return false;

  // Otherwise: can't tell. Say no. A missed reply costs a glance at the inbox;
  // a false one tells you a seller is waiting when they aren't.
  return false;
}
