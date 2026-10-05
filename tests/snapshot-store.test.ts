import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";
import {
  createFilesystemSnapshotStore,
  createInMemorySnapshotStore,
  replaySource,
} from "../src/fetch/snapshot-store.js";
import { sha256Hex, sha256Bytes } from "../src/fetch/fetch-source.js";
import type { Snapshot } from "../src/fetch/types.js";
import { readFileSync } from "node:fs";

const pdfFixtureBytes = new Uint8Array(
  readFileSync(new URL("../../tests/fixtures/minimal-two-page.pdf", import.meta.url)),
);

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  const body = overrides.body ?? "<h1>Hello</h1>";
  return {
    sourceId: "src-1",
    url: "https://example.test/page",
    fetchedAt: "2026-07-02T00:00:00.000Z",
    status: 200,
    contentType: "html",
    body,
    bodyHash: sha256Hex(body),
    ...overrides,
  };
}

function snapWithBytes(overrides: Partial<Snapshot> = {}): Snapshot {
  const bytes = (overrides.bodyBytes as Uint8Array | undefined) ?? pdfFixtureBytes;
  return {
    sourceId: "src-pdf",
    url: "https://example.test/doc.pdf",
    fetchedAt: "2026-07-02T00:00:00.000Z",
    status: 200,
    contentType: "pdf",
    body: "",
    bodyBytes: bytes,
    bodyHash: sha256Bytes(bytes),
    ...overrides,
  };
}

/** A rendered snapshot (traverse#41) — see snap() for the plain-text default. */
function snapRendered(overrides: Partial<Snapshot> = {}): Snapshot {
  const body = overrides.body ?? "<h1>Rendered</h1>";
  return {
    sourceId: "src-rendered",
    url: "https://example.test/spa",
    fetchedAt: "2026-07-02T00:00:00.000Z",
    status: 200,
    contentType: "html",
    body,
    bodyHash: sha256Hex(body),
    rendered: true,
    ...overrides,
  };
}

describe("filesystem snapshot store", () => {
  let root: string;
  before(async () => { root = await mkdtemp(path.join(os.tmpdir(), "traverse-store-")); });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  it("round-trips a snapshot byte-identically via put -> latest -> get -> list", async () => {
    const store = createFilesystemSnapshotStore({ root });
    const s = snap();
    await store.put(s);

    const latest = await store.latest("src-1");
    assert.deepEqual(latest, s);

    const byHash = await store.get("src-1", s.bodyHash);
    assert.deepEqual(byHash, s);

    const byPrefix = await store.get("src-1", s.bodyHash.slice(0, 10));
    assert.deepEqual(byPrefix, s);

    const list = await store.list("src-1");
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], s);
  });

  it("latest() returns the newest snapshot by fetchedAt", async () => {
    const store = createFilesystemSnapshotStore({ root });
    const older = snap({ sourceId: "src-2", fetchedAt: "2026-07-01T00:00:00.000Z", body: "old" });
    const newer = snap({ sourceId: "src-2", fetchedAt: "2026-07-03T00:00:00.000Z", body: "new" });
    await store.put(older);
    await store.put(newer);
    const latest = await store.latest("src-2");
    assert.equal(latest!.body, "new");
    const list = await store.list("src-2");
    assert.deepEqual(list.map((s) => s.body), ["new", "old"]);
  });

  it("keeps snapshots for distinct sourceIds separate", async () => {
    const store = createFilesystemSnapshotStore({ root });
    await store.put(snap({ sourceId: "alpha", body: "a" }));
    await store.put(snap({ sourceId: "beta", body: "b" }));
    assert.equal((await store.latest("alpha"))!.body, "a");
    assert.equal((await store.latest("beta"))!.body, "b");
  });

  it("returns undefined for an unknown source and unknown hash", async () => {
    const store = createFilesystemSnapshotStore({ root });
    assert.equal(await store.latest("does-not-exist"), undefined);
    assert.equal(await store.get("src-1", "deadbeef"), undefined);
    assert.deepEqual(await store.list("does-not-exist"), []);
  });

  it("round-trips a binary (bodyBytes) snapshot byte-identically via put -> latest -> get -> list (AC4)", async () => {
    const store = createFilesystemSnapshotStore({ root });
    const s = snapWithBytes();
    await store.put(s);

    const latest = await store.latest("src-pdf");
    assert.deepEqual(latest, s);
    assert.ok(latest!.bodyBytes instanceof Uint8Array);

    const byHash = await store.get("src-pdf", s.bodyHash);
    assert.deepEqual(byHash, s);

    const list = await store.list("src-pdf");
    assert.equal(list.length, 1);
    assert.deepEqual(list[0], s);
  });

  it("still loads an OLD-shape on-disk snapshot (no bodyBytes/bodyBytesBase64 field at all) unchanged (AC4 back-compat)", async () => {
    const store = createFilesystemSnapshotStore({ root });
    // put() a plain text-only snapshot with the CURRENT store code: toDiskShape
    // is a no-op when bodyBytes is undefined, so this is byte-identical to the
    // pre-#23 on-disk shape (no bytes field of any kind).
    const s = snap({ sourceId: "src-old-shape" });
    await store.put(s);
    const latest = await store.latest("src-old-shape");
    assert.deepEqual(latest, s);
    assert.equal(latest!.bodyBytes, undefined);
  });

  it("Snapshot.rendered survives a put -> latest/get round-trip (traverse#41 AC4)", async () => {
    const store = createFilesystemSnapshotStore({ root });
    const s = snapRendered();
    await store.put(s);

    const latest = await store.latest("src-rendered");
    assert.deepEqual(latest, s);
    assert.equal(latest!.rendered, true);

    const byHash = await store.get("src-rendered", s.bodyHash);
    assert.deepEqual(byHash, s);
    assert.equal(byHash!.rendered, true);
  });
});

