# @kontourai/traverse

Schema-directed content extraction that produces **provenance-bearing,
review-ready extraction proposals** in Survey's shape.

Traverse takes prepared content (HTML or text) plus a caller-supplied list of
target fields, asks a pluggable extraction provider to propose field values,
and normalizes those into `ExtractionProposal[]` — each one a reviewable record
carrying a verbatim `excerpt` and a `locator`. Traverse is a **proposer only**:
it never resolves a value, never crawls, never ranks, and never owns review
policy. See [`docs/adr/0001-proposals-only.md`](docs/adr/0001-proposals-only.md).

## Install

```sh
npm install @kontourai/traverse
```

The Anthropic adapter needs the SDK as an optional peer dependency — install it
only if you use that adapter:

```sh
npm install @anthropic-ai/sdk
```

Traverse has **zero runtime dependencies** of its own.

## The provenance contract

Every `ExtractionProposal` carries required `provenance`, and `extract()`
**enforces** it — not just requires its presence:

- **`excerpt`** — a verbatim quote against the **CONTENT-PREPARED text**
  `extract()` hands to the provider (the output of `content-prep.ts`: tags
  stripped, entities decoded, whitespace collapsed, truncated to
  `maxContentChars`) — **not** the caller's raw HTML/source document. A
  proposal without an excerpt is not something Traverse emits.
- **Occurrence is checked, not assumed.** `extract()`'s normalization step
  verifies `excerpt` actually occurs in that prepared text via
  `String.prototype.indexOf`. A proposal whose excerpt cannot be found there is
  **dropped** with the warning `"excerpt not found in prepared content"` — an
  LLM that paraphrases, translates, or reformats instead of quoting verbatim
  produces no proposal, not a false one.
- **`locator`** — a fixed, defined scheme: `"chars:<start>-<end>"`, where
  `<start>`/`<end>` are 0-based UTF-16 code-unit offsets of the *first*
  `indexOf` match of `excerpt` within the prepared text. `extract()` always
  derives/overwrites `locator` itself from the verified offset — a
  provider/adapter-supplied `locator` is never trusted as-is, because only
  `extract()` holds the prepared text needed to verify one.

Because the excerpt and the offsets it implies are anchored to the
**prepared** text and not the caller's original document, a consumer that
wants to highlight/locate an excerpt in the raw source must re-run the same
content-prep step (or an equivalent) to reproduce the text those offsets refer
to, or map prepared-text offsets back to raw-document offsets itself. Traverse
does not do that mapping.

Because provenance is required on the type itself AND enforced by
normalization, the whole package is structurally a provenance-bearing-proposal
producer — this is its identity, not a convention.

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
  content: "<h1>Beginner Bouldering Session</h1>",
  contentType: "html",
  sourceRef: "https://example.test/schedule",
  targetSchema,
  provider,
});

// result.proposals[0].provenance.locator === "chars:0-27" — extract() verified
// the excerpt against the prepared text ("Beginner Bouldering Session", the
// <h1> stripped to text) and derived the offset itself.
// result.proposals — normalized, provenance-bearing proposals
// result.raw       — the provider's raw response, for audit
// result.error     — set (never thrown) if a stage failed
// result.warnings  — merged provider + normalization notes (dropped/adjusted proposals)
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

The adapter's own synthesized/provided `locator` on each proposal is
**provisional** — `extract()`'s normalization step is the sole owner of the
final `locator` value, which it derives from a verified excerpt offset (see
"The provenance contract" above). This applies to any provider, not just the
Anthropic adapter: `extract()` re-derives every proposal's locator itself.

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
has **zero runtime dependencies** (global `fetch` + `node:crypto`/`node:fs`).

Out of scope for this layer (see
[`docs/slice-3-candidates.md`](docs/slice-3-candidates.md)): multi-page
link-following / crawl frontier, headless-browser rendering, and scheduling.

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
  console.error(result.error.kind, result.error.message);
} else {
  const s = result.snapshot!;
  // s.url (final, post-redirect), s.status, s.contentType, s.body,
  // s.bodyHash (sha256), s.redirects?, s.fetchedAt
}
```

**Robots & politeness.** With `respectRobots` (default `true`), `/robots.txt` is
fetched for your `User-Agent` before the request and any redirect hop; a
disallowed path returns `kind: "robots-denied"` and the page is never fetched.
If `/robots.txt` is itself unreachable or 5xx, the fetch **fails open** with a
warning (a single-page fetch should not be blocked by robots *infra* problems —
see [`docs/adr/0002`](docs/adr/0002-fetch-snapshot-slice2.md)). Politeness is a
per-host minimum delay, enforced in-process.

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

## PDF is deferred

`ContentType` already includes `"pdf"` so callers can pass it through a stable
union today, but PDF content-prep is **not implemented at `0.1.0`** — it returns
a typed error rather than attempting to decode bytes. HTML and text are fully
supported.

## Requirements

- Node.js `>= 22`
- License: Apache-2.0
