import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchSource, sha256Hex, resolveContentType } from "../src/fetch/fetch-source.js";
import type { FetchSourceOptions, SourceConfig } from "../src/fetch/types.js";
import { DEFAULT_USER_AGENT } from "../src/fetch/types.js";
import { fakeFetch, firingSchedule } from "./fixtures/fake-fetch.js";

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
