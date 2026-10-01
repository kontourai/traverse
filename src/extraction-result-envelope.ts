/**
 * Portable, versioned wire contract for a completed Traverse extraction.
 *
 * This module deliberately serializes identity and audit metadata, never the
 * prepared text behind a chars locator. Provider-native failure objects are
 * similarly excluded: the stable classified failure is portable while native
 * diagnostics remain an in-process concern.
 */

import { compareCodeUnits } from "./canonical-json.js";
import {
  EXACT_OCCURRENCE_RESOLVER_VERSION,
  type ExactOccurrenceResolution,
} from "./occurrence-resolver.js";
import {
  isWellFormedUnicode,
  validatePreparedArtifact,
  type PreparedArtifact,
  type PreparedArtifactInvalidReason,
  type PreparedArtifactResolution,
} from "./prepared-artifact.js";
import type {
  ExtractionCoverageEntry,
  ExtractionCoverageReason,
  ExtractionCoverageStatus,
  ExtractionPartial,
  ExtractionModelSource,
  ExtractionEvidenceMatch,
  ExtractionSchemaMatch,
  ExtractionValueInExcerpt,
  ExtractionValueNormalization,
  ExtractionProposal,
  ExtractionProviderFailure,
  ExtractionResult,
  PdfLayout,
  TargetFieldSchema,
} from "./types.js";
import { validatePdfLayout } from "./content-prep.js";
import { EVIDENCE_MATCH_CHECKER_VERSION, schemaMatch, valueInExcerpt } from "./evidence-match.js";
import { normalizeCandidateValue } from "./value-normalization.js";

export const PORTABLE_EXTRACTION_RESULT_ENVELOPE_FORMAT = "traverse-extraction-result";
export const PORTABLE_EXTRACTION_RESULT_ENVELOPE_VERSION = 1;

/** `ExtractionResult.error` when no dispatched chunk was answered and no call threw; classified `provider`/`no-usable-answer`. */
export const NO_USABLE_ANSWER_ERROR = "no dispatched chunk returned a usable answer";

export interface PortableExtractionSource {
  ref: string;
  /** Immutable fetch/replay identity when one is available. */
  snapshotRef?: string;
}

export interface PortableExtractionProposal extends Omit<ExtractionProposal, "occurrenceHint" | "producedBy"> {
  /** Carried only when the in-process `producedBy` names its `modelSource`. */
  producedBy?: PortableExtractionProducedBy;
  provenance: {
    excerpt: string;
    locator: string;
    /** Portable envelopes carry exact-match audit metadata for every proposal. */
    occurrence: ExactOccurrenceResolution;
  };
}

/** Which model produced one proposal; every key is required on the wire. */
export interface PortableExtractionProducedBy {
  model: string;
  modelSource: ExtractionModelSource;
  /** Content-free digest of the provider request (`sha256:<hex>`). */
  requestDigest: string;
}

/**
 * Provider classification without non-portable native or message diagnostics.
 * `code` is the upstream error code, informational only (`kind` stays
 * authoritative), and is omitted when longer than 128 characters.
 */
export type PortableExtractionProviderFailure = Omit<ExtractionProviderFailure, "native" | "message">;

/**
 * One prepared-text range and whether it was read and answered; identical to
 * the in-process `ExtractionCoverageEntry`. Carried only on a `partial`
 * outcome (see `PortableExtractionResult.coverage`).
 */
export type PortableExtractionCoverageEntry = ExtractionCoverageEntry;

/** Default-safe provider audit fields. Raw response content is never included. */
export interface PortableRawProviderResponse {
  tokensUsed?: number;
}

export type PortableExtractionOutcome =
  | { status: "success" }
  | { status: "partial"; reason: ExtractionPartial["reason"] }
  | { status: "failure"; category: "invalid-config" | "invalid-task" | "preparation" | "provider" | "unexpected"; code: string };

export interface PortableExtractionWarning {
  category: "provider" | "normalization" | "preparation" | "limit" | "storage" | "content" | "other";
  code: string;
}

/**
 * A text-free projection of PreparedArtifactResolution. `available` deliberately
 * carries no text, so resolving an artifact cannot accidentally turn a result
 * envelope into a source-content transport.
 */
export type PortablePreparedArtifactState =
  | { status: "available" | "unavailable" | "storage-error"; requestedRef: string; canonicalRef: string }
  | { status: "identity-mismatch"; requestedRef: string; canonicalRef: string }
  | { status: "invalid-artifact"; reason: PreparedArtifactInvalidReason; canonicalRef: string }
  | { status: "digest-mismatch"; requestedRef: string; canonicalRef: string; actualDigest: string; actualContentLength: number };

export interface PortableExtractionResult {
  proposals: PortableExtractionProposal[];
  /** Stable provider identity even when no proposal was returned. */
  provider: string;
  /** Stable model identity when the provider produced one. */
  model?: string;
  /** Opaque stable identity of this individual run. */
  runId: string;
  raw: PortableRawProviderResponse;
  outcome: PortableExtractionOutcome;
  warningClassifications?: PortableExtractionWarning[];
  extractedAt: string;
  providerCalls: number;
  totalTokensUsed: number;
  partial?: ExtractionPartial;
  /**
   * Per-chunk coverage of the prepared text, ordered by `start`; ranges may
   * overlap. The serializer emits it only when `outcome.status` is `partial`,
   * so a run that read everything serializes exactly as before. A validator
   * accepts it on any outcome but rejects a non-`complete` entry on a
   * `success` outcome. Requires `preparedArtifact`.
   */
  coverage?: PortableExtractionCoverageEntry[];
  providerFailures?: PortableExtractionProviderFailure[];
  taskDigest?: string;
  exampleDigests?: string[];
  pdfPageOffsets?: number[];
  pdfLayout?: PdfLayout;
  ocrDerived?: true;
  preparedArtifact?: PreparedArtifact;
  preparedArtifactState?: PortablePreparedArtifactState;
}

export interface PortableExtractionResultEnvelope {
  format: typeof PORTABLE_EXTRACTION_RESULT_ENVELOPE_FORMAT;
  version: typeof PORTABLE_EXTRACTION_RESULT_ENVELOPE_VERSION;
  source: PortableExtractionSource;
  result: PortableExtractionResult;
}

export interface PortableExtractionResultOptions {
  /** Required when serializing a manually-constructed legacy ExtractionResult. */
  sourceRef?: string;
  /** Overrides the snapshot ref derived from result.preparedArtifact. */
  sourceSnapshotRef?: string;
  /** Optional resolution outcome, projected to a text-free typed state. */
  preparedArtifactResolution?: PreparedArtifactResolution;
}

