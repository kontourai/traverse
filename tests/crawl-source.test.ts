import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { crawlSource } from "../src/fetch/crawl.js";
import { parseSnapshotSourceRef } from "../src/fetch/compose.js";
import { createInMemorySnapshotStore } from "../src/fetch/snapshot-store.js";
import type { FetchSourceOptions, SnapshotStore, SourceConfig } from "../src/fetch/types.js";
import { fakeFetch } from "./fixtures/fake-fetch.js";
import type { FakeResponseSpec } from "./fixtures/fake-fetch.js";

// Fixture site (tests/fixtures/crawl-site/home.html carries the full intended
// link graph as a doc comment). Recap of the shape this file relies on:
//
//   home.html   (seed, depth 0) -> about.html (relative), gear.html (absolute
//                same-host), other-example.test/promo.html (cross-host,
//                EXCLUDED), mailto:hello@example.test (non-http, EXCLUDED),
//                home.html#top (fragment -> dedupes to the seed, no re-enqueue)
//   about.html  (depth 1, only reachable from home.html) -> contact.html
//   gear.html   (depth 1, only reachable from home.html) -> contact.html,
//                gear.html?variant=green (query-variant, distinct URL)
//   contact.html (depth 2 — reachable only via about.html/gear.html, both of
//                which link to it: the dedup case) -> home.html (already seen)
//
// Five distinct same-host URLs are discoverable: home, about, gear, contact,
// gear?variant=green.

const ORIGIN = "https://example.test/crawl-site";

