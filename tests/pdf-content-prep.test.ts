// End-to-end PDF content-prep tests: the opt-in PdfTextExtractor seam
// composing through extract()'s EXISTING chunk/provider/provenance
// pipeline — no PDF-specific chunking or verification code exists to test
// separately (see src/content-prep.ts preparePdfText, src/extract.ts's pdf
// pre-step, docs/decisions/content-preparation.md).
//
// Covers:
//  - AC4: default-unchanged regression (no pdfTextExtractor supplied).
//  - AC2/AC3: end-to-end offset fidelity + page resolution, against the real
//    hand-crafted fixture PDF (tests/fixtures/minimal-two-page.pdf) and the
//    test-only naive extractor double (tests/fixtures/naive-pdf-text-extractor.ts).
//  - AC2/AC6: character-window chunking composition and cost-guard
//    composition against pdf-sourced, multi-chunk text — proving PDF content
//    reuses the EXISTING chunker/cost-guard loop with zero new code.
//  - AC5: never-throw for a synchronously-throwing and a Promise-rejecting
//    extractor.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { extract } from "../src/extract.js";
import { PDF_PREP_ERROR, pdfBytesRequiredError, resolvePdfPage } from "../src/content-prep.js";
import type { PdfTextExtractor } from "../src/types.js";
import { createMockExtractionProvider, createRegexScanProvider } from "./fixtures/mock-provider.js";
import { createNaivePdfTextExtractor } from "./fixtures/naive-pdf-text-extractor.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";

const fixtureBytes = readFileSync(new URL("../../tests/fixtures/minimal-two-page.pdf", import.meta.url));

describe("extract() pdf — default unchanged (AC4)", () => {
  it("with no pdfTextExtractor, contentType 'pdf' returns the exact pre-existing PDF_PREP_ERROR, byte-identical to 0.8.0", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
    const result = await extract({
      content: fixtureBytes,
      contentType: "pdf",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    // Exact string equality against the pre-existing export, not a loose
    // substring match — this is what pins byte-identical 0.8.0 behavior.
    assert.equal(result.error, PDF_PREP_ERROR);
    assert.deepEqual(result.proposals, []);
    assert.equal(result.providerCalls, 0);
    assert.equal(result.totalTokensUsed, 0);
    assert.equal(provider.calls.length, 0);
  });
});

describe("extract() pdf — end-to-end with the real fixture + the naive extractor (AC2, AC3)", () => {
  it("produces a chars:<start>-<end> proposal that round-trips against the pdf-derived text, and resolves to the correct page", async () => {
    const extractor = createNaivePdfTextExtractor();
    // Independently reconstruct the expected prepared text/pageOffsets (the
    // naive extractor is pure) so this test's expectations are derived from
    // the fixture, not hard-coded against extract()'s internals.
    const expected = await extractor.extract(fixtureBytes);
    const excerpt = "Section Two: Item counts";
    assert.ok(
      expected.text.includes(excerpt),
      "fixture sanity: page 2's known text is present in the naive extractor's output",
    );
    const expectedStart = expected.text.indexOf(excerpt);

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
      content: fixtureBytes,
      contentType: "pdf",
      pdfTextExtractor: extractor,
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });

    assert.equal(result.error, undefined);
    assert.equal(result.proposals.length, 1);
    const proposal = result.proposals[0];
    assert.match(proposal.provenance.locator, /^chars:\d+-\d+$/);
    const match = proposal.provenance.locator.match(/^chars:(\d+)-(\d+)$/) as RegExpMatchArray;
    const start = Number(match[1]);
    const end = Number(match[2]);
    assert.equal(start, expectedStart, "locator start matches the offset in the independently-derived pdf text");
    assert.equal(expected.text.slice(start, end), excerpt, "fullText.slice(start, end) === excerpt (offset fidelity)");

    assert.deepEqual(result.pdfPageOffsets, expected.pageOffsets);
    assert.equal(resolvePdfPage(result.pdfPageOffsets, start), 2, "the excerpt's known source page (page 2)");
  });
});

// Synthetic multi-chunk pdf-sourced text: 8 blocks of exactly BLOCK_SIZE
// characters, each starting with a distinct "Program NN Alpha" match (the
// same pattern tests/cost-guard.test.ts and tests/chunking.test.ts scan for
// via the shared createRegexScanProvider fixture) followed by filler padding.
// With chunkSize = BLOCK_SIZE and chunkOverlap = 0, the character-window
// chunker's windows land EXACTLY on block boundaries (step === chunkSize),
// so this deterministically produces ITEM_COUNT chunks, each with exactly
// one match, no overlap/dedup interplay to reason about.
const BLOCK_SIZE = 300;
const ITEM_COUNT = 8;

function makeSyntheticPdfText(): string {
  let text = "";
  for (let i = 1; i <= ITEM_COUNT; i++) {
    const item = `Program ${String(i).padStart(2, "0")} Alpha`;
    text += item + "x".repeat(BLOCK_SIZE - item.length);
  }
  return text;
}

function createSyntheticExtractor(): PdfTextExtractor {
  const text = makeSyntheticPdfText();
  return { extract: () => ({ text }) };
}