export type PortableExtractionResultEnvelopeValidation =
  | { status: "valid"; envelope: PortableExtractionResultEnvelope }
  | { status: "invalid"; reason: string };

const LOCATOR = /^chars:(0|[1-9]\d*)-(0|[1-9]\d*)$/;
const RUN_ID = /^traverse-extraction-run:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STABLE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,255}$/;
const CREDENTIAL_IDENTITY = /^(?:gh[pousr]_|sk-[A-Za-z0-9]|AKIA[A-Z0-9]|ASIA[A-Z0-9]|eyJ[A-Za-z0-9_-]+\.eyJ)/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const VALUE_TYPES: ReadonlySet<TargetFieldSchema["type"]> = new Set(["string", "number", "boolean", "date", "enum", "array", "object"]);
const INFERENCE_TYPES = new Set(["explicit", "inferred"]);
const VALUE_NORMALIZATION_KINDS = new Set<ExtractionValueNormalization["kind"]>(["string-to-number", "date-to-iso"]);
const SCHEMA_MATCHES = new Set<ExtractionSchemaMatch>(["ok", "type-mismatch", "enum-mismatch", "format-invalid"]);
const VALUE_IN_EXCERPT_MATCHES = new Set<ExtractionValueInExcerpt>(["match", "mismatch", "not-evaluated", "not-applicable"]);
const PARTIAL_REASONS = new Set([
  "cancelled", "max-provider-calls", "max-total-tokens", "max-chunks",
  "provider-failure", "content-truncated", "output-truncated",
]);
/** Partial reasons meaning a dispatched chunk was not (fully) read or answered. */
const LOSS_PARTIAL_REASONS = new Set<string>(["provider-failure", "content-truncated", "output-truncated"]);
const COVERAGE_STATUSES = new Set<ExtractionCoverageStatus>(["complete", "unread", "output-truncated"]);
const COVERAGE_REASONS = new Set<ExtractionCoverageReason>(["provider-failure", "content-truncated", "missing-tool-call", "not-dispatched"]);
const FAILURE_KINDS = new Set(["authentication", "rate-limit", "timeout", "invalid-request", "unavailable", "unknown"]);
const MODEL_SOURCES = new Set(["provider-reported", "configured"]);
/** Envelope importers cap a portable failure code at this length. */
const MAX_PORTABLE_FAILURE_CODE_LENGTH = 128;
const ARTIFACT_REASONS = new Set<PreparedArtifactInvalidReason>([
  "not-an-object", "invalid-format", "invalid-version", "invalid-digest", "invalid-ref",
  "invalid-preparation-mode", "invalid-preparation-version", "invalid-content-length",
  "invalid-source-snapshot-ref", "ill-formed-unicode", "invalid-resolved-text",
]);

/** Turn a resolver outcome into a portable state without copying resolved text. */
export function toPortablePreparedArtifactState(
  resolution: PreparedArtifactResolution,
  canonicalArtifact?: PreparedArtifact,
): PortablePreparedArtifactState {
  if (!canonicalArtifact) throw new TypeError("portable artifact state requires the canonical result artifact");
  const canonicalRef = canonicalArtifact.ref;
  switch (resolution.status) {
    case "available": case "unavailable": case "storage-error":
      return { status: resolution.status, requestedRef: resolution.artifact.ref, canonicalRef };
    case "identity-mismatch": return { status: "identity-mismatch", requestedRef: resolution.artifact.ref, canonicalRef };
    case "invalid-artifact": return { status: "invalid-artifact", reason: resolution.reason, canonicalRef };
    case "digest-mismatch": return {
      status: "digest-mismatch", requestedRef: resolution.artifact.ref, canonicalRef,
      actualDigest: resolution.actualDigest, actualContentLength: resolution.actualContentLength,
    };
  }
}

/**
 * Canonically serialize a result or a previously-deserialized envelope. The
 * output is key-sorted and contains only lossless JSON values, making
 * deserialize -> serialize byte-stable for a valid envelope.
 */
export function serializePortableExtractionResult(
  input: ExtractionResult | PortableExtractionResultEnvelope,
  options: PortableExtractionResultOptions = {},
): string {
  const envelope = isEnvelopeInput(input)
    ? validatedEnvelopeOrThrow(input)
    : envelopeFromResult(input, options);
  return canonicalJson(envelope);
}

/** Parse and validate an untrusted portable extraction-result JSON document. */
export function deserializePortableExtractionResult(serialized: string): PortableExtractionResultEnvelope {
  if (typeof serialized !== "string") throw new TypeError("portable extraction-result envelope must be a JSON string");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new TypeError("portable extraction-result envelope is not valid JSON");
  }
  return validatedEnvelopeOrThrow(parsed);
}

/** Validate an untrusted parsed envelope without throwing. */
export function validatePortableExtractionResultEnvelope(input: unknown): PortableExtractionResultEnvelopeValidation {
  try {
    assertJsonSafe(input, "envelope");
    return { status: "valid", envelope: validateEnvelope(input) };
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : "invalid portable extraction-result envelope" };
  }
}

/** Compatibility-friendly explicit aliases for the public wire-contract verbs. */
export const serializeExtractionResultEnvelope = serializePortableExtractionResult;
export const deserializeExtractionResultEnvelope = deserializePortableExtractionResult;
export const validateExtractionResultEnvelope = validatePortableExtractionResultEnvelope;

