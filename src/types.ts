/**
 * Core Traverse contracts.
 *
 * Traverse is a PROPOSER only (see docs/adr/0001-proposals-only.md): every
 * ExtractionProposal is a reviewable record carrying provenance. The types in
 * this file make that identity structural, not merely documented — `provenance`
 * (with both an `excerpt` and a `locator`) is a REQUIRED field on every
 * proposal. A value without provenance is not something Traverse emits.
 *
 * Base API sketched in the WS11 shaping doc; the one intentional, documented
 * deviation is `ExtractionProvider.extract()`'s return type — see
 * `ProviderExtractionOutput` below.
 */

/**
 * Content encodings Traverse can prepare for extraction. `"pdf"` is declared
 * here so callers can pass it through a stable union today, but content-prep for
 * it is deferred (returns a typed not-yet-implemented error at 0.1.0) — see
 * src/content-prep.ts.
 */
export type ContentType = "html" | "text" | "pdf";

/**
 * A caller-owned description of one field to extract. Traverse defines ZERO
 * field names itself; `path`, `enumValues`, and `description` semantics are
 * entirely the caller's. This is the mechanism that keeps domain vocabulary out
 * of the package (no camp/regulated-document field names live in `src/`).
 */
export interface TargetFieldSchema {
  /** dot/bracket field path, e.g. "pricing[].amount" — caller-owned semantics. */
  path: string;
  type: "string" | "number" | "boolean" | "date" | "enum" | "array" | "object";
  enumValues?: string[];
  /** field semantics for the provider prompt/rules — caller-owned, not a fixed enum. */
  description?: string;
  required?: boolean;
  /**
   * Optional grounding-honesty classification for this field, carried
   * through onto the matching `ExtractionProposal.inferenceType` by
   * `extract()`'s normalization step (see below) and, for the Anthropic
   * adapter, turned into one extra prompt-guidance sentence per field
   * (`buildExtractionTool`). `"explicit"` — the value should appear
   * verbatim in the source text; offset-verification of the VALUE itself
   * (not just the excerpt) is meaningful, and adapters may instruct the
   * provider to copy it verbatim rather than paraphrase/reformat it.
   * `"inferred"` — the value is derived/normalized/classified from the
   * source (e.g. computed, reworded, or categorized); the excerpt still
   * grounds the proposal, but the VALUE itself can never be
   * offset-verified against the source text. Absent (the default) means
   * unspecified — today's behavior, no classification implied either way.
   * Additive and optional: a schema that never sets this drives zero
   * behavior change by itself.
   */
  inferenceType?: "explicit" | "inferred";
}

/**
 * Provenance is required on every proposal. `excerpt` is a verbatim quote
 * against the CONTENT-PREPARED text `extract()` hands to the provider — i.e.
 * the output of `content-prep.ts` (tags stripped, entities decoded, whitespace
 * collapsed, truncated to `maxContentChars`), NOT the caller's raw HTML/source
 * document. `extract()`'s normalization step ENFORCES this: it verifies
 * `excerpt` occurs verbatim in the prepared text (via `indexOf`) and drops any
 * proposal whose excerpt cannot be found there.
 *
 * `locator` uses a fixed, defined scheme: `"chars:<start>-<end>"`, where
 * `<start>`/`<end>` are 0-based UTF-16 code-unit offsets of `excerpt` within
 * that SAME prepared text (`start` = the first `indexOf` match, `end` = `start
 * + excerpt.length`). `extract()` always derives/overwrites `locator` itself
 * from the verified excerpt offset — a provider- or adapter-supplied `locator`
 * is never trusted as-is, because only `extract()` holds the prepared text
 * needed to verify it.
 *
 * Consequence for consumers: because offsets are anchored to prepared text,
 * NOT the original raw document, a consumer that wants to highlight/locate an
 * excerpt in the raw source must either re-run the same content-prep step (or
 * an equivalent) to reproduce the prepared text the offsets refer to, or map
 * prepared-text offsets back to raw-document offsets itself. Traverse does not
 * do this mapping.
 */
export interface ExtractionProvenance {
  /** Verbatim quote against the prepared text — maps to Survey Extraction.excerpt. */
  excerpt: string;
  /** "chars:<start>-<end>" — code-unit offsets of `excerpt` within the prepared text. */
  locator: string;
}

/**
 * One proposed field value with full provenance. This is the whole identity of
 * the package: a proposal is a reviewable record, never a resolved value.
 */
