# Getting started

This guide takes you from install to a first extraction, then shows how to read
the result and what to do when a proposal goes missing. The
[README](../README.md) is the full behavior reference; the
[reference page](reference.md) lists every entry point.

## Requirements

- Node.js 22 or newer.
- An extraction provider. Traverse bundles adapters for Anthropic, OpenAI,
  Gemini, and Relay, each behind its own subpath, or you can write your own.

## Install

```sh
npm install @kontourai/traverse
```

Then install only the SDK for the adapter you use. Each is an optional peer
dependency:

| Adapter subpath | Peer to install | API key environment variable |
| --- | --- | --- |
| `@kontourai/traverse/anthropic` | `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` |
| `@kontourai/traverse/openai` | `openai` | `OPENAI_API_KEY` |
| `@kontourai/traverse/gemini` | `@google/genai` | `GEMINI_API_KEY` |
| `@kontourai/traverse/relay` | `@kontourai/relay` | none; you supply a Relay `ModelRuntime` |

Each SDK-backed adapter also accepts `apiKey` directly, or an injected `client`
for tests.

## Your first extraction

Describe the fields you want with a `TargetFieldSchema[]`. Traverse defines no
field names of its own: `path`, `description`, and `enumValues` mean whatever
your application says they mean.

```ts
import { extract } from "@kontourai/traverse";
import type { TargetFieldSchema } from "@kontourai/traverse";
import { createAnthropicExtractionProvider } from "@kontourai/traverse/anthropic";

const targetSchema: TargetFieldSchema[] = [
  { path: "title", type: "string", required: true, description: "The event name." },
  { path: "price", type: "number", inferenceType: "explicit" },
];

const result = await extract({
  content: "<h1>Spring Workshop</h1><p>Price: $45 per seat.</p>",
  contentType: "html",
  sourceRef: "https://example.test/events/spring",
  targetSchema,
  provider: createAnthropicExtractionProvider(),
});
```

`extract()` prepares the content (HTML becomes Markdown by default), splits it
into chunks when it is large, calls the provider, and then normalizes what the
provider returned. The `sourceRef` is your own identifier for the source; it is
carried onto the result.

## Read the result

Each entry in `result.proposals` is a reviewable record, not a decided value:

```ts
for (const proposal of result.proposals) {
  proposal.fieldPath;            // "title", a path from your targetSchema
  proposal.candidateValue;       // "Spring Workshop"
  proposal.provenance.excerpt;   // verbatim quote from the prepared text
  proposal.provenance.locator;   // "chars:2-17", offsets into the prepared text
  proposal.evidenceMatch;        // deterministic checks on the value
}
```

