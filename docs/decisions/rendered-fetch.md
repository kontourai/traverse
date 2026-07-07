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

### 1. Two-key opt-in gate

The seam is gated by TWO keys, an exact structural mirror of the existing
`SourceConfig.revalidate` + `FetchSourceOptions.store` pattern:
`SourceConfig.render?: boolean` (the source opts in) AND
`FetchSourceOptions.renderImpl?: RenderImpl` (the caller configures a
renderer). `fetchSource` never renders unless BOTH are set. `render: true`
with no `renderImpl` configured is a typed `invalid-config` error
("SourceConfig.render is true but no FetchSourceOptions.renderImpl is
configured") — never a silent fall-through to a normal HTTP fetch, mirroring
the `mode: "replay"` + no `store` precedent in `compose.ts`/`crawl.ts`.

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

### 6. Validators skipped, with an explicit warning on the config mistake

HTTP validators (`etag`/`lastModified`/conditional GET) are SKIPPED entirely
for a rendered fetch — a renderer has no real HTTP response headers to
report, so no `If-None-Match`/`If-Modified-Since` is ever sent and
`etag`/`lastModified` stay unset on the resulting snapshot. When a caller
sets BOTH `render: true` AND `revalidate: true`, `fetchSource` pushes an
explicit `FetchResult.warnings` note ("revalidation has no effect for a
rendered fetch...") rather than silently ignoring the combination — masking
that config mistake would be worse than a normal, unconditional render.

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

### 10. Cost guards untouched

Rendering happens inside `acquire()` (`compose.ts`), strictly before the
resulting snapshot is handed to `extract()`. `maxProviderCalls`/
`maxTotalTokens` accounting is entirely `extract()`-side and never sees
whether a snapshot was rendered or wire-fetched — `compose.ts` needed no
code change for this seam.

## Non-goals (explicit, matching the issue)

- Shipping any Playwright/browser dependency in traverse core.
- Screenshot/visual capture.
- Auth/session flows.
- A `crawlAndExtract`-style new composition — crawl stays fetch-layer-only,
  unchanged from `docs/decisions/crawl-frontier.md`.
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