function envelopeFromResult(result: ExtractionResult, options: PortableExtractionResultOptions): PortableExtractionResultEnvelope {
  const sourceRef = options.sourceRef ?? result.sourceRef;
  if (sourceRef === undefined) throw new TypeError("portable extraction-result envelope requires sourceRef");
  const source: PortableExtractionSource = {
    ref: sourceRef,
    ...(options.sourceSnapshotRef !== undefined
      ? { snapshotRef: options.sourceSnapshotRef }
      : result.preparedArtifact?.sourceSnapshotRef !== undefined
        ? { snapshotRef: result.preparedArtifact.sourceSnapshotRef }
        : {}),
  };
  const portable: PortableExtractionResult = {
    proposals: result.proposals.map(portableProposal),
    provider: result.provider ?? "",
    ...(result.raw.model !== "" ? { model: result.raw.model } : {}),
    runId: result.runId ?? "",
    raw: {
      ...(result.raw.tokensUsed !== undefined ? { tokensUsed: result.raw.tokensUsed } : {}),
    },
    outcome: classifyOutcome(result),
    ...(result.warnings?.length ? { warningClassifications: result.warnings.map(classifyWarning) } : {}),
    extractedAt: result.extractedAt,
    providerCalls: result.providerCalls,
    totalTokensUsed: result.totalTokensUsed,
    ...(result.partial !== undefined ? { partial: result.partial } : {}),
    // Only a partial run carries coverage, so envelopes of complete runs stay
    // byte-identical to what readers of the earlier wire already accept.
    ...(result.partial !== undefined && result.coverage !== undefined
      ? { coverage: result.coverage.map((entry) => ({ ...entry })) }
      : {}),
    ...(result.providerFailures !== undefined ? { providerFailures: result.providerFailures.map(portableFailure) } : {}),
    ...(result.taskDigest !== undefined ? { taskDigest: result.taskDigest } : {}),
    ...(result.exampleDigests !== undefined ? { exampleDigests: result.exampleDigests } : {}),
    ...(result.pdfPageOffsets !== undefined ? { pdfPageOffsets: result.pdfPageOffsets } : {}),
    ...(result.pdfLayout !== undefined ? { pdfLayout: result.pdfLayout } : {}),
    ...(result.ocrDerived !== undefined ? { ocrDerived: true as const } : {}),
    ...(result.preparedArtifact !== undefined ? { preparedArtifact: result.preparedArtifact } : {}),
    ...(options.preparedArtifactResolution !== undefined
      ? { preparedArtifactState: portableArtifactStateForResult(options.preparedArtifactResolution, result.preparedArtifact) }
      : {}),
  };
  return validatedEnvelopeOrThrow({
    format: PORTABLE_EXTRACTION_RESULT_ENVELOPE_FORMAT,
    version: PORTABLE_EXTRACTION_RESULT_ENVELOPE_VERSION,
    source,
    result: portable,
  });
}

function portableProposal(proposal: ExtractionProposal): PortableExtractionProposal {
  const occurrence = proposal.provenance?.occurrence;
  if (!occurrence) throw new TypeError("portable extraction-result proposal is missing exact occurrence metadata");
  return {
    fieldPath: proposal.fieldPath, candidateValue: proposal.candidateValue,
    ...(proposal.confidence !== undefined ? { confidence: proposal.confidence } : {}),
    provenance: { excerpt: proposal.provenance.excerpt, locator: proposal.provenance.locator, occurrence },
    extractor: proposal.extractor,
    ...(proposal.pathIndices !== undefined ? { pathIndices: proposal.pathIndices } : {}),
    ...(proposal.inferenceType !== undefined ? { inferenceType: proposal.inferenceType } : {}),
    ...(proposal.valueType !== undefined ? { valueType: proposal.valueType } : {}),
    ...(proposal.enumValues !== undefined ? { enumValues: proposal.enumValues } : {}),
    ...(proposal.producedBy?.modelSource !== undefined
      ? { producedBy: { model: proposal.producedBy.model, modelSource: proposal.producedBy.modelSource, requestDigest: proposal.producedBy.requestDigest } }
      : {}),
    ...(proposal.evidenceMatch !== undefined
      ? {
        evidenceMatch: {
          checkerVersion: proposal.evidenceMatch.checkerVersion,
          schema: proposal.evidenceMatch.schema,
          valueInExcerpt: proposal.evidenceMatch.valueInExcerpt,
          ...(proposal.evidenceMatch.tokenBoundary !== undefined ? { tokenBoundary: proposal.evidenceMatch.tokenBoundary } : {}),
        },
      }
      : {}),
    ...(proposal.valueNormalization !== undefined
      ? { valueNormalization: { kind: proposal.valueNormalization.kind, from: proposal.valueNormalization.from } }
      : {}),
  };
}

function portableFailure(failure: ExtractionProviderFailure): PortableExtractionProviderFailure {
  return {
    provider: failure.provider, kind: failure.kind, retryable: failure.retryable,
    ...(failure.code !== undefined && failure.code.length <= MAX_PORTABLE_FAILURE_CODE_LENGTH ? { code: failure.code } : {}),
  };
}

function classifyOutcome(result: ExtractionResult): PortableExtractionOutcome {
  if (result.partial) return { status: "partial", reason: result.partial.reason };
  if (result.error === undefined) return { status: "success" };
  if (result.error.startsWith("invalid taskSpec:")) return { status: "failure", category: "invalid-task", code: "invalid-task-spec" };
  if (result.error.startsWith("invalid ") || result.error.includes("does not support required capability")) {
    return { status: "failure", category: "invalid-config", code: result.error.includes("capability") ? "unsupported-provider-capability" : "invalid-extract-config" };
  }
  if (result.providerFailures?.length) return { status: "failure", category: "provider", code: "provider-failure" };
  if (result.error === NO_USABLE_ANSWER_ERROR) return { status: "failure", category: "provider", code: "no-usable-answer" };
  if (/preparation|extraction failed|bytes are required|not implemented/i.test(result.error)) {
    return { status: "failure", category: "preparation", code: "content-preparation-failure" };
  }
  return { status: "failure", category: "unexpected", code: "unexpected-extraction-failure" };
}

function classifyWarning(warning: string): PortableExtractionWarning {
  if (/^stopped after /.test(warning)) return { category: "limit", code: "partial-stop" };
  if (/^prepared artifact storage failed/.test(warning)) return { category: "storage", code: "prepared-artifact-storage-failed" };
  // Chunk-loss cases each keep their own code: a consumer reading only the
  // envelope can tell a failed chunk from a truncated output or dispatch.
  if (/^chunk \d+\/\d+ provider call failed/.test(warning)) return { category: "provider", code: "chunk-provider-failure" };
  if (/^chunk \d+\/\d+ content truncated at maxContentChars/.test(warning)) return { category: "limit", code: "content-truncated-at-dispatch" };
  // Only the located form extract() writes when it records the loss on a
  // chunk, so these codes never appear on an envelope whose outcome ignores it.
  if (/^chunk \d+\/\d+ \(chars:\d+-\d+\): response truncated at maxTokens/.test(warning)) return { category: "provider", code: "output-truncated" };
  if (/^chunk \d+\/\d+ \(chars:\d+-\d+\): provider returned no extraction (?:tool|function) call/.test(warning)) return { category: "provider", code: "missing-tool-call" };
  if (/^chunk \d+\/\d+ \(chars:\d+-\d+\): provider answer unusable/.test(warning)) return { category: "provider", code: "unusable-answer" };
  if (/^chunk \d+\/\d+ \(chars:\d+-\d+\): dropped \d+ of \d+ tool items as malformed$/.test(warning)) return { category: "normalization", code: "malformed-tool-items" };
  if (/provider call failed|^response truncated|^provider returned|^provider tool call/.test(warning)) return { category: "provider", code: "provider-warning" };
  if (/^coerced string value to number for |^normalized date value to ISO 8601 for /.test(warning)) return { category: "normalization", code: "value-normalized" };
  if (/^dropped .*proposal|^dropped malformed tool item|^clamped |^omitted non-numeric confidence|normalization failed/.test(warning)) return { category: "normalization", code: "proposal-normalization" };
  if (/^(?:structural|markdown) prep pruned /.test(warning)) return { category: "preparation", code: "navigation-pruned" };
  // The chunk cap, not the maxContentChars cut: `content-truncated` names only
  // the latter elsewhere in the envelope, so this matches the partial reason.
  if (/beyond maxChunks/.test(warning)) return { category: "limit", code: "max-chunks" };
  if (/chunked into/.test(warning)) return { category: "content", code: "content-chunking" };
  if (/js-shell|embedded-state|markdown preparation|extractor-reported|pdfLayout|OCR/i.test(warning)) return { category: "preparation", code: "content-preparation-warning" };
  return { category: "other", code: "unclassified-warning" };
}

