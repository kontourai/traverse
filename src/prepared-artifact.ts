/**
 * Versioned identity and resolution for the exact prepared text behind an
 * extraction result. The text itself deliberately remains caller-owned: an
 * ExtractionResult carries this compact identity, never a copy of the text.
 */

import { createHash } from "node:crypto";

export const PREPARED_ARTIFACT_FORMAT = "traverse-prepared-artifact";
export const PREPARED_ARTIFACT_VERSION = 1;
export const PREPARED_ARTIFACT_PREPARATION_VERSION = "1";

export type PreparedArtifactPreparationMode = "text" | "markdown" | "transcript" | "pdf-text" | "image-ocr";

/** A versioned reference whose identity binds preparation metadata and text. */
export type PreparedArtifactRef = `${typeof PREPARED_ARTIFACT_FORMAT}:v${typeof PREPARED_ARTIFACT_VERSION}:sha256:${string}`;

export interface PreparedArtifact {
  format: typeof PREPARED_ARTIFACT_FORMAT;
  version: typeof PREPARED_ARTIFACT_VERSION;
  /** SHA-256 of the exact UTF-8 prepared text. */
  digest: string;
  /** SHA-256 identity of the canonical artifact binding. */
  ref: PreparedArtifactRef;
  preparationMode: PreparedArtifactPreparationMode;
  preparationVersion: string;
  /** UTF-16 code-unit length, matching chars:<start>-<end> locators. */
  contentLength: number;
  /** Optional immutable snapshot identity supplied by a fetch/replay adapter. */
  sourceSnapshotRef?: string;
}

export interface PreparedArtifactOptions {
  preparationMode: PreparedArtifactPreparationMode;
  preparationVersion?: string;
  sourceSnapshotRef?: string;
}

/** Storage is injected: Traverse never persists caller text unless asked to. */
export interface PreparedArtifactStore {
  get(ref: PreparedArtifactRef): string | undefined | Promise<string | undefined>;
  put?(artifact: PreparedArtifact, text: string): void | Promise<void>;
}

export type PreparedArtifactResolution =
  | { status: "available"; artifact: PreparedArtifact; text: string }
  | { status: "unavailable"; artifact: PreparedArtifact }
  | { status: "storage-error"; artifact: PreparedArtifact }
  | { status: "invalid-artifact"; reason: PreparedArtifactInvalidReason }
  | { status: "identity-mismatch"; artifact: PreparedArtifact }
  | {
      status: "digest-mismatch";
      artifact: PreparedArtifact;
      actualDigest: string;
      actualContentLength: number;
    };

export type PreparedArtifactInvalidReason =
  | "not-an-object"
  | "invalid-format"
  | "invalid-version"
  | "invalid-digest"
  | "invalid-ref"
  | "invalid-preparation-mode"
  | "invalid-preparation-version"
  | "invalid-content-length"
  | "invalid-source-snapshot-ref"
  | "ill-formed-unicode"
  | "invalid-resolved-text";

export type PreparedArtifactValidation =
  | { status: "valid"; artifact: PreparedArtifact }
  | { status: "invalid-artifact"; reason: PreparedArtifactInvalidReason }
  | { status: "identity-mismatch"; artifact: PreparedArtifact };

