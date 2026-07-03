/**
 * Top-level extraction orchestration.
 *
 * Pipeline: prepareAndChunk -> per-chunk provider.extract() -> strict proposal
 * normalization (offset-adjusted, re-verified provenance) -> cross-chunk dedup
 * -> ExtractionResult. It NEVER throws for provider/parse/prep failure — every
 * stage error surfaces as `ExtractionResult.error` with an empty `proposals`
 * array.
 *
 * Large-page chunking (0.5.0). `prepareAndChunk` turns the input into one
 * `fullText` plus offset-correct `chunks` (structural card boundaries for a
 * repeated-card listing, else a character window with overlap — see
 * src/chunk.ts and docs/adr/0004-large-page-chunking.md). Chunks are sent to the
 * provider SEQUENTIALLY (rate-limit friendly; concurrency is future work).
 * `maxContentChars` is the PER-CHUNK provider budget: each chunk handed to the
 * provider is truncated to it (identical to the pre-0.5.0 whole-text truncation
 * in the common single-chunk case).
 *
 * Provenance across chunks. A proposal's `excerpt` is verified against the chunk
 * text the provider saw (via `indexOf`), then re-anchored to the FULL prepared
 * text: `locator = "chars:<start>-<end>"` with `start = chunk.start + localIndex`,
 * re-verified at that offset against `fullText`. The `"chars:"` scheme therefore
 * still means "offsets into the full prepared text" even though a provider only
 * ever saw one chunk.
 *
 * Per-chunk provider errors are recorded as warnings and the other chunks still
 * run (partial results survive); only if EVERY chunk's call fails does
 * `extract()` surface a `result.error`.
 *
 * Normalization discipline (proposals-only, ADR 0001 §4). A proposal survives
 * normalization only if ALL of the following hold — anything else is dropped
 * (or, for confidence, clamped) with a warning, never silently:
 *  - `fieldPath` MUST be a non-empty string present in the caller's
 *    `targetSchema`; missing or unknown fields are dropped with a warning.
 *    EXCEPTION: an indexed path against a declared array field (e.g.
 *    `"schedules[0].startDate"` when the schema declares
 *    `"schedules[].startDate"`) is ACCEPTED, not dropped — `[n]` segments are
 *    stripped to `[]` (consistently at every level, e.g.
 *    `"a[2].b[0].c"` -> `"a[].b[].c"`) and checked against `targetSchema`
 *    again; a match rewrites `fieldPath` to the declared form and records the
 *    stripped index/indices on `pathIndices` (silently — no warning; this is
 *    a supported input shape, not a defect). A fieldPath whose normalized
 *    form STILL doesn't match `targetSchema` is dropped with a warning, same
 *    as any other unknown fieldPath. See
 *    `docs/adr/0003-indexed-path-normalization.md` for why this is
 *    accept-and-normalize rather than reject,
 *  - `extractor` MUST be a non-empty string; a blank one drops the item,
 *  - the proposal MUST carry provenance with a non-empty `excerpt`; a missing
 *    excerpt drops the item,
 *  - that `excerpt` MUST OCCUR VERBATIM in the prepared content handed to the
 *    provider (checked via `String.prototype.indexOf` against the exact text
 *    `provider.extract()` was called with — never the caller's raw
 *    HTML/source). A miss drops the item with the warning "excerpt not found
 *    in prepared content"; this is what turns the provenance contract from a
 *    prompted convention into an ENFORCED one. A hit sets/overwrites
 *    `provenance.locator` to the defined `"chars:<start>-<end>"` scheme —
 *    0-based UTF-16 code-unit offsets of the matched excerpt within the
 *    prepared text — regardless of any locator a provider/adapter supplied
 *    (only `extract()` holds the prepared text needed to verify one, so it is
 *    the sole owner of the final `locator` value),
 *  - `confidence` MUST be a finite number; a non-finite (or missing)
 *    confidence drops the item. An in-range value passes through; an
 *    out-of-range value is CLAMPED into `0..1` (never dropped) with a warning.
 *
 * `warnings` on the final `ExtractionResult` merges BOTH of the above
 * normalization notes AND any `warnings` the provider itself returned (e.g.
 * the Anthropic adapter's malformed-tool-item / maxTokens-truncation notes) —
 * nothing either stage notices is silent.
 */