describe("in-memory snapshot store", () => {
  it("round-trips and orders newest-first", async () => {
    const store = createInMemorySnapshotStore();
    await store.put(snap({ fetchedAt: "2026-07-01T00:00:00.000Z", body: "old" }));
    await store.put(snap({ fetchedAt: "2026-07-05T00:00:00.000Z", body: "new" }));
    assert.equal((await store.latest("src-1"))!.body, "new");
    assert.deepEqual((await store.list("src-1")).map((s) => s.body), ["new", "old"]);
  });

  it("copies bodyBytes on put() and on read, so the stored record cannot be changed from outside", async () => {
    const store = createInMemorySnapshotStore();
    const original = snapWithBytes();
    const expected = Array.from(original.bodyBytes!);
    await store.put(original);
    const latest = await store.latest("src-pdf");
    assert.notStrictEqual(latest!.bodyBytes, original.bodyBytes, "a copy, not the caller's array");
    assert.deepEqual(Array.from(latest!.bodyBytes!), expected);

    // Neither the caller's array nor a returned one is the stored one.
    original.bodyBytes!.fill(0);
    latest!.bodyBytes!.fill(0);
    const again = await store.latest("src-pdf");
    assert.deepEqual(Array.from(again!.bodyBytes!), expected);
  });

  it("Snapshot.rendered survives a put -> latest round-trip (traverse#41 AC4)", async () => {
    const store = createInMemorySnapshotStore();
    const s = snapRendered();
    await store.put(s);
    const latest = await store.latest("src-rendered");
    assert.equal(latest!.rendered, true);
    assert.deepEqual(latest, s);
  });
});

describe("replaySource()", () => {
  it("returns the latest snapshot as a FetchResult with fromCache: true", async () => {
    const store = createInMemorySnapshotStore();
    const s = snap();
    await store.put(s);
    const result = await replaySource(store, "src-1");
    assert.equal(result.error, undefined);
    assert.equal(result.snapshot!.fromCache, true);
    // byte-identical apart from the fromCache flag
    assert.deepEqual({ ...result.snapshot, fromCache: undefined }, { ...s, fromCache: undefined });
  });

  it("replaySource() returns bodyBytes equal to what was put, as a copy", async () => {
    const store = createInMemorySnapshotStore();
    const original = snapWithBytes();
    await store.put(original);
    const result = await replaySource(store, "src-pdf");
    assert.notStrictEqual(result.snapshot!.bodyBytes, original.bodyBytes);
    assert.deepEqual(Array.from(result.snapshot!.bodyBytes!), Array.from(original.bodyBytes!));
  });

  it("returns a typed no-snapshot error (never throws) when nothing is stored", async () => {
    const store = createInMemorySnapshotStore();
    const result = await replaySource(store, "missing");
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "no-snapshot");
  });
});

/** Every file under `dir`, as paths relative to it. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();
}

/**
 * A binary snapshot over its own bytes. An earlier test zeroes the shared PDF
 * fixture in place, so a table built before it runs must not use that array.
 */
