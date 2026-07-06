/**
 * `fetchAndExtract` — one-call composition of the fetch side and the extract
 * side, with PROVENANCE CONTINUITY.
 *
 * It wires: (fetch | replay) -> snapshot -> prepareContent (inside extract) ->
 * extract, and threads a `sourceRef` built from the snapshot's identity into
 * `extract()` so every resulting proposal is traceable back to the EXACT bytes
 * it came from:
 *
 *   traverse-snapshot:<sourceId>?url=<final-url>&sha256=<bodyHash>&fetchedAt=<iso>
 *
 * Given any extraction produced here, `parseSnapshotSourceRef(result.sourceRef)`
 * yields `{ sourceId, url, bodyHash, fetchedAt }`, and
 * `store.get(sourceId, bodyHash)` returns the byte-identical snapshot the
 * proposals were drawn from. This is the fetch-side analogue of the extraction
 * side's enforced excerpt provenance.
 *
 * Modes:
 *  - `live`             — fetch over the network; do not persist.
 *  - `live-with-capture`— fetch over the network; persist the snapshot to `store`.
 *  - `replay`           — do not touch the network; serve the latest snapshot
 *                         from `store`. This is what CI uses.
 */

import { extract } from "../extract.js";
import type { ExtractionProvider, ExtractionResult, TargetFieldSchema } from "../types.js";
import { fetchSource } from "./fetch-source.js";
import { replaySource } from "./snapshot-store.js";
import type { FetchResult, FetchSourceOptions, Snapshot, SnapshotStore, SourceConfig } from "./types.js";

export type FetchMode = "live" | "replay" | "live-with-capture";

export interface FetchAndExtractOptions {
  /** the fields to extract — same contract as `extract()`'s `targetSchema`. */
  targetSchema: TargetFieldSchema[];
  /** the extraction provider (mock/Anthropic/any) — same contract as `extract()`. */
  provider: ExtractionProvider;
  /** snapshot store; REQUIRED for `replay` and `live-with-capture`. */
  store?: SnapshotStore;
  /** live (default) | replay | live-with-capture. */
  mode?: FetchMode;
  /** optional per-field hints forwarded to `extract()`. */
  fieldHints?: Record<string, string>;
  /** optional per-chunk provider budget forwarded to `extract()`. */
  maxContentChars?: number;
  /** structure-preserving prep mode forwarded to `extract()` (default markdown for html). */
  prep?: "text" | "markdown";
  /** target max characters per chunk forwarded to `extract()` (default 12_000). */
  chunkSize?: number;
  /** character-window overlap forwarded to `extract()` (default 200). */
  chunkOverlap?: number;
  /** cap on number of chunks forwarded to `extract()` (default 40). */
  maxChunks?: number;
  /** injectable fetch/time seams forwarded to `fetchSource()` (network-free tests). */
  fetchOptions?: FetchSourceOptions;
  /** ceiling on provider.extract() calls in one run, forwarded to extract() (see ExtractInput.maxProviderCalls). */
  maxProviderCalls?: number;
  /** ceiling on accumulated raw.tokensUsed in one run, forwarded to extract() (see ExtractInput.maxTotalTokens). */
  maxTotalTokens?: number;
}

export interface FetchAndExtractResult {
  /** the fetch (or replay) outcome — `snapshot` or typed `error`, never throws. */
  fetch: FetchResult;
  /** the extraction outcome — present only when the fetch produced a snapshot. */
  extraction?: ExtractionResult;
  /** the snapshot-anchored provenance ref threaded into `extract()`, when fetched. */
  sourceRef?: string;
}

/** Build the snapshot-anchored provenance sourceRef for a snapshot. */
export function buildSnapshotSourceRef(snapshot: Snapshot): string {
  const params = new URLSearchParams({
    url: snapshot.url,
    sha256: snapshot.bodyHash,
    fetchedAt: snapshot.fetchedAt,
  });
  return `traverse-snapshot:${encodeURIComponent(snapshot.sourceId)}?${params.toString()}`;
}

