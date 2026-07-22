import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolvePdfPage } from "../src/content-prep.js";
import { extract } from "../src/extract.js";
import { createInMemoryPreparedArtifactStore, resolvePreparedArtifact } from "../src/prepared-artifact.js";
import type { ExtractionResult } from "../src/types.js";
import { createMockExtractionProvider } from "./fixtures/mock-provider.js";
import { createNaivePdfTextExtractor } from "./fixtures/naive-pdf-text-extractor.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";
import { rawSourceLocatorProfiles } from "./fixtures/raw-source-locator-profiles.js";

// `npm test` runs compiled tests from dist/, so retain the repository-relative
// fixture lookup used by the established PDF content-prep suite.
const pdfBytes = readFileSync(new URL("../../tests/fixtures/minimal-two-page.pdf", import.meta.url));

function providerFor(excerpt: string) {
  return createMockExtractionProvider({
    proposals: [{
      fieldPath: "title",
      candidateValue: excerpt,
      confidence: 0.9,
      provenance: { excerpt, locator: "provider-supplied-locator-is-replaced" },
      extractor: "raw-source-locator-profile-test-provider",
    }],
    raw: { response: "{}", model: "mock" },
  });
}

function locatorSpan(locator: string): [number, number] {
  const match = /^chars:(\d+)-(\d+)$/.exec(locator);
  if (!match) throw new Error(`expected chars locator, got ${locator}`);
  return [Number(match[1]), Number(match[2])];
}

async function assertReplayablePreparedLocator(
  result: ExtractionResult,
  expected: (typeof rawSourceLocatorProfiles)[keyof typeof rawSourceLocatorProfiles],
  store: ReturnType<typeof createInMemoryPreparedArtifactStore>,
) {
  assert.equal(result.error, undefined);
  const artifact = result.preparedArtifact;
  assert.ok(artifact, "every profile returns the complete prepared-artifact identity");
  if (!artifact) throw new Error("expected prepared artifact");
  assert.equal(artifact.preparationMode, expected.preparationMode);
  assert.equal(result.proposals.length, 1);

  const proposal = result.proposals[0];
  const [start, end] = locatorSpan(proposal.provenance.locator);
  const resolution = await resolvePreparedArtifact(artifact, store);
  assert.equal(resolution.status, "available", "the configured store can replay the exact prepared text");
  if (resolution.status === "available") {
    assert.equal(resolution.text.slice(start, end), expected.excerpt);
  }
  assert.equal(proposal.provenance.excerpt, expected.excerpt);
  assert.ok(proposal.provenance.occurrence, "exact occurrence metadata accompanies every replayable span");

  for (const key of expected.forbiddenResultKeys) {
    assert.equal(key in result, false, `${expected.format} does not claim unsupported result metadata: ${key}`);
  }
  for (const key of expected.forbiddenProvenanceKeys) {
    assert.equal(key in proposal.provenance, false, `${expected.format} does not claim unsupported proposal metadata: ${key}`);
  }
}

describe("format-specific raw-source locator profiles (#69)", () => {
  it("HTML grounds excerpts in the replayable prepared artifact, not a DOM or raw-source offset", async () => {
    const profile = rawSourceLocatorProfiles.html;
    const store = createInMemoryPreparedArtifactStore();
    const result = await extract({
      content: profile.content,
      contentType: profile.contentType,
      sourceRef: "fixture:html-profile",
      targetSchema: genericTargetSchema,
      provider: providerFor(profile.excerpt),
      preparedArtifact: { store, sourceSnapshotRef: "snapshot:html-profile" },
    });

    await assertReplayablePreparedLocator(result, profile, store);
    assert.equal(result.preparedArtifact?.sourceSnapshotRef, "snapshot:html-profile");
    assert.equal(result.proposals[0].provenance.locator.startsWith("chars:"), true);
  });

  it("PDF reuses the existing page-offset sidecar without claiming regions, elements, or tables", async () => {
    const profile = rawSourceLocatorProfiles.pdf;
    const store = createInMemoryPreparedArtifactStore();
    const result = await extract({
      content: pdfBytes,
      contentType: profile.contentType,
      pdfTextExtractor: createNaivePdfTextExtractor(),
      sourceRef: "fixture:pdf-profile",
      targetSchema: genericTargetSchema,
      provider: providerFor(profile.excerpt),
      preparedArtifact: { store },
    });

    await assertReplayablePreparedLocator(result, profile, store);
    const [start] = locatorSpan(result.proposals[0].provenance.locator);
    assert.ok(result.pdfPageOffsets, "the existing PDF page-offset sidecar is preserved");
    assert.equal(resolvePdfPage(result.pdfPageOffsets, start), 2);
  });

  it("OCR grounds excerpts in replayable OCR text and marks origin without claiming image regions", async () => {
    const profile = rawSourceLocatorProfiles.ocr;
    const store = createInMemoryPreparedArtifactStore();
    const imageTextExtractor = { extract: async () => ({ text: profile.excerpt }) };
    const result = await extract({
      content: profile.content,
      contentType: profile.contentType,
      imageTextExtractor,
      sourceRef: "fixture:ocr-profile",
      targetSchema: genericTargetSchema,
      provider: providerFor(profile.excerpt),
      preparedArtifact: { store },
    });

    await assertReplayablePreparedLocator(result, profile, store);
    assert.equal(result.ocrDerived, true);
  });
});
