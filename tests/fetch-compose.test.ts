import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fetchAndExtract,
  buildSnapshotSourceRef,
  parseSnapshotSourceRef,
} from "../src/fetch/compose.js";
import { createInMemorySnapshotStore } from "../src/fetch/snapshot-store.js";
import { sha256Hex } from "../src/fetch/fetch-source.js";
import { prepareContent } from "../src/content-prep.js";
import type { SourceConfig } from "../src/fetch/types.js";
import { readFileSync } from "node:fs";
import { fakeFetch } from "./fixtures/fake-fetch.js";
import { createMockExtractionProvider, createRegexScanProvider } from "./fixtures/mock-provider.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";
import { createNaivePdfTextExtractor } from "./fixtures/naive-pdf-text-extractor.js";
import { fakeRenderImpl } from "./fixtures/fake-render.js";

const pdfFixtureBytes = new Uint8Array(
  readFileSync(new URL("../../tests/fixtures/minimal-two-page.pdf", import.meta.url)),
);

const PAGE = "<h1>Beginner Bouldering Session</h1>";

// Reused from tests/cost-guard.test.ts: cardsHtml structurally chunks into
// exactly 6 chunks at chunkSize 400 (12 cards, ~2 per chunk) — the same
// "6 natural calls" baseline used there for cost-guard ceiling scenarios.
const cardsHtml = readFileSync(
  new URL("../../tests/fixtures/repeated-cards-page.html", import.meta.url),
  "utf8",
);
const CHUNK_SIZE = 400;

function cfg(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return { id: "listing-1", url: "https://example.test/listing", respectRobots: false, ...overrides };
}

function mockProvider() {
  return createMockExtractionProvider({
    proposals: [
      {
        fieldPath: "title",
        candidateValue: "Beginner Bouldering Session",
        confidence: 0.9,
        provenance: { excerpt: "Beginner Bouldering Session", locator: "provisional" },
        extractor: "mock-extraction-provider",
      },
    ],
    raw: { response: "{}", model: "mock-model", tokensUsed: 7 },
  });
}

describe("buildSnapshotSourceRef / parseSnapshotSourceRef", () => {
  it("round-trips sourceId, url, bodyHash, fetchedAt", () => {
    const ref = buildSnapshotSourceRef({
      sourceId: "id with spaces & symbols",
      url: "https://example.test/x?q=1",
      fetchedAt: "2026-07-02T00:00:00.000Z",
      status: 200,
      contentType: "html",
      body: "b",
      bodyHash: "abc123",
    });
    const parsed = parseSnapshotSourceRef(ref);
    assert.deepEqual(parsed, {
      sourceId: "id with spaces & symbols",
      url: "https://example.test/x?q=1",
      bodyHash: "abc123",
      fetchedAt: "2026-07-02T00:00:00.000Z",
    });
  });
  it("returns undefined for a non-snapshot ref", () => {
    assert.equal(parseSnapshotSourceRef("https://example.test/plain"), undefined);
  });
});

describe("fetchAndExtract() — live", () => {
  it("fetches, extracts, and threads a snapshot-anchored sourceRef with the exact bodyHash", async () => {
    const fetch = fakeFetch({ "https://example.test/listing": { headers: { "content-type": "text/html" }, body: PAGE } });
    const provider = mockProvider();
    const result = await fetchAndExtract(cfg(), {
      targetSchema: genericTargetSchema,
      provider,
      mode: "live",
      fetchOptions: { fetch, sleep: async () => {}, clock: () => "2026-07-02T00:00:00.000Z" },
    });

    assert.equal(result.fetch.snapshot!.bodyHash, sha256Hex(PAGE));
    assert.equal(result.extraction!.proposals.length, 1);
    // provenance continuity: the sourceRef carries the exact bytes' hash + fetchedAt.
    const parsed = parseSnapshotSourceRef(result.sourceRef!);
    assert.equal(parsed!.bodyHash, sha256Hex(PAGE));
    assert.equal(parsed!.fetchedAt, "2026-07-02T00:00:00.000Z");
    assert.equal(parsed!.sourceId, "listing-1");
  });

  it("returns no extraction when the fetch fails (never throws)", async () => {
    const fetch = fakeFetch({ "https://example.test/listing": { status: 500, body: "err" } });
    const provider = mockProvider();
    const result = await fetchAndExtract(cfg(), {
      targetSchema: genericTargetSchema,
      provider,
      mode: "live",
      fetchOptions: { fetch, sleep: async () => {}, random: () => 0 },
    });
    assert.equal(result.extraction, undefined);
    assert.equal(result.fetch.error!.kind, "http-error");
    assert.equal(provider.calls.length, 0);
  });
});

