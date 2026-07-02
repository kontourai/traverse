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
 * Provenance is required on every proposal. `excerpt` is the verbatim source
 * quote the value was drawn from; `locator` is a Survey `LocatorScheme`-
 * compatible string (e.g. "html:field:title") so a caller building a Survey
 * `RawSource.locatorScheme`/`Extraction.locator` needs no translation table.
 */
export interface ExtractionProvenance {
  /** Verbatim quote from the source — maps to Survey Extraction.excerpt. */
  excerpt: string;
  /** Survey LocatorScheme-compatible locator string, e.g. "html:field:name". */
  locator: string;
}

/**
 * One proposed field value with full provenance. This is the whole identity of
 * the package: a proposal is a reviewable record, never a resolved value.
 */
export interface ExtractionProposal {
  fieldPath: string;
  candidateValue: unknown;
  /** 0..1 — clamped by extract() if a provider returns an out-of-range value. */
  confidence: number;
  /** REQUIRED — both excerpt and locator must be present. */
  provenance: ExtractionProvenance;
  /** provider identity string, e.g. "anthropic-extraction-provider:claude-sonnet-4-6". */
  extractor: string;
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
 * collects non-fatal normalization notes (e.g. a proposal dropped because its
 * `fieldPath` was not in the target schema).
 */
export interface ExtractionResult {
  proposals: ExtractionProposal[];
  /** raw provider response — kept for audit. */
  raw: RawProviderResponse;
  extractedAt: string;
  /** never throws for provider/parse failure — populated instead. */
  error?: string;
  /** non-fatal normalization notes (dropped/adjusted proposals). */
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