function portableArtifactStateForResult(
  resolution: PreparedArtifactResolution,
  resultArtifact: PreparedArtifact | undefined,
): PortablePreparedArtifactState {
  if (!resultArtifact) throw new TypeError("preparedArtifactResolution requires result.preparedArtifact");
  if ("artifact" in resolution) {
    assertJsonSafe(resolution.artifact, "preparedArtifactResolution.artifact");
    assertJsonSafe(resultArtifact, "result.preparedArtifact");
    const sameArtifact = resolution.status === "identity-mismatch"
      ? artifactMetadataMatchesExceptRef(resolution.artifact, resultArtifact)
      : canonicalJson(resolution.artifact) === canonicalJson(resultArtifact);
    if (!sameArtifact) {
      throw new TypeError("preparedArtifactResolution.artifact metadata does not match result.preparedArtifact");
    }
  }
  return toPortablePreparedArtifactState(resolution, resultArtifact);
}

function artifactMetadataMatchesExceptRef(candidate: PreparedArtifact, canonical: PreparedArtifact): boolean {
  const { ref: _candidateRef, ...candidateMetadata } = candidate;
  const { ref: _canonicalRef, ...canonicalMetadata } = canonical;
  return canonicalJson(candidateMetadata) === canonicalJson(canonicalMetadata);
}

function isEnvelopeInput(input: ExtractionResult | PortableExtractionResultEnvelope): input is PortableExtractionResultEnvelope {
  return typeof input === "object" && input !== null && (input as { format?: unknown }).format === PORTABLE_EXTRACTION_RESULT_ENVELOPE_FORMAT;
}

function validatedEnvelopeOrThrow(input: unknown): PortableExtractionResultEnvelope {
  const validation = validatePortableExtractionResultEnvelope(input);
  if (validation.status === "invalid") throw new TypeError(`invalid portable extraction-result envelope: ${validation.reason}`);
  return validation.envelope;
}

function validateEnvelope(input: unknown): PortableExtractionResultEnvelope {
  const envelope = record(input, "envelope");
  exactKeys(envelope, ["format", "version", "source", "result"], [], "envelope");
  if (envelope.format !== PORTABLE_EXTRACTION_RESULT_ENVELOPE_FORMAT) fail("unsupported envelope format");
  if (envelope.version !== PORTABLE_EXTRACTION_RESULT_ENVELOPE_VERSION) fail("unsupported envelope version");
  const source = validateSource(envelope.source);
  const result = validateResult(envelope.result);
  if (source.snapshotRef !== undefined && result.preparedArtifact?.sourceSnapshotRef !== undefined &&
      source.snapshotRef !== result.preparedArtifact.sourceSnapshotRef) {
    fail("source.snapshotRef does not match result.preparedArtifact.sourceSnapshotRef");
  }
  return {
    format: PORTABLE_EXTRACTION_RESULT_ENVELOPE_FORMAT,
    version: PORTABLE_EXTRACTION_RESULT_ENVELOPE_VERSION,
    source,
    result,
  };
}

function validateSource(input: unknown): PortableExtractionSource {
  const source = record(input, "source");
  exactKeys(source, ["ref"], ["snapshotRef"], "source");
  return {
    ref: safeReference(source.ref, "source.ref"),
    ...(source.snapshotRef === undefined ? {} : { snapshotRef: safeReference(source.snapshotRef, "source.snapshotRef") }),
  };
}

