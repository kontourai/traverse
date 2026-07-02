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

Every `ExtractionProposal` carries required `provenance`:

- **`excerpt`** — the verbatim span of source text the value was drawn from. A
  proposal without an excerpt is not something Traverse emits; `extract()` drops
  any provider output that lacks one.
- **`locator`** — a source locator string. The scheme intentionally reuses
  Survey's `LocatorScheme` vocabulary (`"html"` / `"text"` / `"pdf"`), so a
  caller building a Survey `RawSource.locatorScheme` or `Extraction.locator`
  from `provenance.locator` needs **no translation table**. When a provider
  omits a locator, Traverse synthesizes `"<contentType>:field:<fieldPath>"`.

Because provenance is required on the type itself, the whole package is
structurally a provenance-bearing-proposal producer — this is its identity, not
a convention.

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
          provenance: { excerpt: "Beginner Bouldering Session", locator: "html:field:title" },
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

// result.proposals — normalized, provenance-bearing proposals
// result.raw       — the provider's raw response, for audit
// result.error     — set (never thrown) if a stage failed
// result.warnings  — notes for any dropped/clamped proposals
```

`extract()` **never throws** for provider, parse, or content-prep failure. Any
stage error surfaces as `result.error` with an empty `proposals` array.

## Normalization semantics

`extract()` runs content-prep, calls `provider.extract()`, then strictly
normalizes proposals:

- proposals lacking a provenance `excerpt` are dropped (with a warning),
- `confidence` is clamped into `0..1` (a non-finite confidence drops the item),
- a `fieldPath` not present in your `targetSchema` is dropped (with a warning),
- an empty `extractor` identity drops the item.

Dropped/adjusted items are reported in `result.warnings`.

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
malformed items (no excerpt, out-of-range confidence, missing field) are
dropped, never silently accepted. For tests, inject a client:
`createAnthropicExtractionProvider({ client })`.

### Model override

`opts.model` overrides the default alias (`claude-sonnet-4-6`) without any API
change, and is reflected in `provider.name`
(`anthropic-extraction-provider:<model>`).

## PDF is deferred

`ContentType` already includes `"pdf"` so callers can pass it through a stable
union today, but PDF content-prep is **not implemented at `0.1.0`** — it returns
a typed error rather than attempting to decode bytes. HTML and text are fully
supported.

## Requirements

- Node.js `>= 22`
- License: Apache-2.0
