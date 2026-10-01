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
import { createFilesystemSnapshotStore } from "../src/fetch/snapshot-store.js";
import type { FetchLike, Snapshot } from "../src/fetch/types.js";
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
      { fetch: fakeFetch({ [url]: { headers: { "content-type": "text/html; charset=iso-8859-1" }, body: "<h1>Café</h1>" } }), clock: () => CLOCK },
    );
    const snapshot = result.snapshot!;
    assert.equal(snapshot.bodyHash, sha256Hex("<h1>Café</h1>"));
    assert.equal(snapshot.bytes, undefined);
    assert.equal(snapshot.declaredCharset, undefined);
    assert.equal(snapshotHashBasis(snapshot), "decoded-utf8");
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

  it("skips a record whose declared charset has no bytes behind it", async () => {
    const brokenRoot = path.join(root, "broken");
    const store = createFilesystemSnapshotStore({ root: brokenRoot });
    const { snapshot } = await traverseCapture(CHARSET_PAGES.bom);
    await store.put({ ...snapshot, sourceId: "broken-source" });

    const [dir] = await readdir(brokenRoot);
    const [file] = await readdir(path.join(brokenRoot, dir));
    const filePath = path.join(brokenRoot, dir, file);
    const record = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
    assert.equal(typeof record.bytesBase64, "string");
    delete record.bytesBase64;
    await writeFile(filePath, JSON.stringify(record));

    assert.equal(await store.latest("broken-source"), undefined);
  });
});

function sha256BytesOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
