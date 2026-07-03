---
status: current
subject: Extraction cost guard
decided: 2026-07-03
evidence:
  - kind: doc
    ref: CONTEXT.md
  - kind: doc
    ref: src/types.ts
  - kind: session-archive
    ref: .kontourai/flow-agents/extraction-cost-guard/extraction-cost-guard--deliver.md
---

# Extraction cost guard

`extract()` gains two optional per-run ceilings — `ExtractInput.maxProviderCalls`
and `ExtractInput.maxTotalTokens` — so a caller can bound one run's provider
spend on a large or many-chunk page. Cost control lives **inside the
`traverse` package itself**, in the existing per-chunk loop in
`src/extract.ts`, rather than pushed out to each consuming application to
reimplement per integration. This overrides WS11 Traverse shaping decision
#3, which had left per-run spend bounding as an out-of-package concern;
owner-accepted scope override recorded 2026-07-03 in
`kontourai/survey/.kontourai/flow-agents/ws11-traverse-shaping/shaping.md` §6.

## Decision

- `ExtractInput.maxProviderCalls?: number` caps the number of
  `provider.extract()` calls issued in one `extract()` run (across all
  chunks); `ExtractInput.maxTotalTokens?: number` caps accumulated
  `raw.tokensUsed` summed across those calls. Both default unset =
  unbounded. Distinct from the content-bound `maxContentChars`/`maxChunks`
  options and from the Anthropic adapter's own
  `AnthropicAdapterOptions.maxTokens` (a different interface entirely — a
  per-call model *output* token cap, default `2048`), which this decision
  does not touch.
- Reaching a ceiling **stops issuing further calls** (checked at the top of
  each loop iteration, before the next call — never mid-call), keeps
  whatever proposals were already collected, and appends a warning to
  `result.warnings` naming the ceiling and how much was consumed — the same
  shape as the pre-existing `maxChunks` truncation warning. `extract()`'s
  never-throws contract is unchanged: invalid config (non-positive,
  non-integer, or non-finite ceilings) is validated once before any
  content-prep or provider work and surfaces as `ExtractionResult.error` (a
  plain string), never a thrown exception. The very first provider call is
  always attempted regardless of how small a valid ceiling is configured.
  When both ceilings are set, `maxProviderCalls` is checked first; whichever
  check trips first is the only one to emit a warning for that stop.
- `maxTotalTokens` is a **stop-issuing bound, not a hard spend cap**: it can
  only be checked using tokens already spent by calls that have already
  completed (a call's cost is unknown until it returns), so actual total
  tokens consumed by a run can exceed the configured ceiling by up to one
  call's usage.
- `ExtractionResult` gains two new **required** fields, `providerCalls` and
  `totalTokensUsed`, populated on every return path (success,
  ceiling-stopped, invalid-config, pdf-deferred, all-chunks-failed) so spend
  is observable even when no ceiling is configured. A provider that never
  reports `raw.tokensUsed` degrades gracefully: `maxTotalTokens` simply
  never fires for it (contributes `0` per call) while `maxProviderCalls`
  keeps working independently — call-count protection does not depend on a
  provider reporting usage.

## Out of scope

- Any per-call (as opposed to per-run) token/output cap — that remains the
  existing, separate `AnthropicAdapterOptions.maxTokens`.
- Any retry, backoff, or rate-limit behavior; "provider-agnostic" here means
  only "works with any provider that reports usage, degrades for one that
  doesn't," not a rate limiter.
- The pre-existing all-chunks-failed fatal return path
  (`src/extract.ts`, near the fatal-error construction) already omits
  `warnings` entirely — a gap that predates this decision. This guard does
  not fix it: in the narrow case where `maxProviderCalls === 1`, that one
  call throws, and more chunks remain, the ceiling-stop warning would also
  be silently dropped on that same path, even though `providerCalls`/
  `totalTokensUsed` are still reported correctly there.
- Any consumer-side integration change — no downstream consumer was available
  to verify against in the session that shipped this decision; the non-breaking claim
  rests on structural typing (new required fields are additive to an object
  a consumer only reads named fields from) and this repo's own release
  history of two prior additive `ExtractionResult` fields (`embedded`,
  `warnings`) shipping as non-breaking `feat:` minor bumps. Stated plainly,
  that non-breaking claim holds only for the **read side**: a consumer that
  decodes an `ExtractionResult` returned by `extract()` and reads named
  fields is unaffected by `providerCalls`/`totalTokensUsed` becoming
  required, exactly as `embedded`/`warnings` were. It does **not** hold for
  the **construct side**: anything that builds a full `ExtractionResult`
  object literal directly — a test double, a consumer-side mock
  implementing the result shape for its own tests, or a future adapter that
  fabricates a result without calling `extract()` — must now also supply
  both new fields, or it fails to compile (TypeScript) or produces an
  incomplete object (untyped construction). That is a real, not merely
  theoretical, breaking change for that narrower construction-side case.
  This package remains on the `0.x` line (currently `0.7.0`), so the change
  is carried by the ordinary `0.x` versioning convention (any `0.x` bump may
  include breaking changes) rather than forcing a major-version bump — but
  it is still breaking, and release notes for this change should say so
  plainly rather than citing only the read-side, additive-field argument.