The locator points into the *prepared* text, not your raw HTML. Here the
prepared text is the Markdown `# Spring Workshop…`, so the title starts at
offset 2. To keep that text for later verification, pass a prepared-artifact
store; see [Resolving exact prepared text](../README.md#resolving-exact-prepared-text).

The result also reports what the run cost and anything it noticed:

- `result.warnings`: dropped or adjusted proposals, and notes from the provider.
- `result.error`: set when a stage failed. `extract()` does not throw for
  provider, parse, or content-preparation failures.
- `result.providerCalls` and `result.totalTokensUsed`: always present, even
  when they are zero.
- `result.partial` and `result.coverage`: present when part of the prepared
  text was not read or not fully answered.

Traverse never picks a winner. When two proposals disagree, both reach your
review step, and your policy decides what to accept.

## Try it without an API key

Any object with a `name` and an `extract()` method is a provider, which makes
tests deterministic:

```ts
import type { ExtractionProvider } from "@kontourai/traverse";

const provider: ExtractionProvider = {
  name: "example-provider",
  async extract() {
    return {
      proposals: [{
        fieldPath: "title",
        candidateValue: "Spring Workshop",
        provenance: { excerpt: "Spring Workshop", locator: "provisional" },
        extractor: "example-provider",
      }],
      raw: { response: "{}", model: "example-model" },
    };
  },
};
```

`extract()` replaces the provisional `locator` with one it derives from the
verified excerpt.

## Fetch the content first

The `@kontourai/traverse/fetch` subpath fetches a page, captures a snapshot, and
can replay that snapshot later without the network. `fetchAndExtract()` does
fetch and extraction in one call. It passes a snapshot-anchored `sourceRef` into
the extraction, so the result's `sourceRef` names the exact snapshot bytes:

```ts
import type { TargetFieldSchema } from "@kontourai/traverse";
import { createAnthropicExtractionProvider } from "@kontourai/traverse/anthropic";
import { createFilesystemSnapshotStore, fetchAndExtract } from "@kontourai/traverse/fetch";

const targetSchema: TargetFieldSchema[] = [
  { path: "title", type: "string", required: true, description: "The event name." },
];
const provider = createAnthropicExtractionProvider();
const store = createFilesystemSnapshotStore({ root: ".snapshots" });

const result = await fetchAndExtract(
  { id: "spring-workshop", url: "https://example.com/events/spring" },
  { targetSchema, provider, store, mode: "live-with-capture" },
);

result.fetch;                   // the snapshot, or a typed fetch error
result.extraction?.proposals;   // absent when the fetch failed
result.sourceRef;               // "traverse-snapshot:spring-workshop?url=…&sha256=…&fetchedAt=…"
result.extraction?.sourceRef;   // the same ref, carried on the ExtractionResult
```

This snippet uses the Anthropic adapter, so it needs `@anthropic-ai/sdk` installed and either `ANTHROPIC_API_KEY` set or an `apiKey` option passed. Any other provider works the same way.

Proposals themselves carry no `sourceRef`; read it from the result. Run the same call with `mode: "replay"` in CI to extract from the stored
snapshot with no network. See
[Fetching & snapshots](../README.md#fetching--snapshots-kontouraitraversefetch).

## Troubleshooting

Every warning below is a string in `result.warnings`.

| Symptom | Cause | What to do |
| --- | --- | --- |
| `dropped proposal for "<field>": excerpt not found in prepared content` | The provider's excerpt is not an exact substring of the prepared text: a paraphrase, a reformat, or a quote from your raw HTML instead of the Markdown. | Prompt for verbatim quotes, or compare against `prepareContent()` output. Traverse never assigns an approximate offset. |
| `dropped proposal for unknown fieldPath "<path>" (not in targetSchema)` | The provider returned a field you did not declare. | Declare it, or ignore the drop. Indexed paths such as `items[0].name` are accepted when `items[].name` is declared. |
| `response truncated at maxTokens; proposals may be incomplete` | The provider's answer hit its output cap. | Raise the adapter's `maxTokens`, or lower `chunkSize`. The run is marked partial. |
| `provider returned no extraction tool call` | The model answered without calling the extraction tool. | Retry, or try another model. The run is marked partial. |
| A warning starting `js-shell-suspected:` | The HTML looks like an unrendered single-page-app shell. | Render the page upstream and retry. See [SPA / JS-rendered pages](../README.md#spa--js-rendered-pages). |
| A warning starting `js-shell-suspected-embedded-state-available:` | Same shell, but the page carried machine-readable state. | Read `result.embedded` instead of rendering. |
| `result.error` is set and `proposals` is empty | Every provider call failed (for example, no API key), or the input or configuration was invalid. | Read `result.error` and `result.providerFailures`, which carry a failure `kind` and `retryable`. |
| `contentType: "pdf"`, `"png"`, or `"jpeg"` returns an error | Traverse bundles no PDF parser or OCR. | Pass `pdfTextExtractor` or `imageTextExtractor`. See [PDF content-prep](../README.md#pdf-content-prep-opt-in-seam-no-bundled-parser). |
| A run stops early with `stopped after N provider call(s)` | A `maxProviderCalls` or `maxTotalTokens` ceiling was reached. | Raise the ceiling, or accept the partial result. See [Cost guards](../README.md#cost-guards). |
