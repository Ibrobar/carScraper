# Reply detection — moving a card to "They replied"

Reads the Marketplace inbox, works out which car each thread belongs to, and moves that card from
`contacted` to `replied`.

```
npm run replies          apply
npm run replies:dry      report only, write nothing
npm run replies:debug    dry run + dump every thread and its best match
```

Code: `lib/matching.js` (pure matching), `FacebookProvider.fetchInboxThreads()` (reading),
`tools/check_replies.js` (the loop).

## This is a read, and only a read

It navigates the inbox and reads the thread list. It never opens a thread, types, or sends. Core
rule 1 in `CLAUDE.md` forbids *writing* to Facebook; reading your own inbox is the same category as
reading listings.

**It also never reads the personal Messenger inbox.** An early version fell back to
`/messages/t/` when the Marketplace folder came up empty, and ended up scanning years of family
conversations looking for car sellers. That fallback is gone: only Marketplace folders are read, and
if none of them yield threads that's reported as a failure rather than papered over.

## Matching, and why re-matching is fine

The hard part isn't detecting a reply, it's knowing **which car** replied.

**Marketplace inbox rows carry no thread id at all** — no `href`, no stable identifier, nothing to
store. So those re-match on every run rather than being pinned. That turned out to be fine: rows
include the listing title, which scores 1.00 against the right car, and the matcher refuses anything
ambiguous. Messenger-style rows *do* have ids and are pinned to the flip (`flips.thread_id`) so later
checks are an exact lookup.

Don't invent a synthetic id from the row text to fake pinning — the preview changes every time a
message arrives, so any key built from it drifts and silently stops matching.

## How a thread is scored

`scoreThread()` tries, in order of trustworthiness:

| Signal | Score | Notes |
|---|---|---|
| Listing id on the thread | 1.0 | Unambiguous, when Facebook provides it |
| Seller name matches exactly | 0.95 | Only trustworthy because `cleanSellerName()` refuses to store page headings as names |
| Title token overlap | 0–1 | The workhorse — Marketplace threads carry the item title |
| Matching year | +0.25 | Strong on cars |
| **Contradicting year** | **×0.4** | "2007 Accord" and "2012 Accord" otherwise look identical |

Stopwords (`for`, `sale`, `clean`, `title`, `runs`, plus Spanish equivalents) are dropped before
comparison — they appear in every listing and match everything.

### It refuses more readily than it guesses

The cost is lopsided. Refusing a match costs one manual click. A **wrong** match silently moves the
wrong car through your pipeline and tells you a seller replied when they didn't.

So `matchThread()`:

- requires `MIN_CONFIDENCE` (0.55) before matching at all, and
- **refuses on a tie** — if the top two candidates are within 0.1 of each other, it returns null.
  Two cars it can't tell apart means picking either one is a coin flip.

Verified against the real inbox: given 19 personal conversations and 3 cars on the board, it matched
**none of them**. That's the correct answer, and it's the property that matters most.

### Is it a reply, or just my own message?

**Unread is the signal.** Marketplace rows are rendered bold when unread; Messenger writes the
literal string `"Unread message:"`. Either one means they wrote and you haven't seen it.

An earlier version also treated "the preview doesn't start with `You:`" as evidence the seller spoke.
**That was wrong for the Marketplace inbox, which has no such prefix.** A real thread previewed
*"yes I am but my budget is 2000"* — Ibrahim's own message — and the rule would have flagged the car
as waiting on him purely because he spoke last.

Now it only says "replied" on unread. Everything else returns false. A missed reply costs a glance at
the inbox; a false one tells you a seller is waiting when they aren't, which is the mistake that
actually wastes your time.

**Consequence worth knowing:** if you read a seller's reply in Facebook first, the thread is no
longer unread and this won't flag it. Check the board before the app.

## Reading the inbox — the part that took the longest

`/marketplace/inbox` is the only route that works. `/messages/marketplace` returns "This content
isn't available right now", and `/marketplace/you/buying` redirects to the Marketplace home page.

Three things had to be right at once, and each one silently produced an empty result:

**1. Rows are plain divs.** No `href`, no ARIA role. The anchor-based and role-based readers both
returned zero on a page that was rendering conversations perfectly well. They're found by *shape*
instead — the innermost element whose text looks like `"<Name> · <Listing title>  <message>  <time>"`.

**2. The inbox opens on "Selling".** Every car you're chasing is a conversation where you're the
*buyer*, so it has to switch tabs. Clicking by text hits the **sidebar nav link** of the same name,
which navigates to `/marketplace/you` and loses the inbox; role-based locators don't match because
Facebook gives these no tab role. `openBuyingTab()` finds the "Buying" that has a "Selling" sibling,
and navigates back if the click escapes the inbox anyway.

**3. Recent threads are stamped with a time, not a date.** Accepting only `MM/DD/YY` made every
fresh conversation invisible — exactly the ones that matter. The row detector now takes `12:12 AM`
and `3h` too.

Reading happens **before** the tab switch and again after, then merges: a tab click that goes wrong
must not cost the threads already on screen.

**Zero threads parsed is treated as a failure**, not an empty inbox — same rule as the scraper. A
reply checker that silently reports "no replies" while broken is worse than one that errors. When it
does fail, `--debug` dumps where it landed, the link/role/iframe counts, 1500 characters of page
text, and a screenshot to `data/debug/` — that combination is what finally exposed all three bugs
above.

## Verified against real conversations

Both live Marketplace threads matched their cars at **1.00 confidence** via `title+year`, with zero
unmatched and zero false positives. Neither was flagged as a reply, correctly — Ibrahim had spoken
last in both.
