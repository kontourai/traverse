# @kontourai/traverse

Schema-directed content extraction that produces **provenance-bearing,
review-ready extraction proposals** in Survey's shape.

Traverse takes prepared content (HTML or text) plus a caller-supplied list of
target fields, asks a pluggable extraction provider to propose field values,
and normalizes those into `ExtractionProposal[]` — each one a reviewable record
carrying a verbatim `excerpt` and a `locator`. Traverse's extraction core is a
**proposer only**: it never resolves a value, never ranks, and never owns
review policy (the opt-in `@kontourai/traverse/fetch` subpath's `crawlSource`
offers a bounded same-host crawl — see "Fetching & snapshots" below — but
extraction itself still never crawls). See
[`docs/adr/0001-proposals-only.md`](docs/adr/0001-proposals-only.md).

## Install

```sh
npm install @kontourai/traverse
```

The Anthropic adapter needs the SDK as an optional peer dependency — install it
only if you use that adapter:

```sh
npm install @anthropic-ai/sdk
```

Traverse has **zero AI-provider runtime dependencies** — no LLM SDK is bundled
or required; `@anthropic-ai/sdk`, `openai`, and `@google/genai` are optional
peer dependencies you only install for the adapter you use. It does declare
real runtime dependencies for content handling: `linkedom` and `turndown`
(HTML→DOM parsing and Markdown conversion in content-prep, used by `extract()`
itself) and `@kontourai/forage` (SSRF-guarded egress and crawling, used by the
`@kontourai/traverse/fetch` subpath — see "Fetching & snapshots" below).

## The provenance contract

Every `ExtractionProposal` carries required `provenance`, and `extract()`
**enforces** it — not just requires its presence:

