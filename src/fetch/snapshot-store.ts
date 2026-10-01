/**
 * Snapshot persistence + replay.
 *
 * `createFilesystemSnapshotStore` lays snapshots out on disk as
 *   <root>/<sourceDir>/<fetchedAt>-<hashPrefix>.json
 * where `<sourceDir>` is a filesystem-safe rendering of the caller's `sourceId`
 * (the original id is always preserved verbatim inside the JSON), `<fetchedAt>`
 * is the ISO instant with `:` replaced by `-` (so filenames sort chronologically
 * AND are path-safe), and `<hashPrefix>` is the first 12 hex chars of the body
 * SHA-256. `latest()` returns the newest by `fetchedAt`; `get()` resolves a
 * snapshot by full-or-prefix `bodyHash`.
 *
 * `replaySource()` returns the latest snapshot as a `FetchResult` (with
 * `fromCache: true`) — the SAME shape a live `fetchSource()` call returns — so
 * downstream code is byte-identical live vs. replay, and CI never needs the
 * network.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { compareCodeUnits } from "../canonical-json.js";
import { decodeTextBody } from "@kontourai/forage/fetch";
import type { FetchResult, Snapshot, SnapshotStore } from "./types.js";

/** Render a caller-owned sourceId into a stable, collision-resistant dir name. */
function sourceDirName(sourceId: string): string {
  const safe = sourceId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "source";
  // Append a short hash of the ORIGINAL id so two distinct ids that sanitise to
  // the same string never share a directory.
  const disc = createHash("sha256").update(sourceId, "utf8").digest("hex").slice(0, 8);
  return `${safe}-${disc}`;
}

function snapshotFileName(snapshot: Snapshot): string {
  const ts = snapshot.fetchedAt.replace(/:/g, "-");
  return `${ts}-${snapshot.bodyHash.slice(0, 12)}.json`;
}

/**
 * JSON-serialisable on-disk shape. Each byte field present becomes base64 in a
 * sibling `<field>Base64`. A text record that carries `bytes` is written
 * WITHOUT `body`: the text is derived from the bytes on read, so a stored
 * record cannot hold a body that disagrees with the bytes its hash covers.
 */
const BYTE_FIELDS = ["bodyBytes", "bytes"] as const;

function toDiskShape(snapshot: Snapshot): Record<string, unknown> {
  const out: Record<string, unknown> = { ...snapshot };
  for (const field of BYTE_FIELDS) {
    const value = snapshot[field];
    if (value === undefined) continue;
    delete out[field];
    out[`${field}Base64`] = Buffer.from(value).toString("base64");
  }
  if (snapshot.bytes !== undefined) delete out.body;
  return out;
}

/** Reverse of toDiskShape's base64 step. Files without a base64 sibling field pass through unchanged. */
function fromDiskShape(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of BYTE_FIELDS) {
    const encoded = out[`${field}Base64`];
    if (typeof encoded !== "string") continue;
    delete out[`${field}Base64`];
    out[field] = new Uint8Array(Buffer.from(encoded, "base64"));
  }
  return out;
}

/**
 * Bind a text record that carries `bytes` to those bytes.
 *
 * Returns the record with `body` decoded from `bytes` using `declaredCharset`,
 * whatever `body` it arrived with, or `undefined` when the bytes do not hash
 * to `bodyHash` or `declaredCharset` is missing or not a string or `null`. A
 * record without `bytes` is returned as it is, unless it has a
 * `declaredCharset` with no bytes behind it.
 *
 * Only `bytes` is checked. A binary record's `bodyBytes` and the body of a
 * text record without `bytes` are returned as stored.
 */
function bindTextBytes(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if (v.bytes === undefined) return v.declaredCharset === undefined ? value : undefined;
  if (!(v.bytes instanceof Uint8Array)) return undefined;
  if (v.declaredCharset !== null && typeof v.declaredCharset !== "string") return undefined;
  if (createHash("sha256").update(v.bytes).digest("hex") !== v.bodyHash) return undefined;
  return { ...v, body: decodeTextBody(v.bytes, v.declaredCharset).text };
}

function isSnapshot(value: unknown): value is Snapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.bodyBytes !== undefined && !(v.bodyBytes instanceof Uint8Array)) return false;
  return (
    typeof v.sourceId === "string" &&
    typeof v.url === "string" &&
    typeof v.fetchedAt === "string" &&
    typeof v.status === "number" &&
    typeof v.contentType === "string" &&
    typeof v.body === "string" &&
    typeof v.bodyHash === "string"
  );
}

