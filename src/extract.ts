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
 * src/chunk.ts and docs/adr/0004-large-page-chunking.md). Chunks dispatch in
 * bounded waves: concurrency and batch size both default to one, preserving the
 * historical sequential behavior until a caller opts in.
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
import { validateExtractionTaskSpec } from "./task.js";
import { normalizeProviderFailure, unsupportedProviderCapability } from "./provider-conformance.js";
import type { PreparedChunks } from "./chunk.js";
import { imageBytesRequiredError, pdfBytesRequiredError, prepareImageText, preparePdfText } from "./content-prep.js";
import { createPreparedArtifact } from "./prepared-artifact.js";
import { ExactOccurrenceResolver } from "./occurrence-resolver.js";
import { randomUUID } from "node:crypto";
import type { PreparedArtifact, PreparedArtifactPreparationMode } from "./prepared-artifact.js";
import type {
  ExtractInput,
  ExtractionProposal,
  ExtractionProviderFailure,
  ExtractionResult,
  ExtractionPartial,
  PdfLayout,
  ProviderExtractionInput,
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
const IMAGE_FULL_TEXT_CAP = 5_000_000;

function preparationModeFor(
  prepared: PreparedChunks,
  usedPdfExtractor: boolean,
  usedImageExtractor: boolean,
): PreparedArtifactPreparationMode {
  if (usedPdfExtractor) return "pdf-text";
  if (usedImageExtractor) return "image-ocr";
  return prepared.effectivePrepMode;
}

const DEFAULT_MAX_CONTENT_CHARS = 32_000;

const EMPTY_RAW: RawProviderResponse = { response: "", model: "" };

interface ChunkDispatch {
  index: number;
  content: string;
}

interface ChunkOutcome extends ChunkDispatch {
  output?: ProviderExtractionOutput;
  error?: unknown;
}

function isImageContentType(contentType: ExtractInput["contentType"]): boolean {
  return contentType === "png" || contentType === "jpeg";
}

interface BoundedDispatchResult {
  outcomes: Array<ChunkOutcome | undefined>;
  providerCalls: number;
  totalTokensUsed: number;
  partial?: ExtractionPartial;
  warnings: string[];
}

/**
 * Reserve and dispatch bounded waves without folding their results. Keeping
 * dispatch separate makes the concurrency/budget state independently testable;
 * `extract()` owns the deterministic index-order normalization/fold below.
 */
async function dispatchBoundedWaves(
  input: ExtractInput,
  chunks: PreparedChunks["chunks"],
  maxChars: number,
): Promise<BoundedDispatchResult> {
  const outcomes: Array<ChunkOutcome | undefined> = new Array(chunks.length);
  const warnings: string[] = [];
  let providerCalls = 0;
  let totalTokensUsed = 0;
  let nextChunk = 0;
  let partial: ExtractionPartial | undefined;
  const requestedConcurrency = input.concurrency ?? 1;
  const providerConcurrency = input.provider.capabilities?.maxConcurrency;
  const effectiveConcurrency = Math.min(
    requestedConcurrency,
    Number.isInteger(providerConcurrency) && providerConcurrency! > 0 ? providerConcurrency! : requestedConcurrency,
  );
  const requestedBatchSize = input.batchSize ?? 1;
  const providerBatchSize = input.provider.capabilities?.maxBatchSize;
  const effectiveBatchSize = input.provider.extractBatch
    ? Math.min(
      requestedBatchSize,
      Number.isInteger(providerBatchSize) && providerBatchSize! > 0 ? providerBatchSize! : requestedBatchSize,
    )
    : 1;
  const partialState = (reason: ExtractionPartial["reason"], remainingChunks: number): ExtractionPartial => {
    const tokenOvershoot = input.maxTotalTokens === undefined ? 0 : totalTokensUsed - input.maxTotalTokens;
    return {
      reason,
      completedChunks: nextChunk,
      remainingChunks,
      ...(tokenOvershoot > 0 ? { tokenOvershoot } : {}),
    };
  };

  // Calls are reserved before Promise.all starts so maxProviderCalls cannot be
  // exceeded by concurrently launched work.
  while (nextChunk < chunks.length) {
    const remainingChunks = chunks.length - nextChunk;
    if (input.signal?.aborted) {
      partial = partialState("cancelled", remainingChunks);
      warnings.push(`stopped after ${providerCalls} provider call(s): cancelled; ${remainingChunks} chunk(s) not processed`);
      break;
    }
    if (input.maxProviderCalls !== undefined && providerCalls >= input.maxProviderCalls) {
      partial = partialState("max-provider-calls", remainingChunks);
      warnings.push(
        `stopped after ${providerCalls} provider call(s): maxProviderCalls (${input.maxProviderCalls}) reached; ${remainingChunks} chunk(s) not processed`,
      );
      break;
    }
    if (input.maxTotalTokens !== undefined && totalTokensUsed >= input.maxTotalTokens) {
      partial = partialState("max-total-tokens", remainingChunks);
      warnings.push(
        `stopped after ${providerCalls} provider call(s): maxTotalTokens (${input.maxTotalTokens}) reached (${totalTokensUsed} tokens used); ${remainingChunks} chunk(s) not processed`,
      );
      break;
    }

    const callSlots = input.maxProviderCalls === undefined
      ? effectiveConcurrency
      : Math.min(effectiveConcurrency, input.maxProviderCalls - providerCalls);
    const wave: ChunkDispatch[][] = [];
    while (nextChunk < chunks.length && wave.length < callSlots) {
      const group: ChunkDispatch[] = [];
      while (nextChunk < chunks.length && group.length < effectiveBatchSize) {
        const chunk = chunks[nextChunk];
        group.push({ index: nextChunk, content: chunk.text.slice(0, maxChars) });
        nextChunk++;
      }
      wave.push(group);
    }

    // Reservation happens before dispatch, one count per physical operation,
    // including one extractBatch() operation for a multi-input group.
    providerCalls += wave.length;
    const waveOutcomes = await Promise.all(wave.map(async (group): Promise<ChunkOutcome[]> => {
      const requests: ProviderExtractionInput[] = group.map(({ content }) => ({
        content,
        contentType: input.contentType,
        targetSchema: input.targetSchema,
        fieldHints: input.fieldHints,
        ...(input.taskSpec ? { taskSpec: input.taskSpec } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }));
      try {
        const batchOutcomes = group.length > 1 && input.provider.extractBatch
          ? await input.provider.extractBatch(requests)
          : [{ status: "fulfilled" as const, value: await input.provider.extract(requests[0]) }];
        if (!Array.isArray(batchOutcomes) || batchOutcomes.length !== group.length) {
          throw new Error(`provider batch returned ${Array.isArray(batchOutcomes) ? batchOutcomes.length : "non-array"} outcome(s) for ${group.length} input(s)`);
        }
        return group.map((dispatch, index) => {
          const outcome = batchOutcomes[index];
          return outcome.status === "fulfilled"
            ? { ...dispatch, output: outcome.value }
            : { ...dispatch, error: outcome.reason };
        });
      } catch (error) {
        return group.map((dispatch) => ({ ...dispatch, error }));
      }
    }));
    for (const group of waveOutcomes) {
      for (const outcome of group) outcomes[outcome.index] = outcome;
    }
    // Token usage is knowable only after the entire bounded wave completes.
    for (const group of waveOutcomes) {
      for (const outcome of group) {
        if (outcome.output && typeof outcome.output.raw?.tokensUsed === "number") {
          totalTokensUsed += outcome.output.raw.tokensUsed;
        }
      }
    }
  }

  return { outcomes, providerCalls, totalTokensUsed, ...(partial ? { partial } : {}), warnings };
}

export async function extract(input: ExtractInput): Promise<ExtractionResult> {
  const extractedAt = new Date().toISOString();
  const sourceRef = input.sourceRef;
  const provider = input.provider.name;
  const runId = `traverse-extraction-run:${randomUUID()}`;
  const maxChars = input.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;

  try {
    if (input.taskSpec) {
      const taskError = validateExtractionTaskSpec(input.taskSpec, input.targetSchema);
      if (taskError) return { proposals: [], raw: EMPTY_RAW, extractedAt, sourceRef, provider, runId, error: `invalid taskSpec: ${taskError}`, providerCalls: 0, totalTokensUsed: 0 };
    }
    const unsupportedCapability = unsupportedProviderCapability(input);
    if (unsupportedCapability) return {
      proposals: [], raw: EMPTY_RAW, extractedAt, sourceRef, provider, runId,
      error: `provider ${input.provider.name} does not support required capability "${unsupportedCapability}"`,
      providerCalls: 0, totalTokensUsed: 0,
    };
    // Invalid-config validation: pure input validation independent of
    // content, so it runs before prepareAndChunk (before any content-prep or
    // provider work). maxProviderCalls is validated first.
    if (input.maxProviderCalls !== undefined) {
      const v = input.maxProviderCalls;
      if (!(Number.isInteger(v) && v > 0)) {
        return {
          proposals: [],
          raw: EMPTY_RAW,
          extractedAt, sourceRef, provider, runId,
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
          extractedAt, sourceRef, provider, runId,
          error: `invalid maxTotalTokens: must be a positive finite number (got ${JSON.stringify(v)})`,
          providerCalls: 0,
          totalTokensUsed: 0,
        };
      }
    }
    if (input.concurrency !== undefined) {
      const v = input.concurrency;
      if (!(Number.isInteger(v) && v > 0)) {
        return {
          proposals: [], raw: EMPTY_RAW, extractedAt, sourceRef, provider, runId,
          error: `invalid concurrency: must be a positive integer (got ${JSON.stringify(v)})`,
          providerCalls: 0, totalTokensUsed: 0,
        };
      }
    }
    if (input.batchSize !== undefined) {
      const v = input.batchSize;
      if (!(Number.isInteger(v) && v > 0)) {
        return {
          proposals: [], raw: EMPTY_RAW, extractedAt, sourceRef, provider, runId,
          error: `invalid batchSize: must be a positive integer (got ${JSON.stringify(v)})`,
          providerCalls: 0, totalTokensUsed: 0,
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
    let pdfLayout: PdfLayout | undefined;
    let ocrDerived = false;
    if (input.contentType === "pdf" && input.pdfTextExtractor) {
      if (!(input.content instanceof Uint8Array)) {
        return {
          proposals: [],
          raw: EMPTY_RAW,
          extractedAt, sourceRef, provider, runId,
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
          extractedAt, sourceRef, provider, runId,
          error: pdfPrep.error,
          providerCalls: 0,
          totalTokensUsed: 0,
        };
      }
      pdfPageOffsets = pdfPrep.pageOffsets;
      pdfLayout = pdfPrep.layout;
      prepared = prepareAndChunk(pdfPrep.text, "text", {
        chunkSize: input.chunkSize,
        chunkOverlap: input.chunkOverlap,
        maxChunks: input.maxChunks,
      });
      prepared.warnings = [...pdfPrep.warnings, ...prepared.warnings];
    } else if (isImageContentType(input.contentType) && input.imageTextExtractor) {
      if (!(input.content instanceof Uint8Array)) {
        return {
          proposals: [],
          raw: EMPTY_RAW,
          extractedAt, sourceRef, provider, runId,
          error: imageBytesRequiredError(),
          providerCalls: 0,
          totalTokensUsed: 0,
        };
      }
      const imagePrep = await prepareImageText(input.content, input.imageTextExtractor, IMAGE_FULL_TEXT_CAP);
      if (imagePrep.error !== undefined) {
        return {
          proposals: [],
          raw: EMPTY_RAW,
          extractedAt, sourceRef, provider, runId,
          error: imagePrep.error,
          providerCalls: 0,
          totalTokensUsed: 0,
        };
      }
      ocrDerived = true;
      prepared = prepareAndChunk(imagePrep.text, "text", {
        chunkSize: input.chunkSize,
        chunkOverlap: input.chunkOverlap,
        maxChunks: input.maxChunks,
      });
      prepared.warnings = [...imagePrep.warnings, ...prepared.warnings];
    } else {
      prepared = prepareAndChunk(input.content, input.contentType, {
        prep: input.prep,
        chunkSize: input.chunkSize,
        chunkOverlap: input.chunkOverlap,
        maxChunks: input.maxChunks,
      });
    }
    if (prepared.error !== undefined) {
      return { proposals: [], raw: EMPTY_RAW, extractedAt, sourceRef, provider, runId, error: prepared.error, providerCalls: 0, totalTokensUsed: 0 };
    }

    const { fullText, chunks } = prepared;
    const occurrenceResolver = new ExactOccurrenceResolver();
    const warnings: string[] = [...prepared.warnings];
    const preparedArtifact: PreparedArtifact = createPreparedArtifact(fullText, {
      preparationMode: preparationModeFor(prepared, input.contentType === "pdf" && !!input.pdfTextExtractor, ocrDerived),
      preparationVersion: input.preparedArtifact?.preparationVersion,
      sourceSnapshotRef: input.preparedArtifact?.sourceSnapshotRef,
    });
    if (input.preparedArtifact?.store?.put) {
      try {
        await input.preparedArtifact.store.put(preparedArtifact, fullText);
      } catch (error) {
        warnings.push("prepared artifact storage failed; exact text is unavailable from the configured store");
      }
    }
    const collected: ExtractionProposal[] = [];
    let lastRaw: RawProviderResponse = EMPTY_RAW;
    const providerErrors: string[] = [];
    const providerFailures: ExtractionProviderFailure[] = [];
    let chunksSucceeded = 0;
    const dispatched = await dispatchBoundedWaves(input, chunks, maxChars);
    warnings.push(...dispatched.warnings);
    const { outcomes, providerCalls, totalTokensUsed, partial } = dispatched;

    // Fold completed work strictly by original chunk index. Completion timing
    // therefore cannot alter proposal ordering, warnings, raw audit output, or
    // exact locator derivation.
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      if (!outcome) continue;
      if (outcome.error !== undefined) {
        const failure = normalizeProviderFailure(input.provider, outcome.error);
        providerFailures.push(failure);
        providerErrors.push(failure.message);
        warnings.push(`chunk ${i + 1}/${chunks.length} provider call failed: ${failure.message}`);
        continue;
      }
      const output = outcome.output as ProviderExtractionOutput;
      chunksSucceeded++;
      if (output.warnings) warnings.push(...output.warnings);
      if (output.raw) lastRaw = output.raw;
      try {
        const { proposals: chunkProposals, warnings: normalizationWarnings } = normalizeChunkProposals(
          output.proposals, input, outcome.content, chunks[i].start, fullText, occurrenceResolver,
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
        sourceRef,
        provider,
        runId,
        error: providerErrors[0],
        providerCalls,
        totalTokensUsed,
        ...(partial ? { partial } : {}),
        ...(providerFailures.length ? { providerFailures } : {}),
      };
      if (prepared.embedded) failed.embedded = prepared.embedded;
      if (pdfPageOffsets) failed.pdfPageOffsets = pdfPageOffsets;
      if (pdfLayout) failed.pdfLayout = pdfLayout;
      if (ocrDerived) failed.ocrDerived = true;
      failed.preparedArtifact = preparedArtifact;
      return failed;
    }

    const { proposals, dropped } = dedupeProposals(collected);
    if (dropped > 0) {
      warnings.push(
        `dropped ${dropped} duplicate proposal${dropped === 1 ? "" : "s"} (same field + value + source span)`,
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

    const result: ExtractionResult = {
      proposals, raw: lastRaw, extractedAt, sourceRef, provider, runId, providerCalls, totalTokensUsed,
      ...(partial ? { partial } : {}),
      ...(input.taskSpec ? { taskDigest: input.taskSpec.digest, exampleDigests: input.taskSpec.examples?.map((example) => example.digest) ?? [] } : {}),
      ...(providerFailures.length ? { providerFailures } : {}),
    };
    if (warnings.length > 0) result.warnings = warnings;
    // Attach the whole-page embedded-state sidecar once (never per chunk).
    if (prepared.embedded) result.embedded = prepared.embedded;
    if (pdfPageOffsets) result.pdfPageOffsets = pdfPageOffsets;
    if (pdfLayout) result.pdfLayout = pdfLayout;
    if (ocrDerived) result.ocrDerived = true;
    result.preparedArtifact = preparedArtifact;
    return result;
  } catch (err) {
    return {
      proposals: [],
      raw: EMPTY_RAW,
      extractedAt,
      sourceRef,
      provider,
      runId,
      error: err instanceof Error ? err.message : String(err),
      providerCalls: 0,
      totalTokensUsed: 0,
    };
  }
}

/**
 * Cross-chunk dedup. A duplicate is the SAME field extracted from the SAME
 * verified source span AND the same candidate value — i.e. `fieldPath` +
 * `pathIndices` + canonical value + `locator` (which encodes the
 * `chars:<start>-<end>` offset into `fullText`). This collapses the true
 * duplicates chunking creates while preserving same-span/different-value and
 * same-value/different-span proposals. Keeps the highest confidence on a
 * collision; first-seen key order is preserved.
 */
function dedupeProposals(input: ExtractionProposal[]): { proposals: ExtractionProposal[]; dropped: number } {
  const byKey = new Map<string, ExtractionProposal>();
  const order: string[] = [];
  let dropped = 0;

  for (const proposal of input) {
    const key = stableProposalIdentity(
      proposal.fieldPath,
      proposal.pathIndices,
      proposal.candidateValue,
      proposal.provenance.locator,
    );

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
 * chunk text (`chunkContent`) the provider saw before every exact match in the
 * complete prepared artifact is enumerated and deterministically selected.
 */
function normalizeChunkProposals(
  raw: unknown,
  input: ExtractInput,
  chunkContent: string,
  chunkStart: number,
  fullText: string,
  occurrenceResolver: ExactOccurrenceResolver,
): { proposals: ExtractionProposal[]; warnings: string[] } {
  const warnings: string[] = [];
  const proposals: ExtractionProposal[] = [];

  if (!Array.isArray(raw)) {
    warnings.push("provider returned no proposals array");
    return { proposals, warnings };
  }

  const schemaByPath = new Map(input.targetSchema.map((f) => [f.path, f] as const));

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
    if (!schemaByPath.has(fieldPath)) {
      // Not a direct match — try normalizing indexed segments ("[0]" -> "[]",
      // consistently at every level) against a declared array path before
      // giving up. This recovers proposals like "schedules[0].startDate"
      // against a schema that only declares "schedules[].startDate" — see
      // docs/adr/0003-indexed-path-normalization.md.
      const { normalized, indices } = normalizeIndexedFieldPath(fieldPath);
      if (indices.length > 0 && schemaByPath.has(normalized)) {
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

    // Provenance contract enforcement begins with the exact chunk text the
    // provider saw. It then enumerates exact matches across the complete
    // prepared artifact; no fuzzy/near-match path can produce a chars: locator.
    const localIndex = chunkContent.indexOf(excerpt);
    if (localIndex === -1) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": excerpt not found in prepared content`);
      continue;
    }
    const sourceOrderKey = stableProposalIdentity(effectiveFieldPath, pathIndices, candidate.candidateValue, excerpt);
    const occurrence = occurrenceResolver.resolve({
      text: fullText,
      visibleText: chunkContent,
      visibleStart: chunkStart,
      excerpt,
      occurrenceHint: candidate.occurrenceHint,
      sourceOrderKey,
    });
    if (!occurrence || fullText.slice(occurrence.selected.start, occurrence.selected.end) !== excerpt) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": excerpt not found in prepared content`);
      continue;
    }
    const locator = `chars:${occurrence.selected.start}-${occurrence.selected.end}`;

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
      provenance: { excerpt, locator, occurrence },
      extractor,
    };
    if (pathIndices !== undefined) proposal.pathIndices = pathIndices;
    const matchedSchema = schemaByPath.get(effectiveFieldPath);
    if (matchedSchema?.inferenceType !== undefined) proposal.inferenceType = matchedSchema.inferenceType;
    if (matchedSchema?.type !== undefined) proposal.valueType = matchedSchema.type;
    if (matchedSchema?.enumValues?.length) proposal.enumValues = [...matchedSchema.enumValues];
    proposals.push(proposal);
  }

  return { proposals, warnings };
}

/** A stable identity for source-ordered allocation and true-duplicate folding. */
function stableProposalIdentity(
  fieldPath: string,
  pathIndices: number[] | undefined,
  candidateValue: unknown,
  excerpt: string,
): string {
  return JSON.stringify([fieldPath, pathIndices ?? null, stableValue(candidateValue), excerpt]);
}

/**
 * Canonicalize arbitrary provider values without allowing object key insertion
 * order to change resolver allocation or deduplication. Unsupported/cyclic
 * values remain deterministic typed markers rather than escaping as an error.
 */
function stableValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null) return ["null"];
  switch (typeof value) {
    case "string": return ["string", value];
    case "boolean": return ["boolean", value];
    case "undefined": return ["undefined"];
    case "number": return ["number", Number.isNaN(value) ? "NaN" : value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : value];
    case "bigint": return ["bigint", value.toString()];
    case "symbol": return ["symbol", String(value)];
    case "function": return ["function", String(value)];
    case "object": {
      if (seen.has(value)) return ["circular"];
      seen.add(value);
      if (Array.isArray(value)) return ["array", value.map((entry) => stableValue(entry, seen))];
      const record = value as Record<string, unknown>;
      return ["object", Object.keys(record).sort().map((key) => [key, stableValue(record[key], seen)])];
    }
  }
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