- **`excerpt`** — a verbatim quote against the **CONTENT-PREPARED text**
  `extract()` hands to the provider — **not** the caller's raw HTML/source
  document. Since 0.5.0 HTML is prepared as **Markdown** by default (links,
  headings, and lists survive; see [Large pages & chunking](#large-pages--chunking));
  pass `prep: "text"` for the legacy flat-text strip. A proposal without an
  excerpt is not something Traverse emits.
- **Occurrence is enumerated, not assumed.** `extract()` verifies an excerpt
  against the chunk the provider saw, enumerates every exact match in both that
  visible slice and the full prepared text, and records the selected span in
  `provenance.occurrence`. A provider may supply an untrusted 1-based
  `occurrenceHint`; only an integer in bounds for the visible slice can select
  a match, which is then mapped to its global occurrence metadata. Otherwise
  source-order allocation selects a visible exact match. A proposal
  whose excerpt cannot be found is **dropped** with the warning `"excerpt not
  found in prepared content"` — paraphrases, translations, reformats, and
  hallucinations receive no approximate offset.
- **`locator`** — a fixed, defined scheme: `"chars:<start>-<end>"`, where
  `<start>`/`<end>` are 0-based UTF-16 code-unit offsets of the selected exact
  occurrence. `extract()` always derives/overwrites `locator` itself from that
  verified span — a provider/adapter-supplied `locator` is never trusted as-is.
  `provenance.occurrence` exposes resolver version, exact count, selected span,
  selection mode, hint use, and ambiguity; ambiguity is evidence to review, not
  a certainty claim.

Because the excerpt and the offsets it implies are anchored to the
**prepared** text and not the caller's original document, a consumer that
wants to highlight/locate an excerpt in the raw source must re-run the same
content-prep step (or an equivalent) to reproduce the text those offsets refer
to, or map prepared-text offsets back to raw-document offsets itself. Traverse
does not do that mapping.

Because provenance is required on the type itself AND enforced by
normalization, the whole package is structurally a provenance-bearing-proposal
producer — this is its identity, not a convention.

### Resolving exact prepared text

An `ExtractionResult` carries `preparedArtifact`: a compact, versioned
identity for the complete prepared text behind every `chars:<start>-<end>`
locator. The result intentionally does **not** embed that text. To retain and
later verify exact text, inject a caller-owned store and resolve the artifact:

```ts
import {
  createInMemoryPreparedArtifactStore,
  extract,
  resolvePreparedArtifact,
} from "@kontourai/traverse";

const preparedStore = createInMemoryPreparedArtifactStore();
const result = await extract({
  content,
  contentType: "html",
  sourceRef: "caller-owned-ref",
  targetSchema,
  provider,
  preparedArtifact: {
    store: preparedStore,
    preparationVersion: "your-preparation-v1",
  },
});

const resolved = await resolvePreparedArtifact(result.preparedArtifact!, preparedStore);
// resolved.status is "available", "unavailable", "storage-error",
// "invalid-artifact", "identity-mismatch", or "digest-mismatch".
// Only "available" includes text; slice it with the proposal locator offsets.
```

The artifact's SHA-256 digest binds exact prepared text; its versioned reference
also binds the preparation mode/version and optional source snapshot reference.
This makes a changed preparation implementation visibly produce a new identity.
Plain-text callers need no migration: `extract()` assigns the deterministic
inline identity automatically, but retains no text unless a store is supplied.
Artifact creation rejects ill-formed Unicode rather than allowing UTF-8
replacement characters to collapse distinct JavaScript strings. Resolution
validates every metadata field and recomputes the canonical reference before
calling a store; store exceptions are returned as redacted `storage-error`
outcomes. `preparationMode` reports the path actually used, including
`"transcript"` cleanup and `"text"` when HTML markdown preparation falls back.

`fetchAndExtract()` accepts `preparedArtifactStore` and `preparationVersion`.
The Forage-backed `crawlAndExtract()` composition accepts the same options and
binds each page artifact to that page's existing `sourceRef`, so byte-stable
Forage replay produces the same prepared-artifact identity and resolution.

### Portable extraction-result envelopes

Traverse owns a versioned, canonical JSON envelope for moving a completed
result across process or product boundaries:

```ts
import {
  deserializePortableExtractionResult,
  serializePortableExtractionResult,
  validatePortableExtractionResultEnvelope,
} from "@kontourai/traverse";

const bytes = serializePortableExtractionResult(result);
const envelope = deserializePortableExtractionResult(bytes);
const validation = validatePortableExtractionResultEnvelope(JSON.parse(bytes));
```

`extract()` assigns every result a top-level `provider` and opaque `runId`, even
for a successful run with zero proposals. The envelope retains those identities,
model and usage counters, source/snapshot and prepared-artifact identity, exact
locator/occurrence metadata, task/example digests, partial state, and typed
provider/artifact failures. A typed `outcome` distinguishes empty success,
partial work, invalid configuration/task, preparation, provider, and unexpected
failure; warning strings become non-sensitive category/code records. Provider,
model, failure-provider, and proposal-extractor identities use a strict,
credential-free grammar. Canonical key ordering makes a validated
deserialize/re-serialize byte-stable.

The default export is deliberately diagnostic-safe: it omits `raw.response`,
`ExtractionResult.error`, warning strings, provider-failure messages/native
objects, embedded raw-source sidecars, prepared text, stores, and authorization configuration. Source refs
with URL credentials or credential-shaped query parameters are rejected. Keep
the full in-process `ExtractionResult` inside its original trust boundary when
raw diagnostics are required; Traverse does not provide a diagnostic-rich wire
export. Candidate values and grounding excerpts are intentional result data and
still require the caller's domain-specific disclosure policy.

## Explicit vs. inferred fields (`inferenceType`)

Every `ExtractionProposal` above is grounded by a verbatim `excerpt` — but
that only tells you the EXCERPT is real; it doesn't tell you whether the
proposed VALUE itself is a verbatim copy of the source text or something a
provider derived, normalized, or classified from it. `TargetFieldSchema`
carries an optional tag for exactly that distinction:

```ts
const targetSchema: TargetFieldSchema[] = [
  // "explicit": the value should appear verbatim in the source. Traverse
  // (and the Anthropic adapter) treat this as a hint that offset-verifying
  // the VALUE itself, not just the excerpt, would be meaningful.
  { path: "zip", type: "string", inferenceType: "explicit" },
  // "inferred": the value is derived/normalized/classified from the
  // source (e.g. a computed total, a reworded summary, a classified
  // category) — the excerpt still grounds the proposal, but the value
  // itself can never be offset-verified against the source text.
  { path: "category", type: "enum", enumValues: ["a", "b"], inferenceType: "inferred" },
];
```

`inferenceType` is **100% optional and additive**: a field that never sets
it behaves exactly as before — no shape change, no new warning, no new drop
behavior for you or for any existing caller. When set, `extract()` carries
the tag through unchanged onto `ExtractionProposal.inferenceType` (present
only when the matched schema field declared it, mirroring the `pathIndices`
conditional-attach idiom used for indexed array paths), so a review UI can
render an honest "offset-grounded value" vs. "derived value, excerpt-grounded
only" distinction. This slice adds **no stricter verification** — an
`"explicit"` field whose returned value doesn't literally match the excerpt
is proposed exactly as it would be without the tag, reviewed by the caller,
not gated by Traverse (see
[`docs/decisions/extraction-proposals.md`](docs/decisions/extraction-proposals.md)
for the full rationale and the deferred stricter-verification follow-up).

## Typed values travel onto the proposal (`valueType` / `enumValues`)

Your `TargetFieldSchema` already declares each field's `type` (and, for an
`enum`, its `enumValues`). By the same conditional-attach idiom as
`inferenceType`, `extract()` echoes those constraints onto every matched
proposal as `ExtractionProposal.valueType` and (when declared)
`ExtractionProposal.enumValues`:

```ts
// schema: { path: "difficulty", type: "enum", enumValues: ["beginner", "advanced"] }
// proposal: { fieldPath: "difficulty", candidateValue: "beginner",
//             valueType: "enum", enumValues: ["beginner", "advanced"], ... }
```

This lets a downstream review UI render and validate the candidate against its
declared shape — a `date` picker, a `number` field, an `enum` select that
rejects an out-of-set value — **without still holding the original
`targetSchema` in scope**, exactly the decoupling `inferenceType` and
`pathIndices` provide. It is the schema's *declared* type, not an assertion
about `candidateValue`'s runtime `typeof`: a provider can still return a
malformed value, which is precisely what a typed reviewer checks. `extract()`
itself adds **no new drop behavior** — constraint metadata only. Additive and
optional: a consumer that ignores these fields sees no change. `enumValues` is
a defensive copy, so mutating it never reaches the caller's schema.

## Quickstart

```ts
import { extract } from "@kontourai/traverse";
import type { ExtractionProvider, TargetFieldSchema } from "@kontourai/traverse";

const targetSchema: TargetFieldSchema[] = [
  { path: "title", type: "string", required: true, description: "The activity name." },
  { path: "priceAmount", type: "number", description: "Drop-in price in whole units." },
];

// Any provider works — here a trivial mock. See the Anthropic adapter below for
// a real one.
const provider: ExtractionProvider = {
  name: "mock",
  async extract() {
    return {
      proposals: [
        {
          fieldPath: "title",
          candidateValue: "Beginner Bouldering Session",
          confidence: 0.9,
          // A provider-supplied `locator` is provisional — extract() overwrites
          // it with the verified "chars:<start>-<end>" scheme below.
          provenance: { excerpt: "Beginner Bouldering Session", locator: "provisional" },
          extractor: "mock",
        },
      ],
      raw: { response: "{}", model: "mock-model" },
    };
  },
};

const result = await extract({
  content: "<p>Beginner Bouldering Session</p>",
  contentType: "html",
  sourceRef: "https://example.test/schedule",
  targetSchema,
  provider,
});

// result.proposals[0].provenance.locator === "chars:0-27" — extract() verified
// the excerpt against the prepared text ("Beginner Bouldering Session", the
// <p> converted to Markdown text) and derived the offset itself.
// result.proposals      — normalized, provenance-bearing proposals
// result.raw            — the provider's raw response, for audit
// result.error          — set (never thrown) if a stage failed
// result.warnings       — merged provider + normalization notes (dropped/adjusted proposals)
// result.providerCalls  — physical provider operations issued this run, always populated
// result.totalTokensUsed — accumulated raw.tokensUsed from successful calls, always populated
// see "Cost guards" below for the maxProviderCalls/maxTotalTokens options that bound these
```

`extract()` **never throws** for provider, parse, or content-prep failure. Any
stage error surfaces as `result.error` with an empty `proposals` array.

## Normalization semantics

`extract()` runs content-prep, calls `provider.extract()`, then strictly
normalizes proposals. A proposal survives only if ALL of the following hold:

- `fieldPath` is a non-empty string present in your `targetSchema` (otherwise
  dropped, with a warning),
- `extractor` is a non-empty string (otherwise dropped),
- it carries a provenance `excerpt` (otherwise dropped, with a warning),
- that `excerpt` **occurs verbatim in the prepared content** handed to the
  provider — checked via `indexOf`, not merely assumed (a miss is dropped with
  `"excerpt not found in prepared content"`; a hit derives/overwrites
  `provenance.locator` as `"chars:<start>-<end>"` — see "The provenance
  contract" above),
- `confidence` is a finite number (otherwise dropped) — an out-of-range value
  is **clamped** into `0..1` (never dropped), with a warning.

`result.warnings` merges BOTH of the above normalization notes AND any
`warnings` the provider itself returned (e.g. the Anthropic adapter's
malformed-tool-item or maxTokens-truncation notes) — nothing either stage
notices is silent.

### Indexed field paths against array schemas

Some providers echo back an **indexed** path for an array field — e.g.
`"schedules[0].startDate"` — instead of the un-indexed declared form your
`targetSchema` uses, e.g. `"schedules[].startDate"`. This mapping is
unambiguous, so `extract()` **normalizes it rather than dropping it**:

- Every `[n]` (integer) segment in `fieldPath` is stripped to `[]`,
  consistently at every level — `"a[2].b[0].c"` normalizes to `"a[].b[].c"`.
- If the normalized path matches a declared `targetSchema` path, the proposal
  is accepted: `fieldPath` is rewritten to the declared (normalized) form, and
  the stripped index/indices survive on the new
  `ExtractionProposal.pathIndices?: number[]` field, in left-to-right
  (outermost-first) source order — `"a[2].b[0].c"` yields `pathIndices: [2, 0]`.
  This is silent on the happy path (no warning) — it is supported input, not a
  defect.
- Use `pathIndices` to regroup proposals that came from the same source array
  item, e.g. multiple `"schedules[].*"` proposals that all carry
  `pathIndices: [0]` came from the same `schedules[0]` entry.
- If the **normalized** path still doesn't match anything in `targetSchema`,
  the proposal is dropped with the same `"unknown fieldPath"` warning as any
  other unrecognized path — normalization recovers one specific, unambiguous
  shape; it does not loosen fieldPath membership in general.
- Every other normalization rule (extractor identity, verified excerpt,
  finite/clamped confidence) still runs unchanged against the normalized
  proposal.

See [`docs/adr/0003-indexed-path-normalization.md`](docs/adr/0003-indexed-path-normalization.md)
for why this is accept-and-normalize rather than reject.

## Large pages & chunking

Since 0.5.0 Traverse prepares and extracts **large listing pages** without
losing records or link URLs. See
[`docs/adr/0004-large-page-chunking.md`](docs/adr/0004-large-page-chunking.md).

**Structure-preserving prep.** HTML is converted to **Markdown** by default
(via Turndown), so `[text](href)` links, headings, and lists survive and the
prepared text is far denser than the old flat-text strip. Pass `prep: "text"`
for the legacy regex strip:

```ts
await extract({ content: html, contentType: "html", sourceRef, targetSchema, provider }); // markdown (default)
await extract({ content: html, contentType: "html", sourceRef, targetSchema, provider, prep: "text" }); // legacy flat text
```

> **Behavior change (0.5.0):** HTML now prepares as Markdown by default, so
> `provenance.excerpt`/`locator` are anchored to Markdown, not flat text. If you
> pinned to the old output, pass `prep: "text"`.

**Structural chunking.** For a page larger than one chunk, Traverse parses the
DOM (via linkedom), prunes chrome (`script`/`style`/`nav`/`footer`/…), and
detects the repeated-sibling "card" container of a listing, cutting chunk
boundaries **on card boundaries** so a card is never split. When no repeated
structure is found (or for `text` / `prep: "text"`), it falls back to a
character window with overlap so a value straddling a boundary is not lost.
Chunks dispatch in bounded waves. `concurrency` and `batchSize` both default to
`1`, so existing callers and providers keep the historical sequential behavior.
When a provider implements optional `extractBatch()`, Traverse can put up to
`batchSize` chunks into one physical provider call; declared provider limits
(`maxConcurrency`, `maxBatchSize`) always cap caller settings.

**Offset-correct provenance across chunks.** Each chunk is an exact contiguous
substring of one `fullText`. A proposal's `excerpt` is verified against the
chunk the provider saw, then resolved from an enumeration of exact full-text
occurrences, bounded to that chunk's visible matches, before
`locator = "chars:<start>-<end>"` is trusted — the `"chars:"`
scheme still means "offsets into the full prepared text." Resolution is folded
in original chunk/proposal order, so batching and concurrency cannot change it.
Only identical `fieldPath` + `pathIndices` + canonical value + selected span
are **deduped**; shared spans for different fields and repeated values at
distinct visible spans remain separate proposals. Overlap never allocates an
unseen later occurrence merely because an earlier span was already selected.

**Options** (all optional, on `extract()`):

| Option | Default | Meaning |
| --- | --- | --- |
| `prep` | `"markdown"` for html, else `"text"` | structure-preserving prep vs. legacy flat text |
| `chunkSize` | `12_000` | target max characters per chunk |
| `chunkOverlap` | `200` | character-window overlap (fallback path) |
| `maxChunks` | `40` | cap on chunks; extras dropped with a warning |
| `maxContentChars` | `32_000` | **per-chunk** provider content budget (each chunk truncated to it) |
| `concurrency` | `1` | maximum physical provider calls in flight; capped by a declared provider limit |
| `batchSize` | `1` | logical chunks per optional physical `extractBatch()` call; capped by a declared provider limit |
| `signal` | unset | stops dispatching new waves while retaining the completed wave's results |

These bound CONTENT (how much is prepared/chunked). To bound provider SPEND
(how many calls / how many tokens one run issues), see
[Cost guards](#cost-guards) below — an independent, composable set of options.

`result.warnings` aggregates per-run chunking notes: the chunk count and
detection mode, cards detected, any `maxChunks` truncation, dropped duplicates,
and any per-chunk provider failure. A provider error on **one** chunk is a
warning and the other chunks still run (partial results); only if **every**
chunk's call fails does `result.error` get set.

> Why not `@mozilla/readability`? It extracts the one main article and strips
> repeated sibling blocks as boilerplate — which is exactly what listing cards
> are. It solves the opposite problem and would discard the content we need.

## Cost guards

`extract()` takes two optional per-run ceilings to bound provider spend on a
large or many-chunk page:

| Option | Default | Meaning |
| --- | --- | --- |
| `maxProviderCalls` | unset (unbounded) | cap on physical `extract()`/`extractBatch()` operations issued in ONE run |
| `maxTotalTokens` | unset (unbounded) | cap on accumulated `raw.tokensUsed`, summed across every SUCCESSFUL call in that run |

```ts
const result = await extract({
  content: html,
  contentType: "html",
  sourceRef,
  targetSchema,
  provider,
  maxProviderCalls: 5,
  maxTotalTokens: 20_000,
});
```

**Stop-issuing, never mid-call, never throws.** Once a configured ceiling is
reached, `extract()` stops issuing further physical provider operations (it
never aborts a call already in flight), keeps whatever proposals were
already collected from calls that did run, and appends a warning to
`result.warnings` naming the ceiling and how much was consumed, e.g.:

```
stopped after 5 provider call(s): maxProviderCalls (5) reached; 3 chunk(s) not processed
stopped after 3 provider call(s): maxTotalTokens (20000) reached (21500 tokens used); 4 chunk(s) not processed
```

This mirrors the existing `maxChunks` truncation warning shape. The very
first provider call is always attempted, regardless of how small a valid
ceiling is configured — a single-chunk page always gets exactly one real
attempt. If both ceilings are set, `maxProviderCalls` is checked first;
whichever one is actually reached first is the only one to emit a warning
for that stop. **Invalid config never throws either**: a non-positive,
non-integer, or non-finite ceiling surfaces as `result.error` (a plain
string) with zero provider calls issued, exactly like any other stage
error.

**Not a hard spend cap.** `maxTotalTokens` can only be checked using tokens
already spent by calls that have already *completed* — a call's cost is
unknown until it returns. With concurrent work, Traverse checks between bounded
waves, so actual total can exceed the ceiling by the completed wave's usage.
That overshoot is reported as `result.partial.tokenOvershoot`; no subsequent
wave starts. Treat it as "stop issuing further calls once this much has been
spent," not "never cross this number."

**Typed partial progress.** A call ceiling, token ceiling, or an aborted
`signal` sets `result.partial` with a machine-readable reason plus completed
and undispatched chunk counts. Already-dispatched calls are allowed to finish
and their normalized proposals remain in the result; cancellation never
silently looks like a complete extraction.

**Independent of `maxChunks`.** `maxChunks` (see
[Large pages & chunking](#large-pages--chunking)) truncates how many chunks
*exist* before the loop even starts; `maxProviderCalls`/`maxTotalTokens`
independently bound how many of those already-capped chunks the loop
actually *processes*. Both can fire in the same run, and both warnings can
appear together in `result.warnings`.

**Not the same as the Anthropic adapter's `maxTokens`.** These are per-RUN
ceilings enforced by `extract()` itself across every chunk. They are a
different option, on a different interface, from
`AnthropicAdapterOptions.maxTokens` (default `2048`) — that one is a
per-CALL cap on a single model response's OUTPUT tokens, passed straight to
the provider. Setting `maxTotalTokens` does not change what any individual
call is allowed to generate; setting the adapter's `maxTokens` does not
bound how many calls a run issues.

**Usage is always observable, ceiling or not.** `ExtractionResult` carries
two REQUIRED fields, `providerCalls` and `totalTokensUsed`, populated on
every return path — a plain success, a ceiling-stopped partial run,
invalid-config, a deferred PDF, or an all-chunks-failed run — so spend is
visible even when no ceiling is configured at all.

**Graceful degrade without `tokensUsed`.** A provider that never sets
`raw.tokensUsed` on its response still gets full, correct protection from
`maxProviderCalls` (call counting is provider-independent). `maxTotalTokens`
simply never fires for such a provider (`totalTokensUsed` stays `0`) — this
is not treated as an error, just a ceiling that has nothing to measure
against.

See [`docs/decisions/extraction-cost-guard.md`](docs/decisions/extraction-cost-guard.md)
for the full decision record.

## SPA / JS-rendered pages

Many sites ship an almost-empty HTML shell and hydrate the real content in the
browser. Traverse **core** still ships no rendering and no browser dependency,
but the fetch subpath now offers an OPT-IN `renderImpl` seam a caller can plug
a renderer into (see "Rendered fetch" below) — and, whether or not you use
that seam, the prep layer does two more things so JS-heavy sources are still
useful:

### 1. Embedded-state sidecar

Before prep strips `<script>` blocks, Traverse harvests any machine-readable
state the page carries and returns it, parsed and size-capped, as a structured
sidecar on the result — `ExtractionResult.embedded` and
`prepareContent().embedded`:

```ts
const result = await extract({ content: html, contentType: "html", /* … */ });

result.embedded?.jsonLd;      // parsed <script type="application/ld+json"> blocks
result.embedded?.nextData;    // parsed Next.js <script id="__NEXT_DATA__">
result.embedded?.initialState;// parsed window.__INITIAL_STATE__ / __PRELOADED_STATE__
```

`jsonLd` covers schema.org markup (Event / Course / Product are common for
activity listings) and is near-perfect precision with no LLM cost. The sidecar
is harvested **once** per page (never duplicated across chunks) and is attached
even if every provider call fails — a shell page with rich `__NEXT_DATA__` is
extractable from the sidecar alone.

This is a **sidecar, not proposals**: proposals carry `chars:<start>-<end>`
provenance into the prepared text, and embedded state is not in the prepared
text (it lives in stripped scripts). Mapping the sidecar onto your field names is
your job — Traverse owns zero field vocabulary. See
[`docs/adr/0005-embedded-state-sidecar.md`](docs/adr/0005-embedded-state-sidecar.md).

### 2. JS-shell warning (render upstream, then retry)

When the prepared text is suspiciously small relative to the HTML **and** the
page is script-dominated or has an empty client-render mount (`#root` / `#__next`
/ `#app`), Traverse emits a machine-actionable warning through `result.warnings`.
The warning starts with a stable code and carries the ratio numbers:

- `js-shell-suspected: …` — likely an un-rendered shell with no usable embedded
  state. Render the page upstream (e.g. a headless browser) and retry.
- `js-shell-suspected-embedded-state-available: …` — same shell shape, but usable
  embedded state was harvested, so **prefer the sidecar and skip the render**.

Every warning is `"<code>: <details>"`, so match on the code with `startsWith`:

```ts
const warnings = result.warnings ?? [];
// Coarse check — true for either shell variant:
const looksLikeShell = warnings.some((w) => w.startsWith("js-shell-suspected"));
// Only render when there is NO usable embedded state to fall back on:
const needsRender = warnings.some((w) => w.startsWith("js-shell-suspected:"));
```

A content-rich page is never flagged, even with heavy analytics/framework
scripts: the heuristic gates on an absolute prepared-text floor, not a bare
ratio (a real 2.7MB listing prepares to ~23k chars — a 0.85% ratio — and is
correctly left alone).

## Anthropic adapter

The Anthropic adapter is exported from the `@kontourai/traverse/anthropic`
subpath — it is **not** re-exported from the main entry point, so consumers
who do not use it (and do not install `@anthropic-ai/sdk`) pay nothing.

```ts
import { extract } from "@kontourai/traverse";
import { createAnthropicExtractionProvider } from "@kontourai/traverse/anthropic";

const provider = createAnthropicExtractionProvider({
  // apiKey defaults to process.env.ANTHROPIC_API_KEY
  // model defaults to "claude-sonnet-4-6" — override per call site:
  model: "claude-sonnet-4-6",
});

const result = await extract({
  content: htmlString,
  contentType: "html",
  sourceRef: url,
  targetSchema,
  provider,
});
```

The adapter builds a forced tool-use schema **dynamically** from your
`targetSchema` and instructs the model to return a verbatim `excerpt` per field
— that is how provenance gets populated. Tool output is parsed defensively:
malformed items (no excerpt, out-of-range confidence, missing field, missing
value) are dropped, never silently accepted — each drop is reported in
`ProviderExtractionOutput.warnings`, which `extract()` merges into
`result.warnings`. The adapter also warns (rather than staying silent) when
the model's response is truncated: `stop_reason === "max_tokens"` adds
`"response truncated at maxTokens; proposals may be incomplete"` to
`warnings`, so a truncated proposal set is never mistaken for a complete one.
For tests, inject a client: `createAnthropicExtractionProvider({ client })`.

## Provider conformance and additional adapters

Bundled adapters declare the same discoverable capability contract and pass one
deterministic conformance suite. Unsupported declared capabilities fail before
a provider call. Provider failures expose normalized retryability while keeping
the original native diagnostic on `ExtractionResult.providerFailures`.

OpenAI and Gemini are optional subpath adapters, following the same injected
client and dynamic optional-peer pattern as the Anthropic adapter:

```ts
import { createOpenAIExtractionProvider } from "@kontourai/traverse/openai";
import { createGeminiExtractionProvider } from "@kontourai/traverse/gemini";

const openaiProvider = createOpenAIExtractionProvider({ model: "gpt-4.1-mini" });
const geminiProvider = createGeminiExtractionProvider({ model: "gemini-2.5-flash" });
```

The optional Relay adapter accepts any `ModelRuntime`, including direct SDK,
local, hosted, replay, or host-routed implementations. Traverse still owns the
extraction prompt, tool schema, proposal parsing, and provenance behavior:

```ts
import { createRelayExtractionProvider } from "@kontourai/traverse/relay";

const provider = createRelayExtractionProvider({ runtime });
```

Relay supplies invocation portability only. Applications that need routing,
budgets, fallbacks, or execution receipts can provide a runtime implementing
those policies without coupling Traverse to an orchestration product.

Traverse does not choose a default provider. See the
[provider conformance decision](docs/decisions/provider-conformance.md).

The adapter's own synthesized/provided `locator` on each proposal is
**provisional** — `extract()`'s normalization step is the sole owner of the
final `locator` value, which it derives from a verified excerpt offset (see
"The provenance contract" above). This applies to any provider, not just the
Anthropic adapter: `extract()` re-derives every proposal's locator itself.

A field's `inferenceType` (see "Explicit vs. inferred fields" above), when
declared, turns into one extra guidance sentence in the tool's `description`
for that field — a verbatim-copy instruction for `"explicit"`, a
derived/normalized-value instruction for `"inferred"` — with **zero prompt
change** for untagged fields. This only affects the natural-language tool
description the model reads; the `input_schema` it must respond against is
unchanged either way.

### Model override

`opts.model` overrides the default alias (`claude-sonnet-4-6`) without any API
change, and is reflected in `provider.name`
(`anthropic-extraction-provider:<model>`).

### Anthropic-compatible endpoints (Z.AI, proxies)

`opts.baseUrl` targets any Anthropic-compatible endpoint — Z.AI's
Anthropic-compatible API, an internal proxy, etc. — instead of
`api.anthropic.com`. It is passed straight through as the `@anthropic-ai/sdk`
constructor's `baseURL` option; when unset, this adapter does not read any env
var itself, so the SDK's own `ANTHROPIC_BASE_URL` fallback still applies. When
`opts.baseUrl` is set, `provider.name` gets an `@<host>` suffix
(e.g. `anthropic-extraction-provider:glm-4.6@api.z.ai`), so parity reports show
which backend produced a given set of proposals.

**Env-only recipe** (no code change — the SDK reads both vars itself):

```sh
export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
export ANTHROPIC_API_KEY="$ZAI_API_KEY"   # your Z.AI key, from your own secret store
```

```ts
const provider = createAnthropicExtractionProvider();
```

**Explicit opts recipe:**

```ts
const provider = createAnthropicExtractionProvider({
  baseUrl: "https://api.z.ai/api/anthropic",
  apiKey: process.env.ZAI_API_KEY, // your Z.AI key, from your own secret store
  model: "glm-4.6",
});
```

Either way, **pass an explicit `model` your backend actually serves** — the
default alias (`claude-sonnet-4-6`) is an Anthropic model ID and is not
guaranteed to resolve on a third-party endpoint. Z.AI's Anthropic-compatible
endpoint maps Claude model names to GLM equivalents rather than erroring, which
can silently swap the model actually used, so pin `model` explicitly (e.g.
`glm-4.6`) rather than relying on that mapping.

## Fetching & snapshots (`@kontourai/traverse/fetch`)

Traverse's **fetch side** is a standalone-first capability: configurable
single-page fetching with **snapshot capture** so a fetch can be **replayed**
offline (CI never needs the network). It is exported from the
`@kontourai/traverse/fetch` subpath — mirroring the `/anthropic` discipline, the
package root stays focused on extraction and re-exports none of it. Like
`extract()`, `fetchSource()` **never throws**: timeouts, retries, robots denial,
HTTP errors, and bad config surface as a typed `FetchError` on the result. It
has no HTTP-client dependency of its own — it's built on global `fetch` plus
`node:crypto`/`node:fs` — but it does depend on `@kontourai/forage`:
`fetchSource`/`crawlSource`/`replaySource` route egress through forage's
SSRF-guarded `createGuardedFetch` (`@kontourai/forage/egress`) by default
(callers can still inject their own `opts.fetch` to bypass it), and
`crawlAndExtract` (below) additionally composes forage's own frontier
`crawl()` (`@kontourai/forage`) for multi-page traversal.

Headless-browser rendering now has an OPT-IN seam — see "Rendered fetch"
below. Out of scope for this layer (see
[`docs/slice-3-candidates.md`](docs/slice-3-candidates.md)): scheduling.
Multi-page link-following now has a bounded, same-host-only crawl frontier
(`crawlSource`, below) — cross-host crawling is still out of scope.

### Standalone fetch

```ts
import { fetchSource } from "@kontourai/traverse/fetch";

const result = await fetchSource({
  id: "listing-1",
  url: "https://example.com/listing",
  // politeness, timeout, and bounded jittered retries all have sane defaults:
  minDelayMs: 1000, // per-host min gap between requests (default 1000)
  timeoutMs: 15000, // per-request timeout (default 15000)
  retries: 2,       // retryable failures only (network/timeout/429/5xx), capped at 5
  respectRobots: true, // default — fetch & honor /robots.txt for our User-Agent
  // Identify honestly. The default UA is an honest bot string with a CONTACT
  // PLACEHOLDER — override it with a real contact when hitting real sites:
  userAgent: "my-crawler/1.0 (+https://example.com/bot; contact: ops@example.com)",
});

if (result.error) {
  // typed, never thrown: "timeout" | "network" | "http-error" | "robots-denied"
  //   | "too-many-redirects" | "invalid-url" | "invalid-config" | "no-snapshot"
  //   | "dependency-missing" | "adapter-error"  (YouTube adapter — see below)
  console.error(result.error.kind, result.error.message);
} else {
  const s = result.snapshot!;
  // s.url (final, post-redirect), s.status, s.contentType, s.body,
  // s.bodyHash (sha256), s.redirects?, s.fetchedAt
  // Binary content (today: "pdf" only) sets s.bodyBytes (raw bytes) instead
  // of s.body (which stays ""); EXACTLY ONE of body / bodyBytes is ever
  // populated. bodyHash's hash domain follows suit: sha256 of the raw bytes
  // for a binary snapshot, sha256 of utf8-body otherwise.
}
```

**Robots & politeness.** With `respectRobots` (default `true`), `/robots.txt` is
fetched for your `User-Agent` before the request and any redirect hop; a
disallowed path returns `kind: "robots-denied"` and the page is never fetched.
If `/robots.txt` is itself unreachable or 5xx, the fetch **fails open** with a
warning (a single-page fetch should not be blocked by robots *infra* problems —
see [`docs/adr/0002`](docs/adr/0002-fetch-snapshot-slice2.md)). Politeness is a
per-host minimum delay, enforced in-process.

### Bounded same-host crawl

`crawlSource(seed, opts)` is a thin BFS driver on top of `fetchSource()` /
`replaySource()`: it follows same-host links discovered in each fetched page's
HTML, bounded by `maxPages` and `maxDepth`, and never throws. It reuses the
same robots/politeness/replay guarantees as a single `fetchSource()` call —
see [`docs/decisions/crawl-frontier.md`](docs/decisions/crawl-frontier.md) for
the query-handling, replay, and same-host-boundary decisions.

```ts
import { crawlSource } from "@kontourai/traverse/fetch";

const manifest = await crawlSource(
  { id: "listing-1", url: "https://example.com/listing" },
  { maxPages: 20, maxDepth: 2 },
);

// manifest.seed              — { id, url } the crawl started from
// manifest.pages             — CrawlPageOutcome[] in BFS discovery order,
//                               each { url, depth, fetch: FetchResult, sourceRef? }
// manifest.warnings          — per-page warnings plus a cap-reached note when truncated
// manifest.truncated         — true if maxPages stopped the crawl before the
//                               frontier was exhausted
```

Cross-host links are never followed (a page whose own fetch redirects
off-host is still recorded, but its links stop the frontier there);
scheduling remains out of scope for this layer. Headless rendering now has
an opt-in seam a crawl seed can enable (see "Rendered fetch" below) —
`crawlSource` itself still implements no rendering of its own.

### Rendered fetch (opt-in `renderImpl` seam)

For an SPA/JS-rendered page whose real content only exists after client-side
JavaScript runs, plug in ANY renderer (Playwright, Puppeteer, a remote
rendering service, a test stub) via `FetchSourceOptions.renderImpl` and opt
the source in with `SourceConfig.render: true`. Traverse core takes no new
runtime dependency for this — you own the renderer.

```ts
import { fetchSource } from "@kontourai/traverse/fetch";
import type { RenderImpl } from "@kontourai/traverse/fetch";

// A minimal stub renderer — swap in Playwright/Puppeteer/a remote service.
const renderImpl: RenderImpl = async (url, { timeoutMs }) => {
  // ... navigate, wait for hydration, read the DOM ...
  return { html: "<html>...</html>" };
};

const result = await fetchSource(
  { id: "spa-page", url: "https://example.com/app", render: true },
  { renderImpl },
);

if (!result.error) {
  result.snapshot!.rendered; // true — the honest wire-vs-rendered marker
}
```

`render: true` with no `renderImpl` configured is a typed `invalid-config`
error, never a silent normal fetch. `robots.txt` is checked once against the
requested URL before `renderImpl` is ever invoked (renderImpl owns any
further client-side navigation itself). HTTP validators
(`etag`/`lastModified`/conditional GET) are skipped for a rendered fetch;
setting `revalidate: true` alongside `render: true` adds an explicit warning
rather than silently doing nothing. A `renderImpl` throw maps to
`kind: "adapter-error"`; a reported non-2xx `status` maps to
`kind: "http-error"` — no new `FetchErrorKind` is introduced. See
[`docs/decisions/rendered-fetch.md`](docs/decisions/rendered-fetch.md) for
the full rationale, including the `timeoutMs`-is-a-hint and
robots-per-hop-limit accepted scope limits.

### Capture & replay

Snapshots persist to a `SnapshotStore` (a filesystem implementation is bundled;
inject any other). `replaySource()` returns the latest snapshot as the **same**
`FetchResult` shape a live call returns, so downstream code is identical live vs.
replay:

```ts
import {
  fetchSource,
  createFilesystemSnapshotStore,
  replaySource,
} from "@kontourai/traverse/fetch";

const store = createFilesystemSnapshotStore({ root: ".snapshots" });

// Capture once (e.g. in a maintainer run):
const live = await fetchSource({ id: "listing-1", url: "https://example.com/listing" });
if (live.snapshot) await store.put(live.snapshot);

// Replay anywhere (e.g. in CI) — no network:
const replayed = await replaySource(store, "listing-1");
// replayed.snapshot!.fromCache === true; byte-identical body & bodyHash.
```

### One-call composition with provenance continuity

`fetchAndExtract()` wires fetch → content-prep → `extract()` in one call, and
threads a **snapshot-anchored `sourceRef`** into the extraction so every proposal
is traceable back to the exact bytes it came from:

```ts
import { fetchAndExtract, parseSnapshotSourceRef } from "@kontourai/traverse/fetch";

const result = await fetchAndExtract(
  { id: "listing-1", url: "https://example.com/listing" },
  {
    targetSchema,
    provider,                    // any ExtractionProvider (mock/Anthropic/...)
    store,                       // required for "replay" / "live-with-capture"
    mode: "live-with-capture",   // "live" | "replay" | "live-with-capture"
    pdfTextExtractor,            // optional — forwarded to extract() for a "pdf" snapshot; see PDF content-prep below
  },
);

// result.fetch       — the FetchResult (snapshot or typed error)
// result.extraction  — the ExtractionResult (absent if the fetch failed)
// result.sourceRef   — "traverse-snapshot:<id>?url=...&sha256=<bodyHash>&fetchedAt=<iso>"

const ref = parseSnapshotSourceRef(result.sourceRef!);      // { sourceId, url, bodyHash, fetchedAt }
const exactBytes = await store.get(ref!.sourceId, ref!.bodyHash); // the snapshot the proposals came from
```

Use `mode: "replay"` to run the identical extraction against a stored snapshot
with no network — the CI path. The bundled `createInMemorySnapshotStore()` is a
handy non-persistent store for tests and single-process capture-then-replay.

### Crawl + extract in one call

`crawlAndExtract(seed, opts)` is the multi-page analogue of `fetchAndExtract`:
it drives a **forage** crawl (`@kontourai/forage`'s frontier — same-host
discovery, sitemap, rendering, and SSRF-guarded egress all live there, not in
traverse) and runs `extract()` against every page the crawl returns, threading
each page's own `sourceRef` into its extraction result:

```ts
import { crawlAndExtract } from "@kontourai/traverse/fetch";

const result = await crawlAndExtract(
  { url: "https://example.com/listing" },        // forage Seed
  {
    targetSchema,
    provider,                                     // any ExtractionProvider (mock/Anthropic/...)
    policy: { maxPages: 20, maxDepth: 2 },        // forage CrawlPolicy — discovery, render, egress, replay store, ...
  },
);

// result.manifest        — forage's full CrawlManifest (pages, truncated, warnings)
// result.pages           — one { page, sourceRef, extraction } per crawled page, in manifest order
for (const p of result.pages) {
  p.sourceRef;             // forage's own citable snapshot pointer (forage-snapshot:...)
  p.extraction.proposals;  // that page's ExtractionProposal[], provenance-checked as usual
}
```

Budgets (`maxProviderCalls`/`maxTotalTokens`) apply **per page** as forwarded
to `extract()`; to bound the whole crawl, cap the frontier itself via
`policy.maxPages`. Like `fetchSource`/`crawlSource`, this never throws for an
operational failure — a bad page degrades to a warning in the manifest, and a
page whose extraction fails still appears in `pages` with that typed result
attached. For tests, inject `crawlImpl` to drive a deterministic manifest with
no network, mirroring `fetchOptions` on `fetchAndExtract`.

### Conditional GET (ETag / Last-Modified)

A snapshot stores the response `ETag` and `Last-Modified` validators when the
server sends them. Opt in to a **conditional GET** on a re-fetch (via a
`revalidate` flag plus a `store`) so an unchanged source comes back as a bodyless
`304` instead of re-downloading — completing the "URL recheck" story
([`docs/decisions/http-validators.md`](docs/decisions/http-validators.md)):

```ts
import { fetchSource, createFilesystemSnapshotStore } from "@kontourai/traverse/fetch";

const store = createFilesystemSnapshotStore({ root: ".snapshots" });

// First fetch captures whatever validators the server offers onto the snapshot.
const first = await fetchSource({ id: "listing-1", url });
if (first.snapshot) await store.put(first.snapshot); // s.etag / s.lastModified stored

// Later re-check: send If-None-Match / If-Modified-Since from the prior snapshot.
const again = await fetchSource({ id: "listing-1", url, revalidate: true }, { store });
if (again.snapshot?.notModified) {
  // 304 — the prior snapshot re-served (fromCache + notModified), zero body transfer.
  // Record a cheap "checked, still current" freshness event and move on.
  // Do NOT `store.put()` this snapshot: it is byte-identical to the prior one
  // (same fetchedAt + bodyHash) and a filesystem store would just overwrite the
  // original file in place. A 304 is a freshness signal, not a new capture.
}
```

Validators only make the **unchanged** case cheap; when a server offers none (or
there is no prior snapshot) the fetch proceeds normally and the existing
`bodyHash` (sha256) compare stays the drift signal. Check MECHANICS live here;
recheck ORCHESTRATION (when to check, recording drift) is the caller's.

### YouTube / transcript acquisition

`fetchYouTube` acquires a video's captions + metadata and returns them
**traverse-shaped** — a `Snapshot` carrying the RAW WebVTT
(`contentType: "transcript"`) plus a `metadata` sidecar — so `extract()` and a
knowledge kit's `ingest-source` consume it unchanged. content-prep's `vttToText`
cleans the VTT to plain transcript text (cue timings / headers / inline tags
stripped, overlapping auto-caption lines rolling-window-deduped, `en` preferred
over `en-orig`), so a proposal's `chars:<start>-<end>` locator anchors to the
CLEANED transcript exactly the way an html page's anchors to its Markdown. See
[`docs/decisions/transcript-content-type.md`](docs/decisions/transcript-content-type.md).

```ts
import { fetchYouTube } from "@kontourai/traverse/fetch";
import { prepareContent } from "@kontourai/traverse";

const result = await fetchYouTube({ id: "talk-1", url: "https://youtu.be/VIDEOID?si=track&t=42" });
if (result.error?.kind === "dependency-missing") {
  // yt-dlp not installed — an OPTIONAL binary dependency (like @anthropic-ai/sdk).
} else if (result.snapshot) {
  result.metadata;            // { videoId, url, title?, channel?, durationSeconds?, uploadDate?, timestampSeconds?, captionLang? }
  const { text } = prepareContent(result.snapshot.body, "transcript"); // cleaned transcript
}
```

`yt-dlp` is an **optional external binary**, detected at call time — a consumer
who never fetches transcripts pays nothing. Like `fetchSource`, `fetchYouTube`
**never throws**: a missing binary (`dependency-missing`), a tool failure
(`adapter-error`), or an unparseable URL (`invalid-url`) surface as typed
`FetchError`s. The **video id is the canonical identity** (`si=`/`is=` tracking
stripped, `t=` surfaced as metadata); politeness is **delegated to `yt-dlp`**
rather than double-governed by traverse's robots/per-host machinery. Inject a
fake `YtDlp` (`{ available, metadata, captions }`) for network-free tests.

## PDF content-prep (opt-in seam, no bundled parser)

`ContentType` includes `"pdf"`, but Traverse ships **no default PDF parser**
and takes **no new dependency** (hard or optional peer) for it — bundling one
would duplicate a parser a real regulated-document consumer already owns and
keeps in parity, rather than absorbing genuinely duplicated logic (the reason
this package absorbed HTML stripping in the first place). Instead, a caller
supplies a small `PdfTextExtractor` that wraps whatever PDF parser it already
has:

```ts
import { extract } from "@kontourai/traverse";
import type { PdfExtractedText, PdfTextExtractor } from "@kontourai/traverse";

const myExtractor: PdfTextExtractor = {
  // May be sync or return a Promise; extract() awaits either.
  async extract(bytes: Uint8Array): Promise<PdfExtractedText> {
    // Wrap your own parser here (e.g. one built on pdfjs-dist). Return the
    // WHOLE document's text plus, optionally, each page's 0-based start
    // offset into that text.
    const { text, pageOffsets } = await myOwnPdfParser(bytes);
    return { text, pageOffsets };
  },
};

const result = await extract({
  content: pdfBytes, // Uint8Array — e.g. Buffer.from(fs.readFileSync(path))
  contentType: "pdf",
  pdfTextExtractor: myExtractor,
  sourceRef: "upload:my-document.pdf",
  targetSchema,
  provider,
});
```

With `pdfTextExtractor` supplied, `extract()` runs it and hands the resulting
text into the **existing, unmodified** character-window chunker
(`prepareAndChunk(text, "text", ...)`) — PDF content-prep reuses 100% of the
already-tested chunking and `chars:<start>-<end>` provenance-verification
machinery HTML/text already use, with zero new chunking or locator code.
Proposals come back in the exact same `ExtractionResult` shape as HTML/text
extraction, with verified `chars:<start>-<end>` locators into the PDF's
prepared text.

**With no `pdfTextExtractor` supplied, behavior is completely unchanged**:
`contentType: "pdf"` still returns the pre-existing typed not-implemented
error, `proposals: []`, `providerCalls: 0`, `totalTokensUsed: 0` — every
existing caller is unaffected by this option's mere existence.

### `pdfPageOffsets` / `resolvePdfPage()`

When your extractor reports `pageOffsets` (each page's 0-based start offset
into the extracted text), `extract()` validates and attaches them as a
structured sidecar — `ExtractionResult.pdfPageOffsets` — mirroring the
`embedded` sidecar precedent
([ADR 0005](docs/adr/0005-embedded-state-sidecar.md)). Use `resolvePdfPage()`
to turn a proposal's verified locator start offset into a 1-based page
number:

```ts
import { resolvePdfPage } from "@kontourai/traverse";

const [, start] = result.proposals[0].provenance.locator.match(/^chars:(\d+)-/)!;
const page = resolvePdfPage(result.pdfPageOffsets, Number(start)); // e.g. 2
```

This is **not** a new locator scheme — `chars:<start>-<end>` still means
"offsets into the prepared text," exactly as it does for HTML/text
([ADR 0001 §4](docs/adr/0001-proposals-only.md)). `pdfPageOffsets` is an
additive sidecar on top of it. Full page/region locators (a distinct locator
scheme) remain deferred to a later slice. Note also that `pageOffsets` is
**trust-not-verify**: unlike `excerpt`, Traverse cannot independently confirm
page numbers against real PDF structure — it only checks the array is
well-formed (ascending, in-range) and drops it, with a warning, if not.

### Known asymmetry

Only `extract()` and the standalone `preparePdfText()` support the extractor
seam. `prepareContent(bytes, "pdf")` still always returns the typed
not-implemented error, even with an extractor available elsewhere in your
code — `prepareContent`'s signature was deliberately not changed to accept an
extractor, to avoid a sync-to-async breaking change to a widely-called
function. See [`docs/decisions/content-preparation.md`](docs/decisions/content-preparation.md)
for the full rationale and out-of-scope list.

Called standalone (not through `extract()`), `preparePdfText(bytes, extractor)`
defaults `maxChars` to 32,000 (the same default every other content-prep
function uses) — much smaller than the 5,000,000-char cap `extract()` passes
internally when it calls `preparePdfText` on your behalf, so a direct caller
who wants the whole document should pass `maxChars` explicitly.

## Image content-prep (opt-in OCR seam, no bundled OCR)

`ContentType` also includes `"png"` and `"jpeg"`. Traverse ships **no default
OCR implementation** and takes **no OCR/vision dependency** for these image
types. A caller supplies an `ImageTextExtractor` that wraps the OCR system it
already owns:

```ts
import { extract } from "@kontourai/traverse";
import type { ImageTextExtractor } from "@kontourai/traverse";

const myImageExtractor: ImageTextExtractor = {
  async extract(bytes: Uint8Array) {
    const text = await myOwnOcr(bytes);
    return { text, warnings: ["OCR output should be reviewed"] };
  },
};

const result = await extract({
  content: imageBytes, // Uint8Array
  contentType: "png",
  imageTextExtractor: myImageExtractor,
  sourceRef: "upload:document-image.png",
  targetSchema,
  provider,
});
```

With `imageTextExtractor` supplied, `extract()` hands the image bytes to the
OCR seam, then sends the returned text through the **existing text chunking and
proposal-normalization pipeline**. Excerpts still verify with the normal
`indexOf` mechanism and locators are still `chars:<start>-<end>` offsets into
the prepared OCR text. Because OCR text is lossier than parsed text, successful
OCR-derived results carry `ExtractionResult.ocrDerived === true` as an
additive presence marker, mirroring `Snapshot.rendered`.

With no `imageTextExtractor` supplied, image bytes return the normal typed
binary-content error with zero provider calls. Fetched PNG/JPEG snapshots are
captured as raw `bodyBytes`, so `fetchAndExtract()` can forward the same
extractor end-to-end for live or replayed snapshots.

## Grounded extraction benchmark

`npm run eval:grounded` runs the credential-free, deterministic gold corpus and
emits JSONL with exact-span precision/recall, value and type accuracy, grounding
failures, schema coverage, calls, tokens, latency, and typed failures. Every
record binds the corpus revision, task digest, package revision, provider,
model, and extraction configuration. The corpus covers repeated/shared spans,
invalid provider output, explicit and inferred values, chunk boundaries,
HTML/Markdown preparation, PDF page offsets, and OCR-derived text.

An optional non-hermetic provider can be supplied explicitly after building:

```sh
node evals/grounded-extraction/run.mjs \
  --provider-module ./local-provider.mjs \
  --model provider-model-id
```

The versioned corpus remains the gold oracle in both modes. See the
[benchmark decision](docs/decisions/grounded-extraction-benchmark.md) for the
evidence contract and known-limitation policy.

## Versioned task guidance and examples

Callers that need reproducible instructions or few-shot examples can create a
provider-neutral task spec. Examples are validated against the schema and their
prepared source text before any provider call; successful results carry the task
and example digests for audit.

```ts
import { createExtractionTaskSpec, extract } from "@kontourai/traverse";

const targetSchema = [{ path: "title", type: "string" as const }];
const taskSpec = createExtractionTaskSpec({
  version: "1.0.0",
  targetSchema,
  guidance: "Copy titles exactly as written.",
  examples: [{
    content: "Title: Alpine Week",
    proposals: [{
      fieldPath: "title",
      candidateValue: "Alpine Week",
      excerpt: "Alpine Week",
    }],
  }],
});

const result = await extract({
  content,
  contentType: "html",
  sourceRef,
  targetSchema,
  taskSpec,
  provider,
});
```

See the [versioned extraction tasks decision](docs/decisions/versioned-extraction-tasks.md)
for validation, compatibility, and digest boundaries.

## Requirements

- Node.js `>= 22`
- Optional peer dependency: `@anthropic-ai/sdk` (`>=0.20.0`), only if you use
  the `@kontourai/traverse/anthropic` adapter — see [Install](#install).
- License: Apache-2.0
