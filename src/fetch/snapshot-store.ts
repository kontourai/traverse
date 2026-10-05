/**
 * Snapshot persistence + replay.
 *
 * `createFilesystemSnapshotStore` lays snapshots out on disk as
 *   <root>/<sourceDir>/<fetchedAt>-<hashPrefix>.json
 * where `<sourceDir>` is a filesystem-safe rendering of the caller's `sourceId`
 * (the original id is always preserved verbatim inside the JSON), `<fetchedAt>`
 * is the ISO instant with `:` replaced by `-` (path-safe; the names are not
 * what orders snapshots), and `<hashPrefix>` is the first 12 hex chars of the
 * body SHA-256. `latest()` returns the newest by the instant `fetchedAt` names
 * (see `sortNewestFirst`); `get()` resolves a snapshot by full-or-prefix
 * `bodyHash`.
 *
 * `replaySource()` returns the latest snapshot as a `FetchResult` (with
 * `fromCache: true`) — the SAME shape a live `fetchSource()` call returns — so
 * downstream code is byte-identical live vs. replay, and CI never needs the
 * network.
 */

import { constants as fsConstants } from "node:fs";
import { mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { compareCodeUnits } from "../canonical-json.js";
import { decodeTextBody } from "@kontourai/forage/fetch";
import { describeThrown } from "./describe-thrown.js";
import type { FetchResult, Snapshot, SnapshotStore } from "./types.js";

/** Render a caller-owned sourceId into a stable, collision-resistant dir name. */
function sourceDirName(sourceId: string): string {
  const safe = sourceId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "source";
  // Append a short hash of the ORIGINAL id so two distinct ids that sanitise to
  // the same string never share a directory.
  const disc = createHash("sha256").update(sourceId, "utf8").digest("hex").slice(0, 8);
  return `${safe}-${disc}`;
}

/**
 * An ISO-8601 instant in extended format, as `Date.prototype.toISOString()`
 * writes it (the library's default clock) or with a UTC offset, seconds or
 * fraction left out. The fraction has at most 9 digits. Only digits, `T`, `Z`,
 * `:`, `.`, `+` and `-` can match, so the file name built from it stays a
 * single, short path segment.
 */
const ISO_INSTANT = /^([+-]\d{6}|\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function isIsoInstant(value: string): boolean {
  const match = ISO_INSTANT.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) return false;
  // Date.parse accepts a day past the end of its month (2026-02-30). A date
  // that does not exist rolls over into another month, or another year.
  const [, year, month, day] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  return date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day);
}

/**
 * `snapshots` newest first, as a new array. Snapshots are ordered by the
 * instant `fetchedAt` names, not by its text: `10:00Z` is before `10:00:30Z`,
 * and `10:00+05:00` is before `06:00Z`. Digits of a fraction past the
 * millisecond, which `Date.parse` drops, still count. Two snapshots at the
 * same instant are ordered by `fetchedAt` text, then by `bodyHash`, both
 * descending. A `fetchedAt` that `Date.parse` cannot read (on a record
 * written before `put()` checked it) orders after every one it can.
 */
function sortNewestFirst(snapshots: readonly Snapshot[]): Snapshot[] {
  const keyed = snapshots.map((snapshot) => {
    const ms = Date.parse(snapshot.fetchedAt);
    return {
      snapshot,
      ms: Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms,
      subMs: /\.\d{3}(\d+)/.exec(snapshot.fetchedAt)?.[1] ?? "",
    };
  });
  keyed.sort((a, b) => {
    if (a.ms !== b.ms) return b.ms > a.ms ? 1 : -1;
    const width = Math.max(a.subMs.length, b.subMs.length);
    const bySubMs = compareCodeUnits(b.subMs.padEnd(width, "0"), a.subMs.padEnd(width, "0"));
    if (bySubMs !== 0) return bySubMs;
    const x = a.snapshot, y = b.snapshot;
    return x.fetchedAt === y.fetchedAt ? compareCodeUnits(y.bodyHash, x.bodyHash) : compareCodeUnits(y.fetchedAt, x.fetchedAt);
  });
  return keyed.map((k) => k.snapshot);
}

