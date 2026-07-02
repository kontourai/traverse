# Parity methodology (for a consumer-adoption slice)

This document specifies how a follow-up "consumer-adoption" slice should prove
that routing a real consumer's extraction path through `@kontourai/traverse`
preserves that consumer's existing behavior. It is written consumer-agnostically
on purpose: it names Traverse's own surfaces, and leaves the concrete file/line
citations of the adopting application to the slice that has that repository in
hand.

Traverse surfaces a slice must exercise:

- `extract()` — the top-level orchestration (`content-prep -> provider ->
  normalize`).
- `createAnthropicExtractionProvider()` — the live provider adapter (subpath
  `@kontourai/traverse/anthropic`).
- `ExtractionProposal` / `ExtractionResult` — the output shapes the adopting
  app must consume in place of its current extraction result shape.

Because a model-backed provider is non-deterministic, "byte-for-byte identical
output" is a valid bar only for the **plumbing**, not for a specific live call's
exact text. Plan two separate, independent proofs.

## 1. Plumbing parity (deterministic replay)

Prove that Traverse's parse/normalize step is behaviorally equivalent to the
adopting app's current parse step, independent of model variance:

1. Capture one real provider response (raw text) from the app's current
   extraction path for a stable target input.
2. Replay that **same captured response** through both:
   - (a) the app's current parse -> diff -> review-item construction, and
   - (b) Traverse's `extract()` with a provider **stub** that returns the same
     captured response, followed by the same app-side diff -> review-item
     construction.
3. Assert the resulting downstream records (the app's proposed-changes and
   review-item structures) are deep-equal.

This isolates and proves the parsing/normalization equivalence with zero model
nondeterminism in the loop.

## 2. Live structural-parity smoke (adapter live)

Prove the real adapter produces output that flows unmodified through the app's
existing pipeline:

1. Run Traverse's real `createAnthropicExtractionProvider()` / `extract()`
   against a real target input **once**, with a real API key. This is a
   local/manual run, **not** CI — the package's CI carries no API key by design.
2. Confirm it produces a structurally valid `ExtractionProposal[]` (each field
   matching the supplied `TargetFieldSchema`, non-empty for at least the
   required fields the input actually contains).
3. Confirm that proposal set flows **unmodified** through the app's existing
   diff -> review-item -> downstream-record chain with no app-side special-
   casing for Traverse.

Here "identical records" means *structurally compatible with the existing
pipeline*, not byte-identical to a specific prior live response. A compile-time
compatibility fixture (`tests/type-fixtures/survey-shape-compat.ts` in this
repo) already proves the output types map onto Survey's `Extraction`/`RawSource`
shapes; the live smoke proves the runtime values do too.

## What each proof does and does not establish

- Proof 1 establishes parse/normalize equivalence. It says nothing about live
  model quality.
- Proof 2 establishes runtime structural compatibility on real data. It is a
  single-sample smoke, not a statistical quality bar.
- The compile-time compat fixture establishes type-shape compatibility. It is
  necessary but not sufficient: a shape can typecheck while carrying
  semantically wrong values, which is exactly why proofs 1 and 2 remain
  required.
