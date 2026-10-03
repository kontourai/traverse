// The hash basis and charset decoding of a text capture, checked against real
// bytes over loopback and against forage's own fetcher on the same response.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import {
  fetchSource as forageFetchSource,
  buildSnapshotSourceRef as buildForageSnapshotSourceRef,
} from "@kontourai/forage/fetch";
import { buildSnapshotSourceRef } from "../src/fetch/compose.js";
import { fetchSource, sha256Hex, snapshotHashBasis } from "../src/fetch/fetch-source.js";
import { isSameSnapshotRef, parseAnySnapshotSourceRef } from "../src/fetch/forage-interop.js";
import { createFilesystemSnapshotStore, createInMemorySnapshotStore, replaySource } from "../src/fetch/snapshot-store.js";
import type { FetchLike, Snapshot, SnapshotStore } from "../src/fetch/types.js";
import { CHARSET_PAGES, startCharsetServer, type CharsetPage, type CharsetServer } from "./fixtures/charset-server.js";
import { fakeFetch } from "./fixtures/fake-fetch.js";

const CLOCK = "2026-08-01T00:00:00.000Z";
const SOURCE_ID = "charset-source";

let server: CharsetServer;
before(async () => { server = await startCharsetServer(); });
after(async () => { await server.close(); });

async function traverseCapture(page: CharsetPage): Promise<{ snapshot: Snapshot; warnings: string[] }> {
  const result = await fetchSource(
    { id: SOURCE_ID, url: server.origin + page.path, respectRobots: false, minDelayMs: 0, retries: 0 },
    { fetch: globalThis.fetch as unknown as FetchLike, clock: () => CLOCK },
  );
  assert.equal(result.error, undefined);
  return { snapshot: result.snapshot!, warnings: result.warnings ?? [] };
}

async function forageCapture(page: CharsetPage) {
  const result = await forageFetchSource(
    {
      id: SOURCE_ID,
      url: server.origin + page.path,
      respectRobots: false,
      minDelayMs: 0,
      retries: 0,
      egress: { guarded: true, testOnlyAllowedLoopbackOrigins: [server.origin] },
    },
    { clock: () => CLOCK },
  );
  assert.equal(result.error, undefined);
  return result.snapshot!;
}