/**
 * Open flags for writing a record: create or truncate, and on platforms that
 * have `O_NOFOLLOW`, refuse to write through a symbolic link at the file name.
 */
const WRITE_NO_FOLLOW =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0);

function snapshotFileName(snapshot: Snapshot): string {
  const ts = snapshot.fetchedAt.replace(/:/g, "-");
  return `${ts}-${snapshot.bodyHash.slice(0, 12)}.json`;
}

/**
 * JSON-serialisable on-disk shape. Each byte field present becomes base64 in a
 * sibling `<field>Base64`. A text record that carries `bytes` is written
 * WITHOUT `body`: the text is derived from the bytes on read.
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

/**
 * Reverse of toDiskShape's base64 step. Files without a base64 sibling field
 * pass through unchanged; a base64 sibling that is not a string makes the
 * whole record unreadable (`undefined`). A string is decoded leniently
 * (`Buffer.from(_, "base64")` skips characters outside the alphabet), so a
 * damaged string is caught only by the hash check in `checkRecord`.
 */
function fromDiskShape(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of BYTE_FIELDS) {
    const key = `${field}Base64`;
    if (!(key in out)) continue;
    const encoded = out[key];
    if (typeof encoded !== "string") return undefined;
    delete out[key];
    out[field] = new Uint8Array(Buffer.from(encoded, "base64"));
  }
  return out;
}

function sha256Of(input: Uint8Array | string): string {
  const hash = createHash("sha256");
  if (typeof input === "string") hash.update(input, "utf8");
  else hash.update(input);
  return hash.digest("hex");
}

type RecordCheck = { snapshot: Snapshot; reason?: undefined } | { snapshot?: undefined; reason: string };

/**
 * Decide whether a record is a snapshot this store returns, and build it.
 *
 * A record is returned only if its content hashes to its `bodyHash`, on the
 * one basis its fields allow:
 *
 * - `bodyBytes` (binary): SHA-256 of `bodyBytes`. `body` must be `""` and the
 *   record must carry neither `bytes` nor `declaredCharset`.
 * - `bytes` (byte-hashed text): SHA-256 of `bytes`. `declaredCharset` must be a
 *   string or `null`. `body` is decoded from the bytes, whatever the record
 *   held; the decoder's warnings are not kept.
 * - neither: SHA-256 of the UTF-8 of `body`. The record must not carry
 *   `declaredCharset`.
 *
 * The check covers the content, not the charset label or any other field.
 */
function checkRecord(value: unknown): RecordCheck {
  if (typeof value !== "object" || value === null) return { reason: "not an object" };
  const v = value as Record<string, unknown>;
  if (
    typeof v.sourceId !== "string" ||
    typeof v.url !== "string" ||
    typeof v.fetchedAt !== "string" ||
    !Number.isFinite(v.status) ||
    typeof v.contentType !== "string" ||
    typeof v.bodyHash !== "string"
  ) {
    return { reason: "a required field is missing or has the wrong type" };
  }
  if (v.bodyBytes !== undefined) {
    if (!(v.bodyBytes instanceof Uint8Array)) return { reason: "bodyBytes is not a Uint8Array" };
    if (v.bytes !== undefined || v.declaredCharset !== undefined || v.body !== "") {
      return { reason: "a binary record (bodyBytes) also carries text (body, bytes or declaredCharset)" };
    }
    if (sha256Of(v.bodyBytes) !== v.bodyHash) return { reason: "bodyBytes does not hash to bodyHash" };
    return { snapshot: v as unknown as Snapshot };
  }
  if (v.bytes !== undefined) {
    if (!(v.bytes instanceof Uint8Array)) return { reason: "bytes is not a Uint8Array" };
    if (v.declaredCharset !== null && typeof v.declaredCharset !== "string") {
      return { reason: "bytes without a declaredCharset that is a string or null" };
    }
    if (sha256Of(v.bytes) !== v.bodyHash) return { reason: "bytes does not hash to bodyHash" };
    return { snapshot: { ...v, body: decodeTextBody(v.bytes, v.declaredCharset).text } as unknown as Snapshot };
  }
  if (v.declaredCharset !== undefined) return { reason: "declaredCharset without bytes" };
  if (typeof v.body !== "string") return { reason: "body is not a string" };
  if (sha256Of(v.body) !== v.bodyHash) return { reason: "the UTF-8 of body does not hash to bodyHash" };
  return { snapshot: v as unknown as Snapshot };
}