export interface ExtractionProposal {
  /**
   * Always a path declared in the caller's `targetSchema` — never an
   * indexed source path. When a provider emits an indexed path against an
   * array field (e.g. "schedules[0].startDate") and the caller only declared
   * the un-indexed array form (e.g. "schedules[].startDate"),
   * `extract()`'s normalization step rewrites `fieldPath` to that declared
   * form and records the stripped index/indices in `pathIndices` (see
   * below) rather than dropping the proposal. See "Indexed field paths" in
   * the README and `docs/adr/0003-indexed-path-normalization.md`.
   */
  fieldPath: string;
  candidateValue: unknown;
  /** 0..1 — clamped by extract() if a provider returns an out-of-range value. */
  confidence: number;
  /** REQUIRED — both excerpt and locator must be present. */
  provenance: ExtractionProvenance;
  /** provider identity string, e.g. "anthropic-extraction-provider:claude-sonnet-4-6". */
  extractor: string;
  /**
   * Present ONLY when `fieldPath` was recovered by normalizing an indexed
   * source path (e.g. "schedules[0].startDate" -> "schedules[].startDate")
   * against a declared array path in `targetSchema`. Holds the stripped
   * index for each `[n]` segment, in left-to-right (outermost-first) source
   * order — e.g. "a[2].b[0].c" -> `pathIndices: [2, 0]`. Absent whenever
   * `fieldPath` matched the schema as-is (no normalization occurred).
   * Consumers use this to group/re-associate proposals that came from the
   * same array item (e.g. multiple `schedules[].*` proposals originating
   * from the same source `schedules[N]`).
   */
  pathIndices?: number[];
  /**
   * Present ONLY when the matched `TargetFieldSchema` entry (looked up by
   * the declared/normalized `fieldPath`, same as `pathIndices`'s recovery
   * path) declared `inferenceType` — absent otherwise. Populated by
   * `extract()`'s normalization, mirroring the `pathIndices`
   * conditional-attach idiom above: this is a claim about the proposal's
   * own grounding honesty ("explicit" = value itself is offset-groundable;
   * "inferred" = value is derived/normalized, only the excerpt is
   * grounded), not a re-statement of schema-authoring constraints, so it
   * is carried onto the proposal itself rather than requiring a consumer
   * to still hold the original `targetSchema` in scope.
   */
  inferenceType?: "explicit" | "inferred";
}

/**
 * Machine-readable state harvested from the raw HTML before prep strips every
 * `<script>` block — a STRUCTURED SIDECAR, deliberately NOT proposals. See
 * `src/embedded.ts` and `docs/adr/0005-embedded-state-sidecar.md` for why
 * embedded state cannot carry the `chars:<start>-<end>` provenance an
 * ExtractionProposal requires (it is not present in the prepared text), and why
 * mapping this state onto caller field names is the caller's job (Traverse owns
 * zero field vocabulary).
 *
 * Every value is JSON.parse-d and size-capped. Absent fields mean "not found";
 * a malformed block is dropped with a warning rather than throwing.
 */
export interface EmbeddedState {
  /**
   * Parsed contents of each `<script type="application/ld+json">` block, in
   * document order (one entry per block; schema.org `@graph`/array payloads are
   * kept as-parsed for the caller to flatten). Empty array when none parsed.
   */
  jsonLd: unknown[];
  /** Parsed `<script id="__NEXT_DATA__">` payload (Next.js), when present. */
  nextData?: unknown;
  /**
   * Parsed generic hydration blob (`window.__INITIAL_STATE__` /
   * `__PRELOADED_STATE__`), when present.
   */
  initialState?: unknown;
}

/**
 * Raw provider response, kept for audit alongside the normalized proposals.
 */
export interface RawProviderResponse {
  response: string;
  model: string;
  tokensUsed?: number;
}

/**
 * The result of `extract()`. Traverse never throws for provider/parse failure —
 * any stage error surfaces here as `error` with `proposals` empty. `warnings`
 * collects non-fatal notes from BOTH the provider (e.g. a truncated response,
 * malformed tool items dropped by an adapter) and `extract()`'s own
 * normalization step (e.g. a proposal dropped because its excerpt was not
 * found in the prepared content, or its `fieldPath` was not in the target
 * schema) — nothing is dropped or adjusted silently.
 */
