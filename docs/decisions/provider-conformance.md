---
status: current
subject: Extraction provider conformance
decided: 2026-07-19
evidence:
  - kind: doc
    ref: src/provider-conformance.ts
  - kind: doc
    ref: tests/provider-conformance.test.ts
---

# Extraction provider conformance

## Decision

Bundled adapters implement one provider-neutral `ExtractionProvider` contract
and declare capabilities for structured output, exact excerpts, task specs,
usage, and warnings. The extraction core rejects a missing required declared
capability before issuing a call. Capability metadata remains optional for
existing injected providers, preserving their behavior.

Anthropic, OpenAI, and Gemini are isolated optional subpath adapters. Each maps
its native forced-function response, finish reason, and usage accounting into
the same proposal parser and then the same core grounding normalization. No
adapter is selected by the core and adding one does not create a default.

Provider exceptions are classified into authentication, rate-limit, timeout,
invalid-request, unavailable, or unknown failures with an explicit retryable
flag. The original exception is retained unchanged as `native`; normalization
adds control-flow semantics and never replaces diagnostic evidence.

## Verification

The deterministic conformance suite runs the same schema, versioned task,
fixture, expected proposal, locator, and token accounting across every bundled
adapter through injected clients. The benchmark's existing optional provider
module lane supplies live quality/cost comparison under the same corpus and
task revisions without making credentials part of the hermetic gate.

## Dependency boundary

Core imports no provider SDK. Adapter SDKs are optional peers loaded dynamically
only when a caller does not inject a client. Provider-specific credentials,
models, endpoints, response types, and diagnostics stay inside their subpaths.