describe("fetchAndExtract() — capture + replay parity", () => {
  it("live-with-capture then replay yields byte-identical prepared content and identical proposals", async () => {
    const fetch = fakeFetch({ "https://example.test/listing": { headers: { "content-type": "text/html" }, body: PAGE } });
    const store = createInMemorySnapshotStore();

    const live = await fetchAndExtract(cfg(), {
      targetSchema: genericTargetSchema,
      provider: mockProvider(),
      store,
      mode: "live-with-capture",
      fetchOptions: { fetch, sleep: async () => {}, clock: () => "2026-07-02T00:00:00.000Z" },
    });
    assert.ok(live.fetch.snapshot);

    // Replay: no fetch is used at all.
    const replay = await fetchAndExtract(cfg(), {
      targetSchema: genericTargetSchema,
      provider: mockProvider(),
      store,
      mode: "replay",
    });
    assert.equal(replay.fetch.snapshot!.fromCache, true);

    // Byte-identical bodies -> byte-identical prepared content.
    const liveBody = live.fetch.snapshot!.body;
    const replayBody = replay.fetch.snapshot!.body;
    assert.equal(liveBody, replayBody);
    const livePrepared = prepareContent(liveBody, live.fetch.snapshot!.contentType);
    const replayPrepared = prepareContent(replayBody, replay.fetch.snapshot!.contentType);
    assert.deepEqual(livePrepared, replayPrepared);

    // Same bodyHash -> same sourceRef -> same proposals from the deterministic provider.
    assert.equal(live.fetch.snapshot!.bodyHash, replay.fetch.snapshot!.bodyHash);
    assert.equal(live.sourceRef, replay.sourceRef);
    assert.deepEqual(live.extraction!.proposals, replay.extraction!.proposals);
  });

  it("a proposal is traceable to the exact stored bytes via the sourceRef", async () => {
    const fetch = fakeFetch({ "https://example.test/listing": { headers: { "content-type": "text/html" }, body: PAGE } });
    const store = createInMemorySnapshotStore();
    const result = await fetchAndExtract(cfg(), {
      targetSchema: genericTargetSchema,
      provider: mockProvider(),
      store,
      mode: "live-with-capture",
      fetchOptions: { fetch, sleep: async () => {} },
    });

    const parsed = parseSnapshotSourceRef(result.sourceRef!);
    const traced = await store.get(parsed!.sourceId, parsed!.bodyHash);
    assert.ok(traced, "sourceRef resolves to a stored snapshot");
    assert.equal(traced!.body, PAGE);
    assert.equal(sha256Hex(traced!.body), parsed!.bodyHash);
  });

  it("replay mode without a store returns a typed invalid-config error and no extraction", async () => {
    const result = await fetchAndExtract(cfg(), {
      targetSchema: genericTargetSchema,
      provider: mockProvider(),
      mode: "replay",
    });
    assert.equal(result.extraction, undefined);
    assert.equal(result.fetch.error!.kind, "invalid-config");
  });
});

describe("fetchAndExtract() — revalidate wiring", () => {
  it("threads the composition store into fetchSource so a config.revalidate conditional GET works", async () => {
    const store = createInMemorySnapshotStore();
    const provider = mockProvider();
    const ETAG = '"listing-v1"';

    // First fetch captures the ETag onto the stored snapshot.
    const first = fakeFetch({
      "https://example.test/listing": { headers: { "content-type": "text/html", etag: ETAG }, body: PAGE },
    });
    await fetchAndExtract(cfg(), {
      targetSchema: genericTargetSchema,
      provider,
      store,
      mode: "live-with-capture",
      fetchOptions: { fetch: first, sleep: async () => {}, clock: () => "2026-07-02T00:00:00.000Z" },
    });

    // Re-check with revalidate: compose must pass `store` down so fetchSource can
    // read the prior snapshot's validator and send If-None-Match — a 304 re-serves
    // the prior snapshot marked notModified.
    const second = fakeFetch({ "https://example.test/listing": { status: 304 } });
    const result = await fetchAndExtract(cfg({ revalidate: true }), {
      targetSchema: genericTargetSchema,
      provider,
      store,
      mode: "live",
      fetchOptions: { fetch: second, sleep: async () => {}, clock: () => "2026-07-03T00:00:00.000Z" },
    });

    assert.equal(second.calls[0].headers["If-None-Match"], ETAG);
    assert.equal(result.fetch.snapshot!.notModified, true);
    assert.equal(result.fetch.snapshot!.fromCache, true);
  });
});


