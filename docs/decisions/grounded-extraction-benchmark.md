---
status: current
subject: Grounded extraction benchmark
decided: 2026-07-20
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/61
  - kind: doc
    ref: evals/grounded-extraction/corpus.v1.json
  - kind: doc
    ref: evals/grounded-extraction/run.mjs
---

# Grounded extraction benchmark

Traverse maintains a provider-neutral benchmark under `evals/grounded-extraction/`.
Its versioned corpus is the gold oracle; providers, models, and comparison
adapters are never the oracle. The ordinary lane is deterministic,
credential-free, and emits stable JSONL. Optional live runs require an explicit
provider module and model and are non-hermetic.

Each case records the corpus revision, task digest, provider/model identity,
exact-span and value quality, type validity, grounding failures, schema
coverage, calls, tokens, latency, and typed failures. The corpus deliberately
retains known limitations as measured results. In particular, identical
excerpts at distinct source locations expose the current first-occurrence
locator behavior instead of allowing aggregate scores to conceal it.

Run the hermetic lane with:

```sh
npm run eval:grounded
```

Run an optional live adapter with:

```sh
npm run build --silent
node evals/grounded-extraction/run.mjs --provider-module ./local-provider.mjs --model provider-model-id
```

The provider module must export `default` or `provider` with the normal
`ExtractionProvider.extract()` contract. Live output is evidence only when its
provider, model, corpus revision, task digests, calls, tokens, and latency remain
attached.