function ownBinary(overrides: Partial<Snapshot> = {}): Snapshot {
  return snapWithBytes({ bodyBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]), ...overrides });
}

/** A byte-hashed text snapshot, the shape fetchSource writes for a text capture. */
function snapWithTextBytes(overrides: Partial<Snapshot> = {}): Snapshot {
  const body = "<h1>bytes</h1>";
  const bytes = new TextEncoder().encode(body);
  return {
    sourceId: "src-text-bytes",
    url: "https://example.test/text",
    fetchedAt: "2026-07-02T00:00:00.000Z",
    status: 200,
    contentType: "html",
    body,
    bytes,
    declaredCharset: "utf-8",
    bodyHash: sha256Bytes(bytes),
    ...overrides,
  };
}

describe("snapshot store put() bounds, both stores", () => {
  let base: string;
  before(async () => { base = await mkdtemp(path.join(os.tmpdir(), "traverse-store-bounds-")); });
  after(async () => { await rm(base, { recursive: true, force: true }); });

  let n = 0;
  /** A filesystem store nested three levels under its own fresh directory, so an escape stays observable. */
  async function fsStore(): Promise<{ store: ReturnType<typeof createFilesystemSnapshotStore>; outer: string; root: string }> {
    const outer = path.join(base, `case-${n++}`);
    const root = path.join(outer, "a", "b", "store");
    await mkdir(root, { recursive: true });
    return { store: createFilesystemSnapshotStore({ root }), outer, root };
  }

  const stray = (s: Snapshot, key: string, value: unknown) => ({ ...s, [key]: value }) as unknown as Snapshot;
  const rejected: Array<[string, Snapshot, RegExp]> = [
    ["status NaN", snap({ status: Number.NaN }), /would not read back: a required field/],
    ["status Infinity", snap({ status: Number.POSITIVE_INFINITY }), /would not read back: a required field/],
    ["status -Infinity", snap({ status: Number.NEGATIVE_INFINITY }), /would not read back: a required field/],
    ["status -0", snap({ status: -0 }), /would not read back: status is -0/],
    ["bytesBase64 on a body-only record", stray(snap(), "bytesBase64", Buffer.from("<h1>Hello</h1>").toString("base64")), /carries bytesBase64/],
    ["bodyBytesBase64 on a body-only record", stray(snap(), "bodyBytesBase64", "JVBERg=="), /carries bodyBytesBase64/],
    ["bytesBase64 on a binary record", stray(ownBinary(), "bytesBase64", "JVBERg=="), /carries bytesBase64/],
    ["bodyBytesBase64 on a byte-hashed text record", stray(snapWithTextBytes(), "bodyBytesBase64", "JVBERg=="), /carries bodyBytesBase64/],
    ["bytesBase64 beside bytes", stray(snapWithTextBytes(), "bytesBase64", Buffer.from("<h1>bytes</h1>").toString("base64")), /carries bytesBase64/],
    ["fetchedAt climbing out of the root", snap({ fetchedAt: "../../../escape" }), /fetchedAt is not an ISO-8601 instant/],
    ["fetchedAt climbing out of the source dir", snap({ fetchedAt: "../escape" }), /fetchedAt is not an ISO-8601 instant/],
    ["fetchedAt with a separator", snap({ fetchedAt: "2026/07/02" }), /fetchedAt is not an ISO-8601 instant/],
    ["fetchedAt absolute", snap({ fetchedAt: "/tmp/escape" }), /fetchedAt is not an ISO-8601 instant/],
    ["fetchedAt as an ISO prefix of a traversal", snap({ fetchedAt: "2026-07-02T00:00:00.000Z/../../../../escape" }), /fetchedAt is not an ISO-8601 instant/],
    ["fetchedAt empty", snap({ fetchedAt: "" }), /fetchedAt is not an ISO-8601 instant/],
    ["fetchedAt date only", snap({ fetchedAt: "2026-07-02" }), /fetchedAt is not an ISO-8601 instant/],
    ["fetchedAt without a zone", snap({ fetchedAt: "2026-07-02T00:00:00" }), /fetchedAt is not an ISO-8601 instant/],
    ["fetchedAt past the end of its month", snap({ fetchedAt: "2026-02-30T00:00:00.000Z" }), /fetchedAt is not an ISO-8601 instant/],
    ["fetchedAt not a date", snap({ fetchedAt: "yesterday" }), /fetchedAt is not an ISO-8601 instant/],
  ];

  for (const [label, bad, message] of rejected) {
    it(`filesystem: put() refuses ${label} and writes nothing`, async () => {
      const { store, outer } = await fsStore();
      await assert.rejects(store.put(bad), (err: unknown) => err instanceof TypeError && message.test(err.message));
      assert.deepEqual(await filesUnder(outer), [], "no file was written, inside the store or outside it");
      assert.equal(await store.latest(bad.sourceId), undefined);
    });
    it(`in-memory: put() refuses ${label}`, async () => {
      const store = createInMemorySnapshotStore();
      await assert.rejects(store.put(bad), (err: unknown) => err instanceof TypeError && message.test(err.message));
      assert.equal(await store.latest(bad.sourceId), undefined);
    });
  }

  const accepted: Array<[string, Snapshot]> = [
    ["fetchedAt as toISOString writes it", snap()],
    ["fetchedAt without a fraction", snap({ fetchedAt: "2026-07-02T00:00:00Z" })],
    ["fetchedAt without seconds", snap({ fetchedAt: "2026-07-02T00:00Z" })],
    ["fetchedAt with a UTC offset", snap({ fetchedAt: "2026-07-02T02:00:00.5+02:00" })],
    ["fetchedAt with an extended year", snap({ fetchedAt: new Date(Date.UTC(10000, 0, 1)).toISOString() })],
    ["fetchedAt on a leap day", snap({ fetchedAt: "2028-02-29T00:00:00.000Z" })],
    ["status 0", snap({ status: 0 })],
    ["a binary record", ownBinary()],
    ["a byte-hashed text record", snapWithTextBytes()],
    ["byte-field keys set to undefined", stray(stray(snap(), "bytesBase64", undefined), "bodyBytesBase64", undefined)],
  ];

  for (const [label, good] of accepted) {
    it(`both stores accept ${label} and read it back the same`, async () => {
      const { store: fs, root } = await fsStore();
      const mem = createInMemorySnapshotStore();
      await fs.put(good);
      await mem.put(good);
      const files = await filesUnder(root);
      assert.equal(files.length, 1);
      assert.equal(files[0].split(path.sep).length, 2, "one file, directly inside its source directory");
      const fromFs = await fs.latest(good.sourceId);
      const fromMem = await mem.latest(good.sourceId);
      // JSON drops an undefined-valued key; compare the defined fields.
      const defined = (s: Snapshot | undefined) => JSON.parse(JSON.stringify({ ...s, bodyBytes: undefined, bytes: undefined }));
      assert.deepEqual(defined(fromFs), defined(good));
      assert.deepEqual(defined(fromMem), defined(good));
      assert.ok(Object.is(fromFs!.status, good.status) && Object.is(fromMem!.status, good.status));
      for (const field of ["bodyBytes", "bytes"] as const) {
        assert.deepEqual(fromFs![field] && Array.from(fromFs![field]!), good[field] && Array.from(good[field]!), field);
        assert.deepEqual(fromMem![field] && Array.from(fromMem![field]!), good[field] && Array.from(good[field]!), field);
      }
    });
  }

  it("filesystem: a sourceId that looks like a path stays one directory inside the root", async () => {
    const { store, outer, root } = await fsStore();
    const ids = ["../../../escape", "..", ".", "/abs/path", "a/../../../b", "..\\..\\x", "", "-"];
    for (const sourceId of ids) await store.put(snap({ sourceId, body: `body for ${JSON.stringify(sourceId)}` }));
    const files = await filesUnder(outer);
    assert.equal(files.length, ids.length);
    for (const file of files) {
      const parts = file.split(path.sep);
      assert.deepEqual(parts.slice(0, 3), ["a", "b", "store"], file);
      assert.equal(parts.length, 5, `${file}: <root>/<sourceDir>/<file>`);
    }
    for (const sourceId of ids) {
      assert.equal((await store.latest(sourceId))!.body, `body for ${JSON.stringify(sourceId)}`, sourceId);
    }
    assert.ok(root);
  });
});