export interface ExtractionResult {
  proposals: ExtractionProposal[];
  /** raw provider response — kept for audit. */
  raw: RawProviderResponse;
  extractedAt: string;
  /** never throws for provider/parse failure — populated instead. */
  error?: string;
  /** non-fatal notes: merged provider warnings + normalization notes (dropped/adjusted proposals). */
  warnings?: string[];
  /**
   * Number of `provider.extract()` calls actually issued during this run
   * (attempted, whether they succeeded or threw) — REQUIRED, always populated,
   * even on an early return where zero calls were made (invalid-config,
   * pdf-deferred) and even with no `ExtractInput.maxProviderCalls`/
   * `maxTotalTokens` ceiling configured, so spend is observable by default.
   * See `ExtractInput.maxProviderCalls`.
   */
  providerCalls: number;
  /**
   * Sum of `raw.tokensUsed` across every SUCCESSFUL provider call this run
   * (a call that threw contributes nothing) — REQUIRED, always populated,
   * same "populated on every return path" guarantee as `providerCalls`. A
   * provider that never reports `raw.tokensUsed` contributes `0` per call
   * (this stays `0`, not `undefined`, for such a provider). See
   * `ExtractInput.maxTotalTokens`.
   */
  totalTokensUsed: number;
  /**
   * Machine-readable state harvested from the raw HTML (JSON-LD, `__NEXT_DATA__`,
   * hydration blobs) — present ONLY for `"html"` content that carried some. This
   * is a structured sidecar the caller can prefer over LLM proposals; it is
   * harvested ONCE from the whole page, so it is never duplicated across chunks.
   * See `src/embedded.ts` and `docs/adr/0005-embedded-state-sidecar.md`.
   */
  embedded?: EmbeddedState;
  /**
   * Page-boundary sidecar for PDF content — present ONLY when contentType
   * was "pdf", ExtractInput.pdfTextExtractor was supplied, and the extractor
   * reported page boundaries. 0-based char offsets into the SAME prepared
   * text every proposal's chars:<start>-<end> locator is anchored to. A
   * consumer resolves a proposal's page via resolvePdfPage(). NOT a new
   * locator scheme (ADR 0001's chars:<start>-<end> contract is unchanged) —
   * a structured sidecar alongside it, mirroring `embedded` (ADR 0005). Full
   * page/region locators are deferred — see
   * docs/decisions/content-preparation.md.
   */
  pdfPageOffsets?: number[];
}

/**
 * What an ExtractionProvider hands back.
 *
 * INTENTIONAL DEVIATION from the shaping sketch, resolved at Slice-1 planning:
 * the sketch left `ExtractionProvider.extract()` returning a bare
 * `ExtractionProposal[]`, which left no path for the provider's raw response to
 * reach the package-level `ExtractionResult.raw`. Providers therefore return
 * `{ proposals, raw }` so `extract()` can carry audit data through unchanged.
 */
export interface ProviderExtractionOutput {
  proposals: ExtractionProposal[];
  raw: RawProviderResponse;
  /**
   * Non-fatal provider-side notes — e.g. a malformed tool-output item the
   * adapter dropped, or a response truncated at `maxTokens`. Nothing an
   * adapter drops or notices should be silent: `extract()` merges these into
   * `ExtractionResult.warnings` alongside its own normalization warnings.
   */
  warnings?: string[];
}

/**
 * A pluggable extraction backend. The bundled Anthropic adapter (subpath
 * `@kontourai/traverse/anthropic`) is one implementation; callers may inject any
 * other, including test mocks.
 */
export interface ExtractionProvider {
  name: string;
  extract(input: {
    /** already normalized to text by the package's content-prep step. */
    content: string;
    contentType: ContentType;
    targetSchema: TargetFieldSchema[];
    fieldHints?: Record<string, string>;
  }): Promise<ProviderExtractionOutput>;
}

/**
 * Extracted text from one PDF document, produced by a caller-supplied
 * {@link PdfTextExtractor}.
 */
export interface PdfExtractedText {
  /** extracted text for the WHOLE document, all pages concatenated. */
  text: string;
  /**
   * 0-based char offsets into `text` where each page begins, in page order
   * (pageOffsets[0] is page 1's start — normally 0). Length equals the
   * detected page count. OPTIONAL: an extractor that cannot report page
   * boundaries may omit this — Traverse still produces valid
   * chars:<start>-<end> locators either way; pageOffsets only adds
   * page-resolution on top (see docs/decisions/content-preparation.md).
   */
  pageOffsets?: number[];
  /** non-fatal notes from extraction (e.g. an unreadable page skipped). */
  warnings?: string[];
}

