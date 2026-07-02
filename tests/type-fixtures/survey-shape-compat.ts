// Compile-time survey-shape compatibility fixture.
//
// This file mirrors Survey's own `tests/type-fixtures/*.ts` pattern: it is a
// non-`.test.ts` file that `tsconfig.json`'s `include` picks up, so `tsc` (both
// `npm run typecheck` and `npm run build`) typechecks it on every run, but
// `node --test dist/tests/*.test.js` NEVER runs it (the test glob is `*.test.js`
// only). It makes no runtime assertions.
//
// Its job: prove — at compile time — that Traverse's `ExtractionResult` and
// `ExtractionProposal` can populate Survey's real, published `RawSource` and
// `Extraction` types field-by-field. `@kontourai/survey` is a types-only
// devDependency (never a runtime `dependencies` entry), imported `import type`
// only. If Survey's `Extraction`/`RawSource` shape narrows or drops a field this
// mapping relies on, `tsc` fails here — a real regression signal, not a paper
// claim.
//
// This is the consume-never-fork choice: Survey's actual exported types are the
// compatibility oracle, rather than a hand-mirrored parallel schema.

import type { Extraction, LocatorScheme, RawSource } from "@kontourai/survey";
import type { ExtractionProposal, ExtractionResult } from "../../src/index.js";

/**
 * Map an ExtractionResult onto Survey's RawSource. Traverse's provenance
 * `locator` strings intentionally reuse Survey's `LocatorScheme` vocabulary, so
 * a caller needs no translation table to pick a `locatorScheme`.
 */
export function toRawSource(sourceRef: string, result: ExtractionResult): RawSource {
  const locatorScheme: LocatorScheme = "html";
  return {
    id: `rawsource:${sourceRef}`,
    kind: "web-page",
    sourceRef,
    observedAt: result.extractedAt,
    locatorScheme,
    inlineText: result.raw.response,
    metadata: { model: result.raw.model, tokensUsed: result.raw.tokensUsed },
  };
}

/**
 * Map a single ExtractionProposal onto Survey's Extraction. Every required
 * Extraction field is populated; provenance flows straight through
 * (excerpt/locator), which is why provenance is required on ExtractionProposal.
 */
export function toExtraction(sourceId: string, proposal: ExtractionProposal): Extraction {
  return {
    id: `extraction:${sourceId}:${proposal.fieldPath}`,
    sourceId,
    target: proposal.fieldPath,
    value: proposal.candidateValue,
    confidence: proposal.confidence,
    locator: proposal.provenance.locator,
    excerpt: proposal.provenance.excerpt,
    extractor: proposal.extractor,
    extractedAt: new Date().toISOString(),
  };
}
