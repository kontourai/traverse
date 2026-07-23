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

## Authorized live comparison

Issue #89 authorizes at most USD 10 for the live comparison. The committed
configuration in
`evals/grounded-extraction/live-multipass-context.v1.json` freezes the
provider/model, corpus size, six-call ceiling, token and latency limits,
rate-equivalent pricing, and promote/narrow/reject thresholds before the first
live request. The selected Relay runtime uses an authenticated subscription,
so incremental API spend is expected to remain zero; the rate-equivalent
calculation remains recorded for comparison and as a second safety rail.

Run `npm run eval:multipass-context:live -- --ledger /absolute/path/to/authorization.jsonl`
only with explicit spend authorization. The required append-only ledger is
keyed by the frozen configuration digest. It atomically reserves a provider
call plus worst-case configured tokens and rate-equivalent spend before each
invocation, so a retry, process exit, or concurrent process cannot reset the
authorization-wide ceilings. Completed calls reconcile to observed usage;
failed or aborted calls retain their conservative reservation, while locally
rejected attempts remain recorded without consuming provider budget. Ledger
records contain bounded identifiers and numeric accounting only—never prompts,
credentials, or provider payloads. The first JSONL result record contains the
configuration and corpus digests before any provider call. The resulting
decision and immutable evidence are added here only after the live run
completes.

## Live result: REJECT multipass promotion

The authorized run used Relay 0.4.1 with Claude Code and exact model
`claude-sonnet-4-6`. The completed comparison made six calls across three
frozen cases. First-pass exact-span recall was `0`; the second pass returned no
additional proposals in every case, so merged exact-span recall remained `0`
and recall gain was `0`, below the predeclared `0.15` threshold. Every retained
proposal was grounded, so false-grounding remained `0`, but its excerpt
boundaries differed from the frozen gold spans. The decision is **REJECT**:
Traverse remains single-pass and gains no multipass runtime API.

Incremental billed API spend was USD `0` under the authenticated subscription.
The completed run reported 18 input and 2,485 output tokens, 77.551 seconds
aggregate model latency, and USD `0.037329` rate-equivalent spend. An earlier
aborted harness run made three first-pass calls before its second-pass requests
failed locally. Authorization-wide totals were nine calls and USD `0.051141`
rate-equivalent, still below the USD 10 financial ceiling.

Safety evidence is not all green. One completed call reported 619 output tokens
despite a requested 512-token limit, showing that Claude Code does not enforce
Relay's requested output limit as a hard process-runtime cap. The retry also
reset the process-local six-call counter, producing nine authorization-wide
calls. Both are recorded as failures, not normalized away. The complete
per-attempt evidence and limitations are in
`evals/grounded-extraction/results/live-multipass-context-2026-07-22.json`.

## Durable-ledger live canary

A separate one-call, USD 0.10 authorization verified the shipped correction
without reopening the rejected multipass experiment. Published Relay 0.5.0
completed one live extraction and preserved the host's cache-write token and
provider-reported cost fields. Traverse wrote `started` before launch and
`completed` after reconciling the receipt. A new process then attempted the
same authorization and was refused before provider launch.

The two-record ledger was mode `0600`; a content scan found no prompt,
credential, or proposal contents. Provider-reported cost was USD `0.056376`
under the USD `0.10` authorization. That field is retained as a runtime fact,
not presented as an independently verified incremental subscription charge.
Sanitized evidence is in
`evals/grounded-extraction/results/relay-0.5-ledger-canary-2026-07-22.json`.