function validateResult(input: unknown): PortableExtractionResult {
  const value = record(input, "result");
  exactKeys(value, ["proposals", "provider", "runId", "raw", "outcome", "extractedAt", "providerCalls", "totalTokensUsed"], [
    "model", "warningClassifications", "partial", "coverage", "providerFailures", "taskDigest", "exampleDigests",
    "pdfPageOffsets", "pdfLayout", "ocrDerived", "preparedArtifact", "preparedArtifactState",
  ], "result");
  const preparedArtifact = value.preparedArtifact === undefined ? undefined : validArtifact(value.preparedArtifact, "result.preparedArtifact");
  const preparedArtifactState = value.preparedArtifactState === undefined
    ? undefined
    : validateArtifactState(value.preparedArtifactState);
  if (preparedArtifactState !== undefined && preparedArtifact === undefined) {
    fail("result.preparedArtifactState requires result.preparedArtifact");
  }
  if (preparedArtifactState !== undefined && preparedArtifactState.canonicalRef !== preparedArtifact?.ref) {
    fail("result.preparedArtifactState.canonicalRef does not match result.preparedArtifact.ref");
  }
  const layoutWarnings: string[] = [];
  const pdfLayout = value.pdfLayout === undefined
    ? undefined
    : preparedArtifact === undefined
      ? fail("result.pdfLayout requires result.preparedArtifact")
      : validatePdfLayout(
        value.pdfLayout,
        preparedArtifact.contentLength,
        layoutWarnings,
      );
  if (value.pdfLayout !== undefined && pdfLayout === undefined) {
    fail("result.pdfLayout is malformed or out of range");
  }
  const result: PortableExtractionResult = {
    proposals: array(value.proposals, "result.proposals").map((item, index) => validateProposal(item, `result.proposals[${index}]`, preparedArtifact)),
    provider: stableIdentity(value.provider, "result.provider"),
    ...(value.model === undefined ? {} : { model: stableIdentity(value.model, "result.model") }),
    runId: runIdentity(value.runId, "result.runId"),
    raw: validateRaw(value.raw),
    outcome: validateOutcome(value.outcome),
    ...(value.warningClassifications === undefined ? {} : { warningClassifications: array(value.warningClassifications, "result.warningClassifications").map((item, index) => validateWarning(item, index)) }),
    extractedAt: nonEmptyString(value.extractedAt, "result.extractedAt"),
    providerCalls: nonNegativeInteger(value.providerCalls, "result.providerCalls"),
    totalTokensUsed: nonNegativeInteger(value.totalTokensUsed, "result.totalTokensUsed"),
    ...(value.partial === undefined ? {} : { partial: validatePartial(value.partial) }),
    ...(value.coverage === undefined ? {} : { coverage: validateCoverage(value.coverage, preparedArtifact) }),
    ...(value.providerFailures === undefined ? {} : { providerFailures: array(value.providerFailures, "result.providerFailures").map((item, index) => validateFailure(item, index)) }),
    ...(value.taskDigest === undefined ? {} : { taskDigest: digest(value.taskDigest, "result.taskDigest") }),
    ...(value.exampleDigests === undefined ? {} : { exampleDigests: strings(value.exampleDigests, "result.exampleDigests").map((item, index) => digest(item, `result.exampleDigests[${index}]`)) }),
    ...(value.pdfPageOffsets === undefined ? {} : { pdfPageOffsets: validatePageOffsets(value.pdfPageOffsets) }),
    ...(pdfLayout === undefined ? {} : { pdfLayout }),
    ...(value.ocrDerived === undefined ? {} : { ocrDerived: literalTrue(value.ocrDerived, "result.ocrDerived") }),
    ...(preparedArtifact === undefined ? {} : { preparedArtifact }),
    ...(preparedArtifactState === undefined ? {} : { preparedArtifactState }),
  };
  if ((result.outcome.status === "partial") !== (result.partial !== undefined)) {
    fail("result.outcome partial status must match result.partial presence");
  }
  if (result.outcome.status === "partial" && result.outcome.reason !== result.partial?.reason) {
    fail("result.outcome.reason must match result.partial.reason");
  }
  const lost = result.coverage?.some((entry) => entry.status !== "complete") ?? false;
  if (result.outcome.status === "success" && lost) {
    fail("result.coverage has a range that was not read or answered, but result.outcome is success");
  }
  // A loss reason names a dispatched chunk, so a never-dispatched range alone
  // cannot account for it.
  const dispatchedLoss = result.coverage?.some((entry) => entry.status !== "complete" && entry.reason !== "not-dispatched") ?? false;
  if (result.outcome.status === "partial" && LOSS_PARTIAL_REASONS.has(result.outcome.reason) && !dispatchedLoss) {
    fail(`result.outcome.reason ${result.outcome.reason} requires a result.coverage entry for a dispatched chunk that was not read or answered`);
  }
  return result;
}

function validateProposal(input: unknown, path: string, artifact: PreparedArtifact | undefined): PortableExtractionProposal {
  const value = record(input, path);
  exactKeys(value, ["fieldPath", "candidateValue", "provenance", "extractor"], ["confidence", "pathIndices", "inferenceType", "valueType", "enumValues", "producedBy", "evidenceMatch", "valueNormalization"], path);
  const provenance = record(value.provenance, `${path}.provenance`);
  exactKeys(provenance, ["excerpt", "locator", "occurrence"], [], `${path}.provenance`);
  const locator = validateLocator(provenance.locator, `${path}.provenance.locator`);
  if (artifact && locator.end > artifact.contentLength) fail(`${path}.provenance.locator exceeds prepared artifact contentLength`);
  const excerpt = nonEmptyString(provenance.excerpt, `${path}.provenance.excerpt`);
  if (locator.end - locator.start !== excerpt.length) fail(`${path}.provenance.locator length does not match excerpt UTF-16 length`);
  const occurrence = validateOccurrence(provenance.occurrence, `${path}.provenance.occurrence`, locator);
  const proposal: PortableExtractionProposal = {
    fieldPath: nonEmptyString(value.fieldPath, `${path}.fieldPath`),
    candidateValue: value.candidateValue,
    ...(value.confidence === undefined ? {} : { confidence: finiteNumber(value.confidence, `${path}.confidence`, 0, 1) }),
    provenance: { excerpt, locator: provenance.locator as string, occurrence },
    extractor: stableIdentity(value.extractor, `${path}.extractor`),
    ...(value.pathIndices === undefined ? {} : { pathIndices: array(value.pathIndices, `${path}.pathIndices`).map((item, index) => nonNegativeInteger(item, `${path}.pathIndices[${index}]`)) }),
    ...(value.inferenceType === undefined ? {} : { inferenceType: enumValue(value.inferenceType, INFERENCE_TYPES, `${path}.inferenceType`) as "explicit" | "inferred" }),
    ...(value.valueType === undefined ? {} : { valueType: enumValue(value.valueType, VALUE_TYPES, `${path}.valueType`) as TargetFieldSchema["type"] }),
    ...(value.enumValues === undefined ? {} : { enumValues: strings(value.enumValues, `${path}.enumValues`) }),
    ...(value.producedBy === undefined ? {} : { producedBy: validateProducedBy(value.producedBy, `${path}.producedBy`) }),
    ...(value.evidenceMatch === undefined ? {} : { evidenceMatch: validateEvidenceMatch(value.evidenceMatch, `${path}.evidenceMatch`) }),
    ...(value.valueNormalization === undefined ? {} : { valueNormalization: validateValueNormalization(value.valueNormalization, `${path}.valueNormalization`) }),
  };
  if (proposal.evidenceMatch) checkEvidenceMatchConsistency(proposal, `${path}.evidenceMatch`);
  if (proposal.valueNormalization) checkValueNormalizationConsistency(proposal, `${path}.valueNormalization`);
  return proposal;
}

function validateValueNormalization(input: unknown, path: string): ExtractionValueNormalization {
  const value = record(input, path);
  exactKeys(value, ["kind", "from"], [], path);
  if (typeof value.from !== "string") fail(`${path}.from must be a string`);
  return {
    kind: enumValue(value.kind, VALUE_NORMALIZATION_KINDS, `${path}.kind`) as ExtractionValueNormalization["kind"],
    from: value.from,
  };
}

/**
 * The rewrite is a pure function of `from` and the declared type, so the
 * validator recomputes it and rejects a record whose `candidateValue` is not
 * what `from` rewrites to.
 */
function checkValueNormalizationConsistency(proposal: PortableExtractionProposal, path: string): void {
  const recorded = proposal.valueNormalization!;
  if (proposal.valueType === undefined) fail(`${path} requires the proposal's valueType`);
  const recomputed = normalizeCandidateValue(recorded.from, { type: proposal.valueType });
  if (recomputed.normalization?.kind !== recorded.kind || recomputed.value !== proposal.candidateValue) {
    fail(`${path} does not rewrite its from value to the proposal's candidateValue`);
  }
}

