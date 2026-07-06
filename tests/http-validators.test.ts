// HTTP validator (conditional GET) tests for fetchSource. Cover: capturing
// ETag / Last-Modified off a 200, sending If-None-Match / If-Modified-Since on a
// revalidate re-fetch when a prior snapshot carries validators, re-serving the
// prior snapshot on a 304 (marked fromCache + notModified), the sha256 fallback
// when a server offers no validators, and the never-throws discipline (an
// unsolicited 304 with no prior is a typed http-error). All network-free via the
// injected fake fetch + an in-memory store.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchSource } from "../src/fetch/fetch-source.js";
import { createInMemorySnapshotStore } from "../src/fetch/snapshot-store.js";
import type { FetchSourceOptions, SourceConfig } from "../src/fetch/types.js";
import { fakeFetch } from "./fixtures/fake-fetch.js";

function cfg(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return { id: "src-1", url: "https://example.test/page", respectRobots: false, ...overrides };
}
function fastOpts(extra: FetchSourceOptions = {}): FetchSourceOptions {
  return { sleep: async () => {}, random: () => 0, politenessState: new Map(), robotsCache: new Map(), ...extra };
}

const ETAG = '"v1-abc123"';
const LAST_MOD = "Wed, 21 Oct 2026 07:28:00 GMT";

describe("fetchSource() — validator capture", () => {
  it("captures ETag and Last-Modified from a 200 response onto the snapshot", async () => {
    const fetch = fakeFetch({
      "https://example.test/page": { status: 200, headers: { etag: ETAG, "last-modified": LAST_MOD }, body: "hello" },
    });
    const result = await fetchSource(cfg(), fastOpts({ fetch }));
    assert.equal(result.snapshot!.etag, ETAG);
    assert.equal(result.snapshot!.lastModified, LAST_MOD);
    assert.equal(result.snapshot!.notModified, undefined);
  });

  it("leaves etag/lastModified unset when the server sends no validators", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { body: "hello" } });
    const result = await fetchSource(cfg(), fastOpts({ fetch }));
    assert.equal(result.snapshot!.etag, undefined);
    assert.equal(result.snapshot!.lastModified, undefined);
  });
});

describe("fetchSource() — conditional GET (revalidate)", () => {
  it("sends If-None-Match / If-Modified-Since when a prior snapshot carries validators", async () => {
    const store = createInMemorySnapshotStore();
    const first = fakeFetch({
      "https://example.test/page": { status: 200, headers: { etag: ETAG, "last-modified": LAST_MOD }, body: "hello" },
    });
    const captured = await fetchSource(cfg(), fastOpts({ fetch: first }));
    await store.put(captured.snapshot!);

    const second = fakeFetch({ "https://example.test/page": { status: 304 } });
    const result = await fetchSource(cfg({ revalidate: true }), fastOpts({ fetch: second, store }));

    assert.equal(second.calls[0].headers["If-None-Match"], ETAG);
    assert.equal(second.calls[0].headers["If-Modified-Since"], LAST_MOD);
    // 304 -> the prior snapshot re-served, flagged fromCache + notModified, with
    // byte-identical body and bodyHash (zero body transfer).
    assert.equal(result.error, undefined);
    assert.equal(result.snapshot!.notModified, true);
    assert.equal(result.snapshot!.fromCache, true);
    assert.equal(result.snapshot!.body, "hello");
    assert.equal(result.snapshot!.bodyHash, captured.snapshot!.bodyHash);
  });

  it("does NOT send conditional headers when revalidate is off, even with a prior snapshot", async () => {
    const store = createInMemorySnapshotStore();
    const first = fakeFetch({ "https://example.test/page": { headers: { etag: ETAG }, body: "hello" } });
    await store.put((await fetchSource(cfg(), fastOpts({ fetch: first }))).snapshot!);

    const second = fakeFetch({ "https://example.test/page": { headers: { etag: ETAG }, body: "hello" } });
    await fetchSource(cfg(), fastOpts({ fetch: second, store }));
    assert.equal(second.calls[0].headers["If-None-Match"], undefined);
  });

  it("does NOT send conditional headers when revalidate is on but no prior snapshot exists", async () => {
    const store = createInMemorySnapshotStore(); // empty
    const fetch = fakeFetch({ "https://example.test/page": { body: "fresh" } });
    const result = await fetchSource(cfg({ revalidate: true }), fastOpts({ fetch, store }));
    assert.equal(fetch.calls[0].headers["If-None-Match"], undefined);
    assert.equal(fetch.calls[0].headers["If-Modified-Since"], undefined);
    assert.equal(result.snapshot!.body, "fresh"); // normal 200, hash-compare fallback path
  });

  it("does NOT send conditional headers when the prior snapshot has no validators (sha256 fallback)", async () => {
    const store = createInMemorySnapshotStore();
    const first = fakeFetch({ "https://example.test/page": { body: "hello" } }); // no validators
    await store.put((await fetchSource(cfg(), fastOpts({ fetch: first }))).snapshot!);

    const second = fakeFetch({ "https://example.test/page": { body: "hello-changed" } });
    const result = await fetchSource(cfg({ revalidate: true }), fastOpts({ fetch: second, store }));
    assert.equal(second.calls[0].headers["If-None-Match"], undefined);
    assert.equal(result.snapshot!.body, "hello-changed"); // full body fetched; drift is caught by hash compare
  });

  it("a fresh 200 during revalidate captures the server's NEW validators", async () => {
    const store = createInMemorySnapshotStore();
    const first = fakeFetch({ "https://example.test/page": { headers: { etag: '"v1"' }, body: "hello" } });
    await store.put((await fetchSource(cfg(), fastOpts({ fetch: first }))).snapshot!);

    const second = fakeFetch({ "https://example.test/page": { status: 200, headers: { etag: '"v2"' }, body: "changed" } });
    const result = await fetchSource(cfg({ revalidate: true }), fastOpts({ fetch: second, store }));
    assert.equal(second.calls[0].headers["If-None-Match"], '"v1"');
    assert.equal(result.snapshot!.notModified, undefined);
    assert.equal(result.snapshot!.etag, '"v2"');
    assert.equal(result.snapshot!.body, "changed");
  });

  it("degrades to an unconditional fetch (never throws) when the prior-snapshot lookup rejects", async () => {
    const store = {
      async latest() {
        throw new Error("store offline");
      },
      async put() {},
      async get() {
        return undefined;
      },
      async list() {
        return [];
      },
    };
    const fetch = fakeFetch({ "https://example.test/page": { body: "fresh" } });
    const result = await fetchSource(cfg({ revalidate: true }), fastOpts({ fetch, store }));
    assert.equal(result.error, undefined);
    assert.equal(result.snapshot!.body, "fresh");
    assert.equal(fetch.calls[0].headers["If-None-Match"], undefined);
    assert.ok(result.warnings?.some((w) => /prior-snapshot lookup failed/.test(w)));
  });

  it("returns a typed http-error (never throws) on an UNSOLICITED 304 with no prior snapshot", async () => {
    const store = createInMemorySnapshotStore(); // empty -> no conditional headers sent
    const fetch = fakeFetch({ "https://example.test/page": { status: 304 } });
    const result = await fetchSource(cfg({ revalidate: true }), fastOpts({ fetch, store }));
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "http-error");
    assert.equal(result.error!.status, 304);
  });
});
