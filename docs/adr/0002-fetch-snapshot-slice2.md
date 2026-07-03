> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0002 — Fetch/snapshot foundation (Slice 2)

Status: Accepted (2026-07-02). Original decision record for Traverse's fetch
side, delivered standalone-first alongside the Slice-1 extraction core.

## §1 Context

Slice 1 shipped the EXTRACT side: schema-directed, provenance-bearing proposals
from already-prepared content. Slice 2 adds the FETCH side — getting that
content in the first place — as a **standalone-first** capability: it must
provide value on its own (configurable single-page fetch + snapshot capture for
replay) and only *later* compose with `extract()`. The owner's framing is
"building out our crawlers to be more easily configured"; this slice makes a
single fetch configurable and replayable without pulling in a crawler.

Deliberately **out of scope** (recorded as slice-3 candidates in
`docs/slice-3-candidates.md`): multi-page link-following / crawl frontier,
headless-browser rendering, and scheduling.

## §2 Decisions

### D1 — Never throws; typed errors on the result

`fetchSource()` and `replaySource()` never throw for an operational outcome.
Timeouts, retry exhaustion, robots denial, HTTP errors, redirect loops, and bad
config surface as `FetchResult.error`, with `snapshot` absent — the same
discipline as `ExtractionResult.error` (ADR 0001 §4).

The one deliberate refinement over the extraction side: the error is a
**structured, discriminated** `FetchError` (`{ kind, message, status? }`), not a
bare string, so a caller can branch on the failure class (`timeout` vs
`robots-denied` vs `http-error`) without string-matching. The extraction side's
`error: string` predates this and is left unchanged; new surface gets the richer
shape.

### D2 — Export shape: a `/fetch` subpath

The fetch surface is exported from `@kontourai/traverse/fetch`, mirroring the
established `@kontourai/traverse/anthropic` subpath discipline. Rationale:

- The package **root** stays focused on the proposals-only extraction identity
  (`extract()`, content-prep, core types) and re-exports **none** of the fetch
  surface. A consumer who only extracts imports nothing from the fetch side.
- Fetching is a distinct concern with its own vocabulary (`SourceConfig`,
  `Snapshot`, `SnapshotStore`); a subpath keeps that vocabulary from crowding
  the root's small, stable API.
- The composition helper `fetchAndExtract` lives under `/fetch` too — it is
  fetch-initiated and simply threads a snapshot into the already-public
  `extract()`, so it belongs with the side that owns the new concern rather than
  at the root.

Both fetch and the extraction core remain **zero-runtime-dependency**
(`node:crypto`/`node:fs` built-ins + global `fetch`); the subpath split is about
API cohesion, not about shielding an optional peer dep (that is the `/anthropic`
subpath's job).

### D3 — Robots: respected by default, fail-open on retrieval error

`respectRobots` defaults to `true`. Before fetching a URL (and before following
any redirect hop), `/robots.txt` is fetched for the configured `User-Agent` and
its `Disallow`/`Allow` group honored. A disallowed path returns
`kind: "robots-denied"` and the page is never fetched.

**Fail-open choice:** when `/robots.txt` is itself unreachable (network error,
timeout) or returns 5xx/429, the fetch **proceeds with a warning** rather than
hard-failing. A single-page fetch should not be blocked by robots *infra*
problems; a 4xx (typically 404) means "no restrictions" and also proceeds. RFC
9309's stricter reading (5xx ⇒ treat as disallow-all) and a configurable
fail-closed mode are recorded as slice-3 candidates. The robots matcher itself
is intentionally minimal (product-token group selection, longest-prefix
Allow/Disallow, Allow-wins-tie); crawl-delay, sitemaps, and the `*`/`$` pattern
language are slice-3 candidates.

### D4 — Politeness: per-host min-delay, process-wide

Each `SourceConfig` carries a per-host `minDelayMs` (default 1000ms). `fetchSource`
enforces at least that gap between the end of one request to a host and the
start of the next to the *same* host, tracked in a process-wide ledger (a
`Map<host, lastFinishedMs>`), injectable for isolation/testing. This is
deliberately in-process and best-effort — cross-process/distributed politeness
is a scheduler concern (slice 3).

### D5 — Retries: bounded and jittered

`retries` (default 2, hard-capped at 5) applies to *retryable* failures only:
network errors, timeouts, HTTP 429, and HTTP 5xx. 4xx (except 429) is not
retried. Backoff is exponential with full jitter. Every retry is recorded as a
warning so an eventually-successful fetch still shows what it took.

### D6 — Redirects: manual, bounded, chain-captured

Redirects are followed manually (`redirect: "manual"`) up to 5 hops so the
snapshot can record the exact redirect chain and the true final URL, and so
robots can be re-checked at each hop's host. Exceeding the bound returns
`kind: "too-many-redirects"`.

### D7 — Provenance continuity via a snapshot-anchored `sourceRef`

`fetchAndExtract` threads a `sourceRef` built from the snapshot's identity into
`extract()`:

```
traverse-snapshot:<sourceId>?url=<final-url>&sha256=<bodyHash>&fetchedAt=<iso>
```

`parseSnapshotSourceRef` recovers `{ sourceId, url, bodyHash, fetchedAt }`, and
`store.get(sourceId, bodyHash)` returns the byte-identical snapshot the
proposals were drawn from. This is the fetch-side analogue of the extraction
side's enforced excerpt provenance: a proposal is traceable to the exact bytes.
The extraction core's types are left untouched — continuity is owned by the
composition layer, not bolted onto `extract()`.

### D8 — Snapshot = the unit of replay; resolved content type

A `Snapshot` stores the **resolved** Traverse `ContentType` (html/text/pdf),
decided from the caller hint or the response header at fetch time, so replay and
extraction are deterministic and need no re-sniffing. `bodyHash` is the SHA-256
of the UTF-8 body — the byte-identity fingerprint that makes "same snapshot ⇒
byte-identical prepared content" checkable.

## §3 Consequences

- CI and any offline run use `mode: "replay"` and never touch the network; live
  vs. replay downstream code is identical (same `FetchResult` shape).
- The whole fetch module is exercised in tests via injected `fetch`/time seams —
  no test hits the network or a real timer.
- The package keeps zero runtime dependencies.
