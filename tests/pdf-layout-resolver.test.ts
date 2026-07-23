import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePdfLayoutSpan } from "../src/pdf-layout.js";
import type { PdfLayout } from "../src/types.js";

const layout: PdfLayout = {
  elements: [
    {
      kind: "paragraph",
      pageNumber: 1,
      range: { start: 10, end: 20 },
    },
    {
      kind: "paragraph",
      pageNumber: 1,
      range: { start: 30, end: 40 },
    },
  ],
  tables: [
    {
      pageNumber: 2,
      cells: [
        {
          rowIndex: 1,
          columnIndex: 2,
          rowSpan: 2,
          columnSpan: 1,
          range: { start: 50, end: 60 },
        },
      ],
    },
  ],
};

describe("resolvePdfLayoutSpan", () => {
  it("uses exclusive-end overlap at exact boundaries", () => {
    assert.equal(resolvePdfLayoutSpan(layout, "chars:0-10").status, "not-found");
    const match = resolvePdfLayoutSpan(layout, "chars:19-30");
    assert.equal(match.status, "matched");
    if (match.status === "matched") {
      assert.deepEqual(match.elements.map(element => element.range), [
        { start: 10, end: 20 },
      ]);
    }
  });

  it("retains table page, index, row, column, and spans", () => {
    const match = resolvePdfLayoutSpan(layout, "chars:52-55");
    assert.equal(match.status, "matched");
    if (match.status === "matched") {
      assert.deepEqual(match.tableCells, [
        {
          pageNumber: 2,
          tableIndex: 0,
          cell: {
            rowIndex: 1,
            columnIndex: 2,
            rowSpan: 2,
            columnSpan: 1,
            range: { start: 50, end: 60 },
          },
        },
      ]);
    }
  });

  it("returns typed failures for unsupported and malformed locators", () => {
    assert.deepEqual(resolvePdfLayoutSpan(layout, "pdf:1:10-20"), {
      status: "invalid-locator",
      reason: "unsupported-scheme",
    });
    for (const locator of [
      "chars:",
      "chars:1",
      "chars:-1-2",
      "chars:02-3",
      "chars:3-3",
      "chars:4-3",
      `chars:0-${Number.MAX_SAFE_INTEGER}0`,
    ]) {
      assert.deepEqual(resolvePdfLayoutSpan(layout, locator), {
        status: "invalid-locator",
        reason: "malformed-range",
      });
    }
  });

  it("resolves repeated excerpts independently by exact locator", () => {
    const first = resolvePdfLayoutSpan(layout, "chars:12-15");
    const second = resolvePdfLayoutSpan(layout, "chars:32-35");
    assert.equal(first.status, "matched");
    assert.equal(second.status, "matched");
    if (first.status === "matched" && second.status === "matched") {
      assert.notDeepEqual(first.elements[0].range, second.elements[0].range);
    }
  });
});