function fixtureHtml(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/crawl-site/${name}`, import.meta.url), "utf8");
}

const HOME_HTML = fixtureHtml("home.html");
const ABOUT_HTML = fixtureHtml("about.html");
const GEAR_HTML = fixtureHtml("gear.html");
const CONTACT_HTML = fixtureHtml("contact.html");

const EXPECTED_URLS = [
  `${ORIGIN}/home.html`,
  `${ORIGIN}/about.html`,
  `${ORIGIN}/gear.html`,
  `${ORIGIN}/contact.html`,
  `${ORIGIN}/gear.html?variant=green`,
];
const EXPECTED_DEPTHS = [0, 1, 1, 2, 2];

function htmlSpec(body: string): FakeResponseSpec {
  return { headers: { "content-type": "text/html; charset=utf-8" }, body };
}

/** Fresh routes map per call — fakeFetch's `calls` ledger is per-instance. */
function siteRoutes(): Record<string, FakeResponseSpec | FakeResponseSpec[]> {
  return {
    [`${ORIGIN}/home.html`]: htmlSpec(HOME_HTML),
    [`${ORIGIN}/about.html`]: htmlSpec(ABOUT_HTML),
    [`${ORIGIN}/gear.html`]: htmlSpec(GEAR_HTML),
    [`${ORIGIN}/contact.html`]: htmlSpec(CONTACT_HTML),
    // Same page content as gear.html — it's a query-variant of the same
    // catalog page, not a distinct document (see the graph recap above).
    [`${ORIGIN}/gear.html?variant=green`]: htmlSpec(GEAR_HTML),
  };
}

function seedCfg(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return { id: "crawl-1", url: `${ORIGIN}/home.html`, respectRobots: false, ...overrides };
}

// Silence real politeness/backoff timers unless a test asserts on them
// (mirrors tests/fetch-source.test.ts's `fastOpts` convention). Deliberately
// does NOT set politenessState/robotsCache, so crawlSource's own
// fresh-per-invocation maps (R2) are what every test below exercises.
function fastFetchOptions(extra: FetchSourceOptions = {}): FetchSourceOptions {
  return { sleep: async () => {}, random: () => 0, ...extra };
}

describe("crawlSource() — AC1 crawl-bounded-ordered-depth", () => {
  it("crawls the fixture site to the exact bounded page set, in BFS discovery order, with correct per-page depth", async () => {
    const fetch = fakeFetch(siteRoutes());
    const manifest = await crawlSource(seedCfg(), {
      maxPages: 10,
      maxDepth: 2,
      fetchOptions: fastFetchOptions({ fetch }),
    });

    assert.deepEqual(manifest.pages.map((p) => p.url), EXPECTED_URLS);
    assert.deepEqual(manifest.pages.map((p) => p.depth), EXPECTED_DEPTHS);
    assert.equal(manifest.truncated, false);
    assert.equal(manifest.seed.id, "crawl-1");
    assert.equal(manifest.seed.url, `${ORIGIN}/home.html`);
  });

  it("never discovers the cross-host link or the mailto: link as a page", async () => {
    const fetch = fakeFetch(siteRoutes());
    const manifest = await crawlSource(seedCfg(), {
      maxPages: 10,
      maxDepth: 2,
      fetchOptions: fastFetchOptions({ fetch }),
    });

    const urls = manifest.pages.map((p) => p.url);
    assert.ok(!urls.some((u) => u.includes("other-example.test")), "cross-host link must not be followed");
    assert.ok(!urls.some((u) => u.startsWith("mailto:")), "mailto: link must not be followed");
    // home.html's fragment self-link dedupes to the seed rather than adding a
    // second entry.
    assert.equal(urls.filter((u) => u === `${ORIGIN}/home.html`).length, 1);
  });
});

describe("crawlSource() — AC2 robots-politeness-across-frontier", () => {
  it("AC2a: records a politeness wait for the second same-host page fetched in the frontier", async () => {
    const fetch = fakeFetch(siteRoutes());
    const slept: number[] = [];
    // A self-incrementing fake clock: every r.now() call returns a distinct,
    // increasing value (no external hook is available between crawlSource's
    // internal per-page fetchSource() calls to advance time manually).
    let clockMs = 0;
    const now = () => {
      const v = clockMs;
      clockMs += 10;
      return v;
    };

    const manifest = await crawlSource(seedCfg({ minDelayMs: 1000 }), {
      maxPages: 2, // stop right after the 2nd page (home, then about) is fetched
      fetchOptions: {
        fetch,
        random: () => 0,
        sleep: async (ms) => {
          slept.push(ms);
        },
        now,
      },
    });

    assert.deepEqual(manifest.pages.map((p) => p.url), [`${ORIGIN}/home.html`, `${ORIGIN}/about.html`]);
    // First page: no prior request to this host yet, so no wait. Second page
    // (same host): a wait IS recorded, proving politeness state is threaded
    // across the frontier (not reset per page) even though no
    // `politenessState` was injected — crawlSource's own fresh map is doing
    // the bookkeeping.
    assert.equal(slept.length, 1);
    assert.equal(slept[0], 990);
  });

  it("AC2b: a robots-disallowed page's outcome is robots-denied while sibling pages in the same crawl still succeed", async () => {
    const routes = siteRoutes();
    routes["https://example.test/robots.txt"] = { status: 200, body: "User-agent: *\nDisallow: /crawl-site/contact.html" };
    const fetch = fakeFetch(routes);

    const manifest = await crawlSource(seedCfg({ respectRobots: true }), {
      maxPages: 10,
      maxDepth: 2,
      fetchOptions: fastFetchOptions({ fetch }),
    });

    const byUrl = new Map(manifest.pages.map((p) => [p.url, p]));
    assert.equal(byUrl.get(`${ORIGIN}/contact.html`)?.fetch.error?.kind, "robots-denied");
    assert.equal(byUrl.get(`${ORIGIN}/home.html`)?.fetch.error, undefined);
    assert.equal(byUrl.get(`${ORIGIN}/about.html`)?.fetch.error, undefined);
    assert.equal(byUrl.get(`${ORIGIN}/gear.html`)?.fetch.error, undefined);
    assert.equal(byUrl.get(`${ORIGIN}/gear.html?variant=green`)?.fetch.error, undefined);

    // robots.txt is fetched (and checked) once per host across the WHOLE
    // frontier, not once per page — proving the robotsCache is shared, not
    // reset per page.
    assert.equal(fetch.calls.filter((c) => c.url === "https://example.test/robots.txt").length, 1);
  });
});

describe("crawlSource() — AC3 manifest-snapshot-roundtrip-provenance", () => {
  it("live-with-capture then replay round-trips byte-identical snapshots and identical sourceRefs, each resolving via parseSnapshotSourceRef", async () => {
    const seed = seedCfg();
    const store = createInMemorySnapshotStore();

    const live = await crawlSource(seed, {
      maxPages: 10,
      maxDepth: 2,
      store,
      mode: "live-with-capture",
      fetchOptions: fastFetchOptions({ fetch: fakeFetch(siteRoutes()), clock: () => "2026-07-06T00:00:00.000Z" }),
    });
    assert.deepEqual(live.pages.map((p) => p.url), EXPECTED_URLS);
    assert.ok(live.pages.every((p) => p.fetch.snapshot), "every page captured a snapshot");

    // Replay: no fetch is used at all.
    const replay = await crawlSource(seed, { maxPages: 10, maxDepth: 2, store, mode: "replay" });
    assert.deepEqual(replay.pages.map((p) => p.url), EXPECTED_URLS);

    for (let i = 0; i < live.pages.length; i++) {
      const livePage = live.pages[i];
      const replayPage = replay.pages[i];
      assert.ok(livePage.fetch.snapshot && replayPage.fetch.snapshot, `page ${i} (${livePage.url}) has a snapshot on both sides`);
      assert.equal(replayPage.fetch.snapshot!.body, livePage.fetch.snapshot!.body);
      assert.equal(replayPage.fetch.snapshot!.bodyHash, livePage.fetch.snapshot!.bodyHash);
      assert.equal(replayPage.sourceRef, livePage.sourceRef);

      const parsed = parseSnapshotSourceRef(livePage.sourceRef!);
      assert.ok(parsed, `sourceRef for ${livePage.url} parses`);
      assert.equal(parsed!.bodyHash, livePage.fetch.snapshot!.bodyHash);
      assert.equal(parsed!.url, livePage.fetch.snapshot!.url);
      assert.equal(parsed!.fetchedAt, livePage.fetch.snapshot!.fetchedAt);
    }
  });

  it("a page missing from the store surfaces its own typed no-snapshot error on replay without failing the rest of the crawl", async () => {
    const seed = seedCfg();
    const fullStore = createInMemorySnapshotStore();
    const live = await crawlSource(seed, {
      maxPages: 10,
      maxDepth: 2,
      store: fullStore,
      mode: "live-with-capture",
      fetchOptions: fastFetchOptions({ fetch: fakeFetch(siteRoutes()) }),
    });
    assert.equal(live.pages.length, 5);

    // Simulate a partially-populated store: every captured snapshot EXCEPT
    // about.html's (recorded decision: a replay can legitimately discover
    // fewer/degraded pages than the live run that captured it — see
    // docs/decisions/crawl-frontier.md).
    const partialStore = createInMemorySnapshotStore();
    for (const page of live.pages) {
      if (page.url === `${ORIGIN}/about.html`) continue;
      if (page.fetch.snapshot) await partialStore.put(page.fetch.snapshot);
    }

    const replay = await crawlSource(seed, { maxPages: 10, maxDepth: 2, store: partialStore, mode: "replay" });

    const about = replay.pages.find((p) => p.url === `${ORIGIN}/about.html`);
    assert.ok(about);
    assert.equal(about!.fetch.error?.kind, "no-snapshot");
    assert.equal(about!.fetch.snapshot, undefined);

    // Sibling pages still replay fine — including contact.html and
    // gear.html?variant=green, which are only reachable in THIS replay via
    // gear.html's own (successful) link discovery, since about.html's
    // discovery was skipped when its snapshot came back missing.
    for (const url of [`${ORIGIN}/home.html`, `${ORIGIN}/gear.html`, `${ORIGIN}/contact.html`, `${ORIGIN}/gear.html?variant=green`]) {
      const page = replay.pages.find((p) => p.url === url);
      assert.ok(page?.fetch.snapshot, `${url} should still replay successfully`);
    }
    // The whole crawl still returns a complete manifest — one degraded page
    // does not abort the frontier.
    assert.equal(replay.pages.length, 5);
  });
});

describe("crawlSource() — AC4 maxpages-cap-typed-errors", () => {
  it("AC4a: the maxPages cap stops the frontier with truncated: true and a machine-checkable cap-reached warning", async () => {
    const fetch = fakeFetch(siteRoutes());
    const manifest = await crawlSource(seedCfg(), {
      maxPages: 2,
      maxDepth: 2,
      fetchOptions: fastFetchOptions({ fetch }),
    });

    assert.equal(manifest.pages.length, 2);
    assert.equal(manifest.truncated, true);
    assert.ok(
      manifest.warnings.some((w) => /maxPages cap/.test(w)),
      `expected a maxPages-cap warning, got: ${JSON.stringify(manifest.warnings)}`,
    );
  });

  it("AC4b: mode 'replay' with no store never throws and returns a whole-crawl invalid-config error on page 0", async () => {
    const manifest = await crawlSource(seedCfg(), { mode: "replay" });

    assert.equal(manifest.pages.length, 1);
    assert.equal(manifest.pages[0].url, seedCfg().url);
    assert.equal(manifest.pages[0].depth, 0);
    assert.equal(manifest.pages[0].fetch.error?.kind, "invalid-config");
    assert.equal(manifest.truncated, false);
  });

  it("AC4c: deliberately malformed/truncated HTML never throws — the page just yields no discovered links", async () => {
    // Truncated mid-attribute: no closing quote, no closing tag. linkedom does
    // not throw on this (nor on the crawl.ts try/catch's other malformed
    // shapes) — it simply yields zero anchors, so the crawl's own never-throw
    // discipline is exercised via crawlSource() resolving cleanly with a
    // 1-page manifest rather than propagating.
    const malformedHtml = '<html><body><a href="about.html';
    const fetch = fakeFetch({ [`${ORIGIN}/home.html`]: htmlSpec(malformedHtml) });

    const manifest = await crawlSource(seedCfg(), { fetchOptions: fastFetchOptions({ fetch }) });

    assert.equal(manifest.pages.length, 1);
    assert.equal(manifest.pages[0].fetch.snapshot?.body, malformedHtml);
    assert.equal(manifest.truncated, false);
  });
});

describe("crawlSource() — review fix: store.put() failure degrades per-page, not whole-crawl", () => {
  it("a throwing store.put() records a page-scoped warning and lets the crawl complete, with every other page still captured", async () => {
    const seed = seedCfg();
    let putCalls = 0;
    const failingStore: SnapshotStore = {
      async put() {
        putCalls++;
        throw new Error("disk full");
      },
      async latest() {
        return undefined;
      },
      async get() {
        return undefined;
      },
      async list() {
        return [];
      },
    };

    const manifest = await crawlSource(seed, {
      maxPages: 10,
      maxDepth: 2,
      store: failingStore,
      mode: "live-with-capture",
      fetchOptions: fastFetchOptions({ fetch: fakeFetch(siteRoutes()) }),
    });

    // The crawl completes fully — this is NOT the whole-crawl catch's
    // `pages: []` degradation; every page in the intended graph is still
    // present, in the same BFS order as an unfailing capture run.
    assert.deepEqual(manifest.pages.map((p) => p.url), EXPECTED_URLS);
    assert.equal(manifest.truncated, false);

    // Every page kept its own fetch result (including its in-memory
    // snapshot) even though persisting it failed every time.
    assert.ok(manifest.pages.every((p) => p.fetch.snapshot), "every page still carries its fetch snapshot despite store.put failing");
    assert.ok(manifest.pages.every((p) => p.fetch.error === undefined), "no page's fetch outcome is turned into an error by a store failure");

    // A page-scoped warning was recorded for each failed persist, naming the
    // page's own depth/url (mirroring every other per-page warning shape).
    assert.equal(putCalls, EXPECTED_URLS.length);
    const putWarnings = manifest.warnings.filter((w) => /store\.put failed/.test(w));
    assert.equal(putWarnings.length, EXPECTED_URLS.length);
    assert.ok(putWarnings.every((w) => /disk full/.test(w)), `expected each warning to include the underlying error, got: ${JSON.stringify(putWarnings)}`);
  });
});

describe("crawlSource() — review fix: seed URL fragment-stripping", () => {
  it("a seed URL carrying a fragment is stripped before seeding queue/seen — no duplicate self-fetch, and the recorded page url is fragment-less", async () => {
    const fetch = fakeFetch(siteRoutes());
    const manifest = await crawlSource(seedCfg({ url: `${ORIGIN}/home.html#top` }), {
      maxPages: 10,
      maxDepth: 2,
      fetchOptions: fastFetchOptions({ fetch }),
    });

    // Same bounded page set as the fragment-free seed — the seed's own
    // fragment self-link (`home.html#top`) dedupes against the (now
    // fragment-stripped) seed entry instead of re-enqueuing a duplicate.
    assert.deepEqual(manifest.pages.map((p) => p.url), EXPECTED_URLS);
    assert.equal(manifest.pages.filter((p) => p.url === `${ORIGIN}/home.html`).length, 1);
    // The recorded page url itself is fragment-less, consistent with every
    // discovered link's own fragment-stripping.
    assert.equal(manifest.pages[0].url, `${ORIGIN}/home.html`);
  });
});

describe("crawlSource() — review fix: seed contentType hint is not propagated to discovered pages", () => {
  it("a discovered page's contentType is resolved from its OWN response header, not force-inherited from the seed's explicit hint", async () => {
    const routes = siteRoutes();
    // Served with a non-html content-type header so a passing test can only
    // mean about.html's contentType came from ITS OWN header/sniffing, not a
    // spread-down copy of the seed's `contentType: "html"` hint.
    routes[`${ORIGIN}/about.html`] = { headers: { "content-type": "text/plain; charset=utf-8" }, body: ABOUT_HTML };
    const fetch = fakeFetch(routes);

    const manifest = await crawlSource(seedCfg({ contentType: "html" }), {
      maxPages: 10,
      maxDepth: 2,
      fetchOptions: fastFetchOptions({ fetch }),
    });

    const byUrl = new Map(manifest.pages.map((p) => [p.url, p]));
    assert.equal(byUrl.get(`${ORIGIN}/home.html`)?.fetch.snapshot?.contentType, "html");
    assert.equal(byUrl.get(`${ORIGIN}/about.html`)?.fetch.snapshot?.contentType, "text");
  });
});