export interface FilesystemSnapshotStoreOptions {
  /** root directory under which per-source snapshot folders are created. */
  root: string;
}

/**
 * A filesystem-backed {@link SnapshotStore}. Reads tolerate a partially-written
 * or foreign file (unparseable/shape-invalid entries are skipped), so a
 * corrupt file never crashes `latest()`/`list()`.
 *
 * A text record whose `bytes` do not hash to its `bodyHash` is skipped the same
 * way. `SnapshotStore` has no channel to report a skipped record, so the skip
 * is silent: `get()` by that hash finds nothing, and `latest()` returns the
 * newest record that does verify, which may be an older capture.
 */
export function createFilesystemSnapshotStore(
  opts: FilesystemSnapshotStoreOptions,
): SnapshotStore {
  const root = path.resolve(opts.root);

  async function readAll(sourceId: string): Promise<Snapshot[]> {
    const dir = path.join(root, sourceDirName(sourceId));
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: Snapshot[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = bindTextBytes(fromDiskShape(JSON.parse(await readFile(path.join(dir, name), "utf8"))));
        if (isSnapshot(parsed)) out.push(parsed);
      } catch {
        // skip unreadable/foreign file
      }
    }
    // newest first by fetchedAt (ISO sorts lexicographically), hash as tiebreak.
    out.sort((a, b) =>
      a.fetchedAt === b.fetchedAt ? compareCodeUnits(b.bodyHash, a.bodyHash) : compareCodeUnits(b.fetchedAt, a.fetchedAt),
    );
    return out;
  }

  return {
    async put(snapshot: Snapshot): Promise<void> {
      const dir = path.join(root, sourceDirName(snapshot.sourceId));
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, snapshotFileName(snapshot));
      await writeFile(file, JSON.stringify(toDiskShape(snapshot), null, 2), "utf8");
    },
    async latest(sourceId: string): Promise<Snapshot | undefined> {
      return (await readAll(sourceId))[0];
    },
    async get(sourceId: string, bodyHash: string): Promise<Snapshot | undefined> {
      const all = await readAll(sourceId);
      return all.find((s) => s.bodyHash === bodyHash || s.bodyHash.startsWith(bodyHash));
    },
    async list(sourceId: string): Promise<Snapshot[]> {
      return readAll(sourceId);
    },
  };
}

/**
 * An in-memory {@link SnapshotStore} — no persistence. Handy for tests and for
 * a single-process live-with-capture run that only needs replay within the same
 * process. Keeps insertion order per source; `latest()` honors `fetchedAt`.
 */
export function createInMemorySnapshotStore(): SnapshotStore {
  const bySource = new Map<string, Snapshot[]>();
  function sorted(sourceId: string): Snapshot[] {
    // Same read rule as the filesystem store: text is derived from `bytes`, and
    // a record whose bytes no longer hash to its `bodyHash` is skipped.
    const arr = (bySource.get(sourceId) ?? []).map(bindTextBytes).filter(isSnapshot);
    arr.sort((a, b) =>
      a.fetchedAt === b.fetchedAt ? compareCodeUnits(b.bodyHash, a.bodyHash) : compareCodeUnits(b.fetchedAt, a.fetchedAt),
    );
    return arr;
  }
  return {
    async put(snapshot: Snapshot): Promise<void> {
      const arr = bySource.get(snapshot.sourceId) ?? [];
      arr.push({ ...snapshot });
      bySource.set(snapshot.sourceId, arr);
    },
    async latest(sourceId: string): Promise<Snapshot | undefined> {
      return sorted(sourceId)[0];
    },
    async get(sourceId: string, bodyHash: string): Promise<Snapshot | undefined> {
      return sorted(sourceId).find((s) => s.bodyHash === bodyHash || s.bodyHash.startsWith(bodyHash));
    },
    async list(sourceId: string): Promise<Snapshot[]> {
      return sorted(sourceId);
    },
  };
}

/**
 * Return the latest stored snapshot for `sourceId` as a `FetchResult`, marked
 * `fromCache: true`. When no snapshot exists, a typed `no-snapshot` error is
 * returned (never thrown) — same never-throw discipline as `fetchSource()`.
 */
export async function replaySource(
  store: SnapshotStore,
  sourceId: string,
): Promise<FetchResult> {
  const snapshot = await store.latest(sourceId);
  if (!snapshot) {
    return { error: { kind: "no-snapshot", message: `no snapshot stored for sourceId "${sourceId}"` } };
  }
  return { snapshot: { ...snapshot, fromCache: true } };
}