describe("filesystem snapshot store read checks", () => {
  let base: string;
  before(async () => { base = await mkdtemp(path.join(os.tmpdir(), "traverse-store-read-")); });
  after(async () => { await rm(base, { recursive: true, force: true }); });

  // Each case writes, beside one good record, a record that is valid except for
  // one field, and newer, so a store that read it would return it as latest().
  const good = snap({ sourceId: "read-check", fetchedAt: "2026-07-01T00:00:00.000Z", body: "good" });
  const badBase = snap({ sourceId: "read-check", fetchedAt: "2026-07-09T00:00:00.000Z", body: "bad" });
  const cases: Array<[string, (r: Record<string, unknown>) => void]> = [
    ["no sourceId", (r) => { delete r.sourceId; }],
    ["a numeric sourceId", (r) => { r.sourceId = 7; }],
    ["no url", (r) => { delete r.url; }],
    ["a non-string url", (r) => { r.url = { href: "https://example.test/" }; }],
    ["no fetchedAt", (r) => { delete r.fetchedAt; }],
    ["a numeric fetchedAt", (r) => { r.fetchedAt = 20260709; }],
    ["no status", (r) => { delete r.status; }],
    ["a string status", (r) => { r.status = "200"; }],
    ["a null status (what JSON writes for NaN)", (r) => { r.status = null; }],
  ];

  for (const [label, damage] of cases) {
    it(`skips a record with ${label}`, async () => {
      const root = path.join(base, label.replace(/[^a-z]+/gi, "-"));
      const store = createFilesystemSnapshotStore({ root });
      await store.put(good);
      const [dir] = await readdir(root);
      const record = JSON.parse(JSON.stringify(badBase)) as Record<string, unknown>;
      damage(record);
      await writeFile(path.join(root, dir, "damaged.json"), JSON.stringify(record));

      assert.deepEqual(await store.latest("read-check"), good);
      assert.deepEqual(await store.list("read-check"), [good]);
      assert.equal(await store.get("read-check", badBase.bodyHash), undefined);
    });
  }
});

