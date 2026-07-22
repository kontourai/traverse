---
status: current
subject: Format-specific Locator Profile
decided: 2026-07-22
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/69
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/25
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/33
  - kind: doc
    ref: docs/decisions/prepared-artifact.md
  - kind: doc
    ref: docs/decisions/exact-occurrence-resolution.md
  - kind: doc
    ref: tests/raw-source-locator-profiles.test.ts
---

# Format-specific raw-source locator profiles

## Decision

**NARROW #69.** Traverse does not introduce a raw-source locator, a universal
raw-to-prepared offset map, or a richer cross-format proposal locator. Each
format continues to use the one replayable proposal locator:
`chars:<start>-<end>` in the complete prepared artifact.

The metadata belongs at the boundary where it can be replayed and verified:

| Metadata | Owner | Rationale |
| --- | --- | --- |
| Prepared-text digest, preparation mode/version, length, and optional source snapshot reference | `PreparedArtifact` | Identifies the exact complete text that a `chars:` span addresses; resolving it verifies text, length, and digest before a consumer treats it as available. A snapshot reference identifies caller-owned capture, not a raw-to-prepared offset map. |
| `chars:` locator and exact occurrence selection | `ExtractionProposal.provenance` | The excerpt is matched exactly in the provider-visible prepared-text slice and the selected span can be replayed against the complete prepared artifact. |
| PDF page boundary | Existing `ExtractionResult.pdfPageOffsets` sidecar | The existing parser-supplied page starts resolve an already-verified character offset to a one-based page. They remain a structurally validated, trust-not-verify sidecar, not a new proposal locator. |
| OCR origin | Existing `ExtractionResult.ocrDerived` marker | It honestly marks that the prepared artifact is OCR text while retaining the same exact prepared-text locator. |

No HTML DOM path is emitted: HTML-to-Markdown preparation and its documented
text fallback are not a stable DOM-to-prepared-text mapping. No PDF region,
element, or table data is emitted here: those optional parser enrichments
remain the additive scope of #25, and must define their own replayable
format-specific contract before they can ground a proposal. No OCR region,
word-coordinate, or confidence-map data is emitted: the injected OCR seam
returns text and warnings only, so such coordinates cannot be replayed from
Traverse's prepared artifact.

## Executable profiles

The generic fixtures in `tests/raw-source-locator-profiles.test.ts` pin these
profiles without a parser, browser, or OCR dependency.

| Format | Locator fidelity | Existing sidecar | Explicitly unsupported |
| --- | --- | --- | --- |
| HTML | Exact UTF-16 span in the prepared Markdown/text artifact, never a raw HTML byte/character span | None | DOM path, CSS selector, XPath, raw-source offsets |
| PDF | Exact UTF-16 span in parser-produced prepared text | `pdfPageOffsets` resolves the span start to a page | PDF region/bounding-box locator, typed elements, table structure |
| OCR image | Exact UTF-16 span in injected OCR prepared text | `ocrDerived: true` | image region, OCR word coordinates, confidence map |

Each profile resolves the returned prepared artifact and proves that its
`chars:` span slices to the emitted excerpt. The PDF profile reuses the
existing two-page fixture, test-only extractor, `pdfPageOffsets`, and
`resolvePdfPage()` rather than adding duplicate geometry metadata.

## Boundaries and follow-up

- Promote the documented profile boundary and its executable replay checks;
  no public API or export changes are required.
- Keep #25 open for optional PDF geometry, element typing, and table
  structure. Any future extension must state how its coordinates and its
  relationship to the prepared artifact can be replayed; a shape-only parser
  claim is insufficient grounding.
- Keep #33 open for the broader cross-provider provenance-quality work. This
  decision deliberately does not claim HTML/PDF raw-offset parity or
  confidence calibration.
- Reject a universal raw-to-prepared map for current HTML, PDF, and OCR seams.
  Preparation can alter, omit, or synthesize text, and callers own the parser
  and OCR implementations. Claiming raw grounding without a replayable mapping
  would overstate Traverse's evidence.
