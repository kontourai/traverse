---
status: current
subject: Extraction proposals
decided: 2026-07-04
evidence:
  - kind: adr
    ref: docs/adr/0001-proposals-only.md
  - kind: doc
    ref: .kontourai/flow-agents/inference-type/inference-type--deliver-plan.md
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/170
  - kind: doc
    ref: src/evidence-match.ts
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

## Evidence annotations (`evidenceMatch`)

`extract()` sets `evidenceMatch` on every proposal it returns: deterministic,
versioned facts computed from the proposal's own value, schema entry and
excerpt. It is an annotation, not a verdict. No proposal is dropped, warned
about, clamped or reordered because of it, the `[AC6]` test above is
unchanged, and a provider-supplied `evidenceMatch` is ignored. Traverse
computes only these deterministic checks; checking a value with a model is
not Traverse's job, and no Traverse confidence is derived from them.

```ts
evidenceMatch: {
  checkerVersion: "evidence-match-v1";
  schema: "ok" | "type-mismatch" | "enum-mismatch" | "format-invalid";
  valueInExcerpt: "match" | "mismatch" | "not-evaluated" | "not-applicable";
  tokenBoundary?: boolean;
}
```

- **`schema`** is exact. The value's JSON type must be the declared `type`
  (the same predicate task examples use); an `enum` string outside
  `enumValues` is `enum-mismatch`; a `date` string that is not an ISO-8601
  calendar date in extended format (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`,
  optionally `THH:MM[:SS[.fff]]` and `Z` or `±HH:MM`, each component
  range-checked) is `format-invalid`.
- **`valueInExcerpt`** runs only for fields declared
  `inferenceType: "explicit"` with a scalar type. Inferred and unclassified
  fields, and `array`/`object` fields, are `not-applicable`: only an explicit
  value is meant to appear in the source. The rule for every type is
  containment on token boundaries after a fixed normalization; equality is
  not required, so `"open"` matches `"Status: Open"`.
  - `string`/`enum`: NFKC, lower case, and letters/marks/digits as tokens,
    so whitespace and punctuation fold away (`"303.555.1234"` matches
    `"(303) 555-1234"`). The value's tokens must occur as a contiguous run of
    the excerpt's tokens (`"open"` does not match `"Reopened"`).
  - `number`: written numbers in the excerpt, each optionally signed and led
    by a currency symbol, with comma thousands separators and a point
    decimal, not touching a letter or digit (`3` is not read from `2023`).
    `match` when one equals the value.
  - `boolean`: the words yes/true and no/false.
  - `date`: the value must be `YYYY-MM-DD`; the excerpt is read for
    `2026-06-09`, `June 9, 2026` and `9 June 2026` (English month names, full
    or abbreviated, optional ordinal and comma). Numeric forms like
    `06/09/2026` are ambiguous between day-first and month-first and are not
    read.
  - A value or excerpt the normalizer cannot read (a number written in
    words, no yes/no word, no readable date, a value with no word
    characters, a value of the wrong type) is `not-evaluated`, never
    `mismatch`.
- **`tokenBoundary`** is false when the excerpt starts or ends inside a word
  of the prepared text (the excerpt `"3"` located inside `"2023"`).

Changing any rule so that some input gets a different result changes
`checkerVersion`.

**Recommended consumer policy.** A `schema` result other than `ok` can block
by default, because it is exact. `valueInExcerpt` and `tokenBoundary` are
annotations until the value-in-excerpt check's false-mismatch rate has been
measured on a labelled set; after that a consumer may choose to block on
`mismatch`. `not-evaluated` and `not-applicable` say nothing about the value.
The consumer decides what blocks; Traverse does not.

The portable envelope carries `evidenceMatch` as an optional proposal key
(see `portable-extraction-result-envelope.md`).

## Out of scope

- **A stricter, `inferenceType === "explicit"`-gated "candidateValue must be
  groundable in the excerpt" check that drops proposals.** The annotation
  above records the comparison without dropping anything ("Evidence
  annotations", issue #170); a gate remains the consumer's choice. The
  original reasons for not building a dropping check here still hold:
  - Format-aware equivalence is heuristic. The normalizers above cover a
    fixed set of forms and report anything else as `not-evaluated`; their
    false-mismatch rate on real pages has not been measured, so dropping on
    `mismatch` could remove well-grounded values.
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
  - A gate needs a labelled evaluation set first; until one exists, blocking
    on `valueInExcerpt` would turn an annotation into a value-dropping gate
    with unmeasured error.
  - Downstream rendering of the explicit/inferred distinction in a review UI
    (e.g. Survey-side) is separate work, not attempted here.
