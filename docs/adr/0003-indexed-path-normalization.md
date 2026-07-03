> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0003 — Indexed fieldPath normalization (accept, don't reject)

Status: Accepted (2026-07-02). Original decision record for
`extract()`'s proposal normalization step.

## §1 Context

`targetSchema` declares array fields in the un-indexed bracket form, e.g.
`"schedules[].startDate"` — `TargetFieldSchema.path` is caller-owned, but
Traverse's own fixtures and prior docs already used this convention (see ADR
0001 §3, §4). In practice, extraction providers do not always echo that exact
string back. A real pilot adjudication (Anthropic-compatible endpoint, model
`glm-5.2`) observed a provider emitting **indexed** paths instead —
`"schedules[0].startDate"`, `"schedules[1].startDate"`, etc. — one concrete
index per array item, which is a natural (arguably more informative) way for a
model to describe "the start date of the *first* schedule entry."

Before this change, `normalizeProposals()` checked `fieldPath` against
`knownFieldPaths` with an exact `Set.has()` lookup. An indexed path never
matched the un-indexed declared path, so every one of these proposals was
dropped as an "unknown fieldPath" — silently, save for a warning nobody was
necessarily reading. On at least one real source in that pilot, this dropped
**every** date/age proposal extracted from a repeating schedule — a systematic
loss, not an edge case, because the model consistently indexed that field.

## §2 Decision

`extract()`'s normalization step now treats an indexed fieldPath as a
**recoverable, unambiguous** variant of a declared array path, not as an
invalid one:

1. If `fieldPath` matches `targetSchema` exactly, behavior is unchanged.
2. Otherwise, strip every `[n]` (integer) segment in `fieldPath` down to `[]`
   — consistently at every level of nesting (`"a[2].b[0].c"` ->
   `"a[].b[].c"`). If the **normalized** path matches a declared
   `targetSchema` path, the proposal is **accepted**: its `fieldPath` is
   rewritten to the declared (normalized) form, and the stripped index/indices
   are recorded on the new `ExtractionProposal.pathIndices?: number[]` field,
   in left-to-right (outermost-first) source order.
3. If the normalized path still doesn't match anything in `targetSchema`, the
   proposal is dropped with the same "unknown fieldPath" warning as before —
   this is not a fallback that widens what "unknown" means, only a narrow,
   unambiguous recovery for the one specific shape (integer array indices)
   that a declared array path can always be recovered from mechanically.
4. Every other normalization rule (non-empty `extractor`, a provenance
   `excerpt` that occurs verbatim in the prepared content, a finite/clamped
   `confidence`) still runs, unchanged, against the **normalized** proposal —
   normalizing the path recovers eligibility to be checked, it does not bypass
   any other check. See `src/extract.ts` and ADR 0001 §4.

## §3 Why accept-and-normalize rather than reject

Rejecting indexed paths is *defensible* in the abstract — `targetSchema` is
caller-owned (ADR 0001 §3) and Traverse could simply hold providers to the
caller's exact string. But the observed failure mode makes the strict reading
actively harmful in practice: the caller's schema and the provider's answer
disagree only in a superficial, **totally unambiguous** way (an index the
provider chose to include is information, not noise), yet the strict check
turned that into losing the answer entirely, for every array item, with no
recovery path available to the caller short of pre-processing every provider
response. That is a worse outcome than the thing the strict check was trying
to prevent (accepting a path the caller didn't declare) — there is no
plausible interpretation of `"schedules[0].startDate"` against a schema that
only declares `"schedules[].startDate"` other than "the start date of
schedule item 0." Traverse is a proposer, not a resolver (ADR 0001 §2): a
normalized `fieldPath` and a preserved `pathIndices` do not resolve anything
on the caller's behalf — they still hand the caller a reviewable proposal
against a path the caller declared, plus the one extra fact (which array
item) needed to make use of it. Silently or loudly dropping the proposal
instead would have destroyed that fact rather than surfaced it.

`pathIndices` exists specifically so a downstream consumer can regroup
proposals by source array item (e.g. multiple `"schedules[].*"` proposals
that all came from the same `schedules[N]` entry) without re-parsing
`fieldPath` strings itself. Recovery is silent (no warning) on the happy
path — a proposal that normalizes cleanly is not a defect to report, it is
supported input. A fieldPath that still doesn't match after normalization
remains dropped with a warning, unchanged from before this ADR: normalization
recovers one specific, unambiguous shape, it does not loosen the schema
membership check in general.

## §4 Consequences

- `ExtractionProposal.fieldPath` is now guaranteed to be a `targetSchema`-declared
  path even when the provider emitted an indexed one; consumers never see the raw
  indexed string.
- `ExtractionProposal.pathIndices?: number[]` is new, optional API surface —
  present only when normalization occurred. Existing consumers that ignore it
  are unaffected.
- The excerpt/locator provenance contract (ADR 0001 §4) is enforced identically
  before and after this change; normalization only affects the `fieldPath`
  membership check.
