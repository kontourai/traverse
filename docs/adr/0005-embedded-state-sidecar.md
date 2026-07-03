# ADR 0005 - Embedded-state extraction: structured sidecar + JS-shell warning

Status: Accepted (2026-07-02). Shipped in 0.6.0.

## 1 Context

Many activity/listing pages are JS-rendered: the HTML the fetcher receives is a
shell whose visible DOM is nearly empty, with the real record living in
machine-readable state the browser would hydrate. Two shapes are common and
near-perfect precision without an LLM:

- `<script type="application/ld+json">` schema.org markup (Event / Course /
  Product), and
- framework state blobs: Next.js `<script id="__NEXT_DATA__">` and generic
  `window.__INITIAL_STATE__` / `__PRELOADED_STATE__` hydration payloads.

Traverse's prep layer STRIPS every `<script>` before it builds the prepared text
(ADR 0004), so this state is thrown away today: a shell page yields little or
nothing, and even a content page loses its high-precision JSON-LD.

Two features close that gap, both at the prep layer so Traverse stays
fetch-agnostic (it never renders):

1. harvest the embedded state so a caller can use it, and
2. warn, machine-actionably, when a page looks like an un-rendered shell so a
   downstream pipeline can retry with a browser render.

Issue #11 left one design question open: surface embedded state as **pre-verified
proposals** (provenance = the script tag's char range) or as a **structured
sidecar**.

## 2 Decision

### D1 - Structured sidecar, NOT proposals (the provenance invariant decides it)

Embedded state is surfaced as a parsed `EmbeddedState` sidecar
(`{ jsonLd: unknown[]; nextData?; initialState? }`) on the prep/extract result —
NOT as `ExtractionProposal`s.

This is forced by the provenance invariant (ADR 0001 §4, ADR 0004 D3), which is
sacred: every proposal's `excerpt` MUST occur verbatim in the FULL prepared text,
and `extract()` derives `locator = "chars:<start>-<end>"` as offsets into that
prepared text, re-verifying with `indexOf`. Embedded state comes from `<script>`
blocks that prep strips, so it is NOT in the prepared text. A JSON-LD-derived
proposal would therefore be dropped by the very normalizer that enforces the
contract. Making it survive would require one of:

- injecting the JSON-LD text back into the prepared text (pollutes the text the
  provider sees and every downstream offset), or
- a second locator scheme anchored to raw-HTML offsets (forks the one invariant
  `extract()` guarantees — a consumer could no longer trust that a `chars:`
  locator always indexes the prepared text).

Both damage the property that makes a proposal trustworthy. The issue's own
suggestion ("provenance = the script tag's char range") is exactly the raw-HTML
offset scheme we reject: those offsets index the original document, not the
prepared text every other locator is anchored to.

The sidecar sidesteps this cleanly: it is honest about being derived from a
different source (the raw markup, not the prepared text), it carries no false
`chars:` provenance, and it keeps domain mapping (JSON-LD Event/Course/Product ->
caller field names) where it belongs — with the caller, who owns ALL field
vocabulary (Traverse defines zero field names; see src/types.ts and ADR 0001).
A future slice can add opt-in, honestly-scoped `embedded`-provenance proposals if
a caller wants them, but that is additive and not built here.

### D2 - Harvesting runs BEFORE shell classification

`prepareAndChunk` (and `prepareContent`) harvest embedded state from the raw HTML
first, then classify the shell. A shell page carrying rich `__NEXT_DATA__` is
extractable from the sidecar WITHOUT a render — that is the whole win — so the
warning is downgraded in that case (D3).

The sidecar is harvested ONCE from the whole page and attached to the top-level
result, so it is never duplicated across chunks. It is also attached even when
every provider call fails (it is prep-derived, not provider-derived), so a shell
page stays extractable from the sidecar on a total provider outage.

### D3 - JS-shell detection: absolute-floor-gated heuristic, machine-actionable warning

`detectJsShell` flags a page as a suspected shell only when ALL of:

- prepared text is below an ABSOLUTE floor (`SHELL_PREPARED_TEXT_FLOOR = 600`
  chars) AND below `SHELL_TEXT_RATIO_MAX = 8%` of the raw HTML, AND
- a structural shell signal holds: scripts are `>= SHELL_SCRIPT_RATIO_MIN = 45%`
  of the raw HTML, OR a known client-render mount (`#root` / `#__next` / `#app`)
  is present but empty.

The absolute floor is the primary false-positive guard and is why it is a floor,
not a bare ratio: the real 2.7MB listing from ADR 0004 prepares to ~23k chars — a
0.85% text ratio that a ratio-only heuristic would wrongly flag — yet it is
content-rich. 23k >> 600, so it is never flagged. A content page is defined by
having real prepared text, regardless of how heavy its analytics/framework
scripts are; requiring low ABSOLUTE text (not just a low ratio) encodes that.

The warning is emitted through the existing `warnings` string channel but is
machine-actionable: it STARTS with a stable code and carries the ratio numbers.

- `js-shell-suspected: ...` — likely a shell, no usable embedded state -> caller
  should render upstream and retry.
- `js-shell-suspected-embedded-state-available: ...` — same shell shape BUT
  embedded state was harvested -> caller should prefer the sidecar and NOT render.

Both start with `js-shell-suspected`, so a coarse `startsWith` check catches
either while the suffix distinguishes the render-vs-sidecar decision.

## 3 Thresholds and false-positive testing

| Constant | Value | Role |
| --- | --- | --- |
| `SHELL_PREPARED_TEXT_FLOOR` | 600 chars | absolute floor; primary false-positive guard |
| `SHELL_TEXT_RATIO_MAX` | 0.08 | prepared text must be a tiny slice of the HTML |
| `SHELL_SCRIPT_RATIO_MIN` | 0.45 | script-dominated signal |

Tested in BOTH directions with realistic fixtures:

- shell-positive (`spa-shell-empty.html`): empty `#root`, script-dominated, no
  data -> `js-shell-suspected`.
- shell-with-embedded (`js-shell-next.html`): empty `#__next` + rich
  `__NEXT_DATA__` -> downgraded `js-shell-suspected-embedded-state-available`,
  and the record is recoverable from the sidecar.
- shell-negative (`content-rich-heavy-scripts.html`): four real content
  paragraphs PLUS a heavy analytics payload and a JSON-LD Event -> NOT flagged,
  because prepared text clears the floor; the JSON-LD is still harvested.

## 4 Size caps

All embedded values are `JSON.parse`-d and size-capped to bound memory on
pathological inputs; over-cap blocks are skipped with an
`embedded-state-size-capped` warning, never a throw: `MAX_JSONLD_BLOCKS` (25),
`MAX_RAW_BLOCK_CHARS` (256k, per-block parse guard), `MAX_JSONLD_TOTAL_CHARS`
(256k cumulative), `MAX_NEXTDATA_CHARS` / `MAX_INITIAL_STATE_CHARS` (512k each).
Malformed blocks are dropped with a typed `embedded-*-parse-failed` warning.

## 5 Consequences

- New public surface: `EmbeddedState` type, `ExtractionResult.embedded`,
  `PreparedChunks.embedded`, and `prepareContent().embedded`/`.warnings`; helper
  exports `harvestEmbeddedState`, `detectJsShell`, `inspectHtml`, the shell
  codes/thresholds, and `ShellSignals`. All additive.
- One extra `linkedom` parse of the raw HTML per HTML page (harvest must see the
  UN-pruned document). Accepted for correctness; the prep layer already parses,
  and a future optimization could share one parse. No new runtime dependency.
- Traverse still never renders and still owns zero field vocabulary; mapping the
  sidecar onto domain fields remains the caller's job.