describe("text capture hash basis and charset decoding", () => {
  for (const name of ["latin1", "bom"] as const) {
    const page = CHARSET_PAGES[name];

    it(`${name}: hashes the response bytes, so the ref matches forage's for the same capture`, async () => {
      const { snapshot } = await traverseCapture(page);
      const forage = await forageCapture(page);

      assert.equal(snapshot.bodyHash, page.sha256, "bodyHash is the SHA-256 of the bytes served");
      assert.notEqual(snapshot.bodyHash, sha256Hex(snapshot.body), "this page's bytes are not the UTF-8 of its text");
      assert.equal(snapshot.bodyHash, forage.bodyHash);

      const traverseRef = buildSnapshotSourceRef(snapshot);
      const forageRef = buildForageSnapshotSourceRef(forage);
      assert.equal(parseAnySnapshotSourceRef(traverseRef)!.bodyHash, page.sha256);
      assert.equal(isSameSnapshotRef(traverseRef, forageRef), true, "one capture, one identity, in either scheme");
    });

    it(`${name}: decodes with the declared charset and keeps the bytes it hashed`, async () => {
      const { snapshot, warnings } = await traverseCapture(page);
      const forage = await forageCapture(page);

      assert.equal(snapshot.body, page.text);
      assert.equal(snapshot.body.includes("�"), false, "no replacement characters");
      assert.equal(snapshot.body.includes("﻿"), false, "no byte-order mark in the text");
      assert.equal(snapshot.body, forage.body);
      assert.deepEqual(warnings, []);

      assert.deepEqual(Array.from(snapshot.bytes!), Array.from(page.bytes));
      assert.equal(snapshot.declaredCharset, name === "latin1" ? "iso-8859-1" : "utf-8");
      assert.equal(snapshot.bodyBytes, undefined, "bodyBytes stays the binary marker");
      assert.equal(snapshotHashBasis(snapshot), "bytes");
    });
  }

  it("leaves the hash of a plain UTF-8 page where it was", async () => {
    const page = CHARSET_PAGES.plain;
    const { snapshot } = await traverseCapture(page);
    assert.equal(snapshot.body, page.text);
    assert.equal(snapshot.bodyHash, page.sha256);
    // Bytes and decoded-text bases coincide here, so refs minted before text
    // was hashed by its bytes are unchanged for such a page.
    assert.equal(snapshot.bodyHash, sha256Hex(snapshot.body));
    assert.equal(snapshot.bodyHash, "b1878d5dcc4de9a940576aff2994c4b814f311badf1dbd92be627b45c39f9249");
  });

  it("warns when the body is not valid in its declared charset, and still hashes the bytes", async () => {
    const bytes = new Uint8Array([0x61, 0xff, 0x62]);
    const url = "https://example.test/invalid";
    const result = await fetchSource(
      { id: SOURCE_ID, url, respectRobots: false, minDelayMs: 0 },
      { fetch: fakeFetch({ [url]: { headers: { "content-type": "text/plain" }, bytes } }), clock: () => CLOCK },
    );
    assert.equal(result.snapshot!.body, "a�b");
    // SHA-256 of the three bytes 61 ff 62.
    assert.equal(result.snapshot!.bodyHash, "01ce0241d2a0e71a4fecd5a8d71157fe2787197732fc15d889cbcf36c38e3c68");
    assert.notEqual(result.snapshot!.bodyHash, sha256Hex("a�b"));
    assert.deepEqual(result.warnings, [`${url}: body is not valid utf-8; invalid bytes were replaced with U+FFFD`]);
  });

  it("a fetchImpl without arrayBuffer() keeps the decoded-text basis and says so", async () => {
    const url = "https://example.test/text-only";
    const result = await fetchSource(
      { id: SOURCE_ID, url, respectRobots: false, minDelayMs: 0 },
      { fetch: fakeFetch({ [url]: { headers: { "content-type": "text/html; charset=iso-8859-1" }, body: "<h1>Café</h1>", noArrayBuffer: true } }), clock: () => CLOCK },
    );
    const snapshot = result.snapshot!;
    assert.equal(snapshot.bodyHash, sha256Hex("<h1>Café</h1>"));
    assert.equal(snapshot.bytes, undefined);
    assert.equal(snapshot.declaredCharset, undefined);
    assert.equal(snapshotHashBasis(snapshot), "decoded-utf8");
  });

  it("reports the bytes basis for a binary capture", async () => {
    const url = "https://example.test/doc.pdf";
    const result = await fetchSource(
      { id: SOURCE_ID, url, respectRobots: false, minDelayMs: 0 },
      { fetch: fakeFetch({ [url]: { headers: { "content-type": "application/pdf" }, bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) } }), clock: () => CLOCK },
    );
    assert.ok(result.snapshot!.bodyBytes instanceof Uint8Array);
    assert.equal(result.snapshot!.bytes, undefined);
    assert.equal(snapshotHashBasis(result.snapshot!), "bytes");
  });

  it("passes on the decoder's warning for a malformed or unknown charset label", async () => {
    const malformed = "https://example.test/malformed";
    const unknown = "https://example.test/unknown";
    const fetch = fakeFetch({
      [malformed]: { headers: { "content-type": 'text/html; charset="not a token"' }, body: "<h1>ok</h1>" },
      [unknown]: { headers: { "content-type": "text/html; charset=x-no-such-charset" }, body: "<h1>ok</h1>" },
    });
    const first = await fetchSource({ id: SOURCE_ID, url: malformed, respectRobots: false, minDelayMs: 0 }, { fetch, clock: () => CLOCK });
    assert.deepEqual(first.warnings, [`${malformed}: content-type declares a malformed charset parameter; decoded as utf-8`]);
    assert.equal(first.snapshot!.declaredCharset, null);

    const second = await fetchSource({ id: SOURCE_ID, url: unknown, respectRobots: false, minDelayMs: 0 }, { fetch, clock: () => CLOCK });
    assert.deepEqual(second.warnings, [`${unknown}: unknown charset "x-no-such-charset"; decoded as utf-8`]);
    assert.equal(second.snapshot!.declaredCharset, "x-no-such-charset");
    assert.equal(second.snapshot!.body, "<h1>ok</h1>");
  });

  it("the fake fetch reads text through arrayBuffer() by default, as a real Response does", async () => {
    const url = "https://example.test/default";
    const result = await fetchSource(
      { id: SOURCE_ID, url, respectRobots: false, minDelayMs: 0 },
      { fetch: fakeFetch({ [url]: { headers: { "content-type": "text/html" }, body: "<h1>Café</h1>" } }), clock: () => CLOCK },
    );
    assert.equal(snapshotHashBasis(result.snapshot!), "bytes");
    assert.deepEqual(Array.from(result.snapshot!.bytes!), Array.from(new TextEncoder().encode("<h1>Café</h1>")));
  });

  it("a 304 re-serves a bytes-bearing prior with its bytes, charset, text and hash", async () => {
    const url = "https://example.test/latin1";
    const page = CHARSET_PAGES.latin1;
    const store = createInMemorySnapshotStore();
    const opts = { sleep: async () => {}, politenessState: new Map<string, number>(), store };
    const first = await fetchSource(
      { id: SOURCE_ID, url, respectRobots: false, minDelayMs: 0 },
      { ...opts, clock: () => CLOCK, fetch: fakeFetch({ [url]: { headers: { "content-type": page.contentType, etag: '"v1"' }, bytes: page.bytes } }) },
    );
    await store.put(first.snapshot!);

    const second = await fetchSource(
      { id: SOURCE_ID, url, respectRobots: false, minDelayMs: 0, revalidate: true },
      { ...opts, clock: () => "2026-08-02T00:00:00.000Z", fetch: fakeFetch({ [url]: { status: 304 } }) },
    );
    const served = second.snapshot!;
    assert.equal(served.notModified, true);
    assert.equal(served.fromCache, true);
    assert.equal(served.bodyHash, page.sha256);
    assert.equal(served.body, page.text);
    assert.deepEqual(Array.from(served.bytes!), Array.from(page.bytes));
    assert.equal(served.declaredCharset, "iso-8859-1");
    assert.equal(served.fetchedAt, CLOCK);
    assert.equal(buildSnapshotSourceRef(served), buildSnapshotSourceRef(first.snapshot!));
  });
});