describe("extract() pdf — chunking composition reuses the EXISTING character-window chunker (AC2, AC6)", () => {
  it("chunks pdf-sourced text into multiple windows and warns using the existing chunking message format, with zero new pdf-specific chunking code", async () => {
    const provider = createRegexScanProvider();
    const result = await extract({
      content: new Uint8Array([1]),
      contentType: "pdf",
      pdfTextExtractor: createSyntheticExtractor(),
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: BLOCK_SIZE,
      chunkOverlap: 0,
    });
    assert.equal(result.error, undefined);
    assert.equal(provider.callContents.length, ITEM_COUNT);
    assert.equal(result.proposals.length, ITEM_COUNT);
    assert.ok(
      result.warnings?.some((w) => w === `chunked into ${ITEM_COUNT} chunks by character window`),
      `expected the existing chunking-into-N-chunks warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });
});

describe("extract() pdf — cost-guard composition (AC6)", () => {
  it("maxProviderCalls stops issuing further calls against pdf-sourced, multi-chunk prepared text, same as html/text today", async () => {
    const provider = createRegexScanProvider();
    const result = await extract({
      content: new Uint8Array([1]),
      contentType: "pdf",
      pdfTextExtractor: createSyntheticExtractor(),
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: BLOCK_SIZE,
      chunkOverlap: 0,
      maxProviderCalls: 1,
    });
    assert.equal(result.error, undefined);
    assert.equal(provider.callContents.length, 1, "exactly one call was issued, not the natural 8");
    assert.equal(result.providerCalls, 1);
    assert.equal(result.proposals.length, 1, "proposals reflect only the first chunk");
    assert.equal(result.proposals[0].candidateValue, "Program 01 Alpha");
    assert.ok(
      result.warnings?.some(
        (w) =>
          w === `stopped after 1 provider call(s): maxProviderCalls (1) reached; ${ITEM_COUNT - 1} chunk(s) not processed`,
      ),
      `expected ceiling warning, got: ${JSON.stringify(result.warnings)}`,
    );
  });
});

describe("extract() pdf — never-throws (AC5)", () => {
  it("an extractor that throws synchronously surfaces as ExtractionResult.error; extract() itself never throws", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
    const throwingExtractor: PdfTextExtractor = {
      extract: () => {
        throw new Error("sync boom");
      },
    };
    let result: Awaited<ReturnType<typeof extract>> | undefined;
    try {
      result = await extract({
        content: new Uint8Array([1]),
        contentType: "pdf",
        pdfTextExtractor: throwingExtractor,
        sourceRef: "ref",
        targetSchema: genericTargetSchema,
        provider,
      });
    } catch {
      assert.fail("extract() must never throw, even when the injected extractor throws synchronously");
    }
    assert.equal(result?.error, "pdf text extraction failed: sync boom");
    assert.deepEqual(result?.proposals, []);
    assert.equal(result?.providerCalls, 0);
    assert.equal(result?.totalTokensUsed, 0);
  });

  it("an extractor that returns a rejected Promise surfaces as ExtractionResult.error; extract() itself never throws", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
    const rejectingExtractor: PdfTextExtractor = {
      extract: () => Promise.reject(new Error("async boom")),
    };
    let result: Awaited<ReturnType<typeof extract>> | undefined;
    try {
      result = await extract({
        content: new Uint8Array([1]),
        contentType: "pdf",
        pdfTextExtractor: rejectingExtractor,
        sourceRef: "ref",
        targetSchema: genericTargetSchema,
        provider,
      });
    } catch {
      assert.fail("extract() must never throw, even when the injected extractor returns a rejected Promise");
    }
    assert.equal(result?.error, "pdf text extraction failed: async boom");
    assert.deepEqual(result?.proposals, []);
    assert.equal(result?.providerCalls, 0);
    assert.equal(result?.totalTokensUsed, 0);
  });
});


describe("extract() pdf — bytes required when an extractor is supplied (MEDIUM finding regression)", () => {
  it("with a pdfTextExtractor supplied but string (not Uint8Array) content, returns the exact pdfBytesRequiredError() message; extract() never throws and issues zero provider calls", async () => {
    // Pins src/extract.ts:142-151 — the "string content + extractor supplied"
    // branch flagged as untested in review-code.md's MEDIUM finding.
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "mock" } });
    const extractor = createNaivePdfTextExtractor();
    let result: Awaited<ReturnType<typeof extract>> | undefined;
    try {
      result = await extract({
        content: "not bytes, a plain string",
        contentType: "pdf",
        pdfTextExtractor: extractor,
        sourceRef: "ref",
        targetSchema: genericTargetSchema,
        provider,
      });
    } catch {
      assert.fail(
        "extract() must never throw when contentType is 'pdf', a pdfTextExtractor is supplied, and content is a string",
      );
    }
    // Exact string equality against the typed error helper, not a loose
    // substring match — mirrors the AC4 test's PDF_PREP_ERROR pinning style.
    assert.equal(result?.error, pdfBytesRequiredError());
    assert.deepEqual(result?.proposals, []);
    assert.equal(result?.providerCalls, 0);
    assert.equal(result?.totalTokensUsed, 0);
    assert.equal(provider.calls.length, 0);
  });
});