export interface ParsedPreparedArtifactRef {
  version: typeof PREPARED_ARTIFACT_VERSION;
  identity: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** UTF-8 encoding replaces lone surrogates, so reject them before hashing. */
export function isWellFormedUnicode(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function canonicalBinding(artifact: Omit<PreparedArtifact, "ref">): string {
  return JSON.stringify({
    format: artifact.format,
    version: artifact.version,
    digest: artifact.digest,
    preparationMode: artifact.preparationMode,
    preparationVersion: artifact.preparationVersion,
    contentLength: artifact.contentLength,
    sourceSnapshotRef: artifact.sourceSnapshotRef ?? null,
  });
}

/** Build the deterministic identity for exact prepared text and its preparation. */
export function createPreparedArtifact(text: string, options: PreparedArtifactOptions): PreparedArtifact {
  const preparationVersion = options.preparationVersion ?? PREPARED_ARTIFACT_PREPARATION_VERSION;
  if (!isWellFormedUnicode(text)) throw new Error("prepared artifact text must be well-formed Unicode");
  if (!PREPARATION_MODES.has(options.preparationMode)) throw new Error("prepared artifact preparationMode is invalid");
  if (preparationVersion.trim().length === 0 || !isWellFormedUnicode(preparationVersion)) {
    throw new Error("prepared artifact preparationVersion is invalid");
  }
  if (options.sourceSnapshotRef !== undefined &&
      (options.sourceSnapshotRef.length === 0 || !isWellFormedUnicode(options.sourceSnapshotRef))) {
    throw new Error("prepared artifact sourceSnapshotRef is invalid");
  }
  const binding = {
    format: PREPARED_ARTIFACT_FORMAT,
    version: PREPARED_ARTIFACT_VERSION,
    digest: sha256(text),
    preparationMode: options.preparationMode,
    preparationVersion,
    contentLength: text.length,
    ...(options.sourceSnapshotRef !== undefined ? { sourceSnapshotRef: options.sourceSnapshotRef } : {}),
  } as const;
  const identity = sha256(canonicalBinding(binding));
  return {
    ...binding,
    ref: `${PREPARED_ARTIFACT_FORMAT}:v${PREPARED_ARTIFACT_VERSION}:sha256:${identity}`,
  };
}

/** Parse a versioned prepared-artifact ref without resolving any caller text. */
export function parsePreparedArtifactRef(ref: string): ParsedPreparedArtifactRef | undefined {
  if (typeof ref !== "string") return undefined;
  const match = new RegExp(`^${PREPARED_ARTIFACT_FORMAT}:v${PREPARED_ARTIFACT_VERSION}:sha256:([a-f0-9]{64})$`).exec(ref);
  return match ? { version: PREPARED_ARTIFACT_VERSION, identity: match[1] } : undefined;
}

const PREPARATION_MODES = new Set<unknown>(["text", "markdown", "transcript", "pdf-text", "image-ocr"]);
const SHA256_RE = /^[a-f0-9]{64}$/;

/** Validate untrusted artifact metadata and its canonical identity before I/O. */
export function validatePreparedArtifact(input: unknown): PreparedArtifactValidation {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { status: "invalid-artifact", reason: "not-an-object" };
    }
    const value = input as Record<string, unknown>;
    if (value.format !== PREPARED_ARTIFACT_FORMAT) return { status: "invalid-artifact", reason: "invalid-format" };
    if (value.version !== PREPARED_ARTIFACT_VERSION) return { status: "invalid-artifact", reason: "invalid-version" };
    if (typeof value.digest !== "string" || !SHA256_RE.test(value.digest)) {
      return { status: "invalid-artifact", reason: "invalid-digest" };
    }
    if (typeof value.ref !== "string" || !parsePreparedArtifactRef(value.ref)) {
      return { status: "invalid-artifact", reason: "invalid-ref" };
    }
    if (!PREPARATION_MODES.has(value.preparationMode)) {
      return { status: "invalid-artifact", reason: "invalid-preparation-mode" };
    }
    if (typeof value.preparationVersion !== "string" || value.preparationVersion.trim().length === 0) {
      return { status: "invalid-artifact", reason: "invalid-preparation-version" };
    }
    if (!Number.isSafeInteger(value.contentLength) || (value.contentLength as number) < 0) {
      return { status: "invalid-artifact", reason: "invalid-content-length" };
    }
    if (value.sourceSnapshotRef !== undefined &&
        (typeof value.sourceSnapshotRef !== "string" || value.sourceSnapshotRef.length === 0)) {
      return { status: "invalid-artifact", reason: "invalid-source-snapshot-ref" };
    }
    const strings = [value.digest, value.ref, value.preparationVersion, value.sourceSnapshotRef]
      .filter((candidate): candidate is string => typeof candidate === "string");
    if (strings.some((candidate) => !isWellFormedUnicode(candidate))) {
      return { status: "invalid-artifact", reason: "ill-formed-unicode" };
    }

    // Reconstruct the trusted shape so extra attacker-controlled properties
    // (including a misleading `text` field or custom serialization hook) never
    // escape through validation/resolution outcomes.
    const artifact: PreparedArtifact = {
      format: PREPARED_ARTIFACT_FORMAT,
      version: PREPARED_ARTIFACT_VERSION,
      digest: value.digest,
      ref: value.ref as PreparedArtifactRef,
      preparationMode: value.preparationMode as PreparedArtifactPreparationMode,
      preparationVersion: value.preparationVersion,
      contentLength: value.contentLength as number,
      ...(typeof value.sourceSnapshotRef === "string" ? { sourceSnapshotRef: value.sourceSnapshotRef } : {}),
    };
    const expectedIdentity = sha256(canonicalBinding({
      format: artifact.format,
      version: artifact.version,
      digest: artifact.digest,
      preparationMode: artifact.preparationMode,
      preparationVersion: artifact.preparationVersion,
      contentLength: artifact.contentLength,
      ...(artifact.sourceSnapshotRef !== undefined ? { sourceSnapshotRef: artifact.sourceSnapshotRef } : {}),
    }));
    const parsed = parsePreparedArtifactRef(artifact.ref) as ParsedPreparedArtifactRef;
    if (parsed.identity !== expectedIdentity) return { status: "identity-mismatch", artifact };
    return { status: "valid", artifact };
  } catch {
    return { status: "invalid-artifact", reason: "not-an-object" };
  }
}

/** Resolve caller-owned text and visibly verify its digest before returning it. */
export async function resolvePreparedArtifact(
  artifactInput: unknown,
  store: PreparedArtifactStore,
): Promise<PreparedArtifactResolution> {
  const validation = validatePreparedArtifact(artifactInput);
  if (validation.status !== "valid") return validation;
  const artifact = validation.artifact;
  let text: string | undefined;
  try {
    if (!store || typeof store.get !== "function") return { status: "storage-error", artifact };
    text = await store.get(artifact.ref);
  } catch {
    return { status: "storage-error", artifact };
  }
  if (text === undefined) return { status: "unavailable", artifact };
  if (typeof text !== "string" || !isWellFormedUnicode(text)) {
    return { status: "invalid-artifact", reason: "invalid-resolved-text" };
  }
  const actualDigest = sha256(text);
  if (actualDigest !== artifact.digest || text.length !== artifact.contentLength) {
    return { status: "digest-mismatch", artifact, actualDigest, actualContentLength: text.length };
  }
  return { status: "available", artifact, text };
}

/** A generic non-persistent store for capture/replay tests and single processes. */
export function createInMemoryPreparedArtifactStore(): PreparedArtifactStore {
  const textByRef = new Map<PreparedArtifactRef, string>();
  return {
    get: (ref) => textByRef.get(ref),
    put: (artifact, text) => {
      textByRef.set(artifact.ref, text);
    },
  };
}
