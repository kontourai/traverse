import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { prepareAndChunk } from "../src/chunk.js";
import { extract } from "../src/extract.js";
import { prepareContent } from "../src/content-prep.js";
import type { ExtractionProvider, ProviderExtractionOutput } from "../src/types.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";

const cardsHtml = readFileSync(
  new URL("../../tests/fixtures/repeated-cards-page.html", import.meta.url),
  "utf8",
);

// A provider that proposes one "title" per "Program NN Alpha" it can see in the
// chunk it is handed, grounding each in a verbatim excerpt. Optionally throws on
// a given (1-based) call to model a single failing chunk.
function titleScanProvider(opts: { throwOnCall?: number } = {}): ExtractionProvider & {
  callContents: string[];
} {
  const callContents: string[] = [];
  return {
    name: "title-scan-mock",
    callContents,
    async extract(input): Promise<ProviderExtractionOutput> {
      callContents.push(input.content);
      if (opts.throwOnCall === callContents.length) {
        throw new Error(`boom on call ${callContents.length}`);
      }
      const proposals = [];
      const re = /Program \d+ Alpha/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(input.content)) !== null) {
        proposals.push({
          fieldPath: "title",
          candidateValue: m[0],
          confidence: 0.9,
          provenance: { excerpt: m[0], locator: "provisional" },
          extractor: "title-scan-mock",
        });
      }
      return { proposals, raw: { response: "{}", model: "mock" } };
    },
  };
}

// A provider that proposes a fixed "title" whenever `marker` occurs in the chunk.
function markerProvider(marker: string): ExtractionProvider {
  return {
    name: "marker-mock",
    async extract(input): Promise<ProviderExtractionOutput> {
      const proposals = [];
      if (input.content.includes(marker)) {
        proposals.push({
          fieldPath: "title",
          candidateValue: marker,
          confidence: 0.8,
          provenance: { excerpt: marker, locator: "provisional" },
          extractor: "marker-mock",
        });
      }
      return { proposals, raw: { response: "{}", model: "mock" } };
    },
  };
}

describe("prepareAndChunk (structural)", () => {
  it("chunks a repeated-card page larger than one chunk on card boundaries, with exact offsets", () => {
    const r = prepareAndChunk(cardsHtml, "html", { chunkSize: 400 });
    assert.equal(r.structural, true);
    assert.equal(r.cardCount, 12);
    assert.ok(r.chunks.length > 1, "splits into more than one chunk");
    assert.equal(r.truncatedChunks, 0);
    // every chunk is an exact contiguous substring of fullText...
    assert.ok(r.chunks.every((c) => r.fullText.slice(c.start, c.end) === c.text));
    // ...and offsets are contiguous across the fixed separator (no gaps/overlap).
    for (let i = 1; i < r.chunks.length; i++) {
      assert.equal(r.chunks[i].start, r.chunks[i - 1].end + 2);
    }
    // all 12 cards survive chunking (none lost across a boundary)
    for (let i = 1; i <= 12; i++) {
      const title = `Program ${String(i).padStart(2, "0")} Alpha`;
      assert.ok(r.fullText.includes(title), `${title} present`);
    }
  });

  it("caps chunk count at maxChunks and reports the truncation", () => {
    const r = prepareAndChunk(cardsHtml, "html", { chunkSize: 400, maxChunks: 2 });
    assert.equal(r.chunks.length, 2);
    assert.ok(r.truncatedChunks > 0);
  });
});

describe("markdown prep", () => {
  it("preserves link hrefs (default markdown for html)", () => {
    const { text } = prepareContent(cardsHtml, "html");
    assert.match(text ?? "", /\]\(https:\/\/example\.test\/apply\/01\)/);
  });

  it("prep:'text' escape hatch strips hrefs (legacy behavior) and finds no structure", () => {
    const { text } = prepareContent(cardsHtml, "html", 32_000, "text");
    assert.doesNotMatch(text ?? "", /example\.test\/apply/);
    const r = prepareAndChunk(cardsHtml, "html", { prep: "text", chunkSize: 400 });
    assert.equal(r.structural, false);
  });
});

describe("prepareAndChunk (character-window fallback)", () => {
  it("windows unstructured text with overlap", () => {
    const r = prepareAndChunk("X".repeat(1000), "text", { chunkSize: 100, chunkOverlap: 20 });
    assert.equal(r.structural, false);
    assert.ok(r.chunks.length > 1);
    assert.equal(r.chunks[0].start, 0);
    assert.equal(r.chunks[0].end, 100);
    // step = chunkSize - overlap = 80
    assert.equal(r.chunks[1].start, 80);
    assert.ok(r.chunks.every((c) => r.fullText.slice(c.start, c.end) === c.text));
  });
});

