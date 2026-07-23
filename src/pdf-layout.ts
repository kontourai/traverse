import type {
  PdfLayout,
  PdfTableCell,
  PdfTextElement,
  PdfTextRange,
} from "./types.js";

export interface ResolvedPdfTableCell {
  pageNumber: number;
  tableIndex: number;
  cell: PdfTableCell;
}

export type PdfLayoutSpanResolution =
  | {
      status: "matched" | "not-found";
      span: PdfTextRange;
      elements: readonly PdfTextElement[];
      tableCells: readonly ResolvedPdfTableCell[];
    }
  | {
      status: "invalid-locator";
      reason: "unsupported-scheme" | "malformed-range";
    };

const overlaps = (left: PdfTextRange, right: PdfTextRange): boolean =>
  left.start < right.end && right.start < left.end;

/**
 * Resolve one exact proposal locator against a validated PDF layout sidecar.
 *
 * Ranges use exclusive ends, matching JavaScript slice() and Traverse's
 * `chars:<start>-<end>` contract. Boundary-touching ranges do not overlap.
 */
export function resolvePdfLayoutSpan(
  layout: PdfLayout,
  locator: string,
): PdfLayoutSpanResolution {
  if (!locator.startsWith("chars:")) {
    return Object.freeze({
      status: "invalid-locator",
      reason: "unsupported-scheme",
    });
  }
  const match = /^chars:(0|[1-9]\d*)-(0|[1-9]\d*)$/.exec(locator);
  if (!match) {
    return Object.freeze({
      status: "invalid-locator",
      reason: "malformed-range",
    });
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    return Object.freeze({
      status: "invalid-locator",
      reason: "malformed-range",
    });
  }
  const span = Object.freeze({ start, end });
  const elements = Object.freeze(
    layout.elements.filter(element => overlaps(element.range, span)),
  );
  const tableCells = Object.freeze(
    (layout.tables ?? []).flatMap((table, tableIndex) =>
      table.cells
        .filter(cell => overlaps(cell.range, span))
        .map(cell =>
          Object.freeze({
            pageNumber: table.pageNumber,
            tableIndex,
            cell,
          }),
        ),
    ),
  );
  return Object.freeze({
    status: elements.length > 0 || tableCells.length > 0
      ? "matched"
      : "not-found",
    span,
    elements,
    tableCells,
  });
}
