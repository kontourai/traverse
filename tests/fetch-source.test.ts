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
    assert.equal(resolveContentType(undefined, "image/png"), "png");
    assert.equal(resolveContentType(undefined, "image/jpeg"), "jpeg");
    assert.equal(resolveContentType(undefined, "image/jpg"), "jpeg");
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

  it("captures a png response as raw bodyBytes, leaves body empty, and hashes over the raw bytes", async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const fetch = fakeFetch({
      "https://example.test/image.png": {
        status: 200,
        headers: { "content-type": "image/png" },
        bytes: pngBytes,
      },
    });
    const result = await fetchSource(
      cfg({ url: "https://example.test/image.png" }),
      fastOpts({ fetch }),
    );

    assert.equal(result.error, undefined);
    assert.ok(result.snapshot);
    assert.equal(result.snapshot!.contentType, "png");
    assert.equal(result.snapshot!.body, "");
    assert.deepEqual(result.snapshot!.bodyBytes, pngBytes);
    assert.equal(result.snapshot!.bodyHash, sha256Bytes(pngBytes));
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

describe("fetchSource() — default egress is SSRF-guarded", () => {
  it("denies a cloud-metadata target when no fetch is injected", async () => {
    // No `fetch` override → the forage-guarded default transport. The metadata
    // IP is link-local (169.254.0.0/16), so the guard denies it before any
    // connection — deterministically, without DNS or network access. The thrown
    // egress-policy error surfaces through timedGet as a `network` result error.
    const result = await fetchSource(
      cfg({ url: "http://169.254.169.254/latest/meta-data/" }),
      fastOpts(),
    );
    assert.equal(result.snapshot, undefined);
    assert.ok(result.error, "expected the guarded default to deny the metadata target");
    assert.equal(result.error!.kind, "network");
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

  it("caller-supplied headers on a rendered fetch produce a not-forwarded warning", async () => {
    const renderImpl = fakeRenderImpl({
      "https://example.test/page": { html: "<h1>x</h1>" },
    });
    const result = await fetchSource(
      cfg({ render: true, headers: { "X-Custom": "yes" } }),
      fastOpts({ renderImpl }),
    );
    assert.equal(result.error, undefined);
    assert.ok(
      result.warnings?.some((w) => /headers are not forwarded to renderImpl/.test(w)),
      `expected a headers-not-forwarded warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  it("a retries setting on a rendered fetch produces a retries-do-not-apply warning", async () => {
    const renderImpl = fakeRenderImpl({
      "https://example.test/page": { html: "<h1>x</h1>" },
    });
    const result = await fetchSource(
      cfg({ render: true, retries: 3 }),
      fastOpts({ renderImpl }),
    );
    assert.equal(result.error, undefined);
    assert.ok(
      result.warnings?.some((w) => /retries do not apply to a rendered fetch/.test(w)),
      `expected a retries-do-not-apply warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  it("a rendered fetch with neither caller headers nor an explicit retries setting emits NEITHER warning (no false positive)", async () => {
    const renderImpl = fakeRenderImpl({
      "https://example.test/page": { html: "<h1>x</h1>" },
    });
    const result = await fetchSource(cfg({ render: true }), fastOpts({ renderImpl }));
    assert.equal(result.error, undefined);
    assert.equal(
      result.warnings?.some((w) => /headers are not forwarded to renderImpl/.test(w)) ?? false,
      false,
    );
    assert.equal(
      result.warnings?.some((w) => /retries do not apply to a rendered fetch/.test(w)) ?? false,
      false,
    );
  });

  it("an empty caller headers object on a rendered fetch does NOT trigger the not-forwarded warning", async () => {
    const renderImpl = fakeRenderImpl({
      "https://example.test/page": { html: "<h1>x</h1>" },
    });
    const result = await fetchSource(
      cfg({ render: true, headers: {} }),
      fastOpts({ renderImpl }),
    );
    assert.equal(result.error, undefined);
    assert.equal(
      result.warnings?.some((w) => /headers are not forwarded to renderImpl/.test(w)) ?? false,
      false,
    );
  });
});

describe("fetchSource() — renderImpl is never invoked without render: true (traverse#41)", () => {
  it("render: false performs a plain wire fetch and never calls renderImpl", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { body: "<h1>wire</h1>" } });
    const renderImpl = fakeRenderImpl({
      "https://example.test/page": { html: "<h1>should never render</h1>" },
    });
    const result = await fetchSource(cfg({ render: false }), fastOpts({ fetch, renderImpl }));
    assert.equal(result.error, undefined);
    assert.ok(result.snapshot);
    assert.equal(result.snapshot!.body, "<h1>wire</h1>");
    assert.equal(result.snapshot!.rendered, undefined);
    assert.equal(fetch.calls.length, 1);
    assert.equal(renderImpl.calls.length, 0);
  });

  it("render left unset (renderImpl still configured) performs a plain wire fetch and never calls renderImpl", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { body: "<h1>wire</h1>" } });
    const renderImpl = fakeRenderImpl({
      "https://example.test/page": { html: "<h1>should never render</h1>" },
    });
    const result = await fetchSource(cfg(), fastOpts({ fetch, renderImpl }));
    assert.equal(result.error, undefined);
    assert.ok(result.snapshot);
    assert.equal(result.snapshot!.body, "<h1>wire</h1>");
    assert.equal(result.snapshot!.rendered, undefined);
    assert.equal(fetch.calls.length, 1);
    assert.equal(renderImpl.calls.length, 0);
  });
});