describe("fetchAndExtract() — pdfTextExtractor forwarding (traverse#23)", () => {
  it("a pdf-content-type snapshot's bytes reach the injected pdfTextExtractor end-to-end, producing verifiable proposals", async () => {
    const extractor = createNaivePdfTextExtractor();
    // Independently derive expected text/pageOffsets from the naive extractor
    // (pure), so this test's expectations come from the fixture, not from
    // reading back extract()'s own internals (mirrors pdf-content-prep.test.ts).
    const expected = await extractor.extract(pdfFixtureBytes);
    const excerpt = "Section Two: Item counts";
    assert.ok(expected.text.includes(excerpt), "fixture sanity: page 2's known text is present");
    const expectedStart = expected.text.indexOf(excerpt);

    const fetch = fakeFetch({
      "https://example.test/doc.pdf": {
        status: 200,
        headers: { "content-type": "application/pdf" },
        bytes: pdfFixtureBytes,
      },
    });

    const provider = createMockExtractionProvider({
      proposals: [
        {
          fieldPath: "title",
          candidateValue: excerpt,
          confidence: 0.9,
          provenance: { excerpt, locator: "provisional" },
          extractor: "test-provider",
        },
      ],
      raw: { response: "{}", model: "mock" },
    });

    const result = await fetchAndExtract(cfg({ url: "https://example.test/doc.pdf" }), {
      targetSchema: genericTargetSchema,
      provider,
      pdfTextExtractor: extractor,
      mode: "live",
      fetchOptions: { fetch, sleep: async () => {}, random: () => 0, politenessState: new Map(), robotsCache: new Map() },
    });

    assert.equal(result.fetch.snapshot!.contentType, "pdf");
    assert.deepEqual(result.fetch.snapshot!.bodyBytes, pdfFixtureBytes);
    assert.equal(result.fetch.snapshot!.body, "");

    assert.equal(result.extraction!.error, undefined);
    assert.equal(result.extraction!.proposals.length, 1);
    const proposal = result.extraction!.proposals[0];
    assert.match(proposal.provenance.locator, /^chars:\d+-\d+$/);
    const match = proposal.provenance.locator.match(/^chars:(\d+)-(\d+)$/) as RegExpMatchArray;
    const start = Number(match[1]);
    const end = Number(match[2]);
    assert.equal(start, expectedStart, "locator start matches the independently-derived pdf text offset");
    assert.equal(expected.text.slice(start, end), excerpt, "fullText.slice(start, end) === excerpt (offset fidelity)");
    assert.deepEqual(result.extraction!.pdfPageOffsets, expected.pageOffsets);
  });
});