/**
 * Injected seam for PDF text extraction. Traverse ships NO default
 * implementation and takes NO parser dependency (pdfjs-dist, pdf-parse,
 * etc.) — a caller that needs "pdf" content-prep supplies one, typically
 * wrapping a parser it already has. See src/content-prep.ts
 * `preparePdfText` and docs/decisions/content-preparation.md.
 */
export interface PdfTextExtractor {
  /** May be sync or return a Promise; callers of this seam await either. */
  extract(bytes: Uint8Array): PdfExtractedText | Promise<PdfExtractedText>;
}

/**
 * Input to the top-level `extract()` orchestration.
 */
export interface ExtractInput {
  content: string | Uint8Array;
  contentType: ContentType;
  /** stable ref for provenance — maps to Survey RawSource.sourceRef. */
  sourceRef: string;
  targetSchema: TargetFieldSchema[];
  fieldHints?: Record<string, string>;
  provider: ExtractionProvider;
  /**
   * Injected PDF text extractor. With this UNSET, contentType: "pdf" keeps
   * returning the pre-existing typed not-implemented error (unchanged since
   * 0.1.0) — every existing caller's behavior is unaffected by this option's
   * existence. See src/content-prep.ts `preparePdfText` and
   * docs/decisions/content-preparation.md.
   */
  pdfTextExtractor?: PdfTextExtractor;
  /**
   * Per-chunk provider content budget (default 32_000). Each chunk handed to the
   * provider is truncated to this length. In the common single-chunk case this
   * is identical to the pre-0.5.0 whole-text truncation. See
   * `docs/adr/0004-large-page-chunking.md`.
   */
  maxContentChars?: number;
  /**
   * Structure-preserving prep mode. Default `"markdown"` for `"html"` content
   * (links/headings/lists survive), `"text"` otherwise. Pass `"text"` for the
   * legacy regex strip. The `"html"` default flipped to `"markdown"` in 0.5.0.
   */
  prep?: "text" | "markdown";
  /** Target max characters per chunk (default 12_000). */
  chunkSize?: number;
  /** Character-window overlap for the fallback chunker (default 200). */
  chunkOverlap?: number;
  /** Cap on number of chunks; extras are dropped with a warning (default 40). */
  maxChunks?: number;
  /**
   * Ceiling on the number of `provider.extract()` calls issued in ONE
   * `extract()` run (across all chunks). Default unset = unbounded. Once
   * reached, `extract()` stops issuing further calls (never mid-call), keeps
   * whatever proposals were already collected, and records a warning naming
   * the ceiling and how many calls were made — mirroring the `maxChunks`
   * truncation precedent, never throwing (`extract()`'s never-throws
   * contract is unchanged). Must be a positive integer when set; a
   * non-positive/non-integer/NaN value surfaces as `ExtractionResult.error`
   * instead of running. Distinct from `maxContentChars`/`maxChunks` (which
   * bound CONTENT, not provider spend) and from the Anthropic adapter's own
   * `AnthropicAdapterOptions.maxTokens` (a different interface entirely — a
   * per-call OUTPUT cap, not a per-run call-count ceiling).
   */
  maxProviderCalls?: number;
  /**
   * Ceiling on accumulated `raw.tokensUsed` (summed across every successful
   * `provider.extract()` call) in ONE `extract()` run. Default unset =
   * unbounded. This is a STOP-ISSUING bound, not a hard spend cap: it is
   * checked BEFORE each call using only tokens already spent by calls that
   * have already completed, because a call's cost is unknown until it
   * returns — actual total tokens consumed by a run can therefore exceed
   * this ceiling by up to one call's usage. Once reached, `extract()` stops
   * issuing further calls (never mid-call), keeps proposals already
   * collected, and records a warning naming the ceiling and tokens
   * consumed — same never-throws contract as `maxProviderCalls`. Must be a
   * positive finite number when set (need not be an integer); invalid
   * values surface as `ExtractionResult.error`. A provider that never sets
   * `raw.tokensUsed` degrades gracefully: this ceiling simply never fires
   * for it (contributes `0` per call), while `maxProviderCalls` keeps
   * working independently. Distinct from the Anthropic adapter's own
   * `AnthropicAdapterOptions.maxTokens` (a different interface — that one is
   * a per-call OUTPUT token cap passed to the model, default `2048`; this
   * one is a per-run cumulative ceiling `extract()` enforces across calls).
   */
  maxTotalTokens?: number;
}
