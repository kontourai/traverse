---
status: current
subject: Rendered Fetch
decided: 2026-07-07
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/41
  - kind: adr
    ref: docs/adr/0002-fetch-snapshot-slice2.md
---
# Rendered Fetch

## Decision

`fetchSource`/`crawlSource` (`@kontourai/traverse/fetch`) add an OPT-IN
`renderImpl` seam (issue #41) so a caller can ingest an SPA/JS-rendered page
without traverse core taking a browser dependency. Traverse ships zero new
runtime dependencies for this: a caller plugs in any renderer (Playwright,
Puppeteer, a remote rendering service, a test stub) that satisfies the
`RenderImpl` signature.

### 1. Render policy and compatibility

`SourceConfig.renderPolicy` is the orchestration control:

| Policy | Attempts | Validator rule | Selected result |
| --- | --- | --- | --- |
| `never` | One plain attempt | Exact-resource revalidation is unchanged | Plain result |
| `always` | One rendered attempt | Revalidation is suppressed; no validator-store read, conditional header, 304, or validator capture | Rendered result; a missing renderer is typed `invalid-config` |
| `on-shell-warning` | One plain attempt, then zero or one rendered attempt | Only the plain attempt may use validators; the render retry receives no revalidation state | A successful rendered snapshot wins; a failed or unavailable renderer falls back to the successful plain snapshot |

The deprecated `SourceConfig.render?: boolean` spelling remains compatible:
with no `renderPolicy`, `render: true` maps to `always` and `render: false` or
an absent value maps to `never`. When both keys are supplied, they must agree
semantically: `true` only agrees with `always`, and `false` only agrees with
`never`. All other combinations return a typed `invalid-config` result before
I/O. This is an additive, semver-minor API change; the legacy key is not
removed.

### 2. `RenderImpl` signature and the `timeoutMs` hint

```ts
type RenderImpl = (
  url: string,
  opts: { userAgent: string; timeoutMs: number },
) => Promise<RenderResult>;

interface RenderResult {
  html: string;
  finalUrl?: string;
  status?: number;
  warnings?: string[];
}
```

Unlike `FetchLike`, `fetchSource` does NOT wrap `renderImpl` in its own
timeout race — there is no `AbortSignal`/cancellation parameter. `timeoutMs`
is passed as a DOCUMENTED HINT the caller's implementation is responsible for
enforcing (e.g. a Playwright navigation timeout). This is a deliberate,
accepted scope limit, not an oversight: traverse core has no way to
cancel/abort a caller-owned rendering process (e.g. a headless browser
tab) the way it can abort its own `fetch()` call.

### 3. Robots ordering: checked once, before any render

`robots.txt` is checked EXACTLY ONCE, against the requested URL, before
`renderImpl` is ever invoked — reusing the same `loadRobots`/`isPathAllowed`
calls the wire-fetch redirect loop already uses (no re-implementation). A
robots-denied result never calls the injected `renderImpl`.

This is a NARROWER guarantee than plain `fetchSource`'s per-redirect-hop
check: a rendered fetch has no manual redirect loop for traverse to hook
per-hop checks into, since `renderImpl` (not traverse) owns all navigation
internally, including any client-side redirect it may follow. This is an
accepted, documented scope limit: robots is NOT re-checked against any
client-side redirect/navigation the renderer itself follows.

### 4. Snapshot shape and the `rendered` marker

A successful render becomes a normal `Snapshot`:

- `contentType` is always `"html"`.
- `body` = the rendered HTML (`renderResult.html`) verbatim.
- `bodyHash = sha256Hex(body)` — the SAME text hash domain every other
  non-binary snapshot already uses (see `docs/decisions/binary-snapshot-bodies.md`);
  no new hash domain is introduced for a rendered snapshot.
- `rendered: true` — an additive, presence-is-the-marker field (never
  explicit `false` on a wire snapshot), mirroring `bodyBytes` marking binary
  content and `notModified` marking a 304.
- `url = renderResult.finalUrl ?? requestedUrl` — mirrors what a plain
  fetch's `snapshot.url` records (the final URL the body actually came
  from).