import { prepareAndChunk } from "./chunk.js";
import type { PreparedChunks } from "./chunk.js";
import { pdfBytesRequiredError, preparePdfText } from "./content-prep.js";
import type {
  ExtractInput,
  ExtractionProposal,
  ExtractionResult,
  ProviderExtractionOutput,
  RawProviderResponse,
} from "./types.js";

/**
 * Full-text cap for `preparePdfText`'s extractor output, independent of any
 * per-chunk budget — mirrors `chunk.ts`'s `SAFETY_CAP` /
 * `content-prep.ts`'s `SHELL_INSPECT_CAP` (kept as a local const to avoid an
 * import cycle; see docs/decisions/content-preparation.md, Stop-short risk 5).
 */
const PDF_FULL_TEXT_CAP = 5_000_000;

const DEFAULT_MAX_CONTENT_CHARS = 32_000;

const EMPTY_RAW: RawProviderResponse = { response: "", model: "" };

export async function extract(input: ExtractInput): Promise<ExtractionResult> {
  const extractedAt = new Date().toISOString();
  const maxChars = input.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;

  try {
    // Invalid-config validation: pure input validation independent of
    // content, so it runs before prepareAndChunk (before any content-prep or
    // provider work). maxProviderCalls is validated first.
    if (input.maxProviderCalls !== undefined) {
      const v = input.maxProviderCalls;
      if (!(Number.isInteger(v) && v > 0)) {
        return {
          proposals: [],
          raw: EMPTY_RAW,
          extractedAt,
          error: `invalid maxProviderCalls: must be a positive integer (got ${JSON.stringify(v)})`,
          providerCalls: 0,
          totalTokensUsed: 0,
        };
      }
    }
    if (input.maxTotalTokens !== undefined) {
      const v = input.maxTotalTokens;
      if (!(Number.isFinite(v) && v > 0)) {
        return {
          proposals: [],
          raw: EMPTY_RAW,
          extractedAt,
          error: `invalid maxTotalTokens: must be a positive finite number (got ${JSON.stringify(v)})`,
          providerCalls: 0,
          totalTokensUsed: 0,
        };
      }
    }

    // PDF pre-step: with contentType "pdf" and a supplied pdfTextExtractor,
    // run the extractor and hand the resulting text into the EXISTING,
    // unmodified character-window chunker (prepareAndChunk(text, "text",
    // ...)) — PDF content-prep reuses 100% of the already-tested chunking
    // and chars:<start>-<end> provenance-verification machinery below with
    // zero new chunking code (see docs/decisions/content-preparation.md).
    // With NO extractor supplied, contentType "pdf" falls through to the
    // unchanged prepareAndChunk(input.content, input.contentType, {...})
    // call below, byte-identical to the pre-existing 0.8.0 PDF_PREP_ERROR
    // path.
    let prepared: PreparedChunks;
    let pdfPageOffsets: number[] | undefined;
    if (input.contentType === "pdf" && input.pdfTextExtractor) {
      if (!(input.content instanceof Uint8Array)) {
        return {
          proposals: [],
          raw: EMPTY_RAW,
          extractedAt,
          error: pdfBytesRequiredError(),
          providerCalls: 0,
          totalTokensUsed: 0,
        };
      }
      const pdfPrep = await preparePdfText(input.content, input.pdfTextExtractor, PDF_FULL_TEXT_CAP);
      if (pdfPrep.error !== undefined) {
        return {
          proposals: [],
          raw: EMPTY_RAW,
          extractedAt,
          error: pdfPrep.error,
          providerCalls: 0,
          totalTokensUsed: 0,
        };
      }
      pdfPageOffsets = pdfPrep.pageOffsets;
      prepared = prepareAndChunk(pdfPrep.text, "text", {
        chunkSize: input.chunkSize,
        chunkOverlap: input.chunkOverlap,
        maxChunks: input.maxChunks,
      });
      prepared.warnings = [...pdfPrep.warnings, ...prepared.warnings];
    } else {
      prepared = prepareAndChunk(input.content, input.contentType, {
        prep: input.prep,
        chunkSize: input.chunkSize,
        chunkOverlap: input.chunkOverlap,
        maxChunks: input.maxChunks,
      });
    }
    if (prepared.error !== undefined) {
      return { proposals: [], raw: EMPTY_RAW, extractedAt, error: prepared.error, providerCalls: 0, totalTokensUsed: 0 };
    }

    const { fullText, chunks } = prepared;
    const warnings: string[] = [...prepared.warnings];
    const collected: ExtractionProposal[] = [];
    let lastRaw: RawProviderResponse = EMPTY_RAW;
    const providerErrors: string[] = [];
    let chunksSucceeded = 0;
    // Cost-guard accumulators: providerCalls counts every ISSUED call
    // (attempted, success or throw); totalTokensUsed sums raw.tokensUsed from
    // SUCCESSFUL calls only (a provider that omits tokensUsed contributes 0).
    let providerCalls = 0;
    let totalTokensUsed = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // In-loop cost-guard checks, at the top of each iteration, before the
      // content slice or provider call below. Both ceilings are validated
      // > 0 above, so on i = 0 both checks are always false (providerCalls
      // and totalTokensUsed start at 0) — the first call is never blocked.
      // maxProviderCalls is checked first; whichever check trips first is
      // the only one to emit a warning for that stop.
      if (input.maxProviderCalls !== undefined && providerCalls >= input.maxProviderCalls) {
        warnings.push(
          `stopped after ${providerCalls} provider call(s): maxProviderCalls (${input.maxProviderCalls}) reached; ${chunks.length - i} chunk(s) not processed`,
        );
        break;
      }
      if (input.maxTotalTokens !== undefined && totalTokensUsed >= input.maxTotalTokens) {
        warnings.push(
          `stopped after ${providerCalls} provider call(s): maxTotalTokens (${input.maxTotalTokens}) reached (${totalTokensUsed} tokens used); ${chunks.length - i} chunk(s) not processed`,
        );
        break;
      }

      // Per-chunk provider budget: the provider sees at most `maxChars` of this
      // chunk. The slice is still a prefix-substring of `fullText` at
      // `chunk.start`, so verified offsets stay correct against `fullText`.
      const chunkContent = chunk.text.slice(0, maxChars);

      let output: ProviderExtractionOutput;
      providerCalls++;
      try {
        output = await input.provider.extract({
          content: chunkContent,
          contentType: input.contentType,
          targetSchema: input.targetSchema,
          fieldHints: input.fieldHints,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        providerErrors.push(msg);
        warnings.push(`chunk ${i + 1}/${chunks.length} provider call failed: ${msg}`);
        continue;
      }

      chunksSucceeded++;
      if (output.warnings) warnings.push(...output.warnings);
      if (output.raw) {
        lastRaw = output.raw;
        if (typeof output.raw.tokensUsed === "number") totalTokensUsed += output.raw.tokensUsed;
      }

      // Isolate normalization per chunk too: a misbehaving provider (e.g. a
      // proposal with a throwing getter) must not discard proposals already
      // collected from earlier chunks — the "partial results survive" guarantee.
      try {
        const { proposals: chunkProposals, warnings: normalizationWarnings } = normalizeChunkProposals(
          output.proposals,
          input,
          chunkContent,
          chunk.start,
          fullText,
        );
        warnings.push(...normalizationWarnings);
        collected.push(...chunkProposals);
      } catch (err) {
        warnings.push(
          `chunk ${i + 1}/${chunks.length} normalization failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Every chunk's provider call failed -> surface as a fatal error. This
    // preserves the single-shot contract: a 1-chunk page whose only provider
    // call throws is an error, not an empty success.
    if (chunks.length > 0 && chunksSucceeded === 0 && providerErrors.length > 0) {
      // The embedded-state sidecar is prep-derived, not provider-derived, so it
      // survives even when every provider call fails — a shell page with rich
      // `__NEXT_DATA__` is still extractable from the sidecar without a render.
      const failed: ExtractionResult = {
        proposals: [],
        raw: EMPTY_RAW,
        extractedAt,
        error: providerErrors[0],
        providerCalls,
        totalTokensUsed,
      };
      if (prepared.embedded) failed.embedded = prepared.embedded;
      if (pdfPageOffsets) failed.pdfPageOffsets = pdfPageOffsets;
      return failed;
    }

    const { proposals, dropped } = dedupeProposals(collected);
    if (dropped > 0) {
      warnings.push(
        `dropped ${dropped} duplicate proposal${dropped === 1 ? "" : "s"} (same field + source span)`,
      );
    }

    if (chunks.length > 1) {
      warnings.push(
        prepared.structural
          ? `chunked into ${chunks.length} chunks by repeated-card structure (${prepared.cardCount} cards detected)`
          : `chunked into ${chunks.length} chunks by character window`,
      );
    }
    if (prepared.truncatedChunks > 0) {
      warnings.push(
        `dropped ${prepared.truncatedChunks} chunk${prepared.truncatedChunks === 1 ? "" : "s"} beyond maxChunks; content truncated`,
      );
    }

    const result: ExtractionResult = { proposals, raw: lastRaw, extractedAt, providerCalls, totalTokensUsed };
    if (warnings.length > 0) result.warnings = warnings;
    // Attach the whole-page embedded-state sidecar once (never per chunk).
    if (prepared.embedded) result.embedded = prepared.embedded;
    if (pdfPageOffsets) result.pdfPageOffsets = pdfPageOffsets;
    return result;
  } catch (err) {
    return {
      proposals: [],
      raw: EMPTY_RAW,
      extractedAt,
      error: err instanceof Error ? err.message : String(err),
      providerCalls: 0,
      totalTokensUsed: 0,
    };
  }
}

/**
 * Cross-chunk dedup. A duplicate is the SAME field extracted from the SAME
 * verified source span — i.e. the same `fieldPath` + `pathIndices` + `locator`
 * (which encodes the `chars:<start>-<end>` offset into `fullText`). This
 * collapses the true duplicates chunking creates — an overlap window seeing the
 * same span twice, or the same span landing in two chunks — while NEVER
 * collapsing two genuinely distinct records that merely share a value (e.g. two
 * listing cards with the same price), which come from different spans. Keeps the
 * highest confidence on a collision; first-seen key order is preserved.
 */
function dedupeProposals(input: ExtractionProposal[]): { proposals: ExtractionProposal[]; dropped: number } {
  const byKey = new Map<string, ExtractionProposal>();
  const order: string[] = [];
  let dropped = 0;

  for (const proposal of input) {
    // JSON-encode the tuple so no field's contents can collide with another's
    // boundary. `locator` is the verified span, so it discriminates distinct
    // occurrences of the same value.
    const key = JSON.stringify([
      proposal.fieldPath,
      proposal.pathIndices ?? null,
      proposal.provenance.locator,
    ]);

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, proposal);
      order.push(key);
    } else {
      dropped++;
      if (proposal.confidence > existing.confidence) byKey.set(key, proposal);
    }
  }

  return { proposals: order.map((k) => byKey.get(k) as ExtractionProposal), dropped };
}

/**
 * Normalize one chunk's proposals. Identical discipline to the pre-0.5.0
 * single-shot normalizer, except the provenance excerpt is verified against the
 * chunk text (`chunkContent`) the provider saw and the locator offset is shifted
 * by `chunkStart` and re-verified against `fullText` before it is trusted.
 */
function normalizeChunkProposals(
  raw: unknown,
  input: ExtractInput,
  chunkContent: string,
  chunkStart: number,
  fullText: string,
): { proposals: ExtractionProposal[]; warnings: string[] } {
  const warnings: string[] = [];
  const proposals: ExtractionProposal[] = [];

  if (!Array.isArray(raw)) {
    warnings.push("provider returned no proposals array");
    return { proposals, warnings };
  }

  const knownFieldPaths = new Set(input.targetSchema.map((f) => f.path));

  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      warnings.push("dropped a proposal that was not an object");
      continue;
    }
    const candidate = item as Partial<ExtractionProposal>;

    const fieldPath = typeof candidate.fieldPath === "string" ? candidate.fieldPath.trim() : "";
    if (!fieldPath) {
      warnings.push("dropped a proposal with a missing fieldPath");
      continue;
    }

    let effectiveFieldPath = fieldPath;
    let pathIndices: number[] | undefined;
    if (!knownFieldPaths.has(fieldPath)) {
      // Not a direct match — try normalizing indexed segments ("[0]" -> "[]",
      // consistently at every level) against a declared array path before
      // giving up. This recovers proposals like "schedules[0].startDate"
      // against a schema that only declares "schedules[].startDate" — see
      // docs/adr/0003-indexed-path-normalization.md.
      const { normalized, indices } = normalizeIndexedFieldPath(fieldPath);
      if (indices.length > 0 && knownFieldPaths.has(normalized)) {
        effectiveFieldPath = normalized;
        pathIndices = indices;
      } else {
        warnings.push(`dropped proposal for unknown fieldPath "${fieldPath}" (not in targetSchema)`);
        continue;
      }
    }

    const extractor = typeof candidate.extractor === "string" ? candidate.extractor.trim() : "";
    if (!extractor) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": missing extractor identity`);
      continue;
    }

    const provenance = candidate.provenance;
    const excerpt =
      provenance && typeof provenance.excerpt === "string" ? provenance.excerpt.trim() : "";
    if (!excerpt) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": missing provenance excerpt`);
      continue;
    }

    // Provenance contract enforcement. The excerpt must occur verbatim in the
    // chunk text the provider actually saw (never merely asserted); the offset is
    // then shifted into `fullText` and re-verified there before the locator is
    // trusted. Anchoring to the chunk (not `fullText.indexOf`) keeps a value that
    // repeats across cards pinned to the specific card/chunk it was drawn from.
    const localIndex = chunkContent.indexOf(excerpt);
    if (localIndex === -1) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": excerpt not found in prepared content`);
      continue;
    }
    const globalIndex = chunkStart + localIndex;
    if (fullText.slice(globalIndex, globalIndex + excerpt.length) !== excerpt) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": excerpt not found in prepared content`);
      continue;
    }
    const locator = `chars:${globalIndex}-${globalIndex + excerpt.length}`;

    const rawConfidence = candidate.confidence;
    if (typeof rawConfidence !== "number" || !Number.isFinite(rawConfidence)) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": non-numeric confidence`);
      continue;
    }
    let confidence = rawConfidence;
    if (confidence < 0 || confidence > 1) {
      confidence = Math.max(0, Math.min(1, confidence));
      warnings.push(`clamped out-of-range confidence for "${effectiveFieldPath}" to ${confidence}`);
    }

    const proposal: ExtractionProposal = {
      fieldPath: effectiveFieldPath,
      candidateValue: candidate.candidateValue,
      confidence,
      provenance: { excerpt, locator },
      extractor,
    };
    if (pathIndices !== undefined) proposal.pathIndices = pathIndices;
    proposals.push(proposal);
  }

  return { proposals, warnings };
}

/**
 * Strips `[n]` (integer) segments from a caller/provider-supplied fieldPath
 * down to `[]`, consistently at every level — `"a[2].b[0].c"` normalizes to
 * `"a[].b[].c"` with `indices: [2, 0]` (left-to-right, outermost-first source
 * order). Used ONLY as a fallback when the raw fieldPath does not already
 * match a declared `targetSchema` path — see the EXCEPTION note in the
 * module docstring above and `docs/adr/0003-indexed-path-normalization.md`.
 *
 * `indices` is empty when `path` has no `[n]` segments, in which case
 * `normalized === path` and the caller should treat this as "nothing to
 * normalize" rather than a match.
 */
function normalizeIndexedFieldPath(path: string): { normalized: string; indices: number[] } {
  const indices: number[] = [];
  const normalized = path.replace(/\[(\d+)\]/g, (_match, digits: string) => {
    indices.push(Number(digits));
    return "[]";
  });
  return { normalized, indices };
}
