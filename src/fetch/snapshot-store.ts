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

/** JSON-serialisable on-disk shape: bodyBytes (if any) becomes base64 in a sibling field. */
function toDiskShape(snapshot: Snapshot): Record<string, unknown> {
  if (snapshot.bodyBytes === undefined) return snapshot as unknown as Record<string, unknown>;
  const { bodyBytes, ...rest } = snapshot;
  return { ...rest, bodyBytesBase64: Buffer.from(bodyBytes).toString("base64") };
}

/** Reverse of toDiskShape: base64 sibling field -> bodyBytes. Old files (no such field) pass through unchanged. */
function fromDiskShape(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const v = value as Record<string, unknown>;
  if (typeof v.bodyBytesBase64 !== "string") return value;
  const { bodyBytesBase64, ...rest } = v;
  return { ...rest, bodyBytes: new Uint8Array(Buffer.from(bodyBytesBase64 as string, "base64")) };
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
        const parsed = fromDiskShape(JSON.parse(await readFile(path.join(dir, name), "utf8")));
        if (isSnapshot(parsed)) out.push(parsed);
      } catch {
        // skip unreadable/foreign file
      }
    }
    // newest first by fetchedAt (ISO sorts lexicographically), hash as tiebreak.
    out.sort((a, b) =>
      a.fetchedAt === b.fetchedAt ? b.bodyHash.localeCompare(a.bodyHash) : b.fetchedAt.localeCompare(a.fetchedAt),
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
    const arr = [...(bySource.get(sourceId) ?? [])];
    arr.sort((a, b) =>
      a.fetchedAt === b.fetchedAt ? b.bodyHash.localeCompare(a.bodyHash) : b.fetchedAt.localeCompare(a.fetchedAt),
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
