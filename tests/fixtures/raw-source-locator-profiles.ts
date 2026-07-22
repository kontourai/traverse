// Generic, executable profile fixtures for #69. The fidelity and unsupported
// fields are deliberate contract statements: tests prove every retained
// locator replays against its prepared artifact and that no unsupported
// raw-source locator shape escapes the result.

import type { PreparedArtifactPreparationMode } from "../../src/prepared-artifact.js";
import type { ContentType } from "../../src/types.js";

export interface RawSourceLocatorProfileFixture {
  format: "html" | "pdf" | "ocr";
  contentType: ContentType;
  content?: string | Uint8Array;
  excerpt: string;
  preparationMode: PreparedArtifactPreparationMode;
  fidelity: string;
  unsupported: readonly string[];
  forbiddenResultKeys: readonly string[];
  forbiddenProvenanceKeys: readonly string[];
}

export const rawSourceLocatorProfiles = {
  html: {
    format: "html",
    contentType: "html",
    content: "<article><h1>Orbit Walk</h1><p>Activity: Orbit Walk</p></article>",
    excerpt: "Activity: Orbit Walk",
    preparationMode: "markdown",
    fidelity: "exact UTF-16 span in prepared Markdown/text, never raw HTML",
    unsupported: ["DOM path", "CSS selector", "XPath", "raw HTML offsets"],
    forbiddenResultKeys: ["htmlDomPath", "rawSourceOffsets"],
    forbiddenProvenanceKeys: ["domPath", "rawSourceLocator"],
  },
  pdf: {
    format: "pdf",
    contentType: "pdf",
    excerpt: "Section Two: Item counts",
    preparationMode: "pdf-text",
    fidelity: "exact UTF-16 span in parser-produced prepared text",
    unsupported: ["PDF region locator", "bounding box", "typed elements", "table structure"],
    forbiddenResultKeys: ["pdfRegions", "pdfElements", "pdfTables"],
    forbiddenProvenanceKeys: ["pdfRegion", "boundingBox"],
  },
  ocr: {
    format: "ocr",
    contentType: "png",
    content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    excerpt: "Scanned activity: Aurora Loop",
    preparationMode: "image-ocr",
    fidelity: "exact UTF-16 span in injected OCR prepared text",
    unsupported: ["image region", "OCR word coordinates", "confidence map"],
    forbiddenResultKeys: ["ocrRegions", "ocrWordCoordinates", "ocrConfidenceMap"],
    forbiddenProvenanceKeys: ["ocrRegion", "wordCoordinates"],
  },
} as const satisfies Record<"html" | "pdf" | "ocr", RawSourceLocatorProfileFixture>;
