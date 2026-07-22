---
status: current
subject: Extraction Result multipass context evaluation
decided: 2026-07-22
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/67
  - kind: doc
    ref: evals/grounded-extraction/multipass-context.mjs
  - kind: doc
    ref: evals/grounded-extraction/corpus.v1.json
  - kind: doc
    ref: tests/multipass-context-evaluation.test.ts
---

# Extraction Result multipass context evaluation

## Thresholds, declared before comparison

Before executing a case, the harness emits a JSONL threshold/configuration
record and its deterministic SHA-256 digest. A future real-provider comparison
would require merged exact-span precision and recall of `1.0`, false-grounding
rate `0`, and at least `0.15` recall gain over the first pass. The current
synthetic fixtures do **not** evaluate or pass that product-value gate.

The mechanics configuration gives each case shared ceilings of two logical
attempts, two physical provider calls, and 14 fixture tokens (seven per
completed call). A later pass is not started after any shared ceiling is
consumed. Every attempt receives the remaining call and token ceilings. The
token ceiling is a stop-issuing bound: a completed call may overshoot it, and
the case records the overshoot explicitly.

These are extraction-quality and bounded-cost thresholds. They do not make a
truth, acceptance, confidence, or review-policy decision.

## Hermetic evaluation design and measurements

`node evals/grounded-extraction/multipass-context.mjs` reuses three existing
grounded-corpus cases: repeated identical values at distinct locators, shared
spans for different fields, and an explicit/inferred pair. The fixture records
first-pass and later-pass proposals separately. The later fixture closes over
the first result only as candidate context; it must still return excerpts that
Traverse independently verifies against prepared text.

With the declared defaults, the constructed complementary fixtures observe for
every selected case: first-pass recall `0.5`, later-pass recall `0.5`, merged
exact-span precision `1.0`, merged recall `1.0`, false-grounding rate `0`, two
logical attempts, two physical provider calls, and 14 tokens. These numbers
prove mechanics only; they are not measured context quality. With
`--max-tokens 7`, the later pass is skipped. With `--max-tokens 8`, the second
attempt receives the remaining one-token ceiling, completes its seven-token
call, and reports six tokens of overshoot.

Each attempt records a stable attempt ID, Traverse run ID, source and task
identity, provider/model/configuration identity and digest, logical-attempt and
physical-call counts, tokens, latency, typed failures, and proposal/merge-key
digests. Lifecycle JSONL records prove the threshold/configuration was emitted
before the first attempt and provider call.

The merge is an ordered union keyed by field path, path indices, canonical
candidate value, and independently verified locator. It retains the original
proposal unchanged. Consensus, confidence aggregation, fuzzy similarity,
semantic agreement, or candidate context never makes provenance and never
creates a `chars:` locator.

## Decision: REJECT product promotion; mechanics PASS

Keep the deterministic harness as a mechanics regression lane. Its ordering,
identity, exact-only merge, grounding, and budget checks PASS. Reject any
product or runtime promotion from the synthetic quality numbers: product value
is **NOT_VERIFIED** pending a predeclared real-provider comparison. Traverse
remains a single-pass proposer API; this spike adds no multipass API, consensus
mechanism, or provenance merge behavior.

Live-provider quality/cost evidence is **NOT_VERIFIED**: this spike used no
provider credentials or paid calls. A future explicitly authorized non-hermetic
comparison must retain the existing benchmark's provider/model, corpus/task
revision, per-attempt calls, tokens, latency, and failures before revisiting
this decision.
