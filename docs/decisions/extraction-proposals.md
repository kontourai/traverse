---
status: current
subject: Extraction proposals
decided: 2026-07-04
evidence:
  - kind: adr
    ref: docs/adr/0001-proposals-only.md
  - kind: doc
    ref: .kontourai/flow-agents/inference-type/inference-type--deliver-plan.md
---

# Extraction proposals

This subject previously had provenance only in frozen ADR history
([0001-proposals-only.md](../adr/0001-proposals-only.md)) with no living
decision ratified under the topic-keyed decision registry. This update
ratifies the first living decision for the subject: `inferenceType`, a
per-field grounding-honesty classification that refines what an
`ExtractionProposal`'s provenance means, without changing ADR 0001's
proposals-only identity or its `chars:<start>-<end>` provenance contract.

## Decision

- **`TargetFieldSchema.inferenceType?: "explicit" | "inferred"`** (caller-set,
  100% optional). `"explicit"` — the value should appear verbatim in the
  source text; offset-verification of the VALUE itself (not just the
  excerpt) is meaningful, and adapters may instruct the provider to copy it
  verbatim rather than paraphrase/reformat it. `"inferred"` — the value is
  derived/normalized/classified from the source (e.g. computed, reworded, or
  categorized); the excerpt still grounds the proposal, but the value itself
  can never be offset-verified against the source text. Absent means
  unspecified — today's behavior, no classification implied either way.
- **Carry-through onto `ExtractionProposal.inferenceType`.** `extract()`'s
  `normalizeChunkProposals` attaches `inferenceType` from the MATCHED
  (post-normalization) `targetSchema` entry — looked up by the declared path,
  the same lookup `pathIndices`'s indexed-path recovery already uses, so an
  indexed-array proposal (e.g. provider-emitted `"schedules[0].startDate"`
  recovered against a declared `"schedules[].startDate"`) still resolves the
  tag correctly — ONLY when that entry declares it; the key is entirely
  absent (`"inferenceType" in proposal === false`) otherwise. This mirrors
  the existing `pathIndices` conditional-attach idiom exactly.
- **Anthropic adapter prompt guidance, `description`-string only.**
  `buildExtractionTool`'s per-field line gains one extra sentence sourced
  from `f.inferenceType`: `"explicit"` appends a verbatim-copy instruction;
  `"inferred"` appends a derived/normalized-value instruction that still
  requires a grounding excerpt; `undefined` appends nothing. `input_schema`
  (the `fieldPath`/`value`/`confidence`/`excerpt`/`locator` shape and
  `required` list) is byte-identical before and after — this is prompt
  guidance, not a schema change, so no client-side parsing of tool output
  changes.
- **Carry-through + prompt guidance ONLY — no stricter verification this
  slice.** `extract()` gains zero new drop/warning/clamp logic tied to
  `inferenceType`. An `"explicit"`-tagged field whose provider-returned
  `candidateValue` does not literally match the excerpt is proposed exactly
  as it would be today — reviewed by the caller, not gated by Traverse (see
  "Out of scope" below for why).

**Enumerated observable deltas** (everything a consumer could notice,
positive or negative):

1. `TargetFieldSchema` gains one new optional key. A schema object that
   never sets it is unaffected — no default value materializes, the key is
   simply absent, same as today.
2. `ExtractionProposal` gains one new optional key, populated ONLY when the
   proposal's matched schema field declared `inferenceType`. For every
   existing caller/schema (untagged), no proposal ever gains this key —
   `"inferenceType" in proposal` is `false`, `JSON.stringify(proposal)`
   output is unchanged, `Object.keys(proposal)` is unchanged.
3. `buildExtractionTool()`'s returned `AnthropicTool.description` string
   gains one extra sentence per field ONLY for fields that declare
   `inferenceType`; an untagged field's rendered line is byte-identical to
   today. `input_schema` is completely unchanged.
4. No change to `extract()`'s drop/warning/clamp semantics for ANY field,
   tagged or not (no new warning strings, no new drop conditions). A tagged
   `"explicit"` field whose provider-returned value doesn't verbatim-match
   the excerpt is proposed exactly as it would be today.
5. No change to `ExtractionResult`'s shape, `warnings` content/count, or
   `providerCalls`/`totalTokensUsed` accounting for any existing caller.
6. No change to the Survey compat fixture's typecheck status (optional
   field; existing `toExtraction()` mapping remains valid).
7. Downstream: a caller who reads `proposal.inferenceType` can now render an
   honest "offset-grounded value" vs. "derived value, excerpt-grounded only"
   badge; a caller who does not read it observes nothing different at all.

## Out of scope

- **A stricter, `inferenceType === "explicit"`-gated "candidateValue must be
  groundable in the excerpt" check** (opt-in via some future flag), deferred
  as an explicit follow-up, not a silently-dropped TODO. Reasoning:
  - Today, `candidateValue` passes through `normalizeChunkProposals`
    completely unverified — only `provenance.excerpt` is checked against the
    prepared text via `indexOf`. There is no existing normalization/
    comparison utility for "does this value appear in this text," and
    building one correctly is a much bigger, separate design problem:
    `candidateValue` is typed per field (`"string" | "number" | "boolean" |
    "date" | "enum" | "array" | "object"`) so a literal substring check
    would need format-aware equivalence — number-vs-formatted-text (`45` vs
    `"$45.00"`), date-vs-prose (`"2026-06-09"` vs `"June 9, 2026"`), and
    whitespace/casing/punctuation folding for strings (`"(303) 555-1234"` vs
    `"303.555.1234"`; `"123 Main St."` vs `"123 Main St"` inside a longer
    address excerpt) — none of which today's strict, single-mechanism
    `indexOf` excerpt check does or is designed to do.
  - The fields most likely to be tagged `"explicit"` in practice (address/
    zip/contact fields, money amounts) are exactly the ones most prone to
    formatting drift between a provider's returned value and the raw
    excerpt text. A naive strict check would produce new, silent-seeming
    false-positive drops for genuinely well-grounded explicit values whose
    provider-returned form merely differs in punctuation/format from the
    raw excerpt — regressing real extractions rather than only "being
    stricter where it's supposed to be." (See the regression test in
    `tests/extract.test.ts`'s `"inferenceType carry-through"` suite,
    `"[AC6] adds no new drop/warning/clamp condition..."`, which pins this
    exact no-op behavior for a reformatted phone number.)
  - No test/spec exists yet for what "close enough" means for a stricter
    check (locale-aware date parsing, number-format equivalence, casing/
    whitespace folding rules) — inventing that scope inside this slice would
    turn an additive field into a value-dropping gate with unreviewed
    semantics.
  - Downstream rendering of the explicit/inferred distinction in a review UI
    (e.g. Survey-side) is separate work, not attempted here.