describe("fetchAndExtract() — cost-guard forwarding", () => {
  async function seededStore() {
    const store = createInMemorySnapshotStore();
    const config = cfg();
    await store.put({
      sourceId: config.id,
      url: config.url,
      fetchedAt: "2026-07-06T00:00:00.000Z",
      status: 200,
      contentType: "html",
      body: cardsHtml,
      bodyHash: sha256Hex(cardsHtml),
    });
    return store;
  }

  it("bounds provider calls to maxProviderCalls through the full fetchAndExtract -> extract() path, with the same ceiling warning extract() asserts directly", async () => {
    const store = await seededStore();
    const provider = createRegexScanProvider();
    const result = await fetchAndExtract(cfg(), {
      targetSchema: genericTargetSchema,
      provider,
      store,
      mode: "replay",
      chunkSize: CHUNK_SIZE,
      maxProviderCalls: 1,
    });

    assert.equal(result.extraction!.providerCalls, 1, "exactly 1 call, not the natural 6");
    assert.equal(provider.callContents.length, 1, "the provider itself recorded exactly 1 call");
    assert.ok(result.extraction!.proposals.length > 0, "partial proposals from the one call survive");
    assert.ok(
      result.extraction!.warnings?.some(
        (w) => w === "stopped after 1 provider call(s): maxProviderCalls (1) reached; 5 chunk(s) not processed",
      ),
      `expected ceiling warning, got: ${JSON.stringify(result.extraction!.warnings)}`,
    );
  });

  it("control: without maxProviderCalls, the same replayed content issues all 6 natural provider calls", async () => {
    const store = await seededStore();
    const provider = createRegexScanProvider();
    const result = await fetchAndExtract(cfg(), {
      targetSchema: genericTargetSchema,
      provider,
      store,
      mode: "replay",
      chunkSize: CHUNK_SIZE,
    });

    assert.equal(result.extraction!.providerCalls, 6);
    assert.ok(
      result.extraction!.providerCalls > 1,
      "proves the guard option (not the fixture) causes the cap above",
    );
    assert.ok(!result.extraction!.warnings?.some((w) => /maxProviderCalls/.test(w)));
  });

  it("maxTotalTokens forwards through the same path: accumulated tokensUsed ceiling stops issuing calls", async () => {
    const store = await seededStore();
    const provider = createRegexScanProvider({ tokensUsed: 100 });
    const result = await fetchAndExtract(cfg(), {
      targetSchema: genericTargetSchema,
      provider,
      store,
      mode: "replay",
      chunkSize: CHUNK_SIZE,
      maxTotalTokens: 250,
    });

    // Same "checked before each call" behavior as tests/cost-guard.test.ts's
    // direct-extract() maxTotalTokens coverage: 2 calls (200 < 250) still
    // issue a 3rd, then the accumulated 300 trips the ceiling before a 4th.
    assert.equal(provider.callContents.length, 3);
    assert.equal(result.extraction!.providerCalls, 3);
    assert.equal(result.extraction!.totalTokensUsed, 300);
    assert.ok(
      result.extraction!.warnings?.some(
        (w) =>
          w ===
          "stopped after 3 provider call(s): maxTotalTokens (250) reached (300 tokens used); 3 chunk(s) not processed",
      ),
      `expected ceiling warning, got: ${JSON.stringify(result.extraction!.warnings)}`,
    );
  });
});


describe("fetchAndExtract() — rendered snapshot cost-guard parity (traverse#41 AC7)", () => {
  it("a rendered snapshot flows through acquire() -> extract() unchanged: maxProviderCalls stops issuing calls identically to a wire-fetched snapshot of the same content", async () => {
    const renderImpl = fakeRenderImpl({
      "https://example.test/listing": { html: cardsHtml },
    });
    const provider = createRegexScanProvider();
    const result = await fetchAndExtract(cfg({ render: true }), {
      targetSchema: genericTargetSchema,
      provider,
      mode: "live",
      chunkSize: CHUNK_SIZE,
      maxProviderCalls: 1,
      fetchOptions: { renderImpl, sleep: async () => {}, random: () => 0 },
    });

    assert.equal(result.fetch.snapshot!.rendered, true);
    assert.equal(result.fetch.snapshot!.contentType, "html");
    // Same ceiling behavior the wire-fetched equivalent test above asserts:
    // exactly 1 call, not the natural 6, with the identical warning text —
    // compose.ts/extract() treat a rendered snapshot as just another Snapshot.
    assert.equal(result.extraction!.providerCalls, 1, "exactly 1 call, not the natural 6");
    assert.equal(provider.callContents.length, 1, "the provider itself recorded exactly 1 call");
    assert.ok(result.extraction!.proposals.length > 0, "partial proposals from the one call survive");
    assert.ok(
      result.extraction!.warnings?.some(
        (w) => w === "stopped after 1 provider call(s): maxProviderCalls (1) reached; 5 chunk(s) not processed",
      ),
      `expected ceiling warning, got: ${JSON.stringify(result.extraction!.warnings)}`,
    );

    // sourceRef provenance continuity holds for a rendered snapshot exactly
    // as it does for a wire-fetched one.
    const parsed = parseSnapshotSourceRef(result.sourceRef!);
    assert.equal(parsed!.bodyHash, result.fetch.snapshot!.bodyHash);
  });

  it("control: without maxProviderCalls, a rendered snapshot of the same content issues all 6 natural provider calls (same as the wire-fetched control above)", async () => {
    const renderImpl = fakeRenderImpl({
      "https://example.test/listing": { html: cardsHtml },
    });
    const provider = createRegexScanProvider();
    const result = await fetchAndExtract(cfg({ render: true }), {
      targetSchema: genericTargetSchema,
      provider,
      mode: "live",
      chunkSize: CHUNK_SIZE,
      fetchOptions: { renderImpl, sleep: async () => {}, random: () => 0 },
    });

    assert.equal(result.extraction!.providerCalls, 6);
    assert.ok(!result.extraction!.warnings?.some((w) => /maxProviderCalls/.test(w)));
  });
});
