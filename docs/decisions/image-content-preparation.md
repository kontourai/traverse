---
status: current
subject: Image content preparation
decided: 2026-07-07
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/46
  - kind: doc
    ref: docs/decisions/content-preparation.md
  - kind: doc
    ref: docs/decisions/binary-snapshot-bodies.md
---
# Image content preparation

## Decision

Traverse supports PNG and JPEG content through an injected
`ImageTextExtractor`, not through a bundled OCR implementation. The public
seam is `ExtractInput.imageTextExtractor?: ImageTextExtractor`, where
`ImageTextExtractor.extract(bytes)` returns `{ text, warnings? }` as a
Promise. Traverse ships no default OCR, no Tesseract dependency, no vision-model
client, and no optional peer for this path; callers wrap whichever OCR system
they already operate.

With an extractor supplied, `extract()` requires `Uint8Array` image bytes and
runs the extractor before provider calls. The returned OCR text is handed into
the existing text chunking path (`prepareAndChunk(text, "text", ...)`), so
cost guards, chunk warnings, proposal normalization, dedupe, and
`chars:<start>-<end>` locator verification all remain unchanged. A proposal's
excerpt is verified with `indexOf` against the OCR text Traverse handed to the
provider, not against the original image bytes.

With no extractor supplied, image bytes keep the generic binary-content typed
error path: `proposals: []`, zero provider calls, and no OCR marker. This
matches the PDF seam's additive posture: the option unlocks new behavior only
when configured and does not install a new parser or silently invoke external
services.

`ExtractionResult.ocrDerived?: true` is the result-level honesty marker.
Presence, never explicit `false`, mirrors `Snapshot.rendered?: true` and
`Snapshot.bodyBytes?: Uint8Array`. OCR text is inherently lossier than parsed
text, so downstream trust surfaces need a stable way to distinguish proposals
grounded in OCR output even though the ordinary proposal `locator` still uses
the same prepared-text `chars:` contract.

`fetchSource()` resolves `image/png` to `contentType: "png"` and
`image/jpeg`/`image/jpg` to `contentType: "jpeg"`. PNG/JPEG are binary
classified beside PDF, so snapshots capture raw bytes on `bodyBytes`, leave
`body` as `""`, and hash the raw bytes. `fetchAndExtract()` forwards
`imageTextExtractor` and passes `snapshot.bodyBytes ?? snapshot.body` into
`extract()`, so live and replayed image snapshots can flow through OCR without
changing snapshot provenance.

Extractor failures preserve Traverse's never-throw contract. A thrown error,
rejected promise, or non-string `text` result becomes `ExtractionResult.error`
with zero provider calls. Extractor `warnings` are accepted only when they are
an array of strings; malformed warning values are dropped with a warning rather
than partially trusted.

## Boundary

- PNG and JPEG are the minimum supported image content types for this decision.
  Other image formats can be added later by extending the same content-type
  classification and binary snapshot path.
- Traverse does not attempt image region locators, bounding boxes, page-like
  offsets, confidence maps, or OCR word coordinates. Those are different
  locator/sidecar decisions and remain out of scope.
- `prepareContent(bytes, "png" | "jpeg")` remains synchronous and unsupported;
  only `extract()` and `prepareImageText()` run the async OCR seam.
