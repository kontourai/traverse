---
status: current
subject: Exact occurrence resolution
decided: 2026-07-20
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/64
  - kind: doc
    ref: tests/occurrence-resolver.test.ts
---

# Exact occurrence resolution

## Decision

Traverse resolves provenance locators from exact excerpt matches in the
provider-visible prepared-text slice. It also enumerates the complete prepared
artifact to assign stable global occurrence indices and counts, but
`chars:<start>-<end>` is assigned only to a match inside the originating slice.

A provider can supply `occurrenceHint`, a one-based hint on a proposal. It is
untrusted and local to that provider-visible slice: Traverse uses it only if it
is an integer within the slice's exact-match count, then maps the selected span
to its global occurrence metadata. An absent, malformed, zero, or out-of-range
hint follows bounded source-order allocation among visible matches instead.
Allocation is performed after provider work
has been folded by original chunk and proposal order, so replay, batching, and
concurrency cannot change the result.

Every retained proposal exposes `provenance.occurrence` with the resolver
version, full exact-match count, selected index/span, selection mode, hint use,
and ambiguity. More than one exact span is an ambiguity signal for a reviewer;
it does not claim that any source occurrence is true.

Deduplication occurs after resolution and collapses only matching field path,
path indices, canonical candidate value, and selected span. This preserves both
different fields grounded by one span and the same value grounded by distinct
spans.

## Boundaries

- Exact occurrence resolution grounds excerpts, not candidate values and not
  review decisions.
- Fuzzy, semantic, normalized, translated, and paraphrased matching may be
  used by a caller as diagnostic information, but never creates a `chars:`
  locator in Traverse.
- A valid hint selects an existing exact match; it cannot manufacture a span or
  bypass excerpt verification against provider-visible prepared content.
- Overlap windows can propose the same visible span more than once; they dedupe
  at that span and never consume an unseen occurrence elsewhere in full text.