/**
 * `evidenceMatch` is a pure function of the proposal's value, declared type,
 * enum values, inference type and excerpt, all carried on the proposal, so the
 * validator recomputes it and rejects a record that disagrees. `tokenBoundary`
 * needs the prepared text around the excerpt, which the envelope does not
 * carry, so only its type is checked.
 */
function checkEvidenceMatchConsistency(proposal: PortableExtractionProposal, path: string): void {
  const match = proposal.evidenceMatch!;
  if (match.checkerVersion !== EVIDENCE_MATCH_CHECKER_VERSION) {
    fail(`${path}.checkerVersion must be ${EVIDENCE_MATCH_CHECKER_VERSION}`);
  }
  if (proposal.valueType === undefined) fail(`${path} requires the proposal's valueType`);
  const field: TargetFieldSchema = {
    path: proposal.fieldPath,
    type: proposal.valueType,
    ...(proposal.enumValues !== undefined ? { enumValues: proposal.enumValues } : {}),
    ...(proposal.inferenceType !== undefined ? { inferenceType: proposal.inferenceType } : {}),
  };
  const schema = schemaMatch(proposal.candidateValue, field);
  if (match.schema !== schema) fail(`${path}.schema is ${match.schema} but the proposal's value and valueType give ${schema}`);
  const inExcerpt = valueInExcerpt(proposal.candidateValue, field, proposal.provenance.excerpt);
  if (match.valueInExcerpt !== inExcerpt) {
    fail(`${path}.valueInExcerpt is ${match.valueInExcerpt} but the proposal's value and excerpt give ${inExcerpt}`);
  }
}

function validateEvidenceMatch(input: unknown, path: string): ExtractionEvidenceMatch {
  const value = record(input, path);
  exactKeys(value, ["checkerVersion", "schema", "valueInExcerpt"], ["tokenBoundary"], path);
  return {
    checkerVersion: stableIdentity(value.checkerVersion, `${path}.checkerVersion`),
    schema: enumValue(value.schema, SCHEMA_MATCHES, `${path}.schema`) as ExtractionSchemaMatch,
    valueInExcerpt: enumValue(value.valueInExcerpt, VALUE_IN_EXCERPT_MATCHES, `${path}.valueInExcerpt`) as ExtractionValueInExcerpt,
    ...(value.tokenBoundary === undefined ? {} : { tokenBoundary: boolean(value.tokenBoundary, `${path}.tokenBoundary`) }),
  };
}

function validateProducedBy(input: unknown, path: string): PortableExtractionProducedBy {
  const value = record(input, path);
  exactKeys(value, ["model", "modelSource", "requestDigest"], [], path);
  return {
    model: stableIdentity(value.model, `${path}.model`),
    modelSource: enumValue(value.modelSource, MODEL_SOURCES, `${path}.modelSource`) as ExtractionModelSource,
    requestDigest: digest(value.requestDigest, `${path}.requestDigest`),
  };
}

function validateOccurrence(input: unknown, path: string, locator: { start: number; end: number }): ExactOccurrenceResolution {
  const value = record(input, path);
  exactKeys(value, ["resolverVersion", "count", "selected", "selection", "hintUsed", "ambiguous"], [], path);
  if (value.resolverVersion !== EXACT_OCCURRENCE_RESOLVER_VERSION) fail(`${path}.resolverVersion is unsupported`);
  const selected = record(value.selected, `${path}.selected`);
  exactKeys(selected, ["index", "start", "end"], [], `${path}.selected`);
  const count = nonNegativeInteger(value.count, `${path}.count`);
  const index = nonNegativeInteger(selected.index, `${path}.selected.index`);
  if (count === 0 || index >= count) fail(`${path}.selected.index is outside occurrence count`);
  const start = nonNegativeInteger(selected.start, `${path}.selected.start`);
  const end = nonNegativeInteger(selected.end, `${path}.selected.end`);
  if (start !== locator.start || end !== locator.end) fail(`${path}.selected span does not match locator`);
  const selection = enumValue(value.selection, new Set(["occurrence-hint", "source-order"]), `${path}.selection`) as "occurrence-hint" | "source-order";
  const hintUsed = boolean(value.hintUsed, `${path}.hintUsed`);
  if (hintUsed !== (selection === "occurrence-hint")) fail(`${path}.hintUsed does not match selection`);
  const ambiguous = boolean(value.ambiguous, `${path}.ambiguous`);
  if (ambiguous !== (count > 1)) fail(`${path}.ambiguous does not match occurrence count`);
  return { resolverVersion: EXACT_OCCURRENCE_RESOLVER_VERSION, count, selected: { index, start, end }, selection, hintUsed, ambiguous };
}

function validateRaw(input: unknown): PortableRawProviderResponse {
  const value = record(input, "result.raw");
  exactKeys(value, [], ["tokensUsed"], "result.raw");
  return {
    ...(value.tokensUsed === undefined ? {} : { tokensUsed: nonNegativeInteger(value.tokensUsed, "result.raw.tokensUsed") }),
  };
}

function validatePartial(input: unknown): ExtractionPartial {
  const value = record(input, "result.partial");
  exactKeys(value, ["reason", "completedChunks", "remainingChunks"], ["tokenOvershoot"], "result.partial");
  return {
    reason: enumValue(value.reason, PARTIAL_REASONS, "result.partial.reason") as ExtractionPartial["reason"],
    completedChunks: nonNegativeInteger(value.completedChunks, "result.partial.completedChunks"),
    remainingChunks: nonNegativeInteger(value.remainingChunks, "result.partial.remainingChunks"),
    ...(value.tokenOvershoot === undefined ? {} : { tokenOvershoot: positiveInteger(value.tokenOvershoot, "result.partial.tokenOvershoot") }),
  };
}

