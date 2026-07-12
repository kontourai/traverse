// HTTP validator (conditional GET) tests for fetchSource. Cover: capturing
// ETag / Last-Modified off a 200, sending If-None-Match / If-Modified-Since on a
// revalidate re-fetch when a prior snapshot carries validators, re-serving the
// prior snapshot on a 304 (marked fromCache + notModified), fresh body hashes for
// caller-owned comparison when a server offers no validators, and the never-
// throws discipline (an unsolicited 304 with no prior is a typed http-error).
// All network-free via the injected fake fetch + an in-memory store.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchSource, sha256Hex } from "../src/fetch/fetch-source.js";
import { createInMemorySnapshotStore } from "../src/fetch/snapshot-store.js";
import type { FetchSourceOptions, SourceConfig } from "../src/fetch/types.js";
import { fakeFetch } from "./fixtures/fake-fetch.js";
import { fakeRenderImpl } from "./fixtures/fake-render.js";
import { readFileSync } from "node:fs";

function cfg(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return { id: "src-1", url: "https://example.test/page", respectRobots: false, ...overrides };
}
function fastOpts(extra: FetchSourceOptions = {}): FetchSourceOptions {
  return { sleep: async () => {}, random: () => 0, politenessState: new Map(), robotsCache: new Map(), ...extra };
}