describe("extract() chunked path", () => {
  it("adjusts locators to the full prepared text (non-zero offset from a later chunk)", async () => {
    const chunkSize = 400;
    const prepared = prepareAndChunk(cardsHtml, "html", { chunkSize });
    const provider = titleScanProvider();
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize,
    });

    assert.equal(result.error, undefined);
    // all 12 distinct cards proposed (nothing dropped at chunk boundaries)
    const titles = new Set(result.proposals.map((p) => p.candidateValue));
    assert.equal(titles.size, 12);

    // a card in a later chunk carries a correct, non-zero locator into fullText
    const p12 = result.proposals.find((p) => p.candidateValue === "Program 12 Alpha");
    assert.ok(p12, "Program 12 was proposed");
    const idx = prepared.fullText.indexOf("Program 12 Alpha");
    assert.ok(idx > 0, "later card sits at a non-zero offset");
    assert.equal(p12!.provenance.locator, `chars:${idx}-${idx + "Program 12 Alpha".length}`);

    // structural chunk-count warning is surfaced
    assert.ok(
      result.warnings?.some((w) =>
        /chunked into \d+ chunks by repeated-card structure \(12 cards detected\)/.test(w),
      ),
    );
  });

  it("dedupes an identical proposal produced from two overlapping windows", async () => {
    // "MARKER" at offset 85 sits fully inside the overlap [80,100] of windows
    // [0,100] and [80,180], so both chunks see it.
    const content = "A".repeat(85) + "MARKER" + "B".repeat(200);
    const result = await extract({
      content,
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider: markerProvider("MARKER"),
      chunkSize: 100,
      chunkOverlap: 20,
    });
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].provenance.locator, "chars:85-91");
    assert.ok(result.warnings?.some((w) => /dropped 1 duplicate proposal \(same field \+ source span\)/.test(w)));
  });

  it("keeps two distinct records that share a value but come from different spans", async () => {
    // Two cards with the SAME title text at DIFFERENT offsets must both survive:
    // dedup keys on the verified source span, not the value alone.
    const content = "Alpha Program here. Then later, Alpha Program again.";
    const first = content.indexOf("Alpha Program");
    const second = content.indexOf("Alpha Program", first + 1);
    assert.ok(second > first, "value genuinely repeats at two spans");

    const provider: ExtractionProvider = {
      name: "two-span-mock",
      async extract(input): Promise<ProviderExtractionOutput> {
        // propose the same value grounded at each occurrence's excerpt
        return {
          proposals: [
            {
              fieldPath: "title",
              candidateValue: "Alpha Program",
              confidence: 0.7,
              provenance: { excerpt: "Alpha Program here", locator: "provisional" },
              extractor: "two-span-mock",
            },
            {
              fieldPath: "title",
              candidateValue: "Alpha Program",
              confidence: 0.7,
              provenance: { excerpt: "Alpha Program again", locator: "provisional" },
              extractor: "two-span-mock",
            },
          ],
          raw: { response: "{}", model: "mock" },
        };
      },
    };

    const result = await extract({
      content,
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.proposals.length, 2, "both distinct-span records survive");
    assert.ok(!result.warnings?.some((w) => /duplicate/.test(w)));
  });

  it("overlap rescues a value straddling a hard window boundary (not lost, not duplicated)", async () => {
    // "MARKER" at 96..102 straddles boundary 100: with no overlap it would split
    // across [0,100] and [100,200] and be lost; overlap 20 makes window [80,180]
    // contain it whole, exactly once.
    const content = "A".repeat(96) + "MARKER" + "B".repeat(120);
    const result = await extract({
      content,
      contentType: "text",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider: markerProvider("MARKER"),
      chunkSize: 100,
      chunkOverlap: 20,
    });
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].provenance.locator, "chars:96-102");
    assert.ok(!result.warnings?.some((w) => /duplicate/.test(w)));
  });

  it("a proposal that throws during normalization does not discard earlier chunks' results", async () => {
    // The provider "succeeds" on every chunk, but on the 2nd chunk it returns a
    // proposal whose fieldPath getter throws. Earlier collected proposals must
    // survive (partial-results guarantee), and extract() must not throw or error.
    let call = 0;
    const provider: ExtractionProvider = {
      name: "throwing-getter-mock",
      async extract(input): Promise<ProviderExtractionOutput> {
        call++;
        if (call === 2) {
          const booby = {
            get fieldPath(): string {
              throw new Error("boom in getter");
            },
            candidateValue: "x",
            confidence: 0.9,
            provenance: { excerpt: "x", locator: "provisional" },
            extractor: "throwing-getter-mock",
          };
          return { proposals: [booby as never], raw: { response: "{}", model: "mock" } };
        }
        const proposals = [];
        const re = /Program \d+ Alpha/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(input.content)) !== null) {
          proposals.push({
            fieldPath: "title",
            candidateValue: m[0],
            confidence: 0.9,
            provenance: { excerpt: m[0], locator: "provisional" },
            extractor: "throwing-getter-mock",
          });
        }
        return { proposals, raw: { response: "{}", model: "mock" } };
      },
    };

    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: 400,
    });
    assert.equal(result.error, undefined);
    assert.ok(result.proposals.length > 0, "earlier chunks' proposals survived");
    assert.ok(result.warnings?.some((w) => /chunk 2\/\d+ normalization failed: boom in getter/.test(w)));
  });

  it("a provider error on one chunk does not kill the others (partial results + warning)", async () => {
    const provider = titleScanProvider({ throwOnCall: 2 });
    const result = await extract({
      content: cardsHtml,
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: 400,
    });
    // not fatal: the surviving chunks still produced proposals
    assert.equal(result.error, undefined);
    assert.ok(result.proposals.length > 0, "surviving chunks produced proposals");
    assert.ok(result.proposals.length < 12, "the failed chunk's cards are missing");
    assert.ok(
      result.warnings?.some((w) => /chunk 2\/\d+ provider call failed: boom on call 2/.test(w)),
    );
  });
});