function validateCoverage(input: unknown, artifact: PreparedArtifact | undefined): PortableExtractionCoverageEntry[] {
  if (artifact === undefined) fail("result.coverage requires result.preparedArtifact");
  const entries = array(input, "result.coverage").map((item, index): PortableExtractionCoverageEntry => {
    const path = `result.coverage[${index}]`;
    const value = record(item, path);
    exactKeys(value, ["chunk", "start", "end", "status"], ["reason"], path);
    const chunk = positiveInteger(value.chunk, `${path}.chunk`);
    const start = nonNegativeInteger(value.start, `${path}.start`);
    const end = nonNegativeInteger(value.end, `${path}.end`);
    if (end <= start) fail(`${path} must have start < end`);
    if (end > artifact.contentLength) fail(`${path}.end exceeds prepared artifact contentLength`);
    const status = enumValue(value.status, COVERAGE_STATUSES, `${path}.status`) as ExtractionCoverageStatus;
    if (status === "unread" && value.reason === undefined) fail(`${path}.reason is required when status is unread`);
    if (status !== "unread" && value.reason !== undefined) fail(`${path}.reason is only allowed when status is unread`);
    return {
      chunk, start, end, status,
      ...(value.reason === undefined ? {} : { reason: enumValue(value.reason, COVERAGE_REASONS, `${path}.reason`) as ExtractionCoverageReason }),
    };
  });
  // Ranges may overlap (adjacent chunks share chunkOverlap) but must be ordered.
  if (entries.some((entry, index) => index > 0 && entry.start < entries[index - 1].start)) {
    fail("result.coverage entries must be ordered by start");
  }
  // One entry per chunk, except a chunk cut at maxContentChars: its sent part
  // and its unread/content-truncated tail, which starts where the sent part ends.
  const byChunk = new Map<number, PortableExtractionCoverageEntry[]>();
  for (const entry of entries) byChunk.set(entry.chunk, [...(byChunk.get(entry.chunk) ?? []), entry]);
  for (const [chunk, group] of byChunk) {
    if (group.length === 1) continue;
    const [sent, tail] = group;
    const cutPair = group.length === 2 && tail.status === "unread" && tail.reason === "content-truncated" &&
      sent.reason !== "content-truncated" && sent.reason !== "not-dispatched" && tail.start === sent.end;
    if (!cutPair) fail(`result.coverage has more than one entry for chunk ${chunk} that is not a sent part and its content-truncated tail`);
  }
  return entries;
}

function validateOutcome(input: unknown): PortableExtractionOutcome {
  const value = record(input, "result.outcome");
  if (value.status === "success") {
    exactKeys(value, ["status"], [], "result.outcome");
    return { status: "success" };
  }
  if (value.status === "partial") {
    exactKeys(value, ["status", "reason"], [], "result.outcome");
    return { status: "partial", reason: enumValue(value.reason, PARTIAL_REASONS, "result.outcome.reason") as ExtractionPartial["reason"] };
  }
  if (value.status === "failure") {
    exactKeys(value, ["status", "category", "code"], [], "result.outcome");
    return {
      status: "failure",
      category: enumValue(value.category, new Set(["invalid-config", "invalid-task", "preparation", "provider", "unexpected"]), "result.outcome.category") as Extract<PortableExtractionOutcome, { status: "failure" }>["category"],
      code: stableIdentity(value.code, "result.outcome.code"),
    };
  }
  fail("result.outcome.status is unsupported");
}

function validateWarning(input: unknown, index: number): PortableExtractionWarning {
  const path = `result.warningClassifications[${index}]`;
  const value = record(input, path);
  exactKeys(value, ["category", "code"], [], path);
  return {
    category: enumValue(value.category, new Set(["provider", "normalization", "preparation", "limit", "storage", "content", "other"]), `${path}.category`) as PortableExtractionWarning["category"],
    code: stableIdentity(value.code, `${path}.code`),
  };
}

function validateFailure(input: unknown, index: number): PortableExtractionProviderFailure {
  const path = `result.providerFailures[${index}]`;
  const value = record(input, path);
  exactKeys(value, ["provider", "kind", "retryable"], ["code"], path);
  if (value.code !== undefined && stableIdentity(value.code, `${path}.code`).length > MAX_PORTABLE_FAILURE_CODE_LENGTH) {
    fail(`${path}.code must be at most ${MAX_PORTABLE_FAILURE_CODE_LENGTH} characters`);
  }
  return {
    provider: stableIdentity(value.provider, `${path}.provider`),
    kind: enumValue(value.kind, FAILURE_KINDS, `${path}.kind`) as PortableExtractionProviderFailure["kind"],
    retryable: boolean(value.retryable, `${path}.retryable`),
    ...(value.code === undefined ? {} : { code: value.code as string }),
  };
}

function validateArtifactState(input: unknown): PortablePreparedArtifactState {
  const value = record(input, "result.preparedArtifactState");
  const status = value.status;
  if (status === "invalid-artifact") {
    exactKeys(value, ["status", "reason", "canonicalRef"], [], "result.preparedArtifactState");
    if (!ARTIFACT_REASONS.has(value.reason as PreparedArtifactInvalidReason)) fail("result.preparedArtifactState.reason is unsupported");
    return { status, reason: value.reason as PreparedArtifactInvalidReason, canonicalRef: preparedRef(value.canonicalRef, "result.preparedArtifactState.canonicalRef") };
  }
  if (status === "identity-mismatch") {
    exactKeys(value, ["status", "requestedRef", "canonicalRef"], [], "result.preparedArtifactState");
    const requestedRef = safeReference(value.requestedRef, "result.preparedArtifactState.requestedRef");
    const canonicalRef = preparedRef(value.canonicalRef, "result.preparedArtifactState.canonicalRef");
    if (requestedRef === canonicalRef) fail("identity-mismatch requestedRef must differ from canonicalRef");
    return { status, requestedRef, canonicalRef };
  }
  if (status === "available" || status === "unavailable" || status === "storage-error") {
    exactKeys(value, ["status", "requestedRef", "canonicalRef"], [], "result.preparedArtifactState");
    const requestedRef = preparedRef(value.requestedRef, "result.preparedArtifactState.requestedRef");
    const canonicalRef = preparedRef(value.canonicalRef, "result.preparedArtifactState.canonicalRef");
    if (requestedRef !== canonicalRef) fail(`${status} requestedRef must equal canonicalRef`);
    return { status, requestedRef, canonicalRef };
  }
  if (status === "digest-mismatch") {
    exactKeys(value, ["status", "requestedRef", "canonicalRef", "actualDigest", "actualContentLength"], [], "result.preparedArtifactState");
    const requestedRef = preparedRef(value.requestedRef, "result.preparedArtifactState.requestedRef");
    const canonicalRef = preparedRef(value.canonicalRef, "result.preparedArtifactState.canonicalRef");
    if (requestedRef !== canonicalRef) fail("digest-mismatch requestedRef must equal canonicalRef");
    return {
      status, requestedRef, canonicalRef,
      actualDigest: hexDigest(value.actualDigest, "result.preparedArtifactState.actualDigest"),
      actualContentLength: nonNegativeInteger(value.actualContentLength, "result.preparedArtifactState.actualContentLength"),
    };
  }
  fail("result.preparedArtifactState.status is unsupported");
}

function validArtifact(input: unknown, path: string): PreparedArtifact {
  strictArtifactShape(input, path);
  const validation = validatePreparedArtifact(input);
  if (validation.status !== "valid") fail(`${path} is not a valid prepared artifact (${validation.status})`);
  return validation.artifact;
}