- `status = renderResult.status ?? 200`.
- `redirects` stays UNSET for a rendered snapshot — traverse does not
  fabricate a redirect chain from something the renderer does not report.
  This is an accepted gap, not silently glossed over: a caller that needs
  the renderer's own navigation chain must get it from `renderResult`
  directly (out of scope for `Snapshot` itself).

### 5. Provenance / sourceRef: no change

`buildSnapshotSourceRef`/`parseSnapshotSourceRef` are NOT changed for this
seam — no new query param is added. The sourceRef contract already fully
identifies the exact bytes (`sourceId` + `url` + `sha256` + `fetchedAt`);
`store.get(sourceId, bodyHash)` returns the same snapshot, which already
carries `rendered` honestly. A sourceRef-embedded flag would be a second
place to keep in sync with the snapshot's own field, for no new capability.
If a future consumer needs render-provenance without a store round-trip
(e.g. a log/UI reading raw sourceRef strings with no snapshot access), that
is the trigger to revisit this — not built preemptively here.

### 6. Validators never enter a rendered attempt

HTTP validators (`etag`/`lastModified`/conditional GET) are skipped entirely
for every rendered attempt — a renderer has no real HTTP response headers to
report, so no `If-None-Match`/`If-Modified-Since` is sent and `etag`/
`lastModified` stay unset. This includes the second attempt under
`on-shell-warning`: stored validators and conditional headers belong only to
the initial plain attempt, and `revalidate` is suppressed before rendering.
A trustworthy plain `304 notModified` is final and never triggers rendering.
An explicit warning still records when revalidation was configured but is
inert for an `always` rendered fetch.

### 7. Headers and retries are also not forwarded — warn, don't silently drop

`RenderImpl` receives only `{ userAgent, timeoutMs }` (see decision 2) — there
is no headers parameter and no retry wrapper around the call. Two caller
config knobs are therefore INERT for a rendered fetch, same category as
`revalidate` above:

- `SourceConfig.headers` (any caller-supplied extra headers) are never
  forwarded to `renderImpl` — the renderer implementation owns its own
  request headers/auth entirely; traverse has no hook to inject them into a
  caller-owned rendering process.
- `SourceConfig.retries` never applies — `fetchSource`'s bounded/jittered
  retry loop (`requestWithRetries`) wraps only the direct `FetchLike` path; a
  `renderImpl` failure maps straight to `adapter-error` (decision 8 below)
  with no retry attempt.

Mirroring the `revalidate` treatment, `fetchSource` pushes an explicit
`FetchResult.warnings` note for each ONLY when the caller actually set
something — a caller-supplied non-empty `headers` object, and/or an explicit
`retries` value — never on `fetchSource`'s own internal defaults (e.g. the
`Accept` header it adds, or the default retry count when `retries` is left
unset). A rendered fetch configured with neither gets no such warning. As
with `revalidate`, this is a deliberate warn-and-document scope limit, not a
gap silently absorbed: header forwarding and a render-retry loop are both
explicitly out of scope for this seam (see Non-goals).

### 8. Error mapping — no new `FetchErrorKind`

- `renderImpl` throwing maps to the existing `adapter-error` kind — mirrors
  the yt-dlp external-tool-failure precedent (`src/fetch/youtube.ts`)
  verbatim: "the external acquisition tool ran but failed".
- `renderImpl` resolving with a `status` outside `[200, 300)` maps to the
  existing `http-error` kind with that `status` — mirrors the direct-fetch
  non-2xx branch.
- `render: true` with no `renderImpl` configured maps to `invalid-config`
  (see decision 1).
- Robots-denied still uses the existing `robots-denied` kind, checked before
  `renderImpl` runs at all (see decision 3).

No new `FetchErrorKind` value is introduced for render failures; the
exported union is unchanged from before this seam.

### 9. `crawlSource` composition

