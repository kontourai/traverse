import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
});

describe("in-memory snapshot store", () => {
  it("round-trips and orders newest-first", async () => {
    const store = createInMemorySnapshotStore();
    await store.put(snap({ fetchedAt: "2026-07-01T00:00:00.000Z", body: "old" }));
    await store.put(snap({ fetchedAt: "2026-07-05T00:00:00.000Z", body: "new" }));
    assert.equal((await store.latest("src-1"))!.body, "new");
    assert.deepEqual((await store.list("src-1")).map((s) => s.body), ["new", "old"]);
  });

  it("keeps REFERENCE semantics for bodyBytes on put() (no defensive deep-clone) (AC4/D4)", async () => {
    const store = createInMemorySnapshotStore();
    const original = snapWithBytes();
    await store.put(original);
    const latest = await store.latest("src-pdf");
    assert.strictEqual(latest!.bodyBytes, original.bodyBytes, "same Uint8Array instance, not a clone");
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

  it("keeps REFERENCE semantics for bodyBytes through replaySource() (no defensive deep-clone) (AC4/D4)", async () => {
    const store = createInMemorySnapshotStore();
    const original = snapWithBytes();
    await store.put(original);
    const result = await replaySource(store, "src-pdf");
    assert.strictEqual(result.snapshot!.bodyBytes, original.bodyBytes, "same Uint8Array instance, not a clone");
  });

  it("returns a typed no-snapshot error (never throws) when nothing is stored", async () => {
    const store = createInMemorySnapshotStore();
    const result = await replaySource(store, "missing");
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "no-snapshot");
  });
});
