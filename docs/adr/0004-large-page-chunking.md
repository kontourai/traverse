# ADR 0004 - Large-page extraction: markdown prep + structural chunking

Status: Accepted (2026-07-03). Shipped in 0.5.0.

## 1 Context

A pilot consumer ran Traverse against large listing pages and hit two failure
modes, both traceable to the Slice-1 content-prep (regex HTML -> flat text,
truncated to `maxContentChars`):

- A real ~2.7MB listing snapshot yielded far fewer records than the consumer's
  legacy selectors found: the flat-text prep plus the 32k truncation cut the
  listing off partway, so most cards never reached the provider at all.
- Application/detail URLs were lost because the regex text stripper discards
  `href` attributes along with the tags - the link text survived but the link
  did not.

Two orthogonal fixes are needed: a denser, structure-preserving prep so a page
carries more signal per character AND keeps links, and a way to feed a page that
is genuinely larger than one provider call to the provider in pieces without
breaking Traverse's provenance invariant (every proposal's `excerpt` must occur
verbatim in the prepared text, and its `locator` is `chars:<start>-<end>` into
the FULL prepared text - ADR 0001 section 4).

## 2 Decisions

### D1 - Markdown is the default prep for HTML (Turndown)

`prepareContent`/`extract()` convert HTML to Markdown by default, preserving
links (`[text](href)`), headings, and lists. `prep: "text"` is retained as an
escape hatch to the legacy regex strip. This is a behavior change (see section 4).

Converter: **turndown 7.2.4** (MIT, last published 2026-04-03). It is the
reference-quality HTML->Markdown converter, actively maintained again, with the
link/heading/list fidelity this feature is about. It carries one transitive dep
(`@mixmark-io/domino`, a maintained DOM fork) and needs `@types/turndown` (dev
only). We evaluated `node-html-markdown` (TS-native, lighter) but chose turndown
for output fidelity on messy real-world HTML and because its Turndown/domino
parser handles both full documents and bare fragments (the latter matters:
linkedom mangles bodyless fragments - see D2/impl note).

### D2 - Structural chunking on repeated-card boundaries (linkedom)

For HTML in markdown mode, we parse the DOM, prune chrome
(script/style/noscript/nav/header/footer/aside/form/iframe/svg/template/head),
and detect the element with the largest run of same-signature (tag + sorted
class list) direct-child elements - the repeated "cards" of a listing. Chunk
boundaries are cut ON card boundaries so a card is never split. When no repeated
structure is found (or for text / `prep:"text"`), a character-window fallback
slides a `chunkSize` window with `chunkOverlap` so a value straddling a boundary
still appears whole in an adjacent window.

DOM parser: **linkedom 0.18.12** (ISC). Chosen over cheerio 1.2.0 because:

- cheerio drags in **undici v7** (a full HTTP client, for its `fromURL` helper)
  plus ~10 other deps - all irrelevant to us; linkedom does not.
- linkedom is ESM-native with bundled types and a **standard DOM API**
  (`children`, `classList`, `querySelectorAll`, `remove`, `contains`), which is
  exactly the shape repeated-sibling detection wants.

Impl note: linkedom does not do full HTML tree construction for a bodyless
fragment (it hoists the first element to `documentElement` and leaves `body`
empty). We only rely on linkedom for real fetched pages (which have a body); the
whole-page/fragment fallback hands the raw string to Turndown, whose own parser
is fragment-correct.

### D3 - Offset-correct provenance across chunks (the invariant is sacred)

Chunking is HAND-ROLLED, not delegated to a third-party text splitter, precisely
to preserve the provenance invariant. `prepareAndChunk` produces a single
`fullText` and a list of chunks that are EXACT contiguous substrings of it, each
carrying its true `start` offset. `extract()` calls the provider per chunk, then:

1. verifies the proposal's `excerpt` occurs in the chunk text the provider saw
   (`chunkContent.indexOf`),
2. shifts the offset into the full text (`globalIndex = chunk.start + localIndex`),
3. re-verifies `fullText.slice(globalIndex, globalIndex + len) === excerpt`
   before trusting it, and
4. sets `locator = "chars:<globalIndex>-<globalIndex+len>"`.