`render` joins the existing list of crawl-wide FETCH BEHAVIOR fields a
discovered page's `SourceConfig` inherits from the seed in `crawl.ts`
(alongside `minDelayMs`, `timeoutMs`, `retries`, `headers`, `userAgent`,
`respectRobots`, `revalidate` — see `docs/decisions/crawl-frontier.md`
decision 6). `renderImpl` itself needs no `crawl.ts` change: it already
flows through the existing `CrawlOptions.fetchOptions: FetchSourceOptions`
forwarding, unchanged. `discoverSameHostLinks` composes unchanged too — it
operates on `Snapshot.body` gated on `contentType === "html"`, both of which
a rendered snapshot satisfies exactly like a wire-fetched one.

This rendered-fetch slice did not add crawl/extract composition. Separately,
an exported `crawlAndExtract` has since shipped in `src/fetch/crawl-extract.ts`;
it composes `@kontourai/forage`'s crawl with `extract()`. That does not change
the caller-injected renderer boundary here: Traverse still bundles no browser
or renderer lifecycle and `crawlSource` remains a fetch-layer driver.

### 10. Shell classification, winner, fallback, and audit

`on-shell-warning` classifies a successful, fresh, unrendered HTML snapshot
during fetch orchestration, using the same bounded HTML preparation and
inspection path extraction uses. It escalates only for the exact pure warning
prefix `js-shell-suspected:`. The distinct
`js-shell-suspected-embedded-state-available:` warning defined by
[`ADR 0005`](../adr/0005-embedded-state-sidecar.md) does not escalate. Neither
do first-attempt errors, binary/text snapshots, already-rendered snapshots, or
trustworthy 304 results. Classification happens before extraction, so a
discarded plain shell never causes a provider pass.

The renderer is invoked at most once per public `fetchSource` call. Any
successful rendered snapshot wins regardless of its size or eventual proposal
count. Render failure or absence under `on-shell-warning` falls back to the
successful first snapshot; `always` without a renderer remains
`invalid-config`. `FetchResult.renderEscalation` is typed audit metadata, not a
second result bag. The selected top-level snapshot/error and warnings remain
authoritative. A discarded attempt's shell warnings are not merged into the
successful rendered attempt's extraction-facing warning channel, while
`firstSnapshotRef` and `renderError` make replacement or fallback auditable.

### 11. Cost guards and ownership

Rendering happens inside `acquire()` (`compose.ts`), strictly before the
resulting snapshot is handed to `extract()`. `maxProviderCalls`/
`maxTotalTokens` accounting is entirely `extract()`-side and never sees
whether a snapshot was rendered or wire-fetched — `compose.ts` needed no
code change for this seam.

Traverse owns deterministic attempt selection, but the caller owns renderer
cost and lifecycle. Traverse adds no browser dependency, passes the existing
`timeoutMs` hint, and never retries `renderImpl`; callers choose and pay for
Playwright, Puppeteer, a remote rendering service, or another implementation.

### 12. Consumer migration boundary

The policy seam is ready for the original downstream ingestion pipeline, its
check coordinator, and the check-runner package itself to forward policy and
consume Traverse's one selected result. Those migrations are follow-up lanes:
this change does not modify consumer repositories, preserve consumer-specific
telemetry shapes, or raise their Traverse dependency. Consumers should remove
local shell parsing, second-fetch coordination, and proposal-count winner rules
only when they adopt the minor release containing this seam.

## Non-goals (explicit, matching the issue)

- Shipping any Playwright/browser dependency in traverse core.
- Screenshot/visual capture.
- Auth/session flows.
- Adding crawl/extract composition to this rendered-fetch slice. A separate,
  exported `crawlAndExtract` in `src/fetch/crawl-extract.ts` has since shipped
  to compose `@kontourai/forage`'s crawl with `extract()`; that does not add a
  bundled browser or renderer lifecycle.
- Enforcing `timeoutMs` around `renderImpl` itself (see decision 2 — passed
  as a hint only).
- Re-checking robots against a renderer's own client-side navigation (see
  decision 3).
- Forwarding `SourceConfig.headers` to `renderImpl`, or retrying a
  `renderImpl` failure (see decision 7 — warn-and-document only).

## Boundary

Rendering MECHANICS (invoking a caller's `RenderImpl`, mapping its result
into a `Snapshot`) live in traverse; the renderer ITSELF (Playwright setup,
browser lifecycle, navigation strategy) is entirely the caller's — traverse
never instantiates or manages a browser.