const SPA_SHELL = readFileSync(new URL("../../tests/fixtures/spa-shell-empty.html", import.meta.url), "utf8");
const EMBEDDED_SHELL = readFileSync(new URL("../../tests/fixtures/js-shell-next.html", import.meta.url), "utf8");
const RICH_HTML = readFileSync(new URL("../../tests/fixtures/content-rich-heavy-scripts.html", import.meta.url), "utf8");

describe("fetchSource() — render policy compatibility", () => {
  it("maps legacy render values and accepts semantically agreeing forms", async () => {
    for (const [config, expectedRendered] of [
      [{ render: false }, false],
      [{}, false],
      [{ render: true }, true],
      [{ render: false, renderPolicy: "never" }, false],
      [{ render: true, renderPolicy: "always" }, true],
    ] as const) {
      const fetch = fakeFetch({ "https://example.test/page": { headers: { "content-type": "text/html" }, body: RICH_HTML } });
      const renderImpl = fakeRenderImpl({ "https://example.test/page": { html: "<main>rendered</main>" } });
      const result = await fetchSource(cfg(config), fastOpts({ fetch, renderImpl }));
      assert.equal(result.error, undefined);
      assert.equal(result.snapshot!.rendered === true, expectedRendered);
    }
  });

  it("rejects semantic conflicts and unknown runtime policy before I/O", async () => {
    for (const config of [
      { render: true, renderPolicy: "never" },
      { render: false, renderPolicy: "always" },
      { render: true, renderPolicy: "on-shell-warning" },
      { renderPolicy: "sometimes" },
    ]) {
      const fetch = fakeFetch({ "https://example.test/page": { body: RICH_HTML } });
      const result = await fetchSource(cfg(config as Partial<SourceConfig>), fastOpts({ fetch }));
      assert.equal(result.error?.kind, "invalid-config");
      assert.equal(fetch.calls.length, 0);
    }
  });
});

describe("fetchSource() — render policy attempts", () => {
  it("never makes exactly one plain attempt and always makes exactly one rendered attempt", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { body: SPA_SHELL } });
    const renderImpl = fakeRenderImpl({ "https://example.test/page": { html: "<main>rendered winner</main>" } });
    const never = await fetchSource(cfg({ renderPolicy: "never" }), fastOpts({ fetch, renderImpl }));
    assert.equal(fetch.calls.length, 1);
    assert.equal(renderImpl.calls.length, 0);
    assert.equal(never.renderEscalation?.outcome, "not-needed");

    const always = await fetchSource(cfg({ renderPolicy: "always" }), fastOpts({ fetch, renderImpl }));
    assert.equal(fetch.calls.length, 1, "always does not perform a plain page fetch");
    assert.equal(renderImpl.calls.length, 1);
    assert.equal(always.snapshot?.rendered, true);
  });

  it("on-shell-warning invokes the renderer at most once", async () => {
    const fetch = fakeFetch({ "https://example.test/page": { headers: { "content-type": "text/html" }, body: SPA_SHELL } });
    const renderImpl = fakeRenderImpl({ "https://example.test/page": [{ html: SPA_SHELL }, { html: "<main>second</main>" }] });
    const result = await fetchSource(cfg({ renderPolicy: "on-shell-warning" }), fastOpts({ fetch, renderImpl }));
    assert.equal(fetch.calls.length, 1);
    assert.equal(renderImpl.calls.length, 1);
    assert.equal(result.snapshot?.rendered, true);
  });
});

