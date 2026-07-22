---
status: current
subject: Content preparation
decided: 2026-07-03
evidence:
  - kind: adr
    ref: docs/adr/0004-large-page-chunking.md
  - kind: adr
    ref: docs/adr/0005-embedded-state-sidecar.md
  - kind: doc
    ref: docs/parity-methodology.md
  - kind: doc
    ref: .kontourai/flow-agents/pdf-content-prep/pdf-content-prep--deliver-plan.md
---

# Content preparation

This subject previously had provenance only in frozen ADR history
([0004-large-page-chunking.md](../adr/0004-large-page-chunking.md),
[0005-embedded-state-sidecar.md](../adr/0005-embedded-state-sidecar.md)) with
no living decision ratified under the topic-keyed decision registry. This
update ratifies the first living decision for the subject: PDF content
preparation, shipped as an **opt-in injected seam**, not a bundled parser.

## Decision

- `ExtractInput.pdfTextExtractor?: PdfTextExtractor` is the seam. A
  `PdfTextExtractor` is a caller-supplied `{ extract(bytes) => { text,
  pageOffsets?, warnings? } }` implementation (sync or async, per
  `src/types.ts`). With this **unset**, `contentType: "pdf"` keeps returning
  the pre-existing typed not-implemented error (`PDF_PREP_ERROR`, unchanged
  since `0.1.0`) — every existing caller's behavior is unaffected by this
  option's mere existence.
- **No default PDF implementation, no additional PDF dependency.** Traverse
  takes on no PDF parsing library (`pdfjs-dist`, `pdf-parse`, `unpdf`, or any
  other) as a hard or optional peer dependency for this slice. That is separate
  from the package's declared content-preparation runtime dependencies:
  `linkedom` and `turndown` implement the default HTML-to-Markdown path. The
  core bundles no AI-provider SDK; provider adapters use optional peer SDKs
  behind provider-specific subpaths. PDF, OCR, and browser/render
  implementations remain caller-injected seams and are not bundled. A caller
  that needs PDF parsing supplies the parser it already owns, so this slice
  adds neither a parser implementation nor a PDF dependency.
- **Composition, not new chunking logic.** With an extractor supplied,
  `extract()` runs it via `preparePdfText()` (`src/content-prep.ts`) and
  hands the resulting text into the EXISTING, unmodified character-window
  chunker (`prepareAndChunk(text, "text", ...)`) — the same offset-correct
  chunking and `chars:<start>-<end>` provenance-verification machinery
  HTML/text already use. `chunk.ts` required zero changes.
- **`pdfPageOffsets` sidecar, mirroring `embedded` (ADR 0005).**
  `ExtractionResult.pdfPageOffsets` is an optional `number[]` of each page's
  0-based start offset into the same prepared text every proposal's
  `chars:<start>-<end>` locator is anchored to. `resolvePdfPage(pageOffsets,
  charOffset)` (`src/content-prep.ts`) resolves a verified locator start
  offset to a 1-based page number. This is deliberately NOT a new locator
  scheme (e.g. not `"pdf:page:3:chars:120-140"`) — the `chars:<start>-<end>`
  contract (ADR 0001 §4) is unchanged for every content type, including pdf;
  `pdfPageOffsets` is a structured sidecar alongside it, matching how
  `embedded` sits alongside proposals rather than inside them.
  `pageOffsets` is **trust-not-verify**: unlike `excerpt`, Traverse cannot
  independently confirm page numbers against real PDF structure. It is
  shape-validated (finite, non-decreasing, in-range) and dropped, with a
  warning, if malformed — never silently trusted. A caller with a buggy
  extractor can still get structurally-valid but semantically-wrong page
  numbers; this mirrors the pre-existing `embedded` sidecar's
  un-verified-content precedent.
- **Never-throw preserved.** `preparePdfText()` wraps the extractor call in
  try/catch (mirroring `htmlToMarkdown`'s degrade-via-try/catch discipline);
  a synchronous throw or a rejected Promise from `PdfTextExtractor.extract()`
  surfaces as `ExtractionResult.error`, never propagated. `extract()`'s
  existing top-level try/catch is an unconditional second safety net.
- **Cost guards compose unchanged.** `maxProviderCalls`/`maxTotalTokens`
  (see `extraction-cost-guard.md`) run in the per-chunk provider loop, which
  the pdf pre-step feeds into identically to html/text — no changes to that
  loop were needed.
- **`prepareContent()`'s sync signature does not gain PDF support.** Only
  `extract()` and the new standalone `preparePdfText()` support the
  extractor seam; `prepareContent(bytes, "pdf")` still always returns
  `PDF_PREP_ERROR`, even with an extractor available elsewhere in a caller's
  code — `prepareContent` was deliberately not given a `pdfTextExtractor`
  parameter, to avoid a sync-to-async breaking change to a widely-called
  function. This is a documented asymmetry, not a bug.

## Out of scope

- **Page/region locators.** A distinct locator scheme beyond
  `chars:<start>-<end>` (e.g. one that names a page/region directly) is the
  issue's own later-slice goal, not attempted here.
- **Page-boundary-preferred chunk splitting.** PDF-aware chunking that never
  lets a chunk boundary fall mid-page (mirroring how structural HTML
  chunking never splits a card) is a real potential future improvement,
  explicitly deferred. The character-window fallback's existing overlap
  (`chunkOverlap`, default 200 chars) already gives reasonable robustness
  against a value straddling a chunk boundary, same as it does for HTML
  today.
- **The fetch-layer binary-body gap (pre-existing, not fixed here).**
  `src/fetch/fetch-source.ts` calls `response.text()` unconditionally for
  every content type, and `Snapshot.body` is UTF-8-decoded — fetching a real
  PDF over HTTP via `fetchSource`/`fetchAndExtract` today silently corrupts
  the binary bytes before content-prep ever runs. This decision does not
  touch the fetch layer; the seam is designed for uploaded-file bytes passed
  directly to `extract()`, not URL-fetched PDFs. A follow-up issue for
  `fetchSource` binary/`Uint8Array` body support is recommended before
  anyone relies on `fetchAndExtract` for a PDF URL.
- **Whether Traverse should ever ship a bundled, optional default PDF
  parser** (dynamic-import, subpath-gated, e.g. behind
  `@kontourai/traverse/pdf`) once a second PDF-consuming application exists.
  Left explicitly open, not decided, not silently foreclosed.
- **No real-parser parity proof in this repo.** The end-to-end test coverage
  for this decision uses a hand-crafted minimal PDF fixture
  (`tests/fixtures/minimal-two-page.pdf`) and a test-only, regex-based
  "naive" extractor (`tests/fixtures/naive-pdf-text-extractor.ts`) — neither
  is `pdfjs-dist` or any production parser. This proves the SEAM composes
  correctly; it does not prove a specific downstream consumer's real parser
  drops in cleanly. See `docs/parity-methodology.md` for how a downstream
  adoption slice should prove that.
- **Very large PDFs (accepted gap).** `preparePdfText`'s internal full-text
  cap mirrors the existing `SAFETY_CAP`/`SHELL_INSPECT_CAP` (5,000,000
  chars); a pathological multi-thousand-page PDF whose extracted text
  exceeds that cap could have trailing `pageOffsets` entries pointing past
  the truncated text. Accepted, matching the existing `SAFETY_CAP` framing
  elsewhere in this package.
