import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crawlAndExtract } from "../src/fetch/crawl-extract.js";
import { sha256Hex } from "../src/fetch/fetch-source.js";
import { createMockExtractionProvider } from "./fixtures/mock-provider.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";
import { createInMemoryPreparedArtifactStore, resolvePreparedArtifact } from "../src/prepared-artifact.js";
import { createForageReplayManifest } from "./fixtures/forage-replay.js";
import { createInMemorySnapshotStore } from "@kontourai/forage";
import { resolveSnapshotSourceRef } from "@kontourai/forage/fetch";
import type { CrawlManifest, Page, Seed } from "@kontourai/forage";
import { parseAnySnapshotSourceRef } from "../src/fetch/forage-interop.js";
import { CHARSET_HEADING, CHARSET_PAGES, startCharsetServer } from "./fixtures/charset-server.js";

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
    // The fixture stands in for a real forage replay only while its ref has
    // forage's current shape, which names the stored record by its digest.
    const fixtureRef = parseAnySnapshotSourceRef(manifest.pages[0].sourceRef)!;
    assert.equal(fixtureRef.scheme, "forage-snapshot");
    assert.match(fixtureRef.snapshotSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(first.pages[0].sourceRef, manifest.pages[0].sourceRef);
    const resolved = await resolvePreparedArtifact(replayArtifact, preparedStore);
    assert.equal(resolved.status, "available");
  });

  it("passes forage's charset decoding and snapshot ref through a real loopback crawl", async () => {
    const server = await startCharsetServer();
    try {
      const store = createInMemorySnapshotStore();
      const provider = mockProvider(CHARSET_HEADING);
      // No crawlImpl: forage does the crawl. The latin1 page links to the
      // byte-order-mark page, so one crawl covers both.
      const result = await crawlAndExtract(
        { url: server.origin + CHARSET_PAGES.latin1.path },
        {
          targetSchema: genericTargetSchema,
          provider,
          policy: {
            maxPages: 2,
            robots: false,
            politeness: { delayMs: 0 },
            egress: { guarded: true, testOnlyAllowedLoopbackOrigins: [server.origin] },
            store,
          },
        },
      );

      assert.deepEqual(result.manifest.warnings, []);
      assert.deepEqual(
        result.pages.map((p) => p.page.url),
        [server.origin + CHARSET_PAGES.latin1.path, server.origin + CHARSET_PAGES.bom.path],
      );
      assert.equal(provider.calls.length, 2);

      for (const [index, expected] of [CHARSET_PAGES.latin1, CHARSET_PAGES.bom].entries()) {
        const { page, sourceRef, extraction } = result.pages[index];

        // The text the provider read is the charset-decoded text.
        const content = provider.calls[index].content;
        assert.ok(content.includes(CHARSET_HEADING), `provider content carries the heading: ${JSON.stringify(content)}`);
        assert.equal(content.includes("\uFFFD"), false, "no replacement characters reach the provider");
        assert.equal(content.includes("\uFEFF"), false, "no byte-order mark reaches the provider");
        assert.equal(page.body, expected.text);
        assert.equal(extraction.proposals.length, 1);
        assert.equal(extraction.proposals[0].candidateValue, CHARSET_HEADING);

        // The digest is of the bytes served, not of the decoded text.
        assert.equal(page.snapshot.bodyHash, expected.sha256);
        assert.notEqual(page.snapshot.bodyHash, sha256Hex(expected.text));

        // The ref handed back is forage's own, digest of the stored record
        // included, and it resolves to that record.
        const parsed = parseAnySnapshotSourceRef(sourceRef)!;
        assert.equal(parsed.scheme, "forage-snapshot");
        assert.equal(parsed.bodyHash, expected.sha256);
        assert.match(parsed.snapshotSha256 ?? "", /^[a-f0-9]{64}$/);
        assert.equal(sourceRef, page.sourceRef);
        const resolved = await resolveSnapshotSourceRef(store, sourceRef);
        assert.equal(resolved.ok, true);
      }
    } finally {
      await server.close();
    }
  });
});
