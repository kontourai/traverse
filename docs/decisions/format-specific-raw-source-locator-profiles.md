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
| PDF page boundary | `ExtractionResult.pdfPageOffsets` sidecar | Parser-supplied page starts resolve an already-verified character offset to a one-based page. |
| PDF page geometry, elements, and tables | `ExtractionResult.pdfLayout` sidecar | Exact prepared-text ranges connect proposals to validated page boxes and structured cells without inventing a raw-PDF locator. |
| OCR origin | Existing `ExtractionResult.ocrDerived` marker | It honestly marks that the prepared artifact is OCR text while retaining the same exact prepared-text locator. |

No HTML DOM path is emitted: HTML-to-Markdown preparation and its documented
text fallback are not a stable DOM-to-prepared-text mapping. PDF layout is
accepted only when every element and table cell supplies an in-range exact
prepared-text span; shape-only geometry is dropped. No OCR region,
word-coordinate, or confidence-map data is emitted: the injected OCR seam
returns text and warnings only, so such coordinates cannot be replayed from
Traverse's prepared artifact.

## Executable profiles

The generic fixtures in `tests/raw-source-locator-profiles.test.ts` pin these
profiles without a parser, browser, or OCR dependency.

| Format | Locator fidelity | Existing sidecar | Explicitly unsupported |
| --- | --- | --- | --- |
| HTML | Exact UTF-16 span in the prepared Markdown/text artifact, never a raw HTML byte/character span | None | DOM path, CSS selector, XPath, raw-source offsets |
| PDF | Exact UTF-16 span in parser-produced prepared text | `pdfPageOffsets` resolves the span start to a page; `pdfLayout` maps exact ranges to optional boxes, typed elements, and structured table cells | raw-PDF byte offsets, inferred geometry |
| OCR image | Exact UTF-16 span in injected OCR prepared text | `ocrDerived: true` | image region, OCR word coordinates, confidence map |

Each profile resolves the returned prepared artifact and proves that its
`chars:` span slices to the emitted excerpt. The PDF profile reuses the
existing two-page fixture, test-only extractor, `pdfPageOffsets`, and
`resolvePdfPage()` rather than adding duplicate geometry metadata.

## Boundaries and follow-up

- Promote the documented profile boundary and its executable replay checks;
  no public API or export changes are required.
- PDF geometry, element typing, and table structure use exact ranges in the
  prepared artifact. The executable PDF/text parity fixture proves the same
  excerpt yields the same verified locator in either path.
- Confidence remains an extractor signal, never provenance or a truth
  decision. Calibration from human review outcomes belongs to Survey; Traverse
  preserves the extractor identity and score without inventing cross-provider
  equivalence.
- Reject a universal raw-to-prepared map for current HTML, PDF, and OCR seams.
  Preparation can alter, omit, or synthesize text, and callers own the parser
  and OCR implementations. Claiming raw grounding without a replayable mapping
  would overstate Traverse's evidence.
