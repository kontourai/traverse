// Test-only PDF text extractor double.
//
// This is a small, regex-based "naive" PDF text extractor good enough to
// parse ONLY tests/fixtures/minimal-two-page.pdf (a hand-crafted, single-
// content-stream-per-page fixture with plain `Tj` text-show operators, no
// compression, no fonts beyond a stock Type1). It is NOT a general-purpose
// PDF parser and must NEVER be imported from `src/` — mirrors the
// "test double, not production code" framing of
// tests/fixtures/mock-provider.ts and tests/fixtures/fake-fetch.ts. A real
// consumer wires its own PdfTextExtractor (e.g. built on pdfjs-dist) per
// src/content-prep.ts `preparePdfText` and docs/decisions/content-preparation.md.

import type { PdfExtractedText, PdfTextExtractor } from "../../src/types.js";

/**
 * Parse each `N 0 obj ... stream ... endstream` content-stream object out of
 * raw PDF bytes, and pull the literal string operands of `Tj`/`TJ` text-show
 * operators out of each one (one PDF page's content stream = one page's text
 * = one `pageOffsets` entry). Deliberately minimal: no cross-reference table
 * parsing, no compression (`/Filter`), no page-object/content-stream
 * association beyond stream discovery order — sufficient only for the
 * fixture's one-content-stream-per-page structure.
 */
function extractStreamTexts(bytes: Uint8Array): string[] {
  const raw = Buffer.from(bytes).toString("latin1");
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  const texts: string[] = [];
  let streamMatch: RegExpExecArray | null;
  while ((streamMatch = streamRe.exec(raw)) !== null) {
    const streamBody = streamMatch[1];
    // Pull literal-string operands of Tj (single string) and TJ (array of
    // strings/numbers) text-show operators, in order, and join with spaces.
    const parts: string[] = [];
    const tjRe = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
    let tjMatch: RegExpExecArray | null;
    while ((tjMatch = tjRe.exec(streamBody)) !== null) {
      parts.push(unescapePdfString(tjMatch[1]));
    }
    const tjArrayRe = /\[((?:[^\[\]]|\\.)*)\]\s*TJ/g;
    let tjArrayMatch: RegExpExecArray | null;
    while ((tjArrayMatch = tjArrayRe.exec(streamBody)) !== null) {
      const inner = tjArrayMatch[1];
      const strRe = /\(((?:[^()\\]|\\.)*)\)/g;
      let strMatch: RegExpExecArray | null;
      const arrayParts: string[] = [];
      while ((strMatch = strRe.exec(inner)) !== null) {
        arrayParts.push(unescapePdfString(strMatch[1]));
      }
      parts.push(arrayParts.join(""));
    }
    if (parts.length > 0) texts.push(parts.join(" "));
  }
  return texts;
}

/** Unescape the handful of PDF literal-string escapes the fixture might use. */
function unescapePdfString(s: string): string {
  return s
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}

/**
 * Factory for the test-only naive PdfTextExtractor. Joins each detected
 * content stream's text with a newline separator, recording each stream's
 * start offset in `pageOffsets` (one stream == one page, matching the
 * fixture's structure).
 */
export function createNaivePdfTextExtractor(): PdfTextExtractor {
  return {
    extract(bytes: Uint8Array): PdfExtractedText {
      const pageTexts = extractStreamTexts(bytes);
      const pageOffsets: number[] = [];
      let text = "";
      for (const pageText of pageTexts) {
        pageOffsets.push(text.length);
        text += pageText + "\n";
      }
      return { text, pageOffsets };
    },
  };
}
