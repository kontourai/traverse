// End-to-end image content-prep tests: the opt-in ImageTextExtractor seam
// composing through extract()'s existing chunk/provider/provenance pipeline.
// Uses a stub OCR extractor only; Traverse must not ship an OCR dependency.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extract } from "../src/extract.js";
import type { ImageTextExtractor } from "../src/types.js";
import { createMockExtractionProvider, createRegexScanProvider } from "./fixtures/mock-provider.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const ocrText = "Generic receipt total 42\nProgram 01 Alpha";

function createStubImageTextExtractor(
  text = ocrText,
  warnings: string[] = ["ocr confidence below review threshold"],
): ImageTextExtractor & { calls: Uint8Array[] } {
  const calls: Uint8Array[] = [];
  return {
    calls,
    async extract(bytes: Uint8Array) {
      calls.push(bytes);
      return { text, warnings };
    },
  };
}

describe("extract() image — default unchanged", () => {
  it("with no imageTextExtractor, contentType 'png' returns a typed binary prep error and issues zero provider calls", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
    const result = await extract({
      content: pngBytes,
      contentType: "png",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });

    assert.equal(result.error, 'binary content is not supported for contentType "png"; provide a string');
    assert.deepEqual(result.proposals, []);
    assert.equal(result.providerCalls, 0);
    assert.equal(result.totalTokensUsed, 0);
    assert.equal(provider.calls.length, 0);
    assert.equal(result.ocrDerived, undefined);
  });
});

describe("extract() image — OCR seam", () => {
  it("hands image bytes to the injected extractor, verifies proposals against OCR text, and marks the result as OCR-derived", async () => {
    const imageTextExtractor = createStubImageTextExtractor();
    const excerpt = "Generic receipt total 42";
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

    const result = await extract({
      content: pngBytes,
      contentType: "png",
      imageTextExtractor,
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });

    assert.equal(result.error, undefined);
    assert.deepEqual(imageTextExtractor.calls, [pngBytes]);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].content, ocrText);
    assert.equal(result.ocrDerived, true);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].provenance.locator, `chars:0-${excerpt.length}`);
    assert.ok(
      result.warnings?.some((w) => w === "ocr confidence below review threshold"),
      `expected extractor warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  it("chunks OCR text through the existing character-window chunker and cost guard", async () => {
    const text = Array.from({ length: 4 }, (_, i) => {
      const item = `Program ${String(i + 1).padStart(2, "0")} Alpha`;
      return item + "x".repeat(80 - item.length);
    }).join("");
    const provider = createRegexScanProvider();
    const result = await extract({
      content: new Uint8Array([1]),
      contentType: "jpeg",
      imageTextExtractor: createStubImageTextExtractor(text, []),
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: 80,
      chunkOverlap: 0,
      maxProviderCalls: 1,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.ocrDerived, true);
    assert.equal(provider.callContents.length, 1);
    assert.equal(result.providerCalls, 1);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].candidateValue, "Program 01 Alpha");
    assert.ok(
      result.warnings?.some(
        (w) => w === "stopped after 1 provider call(s): maxProviderCalls (1) reached; 3 chunk(s) not processed",
      ),
      `expected ceiling warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });

  it("requires Uint8Array when an imageTextExtractor is supplied", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
    const result = await extract({
      content: "not bytes",
      contentType: "png",
      imageTextExtractor: createStubImageTextExtractor(),
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });

    assert.equal(result.error, "image content-prep requires Uint8Array (bytes), not a string");
    assert.deepEqual(result.proposals, []);
    assert.equal(result.providerCalls, 0);
    assert.equal(provider.calls.length, 0);
  });

  it("surfaces extractor failures as ExtractionResult.error and never calls the provider", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
    const imageTextExtractor: ImageTextExtractor = {
      async extract() {
        throw new Error("ocr boom");
      },
    };

    const result = await extract({
      content: pngBytes,
      contentType: "png",
      imageTextExtractor,
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });

    assert.equal(result.error, "image text extraction failed: ocr boom");
    assert.deepEqual(result.proposals, []);
    assert.equal(result.providerCalls, 0);
    assert.equal(provider.calls.length, 0);
    assert.equal(result.ocrDerived, undefined);
  });
});

describe("extract() image — OCR marker absence", () => {
  it("does not mark ordinary text extraction as OCR-derived", async () => {
    const excerpt = "Plain text source";
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

    const result = await extract({
      content: excerpt,
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.ocrDerived, undefined);
  });
});
