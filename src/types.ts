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
  /** default 32_000. */
  maxContentChars?: number;
}
