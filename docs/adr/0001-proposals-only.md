# ADR 0001 — Traverse is a proposer only

Status: Accepted (2026-07-02). This is an original decision record for Traverse
at Slice 1, not a reconstruction.

## §1 Context

Traverse extracts field values from prepared content using a pluggable,
often model-backed, provider. Extraction is inherently uncertain: a provider can
misread, hallucinate, or over-reach. Downstream, these values feed a producer
pipeline (Survey's source -> extraction -> candidate -> review -> claim chain)
whose entire premise is that nothing counts as true until it has been reviewed.

A library that sat in front of that pipeline and *resolved* values — deciding a
field is correct and handing back a settled answer — would silently bypass the
review step that gives the whole chain its integrity. Traverse must not be able
to do that, by construction, not by convention.

## §2 Decision

Traverse is a **proposer only**. Its output type is `ExtractionProposal`, and
every proposal is a reviewable record. Traverse produces proposals; it never
produces resolutions, decisions, rankings, or selected values. The caller owns
the review path that turns proposals into anything authoritative.

## §3 Scope

This ADR governs Traverse's public surface: `extract()`, the
`ExtractionProvider` interface, and every bundled adapter (currently the
Anthropic adapter behind the `/anthropic` subpath). It does not govern how a
caller reviews proposals, what schema a caller supplies, or how downstream
systems store results — those are caller concerns.

Traverse also does **not** own: crawling or fetching content, ranking or
deduping across sources, resolving conflicts between candidate values, or
defining any domain field vocabulary. `TargetFieldSchema` is 100% caller-
supplied; the package defines zero field names of its own.

## §4 Proposals-only rule (hard constraint)

Nothing in Traverse may resolve a value or bypass review. Concretely:

1. Every emitted item is an `ExtractionProposal` carrying **required
   provenance** — a verbatim `excerpt` and a `locator`. Provenance is required
   on the type itself, so a proposal without it cannot exist. `extract()`
   drops any provider output lacking an excerpt.
2. `confidence` is an honest `0..1` signal for the reviewer, never a gate
   Traverse acts on. Traverse does not accept, reject, or select based on it; it
   only clamps out-of-range values into range and reports the adjustment.
3. Adapters are proposers too. The Anthropic adapter uses forced tool-use to
   collect proposals with excerpts and parses the result defensively; it never
   decides a field.
4. Traverse never throws to signal an extraction outcome. Provider and parse
   failures surface as `ExtractionResult.error` so the caller — not Traverse —
   decides what to do about them.

This constraint is what makes Traverse safe to place in front of a review
pipeline: everything it emits is, and remains, a proposal.
