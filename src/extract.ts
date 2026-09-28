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
 * in the common single-chunk case), with a warning naming the unsent range.
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
 * `extract()` surface a `result.error`. `result.coverage` records, per chunk,
 * which prepared-text range was read and answered, and any range that was not
 * (a failed call, a cut at `maxContentChars`, an output cap, a missing tool
 * call, or a chunk never dispatched) also makes the run `partial`.
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
 *  - `extractor` MUST be a non-empty string and a stable identity the
 *    portable envelope accepts; otherwise the item is dropped,
 *  - the proposal MUST carry provenance with a non-empty, well-formed Unicode
 *    `excerpt`; otherwise the item is dropped,
 *  - `candidateValue` MUST be representable as lossless portable JSON (`-0`
 *    is normalized to `0`); `undefined`, `NaN`, non-plain objects and the like
 *    drop the item. These representability checks share the envelope's own
 *    predicates and run before occurrence resolution, so a dropped item never
 *    shifts a surviving neighbour's locator,
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
 *  - `confidence` is an OPTIONAL provider self-report and never drops a
 *    proposal. Missing or `null` is omitted silently; a non-finite or
 *    non-numeric value is omitted with a warning. `-0` is normalized to `0`
 *    (at any depth for `candidateValue` too). An in-range value passes
 *    through; an out-of-range value is CLAMPED into `0..1` with a warning. The
 *    bundled adapters pass finite out-of-range values through to this clamp.
 *
 * `warnings` on the final `ExtractionResult` merges BOTH of the above
 * normalization notes AND any `warnings` the provider itself returned (e.g.
 * the Anthropic adapter's malformed-tool-item / maxTokens-truncation notes) —
 * nothing either stage notices is silent.
 */

import { prepareAndChunk } from "./chunk.js";
import { canonicalTaskJson, checkExtractionTaskSpec } from "./task.js";
import { normalizeProviderFailure, unsupportedProviderCapability } from "./provider-conformance.js";
import type { PreparedChunks } from "./chunk.js";
import { imageBytesRequiredError, pdfBytesRequiredError, prepareImageText, preparePdfText } from "./content-prep.js";
import { createPreparedArtifact, isWellFormedUnicode } from "./prepared-artifact.js";
import { isPortableJsonValue, isPortableStableIdentity } from "./extraction-result-envelope.js";
import { ExactOccurrenceResolver } from "./occurrence-resolver.js";
import { createHash, randomUUID } from "node:crypto";
import type { PreparedArtifact, PreparedArtifactPreparationMode } from "./prepared-artifact.js";
import type {
  ExtractInput,
  ExtractionProposal,
  ExtractionProviderFailure,
  ExtractionResult,
  ExtractionPartial,
  ExtractionPartialReason,
  ExtractionCoverageEntry,
  ExtractionProducedBy,
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

/** Fallback: adapter warning meaning a chunk's answer stopped at the output cap. */
const OUTPUT_TRUNCATED_ADAPTER_WARNING = /^response truncated at maxTokens/;
/** Fallback: adapter warning meaning no extraction tool call came back for a chunk. */
const MISSING_TOOL_CALL_ADAPTER_WARNING = /^provider returned no extraction (?:tool|function) call/;
/** Written (located on the chunk) when a typed signal reports a loss the adapter did not warn about. */
const OUTPUT_TRUNCATED_WARNING = "response truncated at maxTokens; proposals may be incomplete";
const MISSING_TOOL_CALL_WARNING = "provider returned no extraction tool call";

/** The partial reason a dispatched chunk's loss reports when no early stop applies. */
function lossPartialReason(entry: ExtractionCoverageEntry): ExtractionPartialReason | undefined {
  if (entry.status === "output-truncated") return "output-truncated";
  if (entry.status !== "unread") return undefined;
  switch (entry.reason) {
    case "provider-failure": case "missing-tool-call": return "provider-failure";
    case "content-truncated": return "content-truncated";
    default: return undefined;
  }
}

interface ChunkDispatch {
  index: number;
  content: string;
}

interface ChunkOutcome extends ChunkDispatch {
  /** Digest of the request this chunk was sent as; see `ExtractionProducedBy.requestDigest`. */
  requestDigest: string;
  output?: ProviderExtractionOutput;
  error?: unknown;
}

/**
 * Content-free digest of one provider request. Correlation-only fields
 * (`signal`, `chunkIndex`, `runId`) are excluded, so the digest names what was
 * asked, not when.
 */
function providerRequestDigest(request: ProviderExtractionInput): string {
  const { content, contentType, targetSchema, fieldHints, taskSpec } = request;
  const canonical = canonicalTaskJson({ content, contentType, targetSchema, fieldHints, taskSpec });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
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
  runId: string,
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
      const requests: ProviderExtractionInput[] = group.map(({ index, content }) => ({
        content,
        contentType: input.contentType,
        targetSchema: input.targetSchema,
        fieldHints: input.fieldHints,
        ...(input.taskSpec ? { taskSpec: input.taskSpec } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        chunkIndex: index,
        runId,
      }));
      const digests = requests.map(providerRequestDigest);
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
            ? { ...dispatch, requestDigest: digests[index], output: outcome.value }
            : { ...dispatch, requestDigest: digests[index], error: outcome.reason };
        });
      } catch (error) {
        return group.map((dispatch, index) => ({ ...dispatch, requestDigest: digests[index], error }));
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
    // The provider name becomes the portable envelope's provider identity and
    // every failure's provider; it is caller configuration, so reject it up
    // front rather than after spending provider calls.
    if (!isPortableStableIdentity(provider)) {
      return {
        proposals: [], raw: EMPTY_RAW, extractedAt, sourceRef, provider, runId,
        error: `invalid provider name: must be a credential-free stable identity (got ${JSON.stringify(provider)})`,
        providerCalls: 0, totalTokensUsed: 0,
      };
    }
    const taskSpecWarnings: string[] = [];
    if (input.taskSpec) {
      const { error: taskError, legacyDigests } = checkExtractionTaskSpec(input.taskSpec, input.targetSchema);
      if (legacyDigests.length > 0) {
        taskSpecWarnings.push(`taskSpec uses the legacy locale-dependent digest (${legacyDigests.join(", ")}); regenerate it with createExtractionTaskSpec`);
      }
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
    const warnings: string[] = [...taskSpecWarnings, ...prepared.warnings];
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
    const coverage: ExtractionCoverageEntry[] = [];
    let lastRaw: RawProviderResponse = EMPTY_RAW;
    const providerErrors: string[] = [];
    const providerFailures: ExtractionProviderFailure[] = [];
    let chunksSucceeded = 0;
    const dispatched = await dispatchBoundedWaves(input, chunks, maxChars, runId);
    warnings.push(...dispatched.warnings);
    const { outcomes, providerCalls, totalTokensUsed } = dispatched;
    let partial = dispatched.partial;

    // Fold completed work strictly by original chunk index. Completion timing
    // therefore cannot alter proposal ordering, warnings, raw audit output, or
    // exact locator derivation.
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = outcomes[i];
      if (!outcome) {
        coverage.push({ chunk: i + 1, start: chunks[i].start, end: chunks[i].end, status: "unread", reason: "not-dispatched" });
        continue;
      }
      // Every loss below names the chunk and the prepared-text range it left
      // unread (or not fully answered). Each call carries every target field,
      // so the range applies to all of them.
      const chunkLabel = `chunk ${i + 1}/${chunks.length}`;
      const sentEnd = chunks[i].start + outcome.content.length;
      if (sentEnd < chunks[i].end) {
        warnings.push(
          `${chunkLabel} content truncated at maxContentChars (${maxChars}): chars:${sentEnd}-${chunks[i].end} not sent to the provider`,
        );
        coverage.push({ chunk: i + 1, start: sentEnd, end: chunks[i].end, status: "unread", reason: "content-truncated" });
      }
      // The part that was sent: [chunk start, sentEnd). Empty only when
      // maxContentChars is 0, in which case the tail entry covers the chunk.
      const sent = (entry: Pick<ExtractionCoverageEntry, "status" | "reason">) => {
        if (sentEnd > chunks[i].start) coverage.push({ chunk: i + 1, start: chunks[i].start, end: sentEnd, ...entry });
      };
      if (outcome.error !== undefined) {
        sent({ status: "unread", reason: "provider-failure" });
        const failure = normalizeProviderFailure(input.provider, outcome.error);
        providerFailures.push(failure);
        providerErrors.push(failure.message);
        warnings.push(`${chunkLabel} provider call failed: ${failure.message} (chars:${chunks[i].start}-${sentEnd} not read)`);
        continue;
      }
      const output = outcome.output as ProviderExtractionOutput;
      chunksSucceeded++;
      // Adapter warnings that mean the answer for this chunk is incomplete are
      // located here, since only the core knows which chunk a call served.
      // The adapter's typed signal decides; a warning prefix is only the
      // fallback for providers that do not set it. Whatever decides, the
      // located warning below is written exactly when the loss is recorded,
      // so the envelope's warning codes and its outcome always agree.
      const adapterWarnings = output.warnings ?? [];
      const missingToolCall = typeof output.missingToolCall === "boolean"
        ? output.missingToolCall
        : adapterWarnings.some((warning) => MISSING_TOOL_CALL_ADAPTER_WARNING.test(warning));
      const outputTruncated = typeof output.truncated === "boolean"
        ? output.truncated
        : adapterWarnings.some((warning) => OUTPUT_TRUNCATED_ADAPTER_WARNING.test(warning));
      const located = (warning: string) => `${chunkLabel} (chars:${chunks[i].start}-${sentEnd}): ${warning}`;
      warnings.push(...adapterWarnings.map((warning) =>
        (missingToolCall && MISSING_TOOL_CALL_ADAPTER_WARNING.test(warning)) ||
        (outputTruncated && OUTPUT_TRUNCATED_ADAPTER_WARNING.test(warning))
          ? located(warning)
          : warning));
      if (missingToolCall && !adapterWarnings.some((warning) => MISSING_TOOL_CALL_ADAPTER_WARNING.test(warning))) {
        warnings.push(located(MISSING_TOOL_CALL_WARNING));
      }
      if (outputTruncated && !adapterWarnings.some((warning) => OUTPUT_TRUNCATED_ADAPTER_WARNING.test(warning))) {
        warnings.push(located(OUTPUT_TRUNCATED_WARNING));
      }
      if (output.raw) {
        lastRaw = output.raw;
        // raw.model becomes the envelope's model identity. Omit one the
        // envelope cannot carry rather than failing the whole result.
        if (lastRaw.model !== "" && !isPortableStableIdentity(lastRaw.model)) {
          warnings.push(`provider returned a model identity that is not a stable identity; omitted ${JSON.stringify(lastRaw.model)}`);
          lastRaw = { ...lastRaw, model: "" };
        }
      }
      const producedBy = producedByFor(output, outcome.requestDigest);
      // An answer core cannot use (no proposals array, or normalization threw)
      // leaves the chunk unanswered, like a failed call.
      let unusableAnswer = false;
      try {
        const { proposals: chunkProposals, warnings: normalizationWarnings, unusable } = normalizeChunkProposals(
          output.proposals, input, outcome.content, chunks[i].start, fullText, occurrenceResolver,
        );
        unusableAnswer = unusable;
        warnings.push(...normalizationWarnings);
        // Each proposal is attributed to the call that served its own chunk,
        // so a run that fell back to another model part-way stays attributable.
        if (producedBy) for (const proposal of chunkProposals) proposal.producedBy = { ...producedBy };
        collected.push(...chunkProposals);
      } catch (err) {
        unusableAnswer = true;
        warnings.push(
          `chunk ${i + 1}/${chunks.length} normalization failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // No tool call means nothing was answered, whatever stopped the model.
      sent(missingToolCall
        ? { status: "unread", reason: "missing-tool-call" }
        : unusableAnswer
          ? { status: "unread", reason: "provider-failure" }
          : { status: outputTruncated ? "output-truncated" : "complete" });
    }

    // Chunks cut by maxChunks whose text is still in the prepared artifact
    // continue the chunk numbering; they were never dispatched.
    prepared.cappedChunks?.forEach((chunk, k) => {
      coverage.push({ chunk: chunks.length + k + 1, start: chunk.start, end: chunk.end, status: "unread", reason: "not-dispatched" });
    });
    coverage.sort((a, b) => a.start - b.start || a.end - b.end);

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
        coverage,
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
      // Truncation is a partial stop, not routine chunking: the capped chunks
      // were never dispatched, so the run did not read the whole document —
      // the same honesty max-provider-calls already reports. An earlier stop
      // (cancel, call cap, token cap) keeps its own reason, but its
      // remainingChunks was counted against the capped set only — the
      // truncated tail was never dispatched either, and remainingChunks
      // means exactly "never dispatched".
      if (!partial) {
        partial = { reason: "max-chunks", completedChunks: chunks.length, remainingChunks: prepared.truncatedChunks };
      } else {
        partial = { ...partial, remainingChunks: partial.remainingChunks + prepared.truncatedChunks };
      }
    }
    // A dispatched chunk that was not fully read or answered makes the run
    // partial too. An early stop above keeps its own reason; otherwise the
    // first loss in prepared-text order is reported, and coverage has the rest.
    if (!partial) {
      const reason = coverage.map(lossPartialReason).find((candidate) => candidate !== undefined);
      if (reason) partial = { reason, completedChunks: chunks.length, remainingChunks: 0 };
    }

    const result: ExtractionResult = {
      proposals, raw: lastRaw, extractedAt, sourceRef, provider, runId, providerCalls, totalTokensUsed,
      ...(partial ? { partial } : {}),
      coverage,
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
 * The served-model record for one chunk's call, or undefined when the call
 * reported no model the envelope could carry. An unrecognized `modelSource`
 * is dropped rather than guessed.
 */
function producedByFor(output: ProviderExtractionOutput, requestDigest: string): ExtractionProducedBy | undefined {
  const model = output.raw?.model;
  if (!isPortableStableIdentity(model)) return undefined;
  const modelSource = output.raw.modelSource;
  return {
    model,
    ...(modelSource === "provider-reported" || modelSource === "configured" ? { modelSource } : {}),
    requestDigest,
  };
}

/**
 * Cross-chunk dedup. A duplicate is the SAME field extracted from the SAME
 * verified source span AND the same candidate value — i.e. `fieldPath` +
 * `pathIndices` + canonical value + `locator` (which encodes the
 * `chars:<start>-<end>` offset into `fullText`). This collapses the true
 * duplicates chunking creates while preserving same-span/different-value and
 * same-value/different-span proposals. Keeps the first-seen proposal in chunk
 * order, whole, regardless of any self-reported confidence, so the kept
 * proposal's `extractor`, `producedBy` and metadata are deterministic.
 * First-seen key order is preserved.
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
): { proposals: ExtractionProposal[]; warnings: string[]; unusable: boolean } {
  const warnings: string[] = [];
  const proposals: ExtractionProposal[] = [];

  if (!Array.isArray(raw)) {
    warnings.push("provider returned no proposals array");
    return { proposals, warnings, unusable: true };
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
    // Envelope-representability checks run BEFORE occurrence resolution: a
    // proposal dropped after resolve() has already consumed an allocation and
    // would shift a valid neighbour's locator.
    if (!isPortableStableIdentity(extractor)) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": extractor is not a stable identity`);
      continue;
    }

    const provenance = candidate.provenance;
    const excerpt =
      provenance && typeof provenance.excerpt === "string" ? provenance.excerpt.trim() : "";
    if (!excerpt) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": missing provenance excerpt`);
      continue;
    }
    if (!isWellFormedUnicode(excerpt)) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": excerpt is ill-formed Unicode`);
      continue;
    }
    // JSON writes -0 as 0, so normalizing it loses nothing, at any depth: a -0
    // nested inside an object or array used to fail assertJsonSafe just like a
    // top-level one, and dropped the whole proposal over a value the envelope
    // could carry once rewritten.
    const candidateValue = normalizeNestedNegativeZero(candidate.candidateValue);
    if (!isPortableJsonValue(candidateValue)) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": value not representable as portable JSON`);
      continue;
    }
    // Confidence is an optional provider self-report. Missing (or null) is
    // omitted silently; a value that is not a finite number is omitted with a
    // warning. Neither drops the proposal.
    const rawConfidence: unknown = (candidate as { confidence?: unknown }).confidence;
    let reportedConfidence: number | undefined;
    if (typeof rawConfidence === "number" && Number.isFinite(rawConfidence)) {
      reportedConfidence = rawConfidence;
    } else if (rawConfidence !== undefined && rawConfidence !== null) {
      warnings.push(`omitted non-numeric confidence for "${effectiveFieldPath}"`);
    }

    // Provenance contract enforcement begins with the exact chunk text the
    // provider saw. It then enumerates exact matches across the complete
    // prepared artifact; no fuzzy/near-match path can produce a chars: locator.
    const localIndex = chunkContent.indexOf(excerpt);
    if (localIndex === -1) {
      warnings.push(`dropped proposal for "${effectiveFieldPath}": excerpt not found in prepared content`);
      continue;
    }
    const sourceOrderKey = stableProposalIdentity(effectiveFieldPath, pathIndices, candidateValue, excerpt);
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

    let confidence = reportedConfidence;
    if (confidence !== undefined) {
      if (Object.is(confidence, -0)) confidence = 0;
      if (confidence < 0 || confidence > 1) {
        confidence = Math.max(0, Math.min(1, confidence));
        warnings.push(`clamped out-of-range confidence for "${effectiveFieldPath}" to ${confidence}`);
      }
    }

    const proposal: ExtractionProposal = {
      fieldPath: effectiveFieldPath,
      candidateValue,
      ...(confidence === undefined ? {} : { confidence }),
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

  return { proposals, warnings, unusable: false };
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
 * Rewrite every `-0` in a candidate value to `0`, at any depth. JSON already
 * writes both the same way, so this loses nothing, but `assertJsonSafe`
 * rejects a nested `-0` exactly like a top-level one — without this walk, a
 * value with `-0` three levels down would fail the portable-JSON check below
 * and drop the whole proposal instead of normalizing losslessly.
 *
 * Only containers `assertJsonSafe` would accept structurally are copied: an
 * array with no holes or extra properties, or a plain object whose own keys
 * are all enumerable string-keyed data properties. Anything else (a `Date`, a
 * symbol key, an accessor, which is never invoked, a sparse array, `NaN`,
 * `undefined`, …) is returned as-is, so `isPortableJsonValue` still sees the
 * original and has the final say. Keys are defined, not assigned, so an own
 * `__proto__` key (as `JSON.parse` produces) survives the copy as data.
 */
function normalizeNestedNegativeZero(value: unknown, ancestors = new Set<object>()): unknown {
  if (Object.is(value, -0)) return 0;
  if (value === null || typeof value !== "object") return value;
  const isArray = Array.isArray(value);
  if (!isArray && Object.getPrototypeOf(value) !== Object.prototype) return value;
  if (ancestors.has(value)) return value;
  const keys = Reflect.ownKeys(value);
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    if (isArray && key === "length") continue;
    if (typeof key === "symbol") return value;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return value;
    entries.push([key, descriptor.value]);
  }
  if (isArray) {
    const length = (value as unknown[]).length;
    if (entries.length !== length || entries.some(([key], index) => key !== String(index))) return value;
  }
  ancestors.add(value);
  const normalizedEntries = entries.map(([key, entry]) => [key, normalizeNestedNegativeZero(entry, ancestors)] as const);
  ancestors.delete(value);
  if (isArray) return normalizedEntries.map(([, entry]) => entry);
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of normalizedEntries) {
    Object.defineProperty(normalized, key, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  return normalized;
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
