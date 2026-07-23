import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { preparePdfText } from "../src/content-prep.js";
import { extract } from "../src/extract.js";
import {
  deserializePortableExtractionResult,
  serializePortableExtractionResult,
} from "../src/extraction-result-envelope.js";
import type {
  ExtractionProvider,
  PdfExtractedText,
  PdfLayout,
  PdfTextExtractor,
} from "../src/types.js";

const text = "Heading\nAlpha value\nBeta value";
const alphaStart = text.indexOf("Alpha value");

const layout = (): PdfLayout => ({
  pages: [
    { pageNumber: 1, width: 612, height: 792, unit: "points" },
  ],
  // Deliberately reversed: preparation normalizes source order.
  elements: [
    {
      kind: "paragraph",
      providerType: "Text",
      pageNumber: 1,
      range: { start: alphaStart, end: alphaStart + "Alpha value".length },
      bounds: { x: 40, y: 90, width: 120, height: 12 },
    },
    {
      kind: "heading",
      providerType: "SectionHeader",
      pageNumber: 1,
      range: { start: 0, end: "Heading".length },
      bounds: { x: 40, y: 40, width: 80, height: 16 },
    },
  ],
  tables: [
    {
      pageNumber: 1,
      bounds: { x: 35, y: 80, width: 250, height: 60 },
      cells: [
        {
          rowIndex: 0,
          columnIndex: 0,
          range: { start: alphaStart, end: alphaStart + "Alpha value".length },
          bounds: { x: 40, y: 90, width: 120, height: 12 },
        },
      ],
    },
  ],
});

const extractor = (result: PdfExtractedText): PdfTextExtractor => ({
  extract: () => result,
});

const provider: ExtractionProvider = {
  name: "layout-fixture",
  async extract() {
    return {
      proposals: [
        {
          fieldPath: "value",
          candidateValue: "Alpha value",
          confidence: 0.8,
          provenance: { excerpt: "Alpha value", locator: "provisional" },
          extractor: "layout-fixture",
        },
      ],
      raw: { response: "{}", model: "fixture" },
    };
  },
};

describe("PDF layout provenance", () => {
  it("validates, orders, and defensively copies layout and tables", async () => {
    const sourceLayout = layout();
    const prepared = await preparePdfText(
      new Uint8Array([1]),
      extractor({ text, pageOffsets: [0], layout: sourceLayout }),
    );

    assert.equal(prepared.warnings.length, 0);
    assert.deepEqual(
      prepared.layout?.elements.map(element => element.kind),
      ["heading", "paragraph"],
    );
    assert.equal(prepared.layout?.tables?.[0].cells[0].range.start, alphaStart);
    assert.notEqual(prepared.layout, sourceLayout);
    sourceLayout.elements[0].range.start = 0;
    assert.equal(prepared.layout?.elements[1].range.start, alphaStart);
  });

  it("drops the whole sidecar when any mapping is not replayable", async () => {
    const malformed = layout();
    malformed.tables![0].cells[0].range.end = text.length + 1;
    const prepared = await preparePdfText(
      new Uint8Array([1]),
      extractor({ text, pageOffsets: [0], layout: malformed }),
    );

    assert.equal(prepared.layout, undefined);
    assert.deepEqual(prepared.warnings, [
      "dropped pdfLayout: malformed or out-of-range layout mapping",
    ]);
  });

  it("threads layout through ExtractionResult with HTML/text locator parity", async () => {
    const pdf = await extract({
      content: new Uint8Array([1]),
      contentType: "pdf",
      sourceRef: "fixture:pdf",
      targetSchema: [{ path: "value", type: "string" }],
      provider,
      pdfTextExtractor: extractor({ text, pageOffsets: [0], layout: layout() }),
    });
    const plain = await extract({
      content: text,
      contentType: "text",
      sourceRef: "fixture:text",
      targetSchema: [{ path: "value", type: "string" }],
      provider,
    });

    const expectedLocator = `chars:${alphaStart}-${alphaStart + "Alpha value".length}`;
    assert.equal(pdf.proposals[0].provenance.locator, expectedLocator);
    assert.equal(plain.proposals[0].provenance.locator, expectedLocator);
    assert.equal(pdf.pdfLayout?.elements[1].range.start, alphaStart);
    assert.equal(pdf.pdfLayout?.tables?.[0].cells[0].range.start, alphaStart);
    const portable = deserializePortableExtractionResult(
      serializePortableExtractionResult(pdf),
    );
    assert.deepEqual(portable.result.pdfLayout, pdf.pdfLayout);
  });
});