Anchoring to the chunk (not `fullText.indexOf`) keeps a value that repeats across
cards pinned to the specific card it was drawn from. A normalizing splitter that
trims/reflows text would break step 3, which is why we build `fullText` and the
offsets together and never mutate a chunk afterward.

### D4 - Cross-chunk dedup

Overlap windows and a span landing in two chunks can produce the same proposal
more than once. A duplicate is the SAME field extracted from the SAME verified
source span, so proposals are deduped by `fieldPath` + `pathIndices` + `locator`
(the `chars:<start>-<end>` span into `fullText`), keeping the highest confidence;
the count dropped is reported in `warnings`.

Keying on the verified span (not the value) is deliberate: two genuinely
distinct records that merely share a value - e.g. two listing cards with the same
price - come from different spans and MUST both survive. An earlier draft keyed
on value alone, which could silently collapse such records (including on
single-chunk pages); the span key fixes that while still collapsing the true
overlap/duplicate-span cases (which resolve to an identical offset by
construction). See 0.5.1.

### D5 - Per-chunk provider errors -> partial results

Providers are called SEQUENTIALLY (rate-limit friendly; concurrency is future
work). A provider error on one chunk is recorded as a warning and the remaining
chunks still run. Only if EVERY chunk's call fails does `extract()` surface a
`result.error` - preserving the single-shot contract for the common 1-chunk case
(a lone page whose only call throws is still an error, not an empty success).

### D6 - `maxContentChars` is the per-chunk provider budget; new options

`maxContentChars` (default 32_000) is redefined as the PER-CHUNK provider
content budget: each chunk handed to the provider is truncated to it. In the
common single-chunk case this is identical to the pre-0.5.0 whole-text
truncation. New `extract()` options, with defaults chosen for extraction quality
vs. call count: `chunkSize` (12_000), `chunkOverlap` (200), `maxChunks` (40,
extras dropped with a warning). `prep` selects `"markdown"` (html default) or
`"text"`.

### D7 - Why NOT @mozilla/readability

Readability is built to extract the ONE main article from a page and explicitly
strips repeated sibling blocks as boilerplate - which is exactly what listing
cards are. On a listing page it would discard the very content we need. It solves
the opposite problem (article view, not enumerate-the-list) and is rejected here.

## 3 Library evaluation

| Concern | Pick | Alt considered | Why the pick |
| --- | --- | --- | --- |
| HTML -> Markdown | turndown 7.2.4 (MIT, 2026-04) | node-html-markdown 2.0.0 | fidelity on messy HTML; fragment-safe parser; actively maintained; 1 transitive dep |
| DOM for chunking | linkedom 0.18.12 (ISC, 2025-08) | cheerio 1.2.0 | avoids cheerio's undici v7 + ~10 deps; ESM + bundled types; standard DOM API |
| Article extraction | (rejected) | @mozilla/readability | strips repeated sibling blocks = listing cards |

Runtime `dependencies` go from 0 to 2 (`turndown`, `linkedom`); `@types/turndown`
is dev-only. The Anthropic adapter stays behind its subpath; core still has no AI
dep.

## 4 Consequences

- BEHAVIOR CHANGE (breaking-ish): HTML content now prepares as Markdown by
  default, so `provenance.excerpt`/`locator` values are anchored to Markdown, not
  flat text. Consumers that pinned to the old flat-text output should pass
  `prep: "text"` (or re-baseline). Downstream consumers bump deliberately.
- Traverse gains its first 2 runtime dependencies, justified by the parity gap
  above.
- Concurrency of per-chunk provider calls is intentionally deferred (sequential
  is rate-limit friendly); noted as future work.

## 5 Local validation

Against the real ~2.7MB listing snapshot (provider stubbed, chunker only):

- 2,728,569 raw HTML chars collapse to 23,075 chars of dense Markdown after
  prune + convert (the bulk of the 2.7MB was scripts/inline data, correctly
  pruned).
- Structural detection found **72 repeated cards** (vs. the legacy selectors'
  23 - higher recall, the point of the change), stable across chunk sizes.
- Chunk counts scale as expected: `chunkSize` 12_000 -> 2 chunks, 6_000 -> 4,
  3_000 -> 8; every chunk verified an exact contiguous substring of `fullText`
  with contiguous offsets, `truncatedChunks` 0.
- `prep: "text"` on the same page produces flat text with no detected structure,
  confirming the escape hatch.