describe("filesystem snapshot store and text bytes", () => {
  let root: string;
  before(async () => { root = await mkdtemp(path.join(os.tmpdir(), "traverse-charset-store-")); });
  after(async () => { await rm(root, { recursive: true, force: true }); });

  it("round-trips the bytes and declared charset of a text capture", async () => {
    const page = CHARSET_PAGES.latin1;
    const { snapshot } = await traverseCapture(page);
    const store = createFilesystemSnapshotStore({ root });
    await store.put(snapshot);

    const stored = (await store.get(SOURCE_ID, page.sha256))!;
    assert.ok(stored.bytes instanceof Uint8Array);
    assert.deepEqual(Array.from(stored.bytes), Array.from(page.bytes));
    assert.equal(stored.declaredCharset, "iso-8859-1");
    assert.equal(stored.body, page.text);
    assert.equal(snapshotHashBasis(stored), "bytes");
    // The stored record can be checked: its bytes hash to its bodyHash and decode to its body.
    assert.equal(sha256BytesOf(stored.bytes), stored.bodyHash);
    assert.equal(new TextDecoder("iso-8859-1").decode(stored.bytes), stored.body);
  });

  it("still reads a text record stored before bytes were kept, on its own basis", async () => {
    const legacyRoot = path.join(root, "legacy");
    const store = createFilesystemSnapshotStore({ root: legacyRoot });
    // The pre-change record for the byte-order-mark page: text() dropped the
    // mark and the hash was taken over the UTF-8 of what was left.
    const legacy: Snapshot = {
      sourceId: "legacy-source",
      url: "https://example.test/bom",
      fetchedAt: "2026-06-01T00:00:00.000Z",
      status: 200,
      contentType: "html",
      body: CHARSET_PAGES.bom.text,
      bodyHash: sha256Hex(CHARSET_PAGES.bom.text),
    };
    await store.put(legacy);

    const stored = (await store.get("legacy-source", legacy.bodyHash))!;
    assert.deepEqual(stored, legacy, "the legacy record and its ref are untouched");
    assert.equal(snapshotHashBasis(stored), "decoded-utf8");
    assert.notEqual(stored.bodyHash, CHARSET_PAGES.bom.sha256, "the two bases give different digests for this page");
  });

  for (const name of ["latin1", "bom", "invalid", "plain"] as const) {
    it(`${name}: a capture read back from the store still agrees with forage`, async () => {
      const page = CHARSET_PAGES[name];
      const sourceRoot = path.join(root, `agree-${name}`);
      const store = createFilesystemSnapshotStore({ root: sourceRoot });
      const { snapshot } = await traverseCapture(page);
      const forage = await forageCapture(page);
      await store.put(snapshot);

      const record = await readOnlyRecord(sourceRoot);
      assert.equal("body" in record, false, "the text is not stored beside the bytes it is derived from");

      const stored = (await store.get(SOURCE_ID, page.sha256))!;
      assert.equal(stored.bodyHash, page.sha256);
      assert.equal(stored.bodyHash, forage.bodyHash);
      assert.equal(stored.body, page.text);
      assert.equal(stored.body, forage.body);
      assert.deepEqual(stored, snapshot, "the record read back is the snapshot that was put");
      assert.equal(isSameSnapshotRef(buildSnapshotSourceRef(stored), buildForageSnapshotSourceRef(forage)), true);

      const replayed = await replaySource(store, SOURCE_ID);
      assert.deepEqual(replayed.snapshot, { ...snapshot, fromCache: true });
    });
  }

  /** Put the latin1 capture in a fresh store, rewrite its one record, and return the store. */
  async function storeWithRewrittenRecord(
    label: string,
    rewrite: (record: Record<string, unknown>) => void,
  ): Promise<{ store: SnapshotStore; snapshot: Snapshot }> {
    const sourceRoot = path.join(root, label);
    const store = createFilesystemSnapshotStore({ root: sourceRoot });
    const { snapshot } = await traverseCapture(CHARSET_PAGES.latin1);
    await store.put(snapshot);
    await rewriteOnlyRecord(sourceRoot, rewrite);
    return { store, snapshot };
  }

  async function rewriteOnlyRecord(sourceRoot: string, rewrite: (record: Record<string, unknown>) => void): Promise<void> {
    const [dir] = await readdir(sourceRoot);
    const [file] = await readdir(path.join(sourceRoot, dir));
    const filePath = path.join(sourceRoot, dir, file);
    const record = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    rewrite(record);
    await writeFile(filePath, JSON.stringify(record));
  }

  async function readOnlyRecord(sourceRoot: string): Promise<Record<string, unknown>> {
    const [dir] = await readdir(sourceRoot);
    const [file] = await readdir(path.join(sourceRoot, dir));
    return JSON.parse(await readFile(path.join(sourceRoot, dir, file), "utf8")) as Record<string, unknown>;
  }

  it("a body written into a byte-hashed record is not what the store returns", async () => {
    const { store } = await storeWithRewrittenRecord("tampered-body", (record) => {
      record.body = "<h1>TAMPERED</h1>";
    });
    const stored = (await store.latest(SOURCE_ID))!;
    assert.equal(stored.body, CHARSET_PAGES.latin1.text, "the text comes from the bytes");
  });

  it("skips a record whose bytes do not hash to its bodyHash", async () => {
    const { store, snapshot } = await storeWithRewrittenRecord("swapped-bytes", (record) => {
      assert.equal(typeof record.bytesBase64, "string");
      record.bytesBase64 = Buffer.from("<h1>TAMPERED</h1>", "utf8").toString("base64");
    });
    assert.equal(await store.latest(SOURCE_ID), undefined);
    assert.equal(await store.get(SOURCE_ID, snapshot.bodyHash), undefined);
    assert.deepEqual(await store.list(SOURCE_ID), []);
    assert.equal((await replaySource(store, SOURCE_ID)).error?.kind, "no-snapshot");
  });

  it("derives the text from the bytes under whatever charset the record declares", async () => {
    // bodyHash covers the bytes, not the charset label, so a changed label is
    // not detectable here. What holds is that the text returned is always the
    // decode of the stored bytes under the stored label.
    const { store } = await storeWithRewrittenRecord("changed-charset", (record) => {
      record.declaredCharset = "utf-8";
    });
    const stored = (await store.latest(SOURCE_ID))!;
    assert.equal(stored.declaredCharset, "utf-8");
    assert.equal(stored.body, new TextDecoder("utf-8").decode(CHARSET_PAGES.latin1.bytes));
    assert.notEqual(stored.body, CHARSET_PAGES.latin1.text);
  });

  it("skips a record that has bytes without a declared charset, or the reverse, or a charset of the wrong type", async () => {
    const noCharset = await storeWithRewrittenRecord("bytes-without-charset", (record) => {
      delete record.declaredCharset;
      record.body = CHARSET_PAGES.latin1.text;
    });
    assert.equal(await noCharset.store.latest(SOURCE_ID), undefined);

    const noBytes = await storeWithRewrittenRecord("charset-without-bytes", (record) => {
      delete record.bytesBase64;
      record.body = CHARSET_PAGES.latin1.text;
    });
    assert.equal(await noBytes.store.latest(SOURCE_ID), undefined);

    const wrongType = await storeWithRewrittenRecord("charset-wrong-type", (record) => {
      record.declaredCharset = 1252;
      record.body = CHARSET_PAGES.latin1.text;
    });
    assert.equal(await wrongType.store.latest(SOURCE_ID), undefined);
  });

  it("skips a byte-hashed record rewritten as a body-only record", async () => {
    // The record keeps the byte hash but loses its bytes: the body it now
    // carries is all there is, and it does not hash to bodyHash.
    const stripped = await storeWithRewrittenRecord("stripped-to-body", (record) => {
      delete record.bytesBase64;
      delete record.declaredCharset;
      record.body = "<h1>TAMPERED</h1>";
    });
    assert.equal(await stripped.store.latest(SOURCE_ID), undefined);
    assert.equal(await stripped.store.get(SOURCE_ID, stripped.snapshot.bodyHash), undefined);

    const nonString = await storeWithRewrittenRecord("bytes-not-a-string", (record) => {
      record.bytesBase64 = 7;
      delete record.declaredCharset;
      record.body = CHARSET_PAGES.latin1.text;
    });
    assert.equal(await nonString.store.latest(SOURCE_ID), undefined);
  });

  it("skips a record that carries binary bytes together with text", async () => {
    // The bytes still hash to bodyHash, moved into the binary field, with a body beside them.
    const moved = await storeWithRewrittenRecord("moved-to-bodybytes", (record) => {
      record.bodyBytesBase64 = record.bytesBase64;
      delete record.bytesBase64;
      delete record.declaredCharset;
      record.body = "<h1>TAMPERED</h1>";
    });
    assert.equal(await moved.store.latest(SOURCE_ID), undefined);
    assert.equal(await moved.store.get(SOURCE_ID, moved.snapshot.bodyHash), undefined);

    const both = await storeWithRewrittenRecord("bodybytes-and-bytes", (record) => {
      record.bodyBytesBase64 = record.bytesBase64;
      record.body = "";
    });
    assert.equal(await both.store.latest(SOURCE_ID), undefined);
  });

  it("skips a body-only record whose body does not hash to its bodyHash", async () => {
    const sourceRoot = path.join(root, "legacy-tampered");
    const store = createFilesystemSnapshotStore({ root: sourceRoot });
    const legacy: Snapshot = {
      sourceId: SOURCE_ID,
      url: "https://example.test/plain",
      fetchedAt: "2026-06-01T00:00:00.000Z",
      status: 200,
      contentType: "html",
      body: "<h1>original</h1>",
      bodyHash: sha256Hex("<h1>original</h1>"),
    };
    await store.put(legacy);
    assert.deepEqual(await store.latest(SOURCE_ID), legacy);

    await rewriteOnlyRecord(sourceRoot, (record) => { record.body = "<h1>TAMPERED</h1>"; });
    assert.equal(await store.latest(SOURCE_ID), undefined);
    assert.equal(await store.get(SOURCE_ID, legacy.bodyHash), undefined);
  });

  it("skips a binary record whose bodyBytes do not hash to its bodyHash", async () => {
    const sourceRoot = path.join(root, "binary-tampered");
    const store = createFilesystemSnapshotStore({ root: sourceRoot });
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const binary: Snapshot = {
      sourceId: SOURCE_ID,
      url: "https://example.test/doc.pdf",
      fetchedAt: "2026-06-01T00:00:00.000Z",
      status: 200,
      contentType: "pdf",
      body: "",
      bodyBytes: pdf,
      bodyHash: sha256BytesOf(pdf),
    };
    await store.put(binary);
    assert.deepEqual(await store.latest(SOURCE_ID), binary);

    await rewriteOnlyRecord(sourceRoot, (record) => {
      record.bodyBytesBase64 = Buffer.from("TAMPERED", "utf8").toString("base64");
    });
    assert.equal(await store.latest(SOURCE_ID), undefined);
  });

  it("skips a record whose base64 field is not a string, or that has no contentType", async () => {
    const empty: Snapshot = {
      sourceId: SOURCE_ID,
      url: "https://example.test/empty",
      fetchedAt: "2026-06-01T00:00:00.000Z",
      status: 200,
      contentType: "html",
      body: "",
      bodyHash: sha256Hex(""),
    };
    for (const [label, rewrite] of [
      // Without its non-string bodyBytesBase64 this would be a valid empty text record.
      ["non-string-base64", (record: Record<string, unknown>) => { record.bodyBytesBase64 = 5; }],
      ["no-content-type", (record: Record<string, unknown>) => { delete record.contentType; }],
    ] as const) {
      const sourceRoot = path.join(root, label);
      const store = createFilesystemSnapshotStore({ root: sourceRoot });
      await store.put(empty);
      assert.deepEqual(await store.latest(SOURCE_ID), empty, `${label}: the intact record reads`);
      await rewriteOnlyRecord(sourceRoot, rewrite);
      assert.equal(await store.latest(SOURCE_ID), undefined, label);
    }
  });

  it("round-trips a capture whose Content-Type declares no charset", async () => {
    const url = "https://example.test/no-label";
    const body = "<h1>Café</h1>";
    const result = await fetchSource(
      { id: SOURCE_ID, url, respectRobots: false, minDelayMs: 0 },
      { fetch: fakeFetch({ [url]: { headers: { "content-type": "text/html" }, body } }), clock: () => CLOCK },
    );
    const snapshot = result.snapshot!;
    assert.equal(snapshot.declaredCharset, null);

    const sourceRoot = path.join(root, "null-label");
    const store = createFilesystemSnapshotStore({ root: sourceRoot });
    await store.put(snapshot);
    const record = await readOnlyRecord(sourceRoot);
    assert.equal(record.declaredCharset, null);
    assert.equal("declaredCharset" in record, true);

    const stored = (await store.latest(SOURCE_ID))!;
    assert.equal(stored.declaredCharset, null);
    assert.equal(stored.body, body);
    assert.deepEqual(stored, snapshot);
  });

  for (const [storeName, makeStore] of [
    ["filesystem", (label: string) => createFilesystemSnapshotStore({ root: path.join(root, `reject-${label}`) })],
    ["in-memory", (_label: string) => createInMemorySnapshotStore()],
  ] as const) {
    it(`${storeName}: put() rejects a snapshot that would not read back`, async () => {
      const { snapshot } = await traverseCapture(CHARSET_PAGES.latin1);
      const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
      const bodyOnly: Snapshot = {
        sourceId: SOURCE_ID, url: "https://example.test/x", fetchedAt: CLOCK, status: 200,
        contentType: "html", body: "<h1>x</h1>", bodyHash: sha256Hex("<h1>x</h1>"),
      };
      const binary: Snapshot = { ...bodyOnly, contentType: "pdf", body: "", bodyBytes: pdf, bodyHash: sha256BytesOf(pdf) };
      const { declaredCharset: _dropped, ...bytesWithoutCharset } = snapshot;

      const cases: Array<[string, Snapshot, RegExp]> = [
        ["bytes without declaredCharset", bytesWithoutCharset, /bytes without a declaredCharset/],
        ["bytes with a hash taken over the text", { ...snapshot, bodyHash: sha256Hex(snapshot.body) }, /bytes does not hash to bodyHash/],
        ["bytes swapped", { ...snapshot, bytes: new TextEncoder().encode("<h1>TAMPERED</h1>") }, /bytes does not hash to bodyHash/],
        ["body that is not the decode of bytes", { ...snapshot, body: "<h1>TAMPERED</h1>" }, /body is not the decode of bytes/],
        ["declaredCharset without bytes", { ...bodyOnly, declaredCharset: "utf-8" }, /declaredCharset without bytes/],
        ["body-only with another hash", { ...bodyOnly, body: "<h1>TAMPERED</h1>" }, /UTF-8 of body does not hash/],
        ["bodyBytes with another hash", { ...binary, bodyBytes: new Uint8Array([1, 2, 3]) }, /bodyBytes does not hash/],
        ["bodyBytes beside a body", { ...binary, body: "<h1>TAMPERED</h1>" }, /binary record \(bodyBytes\) also carries text/],
      ];
      for (const [label, bad, message] of cases) {
        const store = makeStore(label.replace(/[^a-z]+/gi, "-"));
        await assert.rejects(store.put(bad), (err: unknown) => err instanceof TypeError && message.test(err.message), label);
        assert.equal(await store.latest(SOURCE_ID), undefined, `${label}: nothing was stored`);
      }

      // The same snapshots, intact, are accepted.
      for (const good of [snapshot, bodyOnly, binary]) {
        const store = makeStore(`good-${good.contentType}-${good.bytes ? "bytes" : "plain"}`);
        await store.put(good);
        assert.deepEqual(await store.latest(SOURCE_ID), good);
      }
    });
  }

  it("the in-memory store copies a snapshot on put and on read", async () => {
    const { snapshot } = await traverseCapture(CHARSET_PAGES.latin1);
    const mine = { ...snapshot, bytes: new Uint8Array(snapshot.bytes!), redirects: ["https://example.test/start"] };
    const store = createInMemorySnapshotStore();
    await store.put(mine);

    mine.bytes.fill(0);
    mine.redirects.push("https://example.test/changed-by-caller");
    const first = (await store.latest(SOURCE_ID))!;
    assert.deepEqual(Array.from(first.bytes!), Array.from(CHARSET_PAGES.latin1.bytes), "the caller's array is not the stored one");
    assert.deepEqual(first.redirects, ["https://example.test/start"], "the caller's redirects are not the stored ones");

    first.bytes!.fill(0);
    first.redirects!.push("https://example.test/changed-by-reader");
    const second = (await store.get(SOURCE_ID, snapshot.bodyHash))!;
    assert.deepEqual(Array.from(second.bytes!), Array.from(CHARSET_PAGES.latin1.bytes), "a returned array is not the stored one");
    assert.deepEqual(second.redirects, ["https://example.test/start"], "returned redirects are not the stored ones");
    assert.equal(second.body, CHARSET_PAGES.latin1.text);
  });

});

function sha256BytesOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
