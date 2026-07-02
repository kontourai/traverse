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
import { sha256Hex } from "../src/fetch/fetch-source.js";
import type { Snapshot } from "../src/fetch/types.js";

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
});

describe("in-memory snapshot store", () => {
  it("round-trips and orders newest-first", async () => {
    const store = createInMemorySnapshotStore();
    await store.put(snap({ fetchedAt: "2026-07-01T00:00:00.000Z", body: "old" }));
    await store.put(snap({ fetchedAt: "2026-07-05T00:00:00.000Z", body: "new" }));
    assert.equal((await store.latest("src-1"))!.body, "new");
    assert.deepEqual((await store.list("src-1")).map((s) => s.body), ["new", "old"]);
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

  it("returns a typed no-snapshot error (never throws) when nothing is stored", async () => {
    const store = createInMemorySnapshotStore();
    const result = await replaySource(store, "missing");
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "no-snapshot");
  });
});
