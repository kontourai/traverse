import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crawlAndExtract } from "../src/fetch/crawl-extract.js";
import { sha256Hex } from "../src/fetch/fetch-source.js";
import { createMockExtractionProvider } from "./fixtures/mock-provider.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";
import { createInMemoryPreparedArtifactStore, resolvePreparedArtifact } from "../src/prepared-artifact.js";
import { createForageReplayManifest } from "./fixtures/forage-replay.js";
import type { CrawlManifest, Page, Seed } from "@kontourai/forage";

// Build a forage-shaped Page without touching the network. `crawlAndExtract`
// only reads page.body, page.snapshot.headers, and page.sourceRef, so a minimal
// literal is a faithful stand-in for a real forage crawl output.
function fakePage(o: {
  url: string;
  body: string;
  depth?: number;
  sourceRef?: string;
  snapshot?: Page["snapshot"];
}): Page {
  return {
    url: o.url,
    status: 200,
    body: o.body,
    depth: o.depth ?? 0,
    rendered: false,
    warnings: [],
    sourceRef: o.sourceRef ?? `forage-snapshot:${o.url}`,
    snapshot: o.snapshot ?? {
      sourceId: o.url,
      url: o.url,
      status: 200,
      fetchedAt: "2026-07-14T00:00:00.000Z",
      body: o.body,
      bodyHash: sha256Hex(o.body),
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  };
}

function fakeManifest(pages: Page[]): CrawlManifest {
  return { seed: pages[0]?.url ?? "https://example.test/", pages, truncated: false, warnings: [] };
}

function mockProvider(excerpt = "Beginner Bouldering Session") {
  return createMockExtractionProvider({
    proposals: [
      {
        fieldPath: "title",
        candidateValue: excerpt,
        confidence: 0.9,
        provenance: { excerpt, locator: "provisional" },
        extractor: "mock-extraction-provider",
      },
    ],
    raw: { response: "{}", model: "mock-model", tokensUsed: 7 },
  });
}

const seed: Seed = { url: "https://example.test/listing" };

describe("crawlAndExtract", () => {
  it("extracts from every crawled page and preserves forage's sourceRef per page", async () => {
    // Bodies contain the proposal excerpt so extract()'s provenance check keeps it.
    const manifest = fakeManifest([
      fakePage({ url: "https://example.test/listing", body: "<h1>Beginner Bouldering Session</h1>", sourceRef: "forage-snapshot:page-a" }),
      fakePage({ url: "https://example.test/camps", body: "<h2>Beginner Bouldering Session</h2>", depth: 1, sourceRef: "forage-snapshot:page-b" }),
    ]);

    const result = await crawlAndExtract(seed, {
      targetSchema: genericTargetSchema,
      provider: mockProvider(),
      crawlImpl: async () => manifest,
    });

    // one extraction per crawled page, in manifest order
    assert.equal(result.pages.length, 2);
    assert.equal(result.manifest, manifest);

    // PROVENANCE CONTINUITY: each result carries forage's own citable sourceRef,
    // threaded straight into extract() (result-level ref === the page's ref).
    assert.equal(result.pages[0].sourceRef, "forage-snapshot:page-a");
    assert.equal(result.pages[1].sourceRef, "forage-snapshot:page-b");
    assert.equal(result.pages[0].sourceRef, result.pages[0].page.sourceRef);

    // extraction actually ran against each page's body
    for (const p of result.pages) {
      assert.ok(p.extraction, "each page has an extraction result");
      assert.equal(p.extraction.proposals.length, 1);
      assert.equal(p.extraction.proposals[0].candidateValue, "Beginner Bouldering Session");
    }
  });

  it("derives contentType from snapshot headers and never throws on an unsupported type", async () => {
    // A PDF page with no injected pdfTextExtractor: extract() returns a typed
    // error result rather than throwing, and the page still appears in output.
    const pdfPage = fakePage({
      url: "https://example.test/rules.pdf",
      body: "%PDF-1.7 not-really-parsed",
      snapshot: {
        sourceId: "https://example.test/rules.pdf",
        url: "https://example.test/rules.pdf",
        status: 200,
        fetchedAt: "2026-07-14T00:00:00.000Z",
        body: "%PDF-1.7 not-really-parsed",
        bodyHash: sha256Hex("%PDF-1.7 not-really-parsed"),
        headers: { "content-type": "application/pdf" },
      },
    });

    const result = await crawlAndExtract(seed, {
      targetSchema: genericTargetSchema,
      provider: mockProvider(),
      crawlImpl: async () => fakeManifest([pdfPage]),
    });

    assert.equal(result.pages.length, 1);
    const extraction = result.pages[0].extraction;
    assert.ok(extraction, "pdf page still yields an extraction result (never throws)");
    // pdf with no injected extractor → typed error, zero proposals
    assert.ok(extraction.error, "unsupported pdf yields a typed error, not a throw");
    assert.equal(extraction.proposals.length, 0);
  });

  it("returns an empty page list for an empty crawl (never throws)", async () => {
    const result = await crawlAndExtract(seed, {
      targetSchema: genericTargetSchema,
      provider: mockProvider(),
      crawlImpl: async () => fakeManifest([]),
    });
    assert.equal(result.pages.length, 0);
    assert.equal(result.manifest.pages.length, 0);
  });

  it("keeps prepared identity and exact resolution stable for a Forage-shaped replay manifest", async () => {
    const manifest = createForageReplayManifest();
    const preparedStore = createInMemoryPreparedArtifactStore();
    const options = {
      targetSchema: genericTargetSchema,
      provider: mockProvider("Sample heading"),
      preparedArtifactStore: preparedStore,
      preparationVersion: "generic-prep-v1",
      policy: { mode: "replay" as const },
      crawlImpl: async () => manifest,
    };
    const first = await crawlAndExtract(seed, options);
    const replay = await crawlAndExtract(seed, { ...options, provider: mockProvider("Sample heading") });

    const firstArtifact = first.pages[0].extraction.preparedArtifact!;
    const replayArtifact = replay.pages[0].extraction.preparedArtifact!;
    assert.equal(firstArtifact.ref, replayArtifact.ref);
    assert.equal(firstArtifact.sourceSnapshotRef, manifest.pages[0].sourceRef);
    const resolved = await resolvePreparedArtifact(replayArtifact, preparedStore);
    assert.equal(resolved.status, "available");
  });
});