/**
 * Refuse a snapshot the read path would not return unchanged, so `put()` never
 * accepts content it then loses. Beyond `checkRecord`, a byte-hashed text
 * snapshot's `body` must already be the decode of its `bytes`, since `body` is
 * not what gets stored.
 */
function assertStorable(snapshot: Snapshot): void {
  const checked = checkRecord(snapshot);
  if (checked.snapshot === undefined) {
    throw new TypeError(`snapshot cannot be stored, it would not read back: ${checked.reason}`);
  }
  // JSON writes NaN and the infinities as null and -0 as 0; checkRecord has
  // already refused the first two.
  if (Object.is(snapshot.status, -0)) {
    throw new TypeError("snapshot cannot be stored, it would not read back: status is -0");
  }
  // The filesystem store turns these keys into byte fields on read, so a
  // snapshot carrying one would read back as a different record.
  for (const field of BYTE_FIELDS) {
    if ((snapshot as unknown as Record<string, unknown>)[`${field}Base64`] !== undefined) {
      throw new TypeError(`snapshot cannot be stored, it would not read back: it carries ${field}Base64, a key the filesystem store reserves`);
    }
  }
  if (!isIsoInstant(snapshot.fetchedAt)) {
    throw new TypeError("snapshot cannot be stored: fetchedAt is not an ISO-8601 instant");
  }
  if (snapshot.bytes !== undefined && checked.snapshot.body !== snapshot.body) {
    throw new TypeError("snapshot cannot be stored, it would not read back: body is not the decode of bytes with declaredCharset");
  }
}

/**
 * A deep copy: shares no byte array, `redirects` list, or any other nested value
 * with `snapshot`. `structuredClone` would copy a typed array's whole backing
 * buffer, which for a pooled `Buffer` or a `subarray` view holds bytes that are
 * not the snapshot's, so the two byte fields, `bytes` and `bodyBytes`, are
 * instead copied into buffers that hold exactly their own bytes, as the
 * filesystem store's reads do. A typed array in any other (undeclared) field is
 * still cloned with its whole backing buffer.
 *
 * Throws a `TypeError` when a field cannot be cloned (a function, `URL`,
 * `Headers`, ...), so `put()` fails the way the `SnapshotStore` docs say.
 */