describe("fetchSource() — on-shell-warning classification", () => {
  it("escalates only the exact pure js-shell-suspected: warning", async () => {
    const renderImpl = fakeRenderImpl({ "https://example.test/page": { html: "<main>rendered</main>" } });
    const pure = await fetchSource(cfg({ renderPolicy: "on-shell-warning" }), fastOpts({
      fetch: fakeFetch({ "https://example.test/page": { headers: { "content-type": "text/html" }, body: SPA_SHELL } }),
      renderImpl,
    }));
    assert.equal(pure.renderEscalation?.shellWarningDetected, true);
    assert.equal(renderImpl.calls.length, 1);

    for (const body of [EMBEDDED_SHELL, RICH_HTML]) {
      const localRenderer = fakeRenderImpl({ "https://example.test/page": { html: "<main>must not run</main>" } });
      const result = await fetchSource(cfg({ renderPolicy: "on-shell-warning" }), fastOpts({
        fetch: fakeFetch({ "https://example.test/page": { headers: { "content-type": "text/html" }, body } }),
        renderImpl: localRenderer,
      }));
      assert.equal(localRenderer.calls.length, 0);
      assert.equal(result.renderEscalation?.outcome, "not-needed");
    }
  });

  it("does not render after a first fetch error or for non-HTML content", async () => {
    const renderImpl = fakeRenderImpl({ "https://example.test/page": { html: "<main>must not run</main>" } });
    const failed = await fetchSource(cfg({ renderPolicy: "on-shell-warning" }), fastOpts({
      fetch: fakeFetch({ "https://example.test/page": { status: 500 } }), renderImpl,
    }));
    assert.equal(failed.error?.kind, "http-error");
    const text = await fetchSource(cfg({ renderPolicy: "on-shell-warning", contentType: "text" }), fastOpts({
      fetch: fakeFetch({ "https://example.test/page": { body: SPA_SHELL } }), renderImpl,
    }));
    assert.equal(text.snapshot?.contentType, "text");
    const binary = await fetchSource(cfg({ renderPolicy: "on-shell-warning", contentType: "png" }), fastOpts({
      fetch: fakeFetch({ "https://example.test/page": { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) } }), renderImpl,
    }));
    assert.equal(binary.snapshot?.contentType, "png");
    assert.equal(renderImpl.calls.length, 0);
  });
});

describe("fetchSource() — render escalation winner selection", () => {
  it("a successful rendered snapshot wins without merging discarded shell warnings", async () => {
    const renderedBody = "<main>tiny rendered winner</main>";
    const result = await fetchSource(cfg({ renderPolicy: "on-shell-warning" }), fastOpts({
      fetch: fakeFetch({ "https://example.test/page": { headers: { "content-type": "text/html" }, body: SPA_SHELL } }),
      renderImpl: fakeRenderImpl({ "https://example.test/page": { html: renderedBody, warnings: ["renderer-note"] } }),
    }));
    assert.equal(result.snapshot?.body, renderedBody);
    assert.equal(result.snapshot?.rendered, true);
    assert.equal(result.renderEscalation?.outcome, "rendered");
    assert.ok(result.renderEscalation?.firstSnapshotRef);
    assert.deepEqual(result.warnings, ["renderer-note"]);
    assert.equal(result.warnings?.some((warning) => warning.startsWith("js-shell-suspected:")) ?? false, false);
  });

  it("missing, throwing, and non-2xx renderers retain the successful first snapshot with audit metadata", async () => {
    const cases = [
      { renderImpl: undefined, outcome: "renderer-unavailable-fallback", attempted: false, error: undefined },
      { renderImpl: fakeRenderImpl({ "https://example.test/page": { throws: "boom" } }), outcome: "render-failed-fallback", attempted: true, error: "adapter-error" },
      { renderImpl: fakeRenderImpl({ "https://example.test/page": { status: 503, html: "down" } }), outcome: "render-failed-fallback", attempted: true, error: "http-error" },
    ] as const;
    for (const testCase of cases) {
      const result = await fetchSource(cfg({ renderPolicy: "on-shell-warning" }), fastOpts({
        fetch: fakeFetch({ "https://example.test/page": { headers: { "content-type": "text/html" }, body: SPA_SHELL } }),
        ...(testCase.renderImpl ? { renderImpl: testCase.renderImpl } : {}),
      }));
      assert.equal(result.snapshot?.body, SPA_SHELL);
      assert.equal(result.renderEscalation?.outcome, testCase.outcome);
      assert.equal(result.renderEscalation?.renderAttempted, testCase.attempted);
      assert.equal(result.renderEscalation?.renderError?.kind, testCase.error);
    }
  });
});