const ETAG = '"v1-abc123"';
const LAST_MOD = "Wed, 21 Oct 2026 07:28:00 GMT";
const SPA_SHELL = readFileSync(new URL("../../tests/fixtures/spa-shell-empty.html", import.meta.url), "utf8");

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
  it("revalidates the same exact URL and re-serves its prior snapshot", async () => {
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

  it("does not forward stored validators across a cross-host redirect", async () => {
    const store = createInMemorySnapshotStore();
    const captured = await fetchSource(
      cfg(),
      fastOpts({
        fetch: fakeFetch({
          "https://example.test/page": {
            status: 200,
            headers: { etag: ETAG, "last-modified": LAST_MOD },
            body: "prior",
          },
        }),
      }),
    );
    await store.put(captured.snapshot!);

    const fetch = fakeFetch({
      "https://example.test/page": {
        status: 302,
        headers: { location: "https://redirect.test/final" },
      },
      "https://redirect.test/final": { status: 200, body: "fresh" },
    });
    const result = await fetchSource(
      cfg({
        revalidate: true,
        headers: {
          "if-none-match": '"caller-etag"',
          "if-modified-since": "Tue, 20 Oct 2026 07:28:00 GMT",
          "X-Trace-Id": "trace-1",
        },
      }),
      fastOpts({ fetch, store }),
    );

    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[0].headers["X-Trace-Id"], "trace-1");
    assert.equal(fetch.calls[0].headers["If-None-Match"], ETAG);
    assert.equal(fetch.calls[0].headers["If-Modified-Since"], LAST_MOD);
    assert.deepEqual(
      Object.keys(fetch.calls[0].headers).filter((name) =>
        ["if-none-match", "if-modified-since"].includes(name.toLowerCase()),
      ),
      ["If-None-Match", "If-Modified-Since"],
    );
    assert.deepEqual(
      Object.keys(fetch.calls[1].headers).filter((name) =>
        ["if-none-match", "if-modified-since"].includes(name.toLowerCase()),
      ),
      [],
    );
    assert.equal(result.snapshot!.url, "https://redirect.test/final");
    assert.equal(result.snapshot!.body, "fresh");
  });

  it("does not reuse validators when a stable source id changes URL", async () => {
    const store = createInMemorySnapshotStore();
    const oldUrl = "https://example.test/old";
    const newUrl = "https://example.test/new";
    const captured = await fetchSource(
      cfg({ url: oldUrl }),
      fastOpts({
        fetch: fakeFetch({
          [oldUrl]: {
            status: 200,
            headers: { etag: ETAG, "last-modified": LAST_MOD },
            body: "prior",
          },
        }),
      }),
    );
    await store.put(captured.snapshot!);

    const fetch = fakeFetch({ [newUrl]: { status: 200, body: "fresh" } });
    const result = await fetchSource(
      cfg({ url: newUrl, revalidate: true }),
      fastOpts({ fetch, store }),
    );

    assert.equal(fetch.calls[0].headers["If-None-Match"], undefined);
    assert.equal(fetch.calls[0].headers["If-Modified-Since"], undefined);
    assert.equal(result.snapshot!.body, "fresh");
    assert.equal(result.snapshot!.bodyHash, sha256Hex("fresh"));
    assert.notEqual(result.snapshot!.bodyHash, captured.snapshot!.bodyHash);
  });

  it("treats a query-string change as a different resource", async () => {
    const store = createInMemorySnapshotStore();
    const priorUrl = "https://example.test/page?version=1";
    const currentUrl = "https://example.test/page?version=2";
    const captured = await fetchSource(
      cfg({ url: priorUrl }),
      fastOpts({
        fetch: fakeFetch({
          [priorUrl]: {
            status: 200,
            headers: { etag: ETAG, "last-modified": LAST_MOD },
            body: "prior",
          },
        }),
      }),
    );
    await store.put(captured.snapshot!);

    const fetch = fakeFetch({ [currentUrl]: { status: 200, body: "fresh" } });
    const result = await fetchSource(
      cfg({ url: currentUrl, revalidate: true }),
      fastOpts({ fetch, store }),
    );

    assert.equal(fetch.calls[0].headers["If-None-Match"], undefined);
    assert.equal(fetch.calls[0].headers["If-Modified-Since"], undefined);
    assert.equal(result.snapshot!.url, currentUrl);
    assert.equal(result.snapshot!.body, "fresh");
  });

  it("revalidates only the exact prior final URL in a redirect chain", async () => {
    const store = createInMemorySnapshotStore();
    const startUrl = "https://example.test/start";
    const finalUrl = "https://example.test/final";
    const captured = await fetchSource(
      cfg({ url: startUrl }),
      fastOpts({
        fetch: fakeFetch({
          [startUrl]: { status: 302, headers: { location: finalUrl } },
          [finalUrl]: {
            status: 200,
            headers: { etag: ETAG, "last-modified": LAST_MOD },
            body: "prior final",
          },
        }),
      }),
    );
    await store.put(captured.snapshot!);

    const fetch = fakeFetch({
      [startUrl]: { status: 302, headers: { location: finalUrl } },
      [finalUrl]: { status: 304 },
    });
    const result = await fetchSource(
      cfg({ url: startUrl, revalidate: true }),
      fastOpts({ fetch, store }),
    );

    assert.equal(fetch.calls.length, 2);
    assert.equal(fetch.calls[0].headers["If-None-Match"], undefined);
    assert.equal(fetch.calls[0].headers["If-Modified-Since"], undefined);
    assert.equal(fetch.calls[1].headers["If-None-Match"], ETAG);
    assert.equal(fetch.calls[1].headers["If-Modified-Since"], LAST_MOD);
    assert.equal(result.error, undefined);
    assert.equal(result.snapshot!.url, finalUrl);
    assert.equal(result.snapshot!.body, "prior final");
    assert.equal(result.snapshot!.bodyHash, captured.snapshot!.bodyHash);
    assert.equal(result.snapshot!.fromCache, true);
    assert.equal(result.snapshot!.notModified, true);
  });

  it("rejects a 304 when no validator from the matching prior was sent", async () => {
    const store = createInMemorySnapshotStore();
    const priorUrl = "https://example.test/old";
    const currentUrl = "https://example.test/new";
    const captured = await fetchSource(
      cfg({ url: priorUrl }),
      fastOpts({
        fetch: fakeFetch({
          [priorUrl]: { status: 200, headers: { etag: ETAG }, body: "prior" },
        }),
      }),
    );
    await store.put(captured.snapshot!);

    const fetch = fakeFetch({ [currentUrl]: { status: 304 } });
    const result = await fetchSource(
      cfg({ url: currentUrl, revalidate: true }),
      fastOpts({ fetch, store }),
    );

    assert.equal(fetch.calls[0].headers["If-None-Match"], undefined);
    assert.equal(fetch.calls[0].headers["If-Modified-Since"], undefined);
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "http-error");
    assert.equal(result.error!.status, 304);
  });

  it("treats a malformed prior snapshot URL as nonmatching and fetches unconditionally", async () => {
    const store = createInMemorySnapshotStore();
    const captured = await fetchSource(
      cfg(),
      fastOpts({
        fetch: fakeFetch({
          "https://example.test/page": {
            status: 200,
            headers: { etag: ETAG, "last-modified": LAST_MOD },
            body: "prior",
          },
        }),
      }),
    );
    await store.put({ ...captured.snapshot!, url: "not a valid URL" });

    const fetch = fakeFetch({ "https://example.test/page": { status: 200, body: "fresh" } });
    const result = await fetchSource(cfg({ revalidate: true }), fastOpts({ fetch, store }));

    assert.equal(result.error, undefined);
    assert.equal(fetch.calls[0].headers["If-None-Match"], undefined);
    assert.equal(fetch.calls[0].headers["If-Modified-Since"], undefined);
    assert.equal(result.snapshot!.body, "fresh");
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
    assert.equal(result.snapshot!.body, "fresh"); // caller can compare the fresh bodyHash with any prior
  });

  it("does NOT send conditional headers when the prior snapshot has no validators (caller compares bodyHash)", async () => {
    const store = createInMemorySnapshotStore();
    const first = fakeFetch({ "https://example.test/page": { body: "hello" } }); // no validators
    await store.put((await fetchSource(cfg(), fastOpts({ fetch: first }))).snapshot!);

    const second = fakeFetch({ "https://example.test/page": { body: "hello-changed" } });
    const result = await fetchSource(cfg({ revalidate: true }), fastOpts({ fetch: second, store }));
    assert.equal(second.calls[0].headers["If-None-Match"], undefined);
    assert.equal(result.snapshot!.body, "hello-changed"); // full body and fresh hash are returned for caller comparison
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

describe("fetchSource() — render escalation never carries validators", () => {
  it("keeps store reads and conditional headers on the plain attempt and captures no rendered validators", async () => {
    const backing = createInMemorySnapshotStore();
    const prior = await fetchSource(cfg(), fastOpts({ fetch: fakeFetch({
      "https://example.test/page": {
        headers: { "content-type": "text/html", etag: ETAG, "last-modified": LAST_MOD },
        body: "<main>older trustworthy body</main>",
      },
    }) }));
    await backing.put(prior.snapshot!);

    const ledger = { latest: 0, get: 0, put: 0, list: 0 };
    const hostileStore = {
      async latest(sourceId: string) { ledger.latest += 1; return backing.latest(sourceId); },
      async get(sourceId: string, hash: string) { ledger.get += 1; return backing.get(sourceId, hash); },
      async put(snapshot: Parameters<typeof backing.put>[0]) { ledger.put += 1; return backing.put(snapshot); },
      async list(sourceId: string) { ledger.list += 1; return backing.list(sourceId); },
    };
    const fetch = fakeFetch({
      "https://example.test/page": {
        status: 200,
        headers: { "content-type": "text/html", etag: '"plain-new"', "last-modified": LAST_MOD },
        body: SPA_SHELL,
      },
    });
    const renderImpl = fakeRenderImpl({
      "https://example.test/page": { html: "<main>rendered fresh</main>" },
    });
    const result = await fetchSource(
      cfg({
        renderPolicy: "on-shell-warning",
        revalidate: true,
        headers: { "if-none-match": '"caller-hostile"', "If-Modified-Since": "yesterday" },
      }),
      fastOpts({ fetch, renderImpl, store: hostileStore }),
    );

    assert.equal(fetch.calls.length, 1, "renderer retry is not a FetchLike/304 path");
    assert.equal(fetch.calls[0].headers["If-None-Match"], ETAG);
    assert.equal(fetch.calls[0].headers["If-Modified-Since"], LAST_MOD);
    assert.equal(renderImpl.calls.length, 1);
    assert.deepEqual(ledger, { latest: 1, get: 0, put: 0, list: 0 }, "render retry never touches the store");
    assert.equal(result.snapshot?.rendered, true);
    assert.equal(result.snapshot?.status, 200);
    assert.equal(result.snapshot?.notModified, undefined);
    assert.equal(result.snapshot?.etag, undefined);
    assert.equal(result.snapshot?.lastModified, undefined);
  });
});

describe("fetchSource() — 304 never renders", () => {
  it("returns the trustworthy cached snapshot without invoking renderImpl", async () => {
    const store = createInMemorySnapshotStore();
    const prior = await fetchSource(cfg(), fastOpts({ fetch: fakeFetch({
      "https://example.test/page": { headers: { "content-type": "text/html", etag: ETAG }, body: SPA_SHELL },
    }) }));
    await store.put(prior.snapshot!);
    const renderImpl = fakeRenderImpl({ "https://example.test/page": { html: "<main>must not render</main>" } });
    const result = await fetchSource(
      cfg({ renderPolicy: "on-shell-warning", revalidate: true }),
      fastOpts({ fetch: fakeFetch({ "https://example.test/page": { status: 304 } }), store, renderImpl }),
    );
    assert.equal(result.snapshot?.notModified, true);
    assert.equal(result.snapshot?.fromCache, true);
    assert.equal(renderImpl.calls.length, 0);
    assert.equal(result.renderEscalation?.outcome, "not-needed");
  });
});