function strictArtifactShape(input: unknown, path: string): void {
  const value = record(input, path);
  exactKeys(value, ["format", "version", "digest", "ref", "preparationMode", "preparationVersion", "contentLength"], ["sourceSnapshotRef"], path);
}

function validatePageOffsets(input: unknown): number[] {
  const offsets = array(input, "result.pdfPageOffsets").map((item, index) => nonNegativeInteger(item, `result.pdfPageOffsets[${index}]`));
  if (offsets.some((offset, index) => index > 0 && offset <= offsets[index - 1])) fail("result.pdfPageOffsets must ascend strictly");
  return offsets;
}

function validateLocator(input: unknown, path: string): { start: number; end: number } {
  const locator = string(input, path);
  const match = LOCATOR.exec(locator);
  if (!match) fail(`${path} uses an unsupported locator`);
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) fail(`${path} is not an ordered safe-integer span`);
  return { start, end };
}

function assertJsonSafe(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") { if (!isWellFormedUnicode(value)) fail(`${path} contains ill-formed Unicode`); return; }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail(`${path} contains a non-lossless JSON number`);
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) fail(`${path} is cyclic`);
    const keys = Reflect.ownKeys(value);
    const expected = new Set<PropertyKey>(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
    for (const key of keys) {
      if (typeof key === "symbol" || !expected.has(key)) fail(`${path} is sparse or has unexpected properties`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) fail(`${path} has an accessor property`);
      if (key !== "length" && !descriptor.enumerable) fail(`${path} has a non-enumerable property`);
    }
    if (keys.length !== expected.size) fail(`${path} is sparse or has unexpected properties`);
    ancestors.add(value);
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index)) as PropertyDescriptor;
      assertJsonSafe(descriptor.value, `${path}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) fail(`${path} is not JSON data`);
  if (ancestors.has(value)) fail(`${path} is cyclic`);
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") fail(`${path} has a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !isWellFormedUnicode(key)) fail(`${path} has an accessor or non-enumerable property`);
    assertJsonSafe(descriptor.value, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function canonicalJson(value: unknown): string {
  assertJsonSafe(value, "envelope");
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort(compareCodeUnits).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function record(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) fail(`${path} must be an object`);
  return input as Record<string, unknown>;
}

function array(input: unknown, path: string): unknown[] {
  if (!Array.isArray(input)) fail(`${path} must be an array`);
  return input;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[], path: string): void {
  const ownKeys = Reflect.ownKeys(value);
  for (const key of required) if (!ownKeys.includes(key)) fail(`${path}.${key} is required`);
  const allowed = new Set([...required, ...optional]);
  for (const key of ownKeys) {
    if (typeof key === "symbol" || !allowed.has(key)) fail(`${path}.${String(key)} is not allowed`);
  }
}

function string(input: unknown, path: string): string {
  if (typeof input !== "string" || !isWellFormedUnicode(input)) fail(`${path} must be a well-formed string`);
  return input;
}

function nonEmptyString(input: unknown, path: string): string {
  const value = string(input, path);
  if (value.length === 0) fail(`${path} must be non-empty`);
  return value;
}

function stableIdentity(input: unknown, path: string): string {
  const value = nonEmptyString(input, path);
  if (!isPortableStableIdentity(value)) fail(`${path} must be a credential-free stable identity`);
  return value;
}

/**
 * The envelope's own identity rule, shared with `extract()` normalization so a
 * value extract() keeps can never be one the envelope rejects.
 */
export function isPortableStableIdentity(value: unknown): value is string {
  return typeof value === "string" && isWellFormedUnicode(value) &&
    STABLE_IDENTITY.test(value) && !CREDENTIAL_IDENTITY.test(value) && !referenceContainsAuthorization(value);
}

/** The envelope's own lossless-JSON rule, shared with `extract()` normalization. */
export function isPortableJsonValue(value: unknown): boolean {
  try {
    assertJsonSafe(value, "value");
    return true;
  } catch {
    return false;
  }
}

function preparedRef(input: unknown, path: string): string {
  const value = safeReference(input, path);
  if (!/^traverse-prepared-artifact:v1:sha256:[a-f0-9]{64}$/.test(value)) fail(`${path} must be a prepared-artifact reference`);
  return value;
}

function safeReference(input: unknown, path: string): string {
  const value = nonEmptyString(input, path);
  if (referenceContainsAuthorization(value)) fail(`${path} contains authorization material`);
  return value;
}

function referenceContainsAuthorization(value: string, depth = 0): boolean {
  if (depth > 2 || /authorization\s*[:=]|bearer\s+[a-z0-9._~-]+/i.test(value)) return true;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.username !== "" || parsed.password !== "") return true;
  for (const [key, nested] of parsed.searchParams) {
    if (/(?:^|[-_])(token|secret|password|passwd|api[-_]?key|authorization|signature|credential)(?:$|[-_])/i.test(key)) return true;
    if (referenceContainsAuthorization(nested, depth + 1)) return true;
  }
  return false;
}

function strings(input: unknown, path: string): string[] {
  return array(input, path).map((item, index) => string(item, `${path}[${index}]`));
}

function finiteNumber(input: unknown, path: string, min: number, max: number): number {
  if (typeof input !== "number" || !Number.isFinite(input) || Object.is(input, -0) || input < min || input > max) fail(`${path} must be a finite number in ${min}..${max}`);
  return input;
}

function nonNegativeInteger(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || Object.is(input, -0) || input < 0) fail(`${path} must be a non-negative safe integer`);
  return input;
}

function positiveInteger(input: unknown, path: string): number {
  const value = nonNegativeInteger(input, path);
  if (value === 0) fail(`${path} must be positive`);
  return value;
}

function boolean(input: unknown, path: string): boolean {
  if (typeof input !== "boolean") fail(`${path} must be boolean`);
  return input;
}

function literalTrue(input: unknown, path: string): true {
  if (input !== true) fail(`${path} must be true when present`);
  return true;
}

function enumValue(input: unknown, values: ReadonlySet<string>, path: string): string {
  if (typeof input !== "string" || !values.has(input)) fail(`${path} has an unsupported value`);
  return input;
}

function digest(input: unknown, path: string): string {
  const value = string(input, path);
  if (!SHA256.test(value)) fail(`${path} must be a sha256 digest`);
  return value;
}

function hexDigest(input: unknown, path: string): string {
  const value = string(input, path);
  if (!HEX_SHA256.test(value)) fail(`${path} must be a sha256 hex digest`);
  return value;
}

function runIdentity(input: unknown, path: string): string {
  const value = string(input, path);
  if (!RUN_ID.test(value)) fail(`${path} must be a Traverse extraction-run identity`);
  return value;
}

function fail(reason: string): never { throw new TypeError(reason); }