function ownCopy(snapshot: Snapshot): Snapshot {
  // The byte fields are left out of the clone, so their backing buffers are
  // never copied whole.
  const { bodyBytes, bytes, ...rest } = snapshot;
  let copy: Snapshot;
  try {
    copy = structuredClone(rest);
  } catch (err) {
    throw new TypeError(`snapshot cannot be stored, it cannot be copied: ${describeThrown(err)}`);
  }
  if ("bodyBytes" in snapshot) copy.bodyBytes = bodyBytes === undefined ? undefined : new Uint8Array(bodyBytes);
  if ("bytes" in snapshot) copy.bytes = bytes === undefined ? undefined : new Uint8Array(bytes);
  return copy;
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
 * A record whose content does not hash to its `bodyHash` is skipped the same
 * way (see `checkRecord`). `SnapshotStore` has no channel to report a skipped
 * record, so the skip is silent: `get()` by that hash finds nothing, and
 * `latest()` returns the newest record that does verify, which may be an older
 * capture.
 *
 * `put()` rejects (throws a `TypeError`) a snapshot that would not read back.
 *
 * `put()` writes only to `<root>/<sourceDir>/<file>`: the names it builds are
 * single path segments, the joined paths are checked, the source directory
 * must resolve (through any symbolic link) to a directory directly inside the
 * resolved root, and where the platform has `O_NOFOLLOW` the file is not
 * written through a symbolic link. These guard against names built from
 * snapshot fields. They do not make a store safe to share with someone who
 * can write into it: such a writer can change or add records, and reads
 * follow whatever links are there.
 */
export function createFilesystemSnapshotStore(
  opts: FilesystemSnapshotStoreOptions,
): SnapshotStore {
  const root = path.resolve(opts.root);

  /**
   * `<root>/<sourceDir>`. `sourceDirName` and `isIsoInstant` already keep both
   * names to one path segment; this checks the joined path string as well.
   * `put()` also checks the resolved path once the directory exists.
   */
  function sourceDir(sourceId: string): string {
    const dir = path.join(root, sourceDirName(sourceId));
    if (path.dirname(dir) !== root) throw new TypeError("snapshot store path for sourceId resolves outside the store root");
    return dir;
  }

  async function readAll(sourceId: string): Promise<Snapshot[]> {
    const dir = sourceDir(sourceId);
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
        const checked = checkRecord(fromDiskShape(JSON.parse(await readFile(path.join(dir, name), "utf8"))));
        if (checked.snapshot !== undefined) out.push(checked.snapshot);
      } catch {
        // skip unreadable/foreign file
      }
    }
    return sortNewestFirst(out);
  }

  return {
    async put(snapshot: Snapshot): Promise<void> {
      assertStorable(snapshot);
      const dir = sourceDir(snapshot.sourceId);
      const file = path.join(dir, snapshotFileName(snapshot));
      if (path.dirname(file) !== dir) {
        throw new TypeError("snapshot cannot be stored: its file name from fetchedAt resolves outside its source directory");
      }
      await mkdir(dir, { recursive: true });
      // The checks above compare path strings. A symbolic link already placed
      // in the root under this source's directory name would still lead
      // elsewhere, so compare the resolved paths too.
      const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)]);
      if (path.dirname(realDir) !== realRoot) {
        throw new TypeError("snapshot cannot be stored: its source directory resolves outside the store root");
      }
      await writeFile(file, JSON.stringify(toDiskShape(snapshot), null, 2), { encoding: "utf8", flag: WRITE_NO_FOLLOW });
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
 * `put()` applies the same rejection as the filesystem store; the record is
 * then deep-copied in and deep-copied out, so nothing outside can change what
 * is stored and the read check does not need repeating. Each byte array is
 * copied tight, both into the store and out of it, so a returned array's
 * buffer holds only that snapshot's bytes. `put()` also throws a `TypeError`
 * for a snapshot with a field that cannot be cloned.
 */
export function createInMemorySnapshotStore(): SnapshotStore {
  const bySource = new Map<string, Snapshot[]>();
  /**
   * The stored records for `sourceId`, newest first. These are the store's own
   * objects: a caller must `ownCopy` whatever it returns. Everything here passed
   * `assertStorable` on the way in and was deep-copied, so nothing outside can
   * have changed it since.
   */
  function sorted(sourceId: string): Snapshot[] {
    return sortNewestFirst(bySource.get(sourceId) ?? []);
  }
  return {
    async put(snapshot: Snapshot): Promise<void> {
      assertStorable(snapshot);
      const arr = bySource.get(snapshot.sourceId) ?? [];
      arr.push(ownCopy(snapshot));
      bySource.set(snapshot.sourceId, arr);
    },
    async latest(sourceId: string): Promise<Snapshot | undefined> {
      const found = sorted(sourceId)[0];
      return found === undefined ? undefined : ownCopy(found);
    },
    async get(sourceId: string, bodyHash: string): Promise<Snapshot | undefined> {
      const found = sorted(sourceId).find((s) => s.bodyHash === bodyHash || s.bodyHash.startsWith(bodyHash));
      return found === undefined ? undefined : ownCopy(found);
    },
    async list(sourceId: string): Promise<Snapshot[]> {
      return sorted(sourceId).map(ownCopy);
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
