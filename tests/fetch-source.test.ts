import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { fetchSource, sha256Hex, sha256Bytes, resolveContentType } from "../src/fetch/fetch-source.js";
import type { FetchSourceOptions, SourceConfig } from "../src/fetch/types.js";
import { DEFAULT_USER_AGENT } from "../src/fetch/types.js";
import { fakeFetch, firingSchedule } from "./fixtures/fake-fetch.js";
import { fakeRenderImpl } from "./fixtures/fake-render.js";
import { createInMemorySnapshotStore } from "../src/fetch/snapshot-store.js";

const pdfFixtureBytes = new Uint8Array(
  readFileSync(new URL("../../tests/fixtures/minimal-two-page.pdf", import.meta.url)),
);

function cfg(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return { id: "src-1", url: "https://example.test/page", respectRobots: false, ...overrides };
}

// Silence real backoff/politeness timers unless a test asserts on them.
function fastOpts(extra: FetchSourceOptions = {}): FetchSourceOptions {
  // Fresh per-call politeness/robots state so process-wide caches never leak
  // between tests.
  return {
    sleep: async () => {},
    random: () => 0,
    politenessState: new Map(),
    robotsCache: new Map(),
    ...extra,
  };
}

describe("fetchSource() — happy path & snapshot", () => {
  it("captures a snapshot with final url, status, resolved contentType, and a stable bodyHash", async () => {
    const fetch = fakeFetch({
      "https://example.test/page": { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<h1>Hello</h1>" },
    });
    const result = await fetchSource(cfg(), fastOpts({ fetch, clock: () => "2026-07-02T00:00:00.000Z" }));

    assert.equal(result.error, undefined);
    assert.ok(result.snapshot);
    assert.equal(result.snapshot!.url, "https://example.test/page");
    assert.equal(result.snapshot!.status, 200);
    assert.equal(result.snapshot!.contentType, "html");
    assert.equal(result.snapshot!.body, "<h1>Hello</h1>");
    assert.equal(result.snapshot!.bodyHash, sha256Hex("<h1>Hello</h1>"));
    assert.equal(result.snapshot!.fetchedAt, "2026-07-02T00:00:00.000Z");
    assert.equal(result.snapshot!.redirects, undefined);
  });

  it("hash is byte-stable across two identical fetches", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { body: "same-bytes" } });
    const a = await fetchSource(cfg(), fastOpts({ fetch }));
    const b = await fetchSource(cfg(), fastOpts({ fetch }));
    assert.equal(a.snapshot!.bodyHash, b.snapshot!.bodyHash);
    assert.equal(a.snapshot!.bodyHash, sha256Hex("same-bytes"));
  });

  it("contentType hint overrides the response header", async () => {
    const fetch = fakeFetch({
      "https://example.test/page": { headers: { "content-type": "text/html" }, body: "raw text" },
    });
    const result = await fetchSource(cfg({ contentType: "text" }), fastOpts({ fetch }));
    assert.equal(result.snapshot!.contentType, "text");
  });

  it("sends an honest bot User-Agent by default and refuses to let headers override it", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { body: "x" } });
    await fetchSource(cfg({ headers: { "User-Agent": "sneaky-override" } }), fastOpts({ fetch }));
    assert.equal(fetch.calls[0].headers["User-Agent"], DEFAULT_USER_AGENT);
  });

  it("resolveContentType prefers hint, else sniffs html/pdf, else text", () => {
    assert.equal(resolveContentType("pdf", "text/html"), "pdf");
    assert.equal(resolveContentType(undefined, "application/xhtml+html"), "html");
    assert.equal(resolveContentType(undefined, "application/pdf"), "pdf");
    assert.equal(resolveContentType(undefined, "application/json"), "text");
    assert.equal(resolveContentType(undefined, null), "text");
  });
});