export interface ParsedSnapshotSourceRef {
  sourceId: string;
  url: string;
  bodyHash: string;
  fetchedAt: string;
}

/**
 * Parse a `buildSnapshotSourceRef` string back into its components, or
 * `undefined` if `ref` is not a traverse-snapshot ref. Round-trips
 * `buildSnapshotSourceRef` exactly.
 */
export function parseSnapshotSourceRef(ref: string): ParsedSnapshotSourceRef | undefined {
  const prefix = "traverse-snapshot:";
  if (!ref.startsWith(prefix)) return undefined;
  const rest = ref.slice(prefix.length);
  const q = rest.indexOf("?");
  if (q === -1) return undefined;
  const sourceId = decodeURIComponent(rest.slice(0, q));
  const params = new URLSearchParams(rest.slice(q + 1));
  const url = params.get("url");
  const bodyHash = params.get("sha256");
  const fetchedAt = params.get("fetchedAt");
  if (!url || !bodyHash || !fetchedAt) return undefined;
  return { sourceId, url, bodyHash, fetchedAt };
}

async function acquire(config: SourceConfig, opts: FetchAndExtractOptions): Promise<FetchResult> {
  const mode = opts.mode ?? "live";
  if (mode === "replay") {
    if (!opts.store) {
      return { error: { kind: "invalid-config", message: "mode 'replay' requires a store" } };
    }
    return replaySource(opts.store, config.id);
  }
  // Thread the composition-level `store` into fetchSource's options when the
  // caller didn't set one explicitly, so a `SourceConfig.revalidate` conditional
  // GET can look up the prior snapshot (fetchSource reads `store.latest(id)`).
  // Without this, `fetchAndExtract` with `store` + `revalidate: true` would
  // silently fetch unconditionally every time.
  const fetchOptions: FetchSourceOptions = { ...(opts.fetchOptions ?? {}) };
  if (opts.store && fetchOptions.store === undefined) fetchOptions.store = opts.store;

  const result = await fetchSource(config, fetchOptions);
  if (mode === "live-with-capture" && result.snapshot && opts.store) {
    await opts.store.put(result.snapshot);
  }
  return result;
}

/**
 * Fetch (or replay) a source and extract from its snapshot in one call.
 * Never throws: a fetch failure returns `{ fetch }` with no `extraction`.
 */
export async function fetchAndExtract(
  config: SourceConfig,
  opts: FetchAndExtractOptions,
): Promise<FetchAndExtractResult> {
  const fetchResult = await acquire(config, opts);
  if (!fetchResult.snapshot) {
    return { fetch: fetchResult };
  }
  const snapshot = fetchResult.snapshot;
  const sourceRef = buildSnapshotSourceRef(snapshot);

  const extraction = await extract({
    content: snapshot.body,
    contentType: snapshot.contentType,
    sourceRef,
    targetSchema: opts.targetSchema,
    provider: opts.provider,
    fieldHints: opts.fieldHints,
    maxContentChars: opts.maxContentChars,
    prep: opts.prep,
    chunkSize: opts.chunkSize,
    chunkOverlap: opts.chunkOverlap,
    maxChunks: opts.maxChunks,
    maxProviderCalls: opts.maxProviderCalls,
    maxTotalTokens: opts.maxTotalTokens,
    // pdfTextExtractor is deliberately NOT forwarded here: Snapshot.body is
    // typed `string` (see traverse#23 — binary content is corrupted before
    // it ever reaches a Snapshot), so when a replayed/fetched snapshot's
    // contentType is "pdf", extract()'s PDF pre-step already fails with
    // pdfBytesRequiredError() (src/extract.ts:141-152) before any
    // pdfTextExtractor would be consulted. Forwarding this option here
    // would be a dead option that traps consumers into configuring
    // something that can never run through this seam. Revisit once #23
    // gives Snapshot a binary-safe body representation.
  });

  return { fetch: fetchResult, extraction, sourceRef };
}