describe("in-memory snapshot store reads", () => {
  it("each read returns a copy: changing what latest(), get() or list() returned changes nothing stored", async () => {
    const store = createInMemorySnapshotStore();
    const older = snap({ fetchedAt: "2026-07-01T00:00:00.000Z", body: "old", redirects: ["https://example.test/a"] });
    const newer = ownBinary({ sourceId: "src-1", fetchedAt: "2026-07-05T00:00:00.000Z", redirects: ["https://example.test/b"] });
    await store.put(older);
    await store.put(newer);
    const expected = await store.list("src-1");

    const vandalise = (s: Snapshot) => {
      s.redirects!.push("https://example.test/changed");
      s.bodyBytes?.fill(0);
      s.fetchedAt = "2099-01-01T00:00:00.000Z";
      s.bodyHash = "0".repeat(64);
    };
    vandalise((await store.latest("src-1"))!);
    assert.deepEqual(await store.list("src-1"), expected, "after changing latest()");
    vandalise((await store.get("src-1", older.bodyHash))!);
    assert.deepEqual(await store.list("src-1"), expected, "after changing get()");
    (await store.list("src-1")).forEach(vandalise);
    assert.deepEqual(await store.list("src-1"), expected, "after changing list()");

    assert.deepEqual(expected.map((s) => s.fetchedAt), ["2026-07-05T00:00:00.000Z", "2026-07-01T00:00:00.000Z"]);
    assert.deepEqual(await store.latest("src-1"), newer);
    assert.deepEqual(await store.get("src-1", older.bodyHash.slice(0, 8)), older);
  });

  it("orders by fetchedAt then bodyHash whatever the insertion order", async () => {
    const a = snap({ fetchedAt: "2026-07-01T00:00:00.000Z", body: "a" });
    const b = snap({ fetchedAt: "2026-07-03T00:00:00.000Z", body: "b" });
    const c = snap({ fetchedAt: "2026-07-03T00:00:00.000Z", body: "c" });
    const want = [b, c].sort((x, y) => (x.bodyHash < y.bodyHash ? 1 : -1)).concat(a).map((s) => s.body);
    for (const order of [[a, b, c], [c, a, b], [b, c, a]]) {
      const store = createInMemorySnapshotStore();
      for (const s of order) await store.put(s);
      assert.deepEqual((await store.list("src-1")).map((s) => s.body), want);
      assert.equal((await store.latest("src-1"))!.body, want[0]);
      // A read does not reorder what is stored for the next one.
      assert.deepEqual((await store.list("src-1")).map((s) => s.body), want);
    }
  });
});