describe("fetchSource() — binary body capture (traverse#23)", () => {
  it("captures a pdf response as raw bodyBytes, leaves body empty, and hashes over the raw bytes", async () => {
    const fetch = fakeFetch({
      "https://example.test/doc.pdf": {
        status: 200,
        headers: { "content-type": "application/pdf" },
        bytes: pdfFixtureBytes,
      },
    });
    const result = await fetchSource(
      cfg({ url: "https://example.test/doc.pdf" }),
      fastOpts({ fetch }),
    );

    assert.equal(result.error, undefined);
    assert.ok(result.snapshot);
    assert.equal(result.snapshot!.contentType, "pdf");
    assert.equal(result.snapshot!.body, "");
    assert.deepEqual(result.snapshot!.bodyBytes, pdfFixtureBytes);
    assert.equal(result.snapshot!.bodyHash, sha256Bytes(pdfFixtureBytes));
  });

  it("degrades to lossy text capture with a warning when the fetchImpl has no arrayBuffer() for a binary content-type", async () => {
    const fetch = fakeFetch({
      "https://example.test/doc.pdf": {
        status: 200,
        headers: { "content-type": "application/pdf" },
        body: "%PDF-1.4 corrupted-as-text",
      },
    });
    const result = await fetchSource(
      cfg({ url: "https://example.test/doc.pdf" }),
      fastOpts({ fetch }),
    );

    assert.equal(result.error, undefined);
    assert.ok(result.snapshot);
    assert.equal(result.snapshot!.contentType, "pdf");
    assert.equal(result.snapshot!.bodyBytes, undefined);
    assert.equal(result.snapshot!.body, "%PDF-1.4 corrupted-as-text");
    assert.equal(result.snapshot!.bodyHash, sha256Hex("%PDF-1.4 corrupted-as-text"));
    assert.ok(
      result.warnings?.some((w) => /arrayBuffer/.test(w) && /binary/.test(w)),
      `expected a missing-arrayBuffer warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });
});

describe("fetchSource() — revalidate with a binary prior snapshot (traverse#23)", () => {
  it("a 304 revalidate preserves bodyBytes on a prior pdf snapshot (body stays empty, bodyHash unchanged)", async () => {
    const store = createInMemorySnapshotStore();
    const first = fakeFetch({
      "https://example.test/doc.pdf": {
        status: 200,
        headers: { "content-type": "application/pdf", etag: '"pdf-v1"' },
        bytes: pdfFixtureBytes,
      },
    });
    const captured = await fetchSource(cfg({ url: "https://example.test/doc.pdf" }), fastOpts({ fetch: first }));
    await store.put(captured.snapshot!);
    assert.ok(captured.snapshot!.bodyBytes); // sanity: the prior snapshot really is binary

    // Re-check: server confirms unchanged via 304, so no body is transferred.
    const second = fakeFetch({ "https://example.test/doc.pdf": { status: 304 } });
    const result = await fetchSource(
      cfg({ url: "https://example.test/doc.pdf", revalidate: true }),
      fastOpts({ fetch: second, store }),
    );

    assert.equal(result.error, undefined);
    assert.ok(result.snapshot);
    assert.equal(result.snapshot!.notModified, true);
    assert.equal(result.snapshot!.fromCache, true);
    assert.equal(result.snapshot!.contentType, "pdf");
    // The 304 re-serves the prior snapshot verbatim: bodyBytes must survive,
    // body stays the binary-marker empty string, and bodyHash is unchanged.
    assert.deepEqual(result.snapshot!.bodyBytes, pdfFixtureBytes);
    assert.equal(result.snapshot!.body, "");
    assert.equal(result.snapshot!.bodyHash, captured.snapshot!.bodyHash);
    assert.equal(result.snapshot!.bodyHash, sha256Bytes(pdfFixtureBytes));
  });
});

describe("fetchSource() — config validation (never throws)", () => {
  it("returns invalid-config for a missing id", async () => {
    const result = await fetchSource({ id: "", url: "https://example.test/" } as SourceConfig, fastOpts());
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "invalid-config");
  });
  it("returns invalid-url for an unparseable url", async () => {
    const result = await fetchSource(cfg({ url: "not a url" }), fastOpts());
    assert.equal(result.error!.kind, "invalid-url");
  });
  it("returns invalid-url for an unsupported protocol", async () => {
    const result = await fetchSource(cfg({ url: "ftp://example.test/x" }), fastOpts());
    assert.equal(result.error!.kind, "invalid-url");
  });
});

describe("fetchSource() — HTTP errors, retries, timeout", () => {
  it("retries a 500 then succeeds, recording retry warnings", async () => {
    const fetch = fakeFetch({
      "https://example.test/page": [
        { status: 500, body: "err" },
        { status: 500, body: "err" },
        { status: 200, body: "ok" },
      ],
    });
    const result = await fetchSource(cfg({ retries: 2 }), fastOpts({ fetch }));
    assert.equal(result.snapshot!.body, "ok");
    assert.equal(fetch.calls.length, 3);
    assert.ok(result.warnings?.some((w) => /retry 1\/2/.test(w)));
    assert.ok(result.warnings?.some((w) => /retry 2\/2/.test(w)));
  });

  it("exhausts retries on persistent 503 and returns a typed http-error", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { status: 503, body: "down" } });
    const result = await fetchSource(cfg({ retries: 2 }), fastOpts({ fetch }));
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "http-error");
    assert.equal(result.error!.status, 503);
    assert.equal(fetch.calls.length, 3);
  });

  it("does NOT retry a 404 (non-retryable client error)", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { status: 404, body: "nope" } });
    const result = await fetchSource(cfg({ retries: 3 }), fastOpts({ fetch }));
    assert.equal(result.error!.kind, "http-error");
    assert.equal(result.error!.status, 404);
    assert.equal(fetch.calls.length, 1);
  });

  it("retries a network error then returns network when it persists", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { networkError: "ECONNRESET" } });
    const result = await fetchSource(cfg({ retries: 1 }), fastOpts({ fetch }));
    assert.equal(result.error!.kind, "network");
    assert.equal(fetch.calls.length, 2);
  });

  it("maps an aborted (timed-out) request to a timeout error", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { hang: true } });
    const result = await fetchSource(cfg({ retries: 0, timeoutMs: 10 }), fastOpts({ fetch, schedule: firingSchedule }));
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "timeout");
  });

  it("caps retries at MAX_RETRIES (5) even when a larger value is configured", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { status: 500, body: "x" } });
    const result = await fetchSource(cfg({ retries: 99 }), fastOpts({ fetch }));
    assert.equal(result.error!.kind, "http-error");
    assert.equal(fetch.calls.length, 6); // 1 initial + 5 retries
  });
});

describe("fetchSource() — redirects", () => {
  it("follows a 301 to the final URL and records the redirect chain", async () => {
    const fetch = fakeFetch({
      "https://example.test/old": { status: 301, headers: { location: "https://example.test/new" } },
      "https://example.test/new": { status: 200, body: "final" },
    });
    const result = await fetchSource(cfg({ url: "https://example.test/old" }), fastOpts({ fetch }));
    assert.equal(result.snapshot!.url, "https://example.test/new");
    assert.equal(result.snapshot!.body, "final");
    assert.deepEqual(result.snapshot!.redirects, ["https://example.test/old"]);
  });

  it("resolves a relative Location against the current URL", async () => {
    const fetch = fakeFetch({
      "https://example.test/a": { status: 302, headers: { location: "/b" } },
      "https://example.test/b": { status: 200, body: "b" },
    });
    const result = await fetchSource(cfg({ url: "https://example.test/a" }), fastOpts({ fetch }));
    assert.equal(result.snapshot!.url, "https://example.test/b");
  });

  it("returns too-many-redirects past the bound", async () => {
    const fetch = fakeFetch({
      "https://example.test/loop": { status: 302, headers: { location: "https://example.test/loop" } },
    });
    const result = await fetchSource(cfg({ url: "https://example.test/loop" }), fastOpts({ fetch }));
    assert.equal(result.error!.kind, "too-many-redirects");
  });

  it("errors on a redirect with no Location header", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { status: 302 } });
    const result = await fetchSource(cfg(), fastOpts({ fetch }));
    assert.equal(result.error!.kind, "http-error");
    assert.equal(result.error!.status, 302);
  });
});

describe("fetchSource() — robots.txt", () => {
  it("denies a disallowed path (and never fetches the page)", async () => {
    const fetch = fakeFetch({
      "https://example.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private" },
      "https://example.test/private/x": { status: 200, body: "secret" },
    });
    const result = await fetchSource(cfg({ url: "https://example.test/private/x", respectRobots: true }), fastOpts({ fetch }));
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "robots-denied");
    assert.ok(!fetch.calls.some((c) => c.url === "https://example.test/private/x"));
  });

  it("allows a path outside the disallow set", async () => {
    const fetch = fakeFetch({
      "https://example.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private" },
      "https://example.test/public": { status: 200, body: "ok" },
    });
    const result = await fetchSource(cfg({ url: "https://example.test/public", respectRobots: true }), fastOpts({ fetch }));
    assert.equal(result.snapshot!.body, "ok");
  });

  it("fails OPEN with a warning when robots.txt is a 5xx", async () => {
    const fetch = fakeFetch({
      "https://example.test/robots.txt": { status: 503, body: "" },
      "https://example.test/page": { status: 200, body: "ok" },
    });
    const result = await fetchSource(cfg({ respectRobots: true }), fastOpts({ fetch }));
    assert.equal(result.snapshot!.body, "ok");
    assert.ok(result.warnings?.some((w) => /robots\.txt.*fail-open/.test(w)));
  });
});

describe("fetchSource() — politeness", () => {
  it("waits out the per-host min-delay before a second request to the same host", async () => {
    const slept: number[] = [];
    const politenessState = new Map<string, number>();
    let clockMs = 0;
    const fetch = fakeFetch({ "https://example.test/page": { body: "x" } });
    const opts: FetchSourceOptions = {
      fetch,
      random: () => 0,
      sleep: async (ms) => { slept.push(ms); },
      now: () => clockMs,
      politenessState,
    };
    await fetchSource(cfg({ minDelayMs: 1000 }), opts); // first: no wait
    clockMs = 200; // 200ms later
    await fetchSource(cfg({ minDelayMs: 1000 }), opts); // second: must wait 800ms
    assert.deepEqual(slept, [800]);
  });

  it("does not wait when the min-delay has already elapsed", async () => {
    const slept: number[] = [];
    const politenessState = new Map<string, number>();
    let clockMs = 0;
    const fetch = fakeFetch({ "https://example.test/page": { body: "x" } });
    const opts: FetchSourceOptions = {
      fetch, random: () => 0, sleep: async (ms) => { slept.push(ms); }, now: () => clockMs, politenessState,
    };
    await fetchSource(cfg({ minDelayMs: 1000 }), opts);
    clockMs = 5000;
    await fetchSource(cfg({ minDelayMs: 1000 }), opts);
    assert.deepEqual(slept, []);
  });
});

describe("fetchSource() — rendered fetch (traverse#41)", () => {
  it("render: true with no renderImpl configured is a typed invalid-config error", async () => {
    const result = await fetchSource(cfg({ render: true }), fastOpts());
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "invalid-config");
    assert.match(result.error!.message, /render is true but no FetchSourceOptions\.renderImpl/);
  });

  it("a successful render produces the documented Snapshot shape (AC3)", async () => {
    const renderImpl = fakeRenderImpl({
      "https://example.test/page": { html: "<h1>Rendered</h1>" },
    });
    const result = await fetchSource(cfg({ render: true }), fastOpts({ renderImpl }));
    assert.equal(result.error, undefined);
    assert.ok(result.snapshot);
    assert.equal(result.snapshot!.contentType, "html");
    assert.equal(result.snapshot!.body, "<h1>Rendered</h1>");
    assert.equal(result.snapshot!.bodyHash, sha256Hex("<h1>Rendered</h1>"));
    assert.equal(result.snapshot!.rendered, true);
    assert.equal(result.snapshot!.url, "https://example.test/page");
    assert.equal(result.snapshot!.status, 200);
    assert.equal(result.snapshot!.redirects, undefined);
    assert.equal(result.snapshot!.etag, undefined);
    assert.equal(result.snapshot!.lastModified, undefined);
    assert.equal(renderImpl.calls.length, 1);
    assert.equal(renderImpl.calls[0], "https://example.test/page");
  });

  it("uses renderResult.finalUrl/status when the renderer reports them", async () => {
    const renderImpl = fakeRenderImpl({
      "https://example.test/page": { html: "<p>x</p>", finalUrl: "https://example.test/page/after-redirect", status: 201 },
    });
    const result = await fetchSource(cfg({ render: true }), fastOpts({ renderImpl }));
    assert.equal(result.snapshot!.url, "https://example.test/page/after-redirect");
    assert.equal(result.snapshot!.status, 201);
  });

  it("robots-denied short-circuits BEFORE renderImpl is ever invoked (AC2)", async () => {
    const fetch = fakeFetch({
      "https://example.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private" },
    });
    const renderImpl = fakeRenderImpl({
      "https://example.test/private/x": { html: "<h1>should never render</h1>" },
    });
    const result = await fetchSource(
      cfg({ url: "https://example.test/private/x", render: true, respectRobots: true }),
      fastOpts({ fetch, renderImpl }),
    );
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "robots-denied");
    assert.equal(renderImpl.calls.length, 0);
  });

  it("allows a render when robots permits the requested URL", async () => {
    const fetch = fakeFetch({
      "https://example.test/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /private" },
    });
    const renderImpl = fakeRenderImpl({
      "https://example.test/public": { html: "<h1>ok</h1>" },
    });
    const result = await fetchSource(
      cfg({ url: "https://example.test/public", render: true, respectRobots: true }),
      fastOpts({ fetch, renderImpl }),
    );
    assert.equal(result.snapshot!.rendered, true);
    assert.equal(renderImpl.calls.length, 1);
  });

  it("renderImpl throwing maps to a typed adapter-error (AC6)", async () => {
    const renderImpl = fakeRenderImpl({
      "https://example.test/page": { throws: "browser crashed" },
    });
    const result = await fetchSource(cfg({ render: true }), fastOpts({ renderImpl }));
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "adapter-error");
    assert.match(result.error!.message, /renderImpl failed for https:\/\/example\.test\/page/);
    assert.match(result.error!.message, /browser crashed/);
  });

  it("renderImpl reporting a non-2xx status maps to a typed http-error with that status (AC6)", async () => {
    const renderImpl = fakeRenderImpl({
      "https://example.test/page": { html: "<h1>gone</h1>", status: 404 },
    });
    const result = await fetchSource(cfg({ render: true }), fastOpts({ renderImpl }));
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "http-error");
    assert.equal(result.error!.status, 404);
  });

  it("render + revalidate: true skips validators entirely and warns instead of silently no-op'ing (AC5)", async () => {
    const store = createInMemorySnapshotStore();
    await store.put({
      sourceId: "src-1",
      url: "https://example.test/page",
      fetchedAt: "2026-07-01T00:00:00.000Z",
      status: 200,
      contentType: "html",
      body: "<h1>prior</h1>",
      bodyHash: sha256Hex("<h1>prior</h1>"),
      etag: '"prior-etag"',
      lastModified: "Wed, 01 Jul 2026 00:00:00 GMT",
    });
    const renderImpl = fakeRenderImpl({
      "https://example.test/page": { html: "<h1>fresh render</h1>" },
    });
    const result = await fetchSource(
      cfg({ render: true, revalidate: true }),
      fastOpts({ renderImpl, store }),
    );
    assert.equal(result.error, undefined);
    assert.ok(result.snapshot);
    assert.equal(result.snapshot!.rendered, true);
    assert.equal(result.snapshot!.etag, undefined);
    assert.equal(result.snapshot!.lastModified, undefined);
    assert.equal(result.snapshot!.notModified, undefined);
    assert.ok(
      result.warnings?.some((w) => /revalidation has no effect for a rendered fetch/.test(w)),
      `expected a validators-skip warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });
});
