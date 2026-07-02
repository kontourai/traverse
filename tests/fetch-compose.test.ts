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
import { fakeFetch } from "./fixtures/fake-fetch.js";
import { createMockExtractionProvider } from "./fixtures/mock-provider.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";

const PAGE = "<h1>Beginner Bouldering Session</h1>";

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
