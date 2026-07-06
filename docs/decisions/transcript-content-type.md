---
status: current
subject: YouTube / transcript (WebVTT) content type
decided: 2026-07-05
evidence:
  - kind: issue
    ref: https://github.com/kontourai/traverse/issues/31
  - kind: adr
    ref: docs/adr/0001-proposals-only.md
---
# YouTube / transcript (WebVTT) content type

## Decision

Traverse gains a `"transcript"` `ContentType` and a YouTube acquisition adapter
(`@kontourai/traverse/fetch` → `fetchYouTube`). Acquisition + preparation of
captioned video is on traverse's side of the product boundary — `fetch/` and
content-prep are already this repo's territory; the Knowledge Kit stages and
recalls and must not grow its own fetch stack (issue #31).

- **Acquire.** `fetchYouTube` shells out to `yt-dlp` (an OPTIONAL external
  binary, the same optional-dependency posture as the Anthropic SDK — detected,
  and DEGRADED to a typed `dependency-missing` FetchError when absent) for
  auto/manual captions plus metadata (id, title, channel, duration, upload
  date). The parsed **video id is the canonical identity**; `si=`/`is=` tracking
  params are stripped and `t=` is surfaced as metadata, never identity. Output
  is traverse-shaped — a `Snapshot` carrying the RAW VTT (`contentType:
  "transcript"`) plus a `metadata` sidecar — so `extract()` and the kit's
  `ingest-source --kind transcript` consume it unchanged.
- **Prep.** `vttToText` (content-prep) cleans WebVTT to plain transcript text:
  strip cue timings / `WEBVTT`/`Kind:`/`Language:`/`NOTE` headers / inline cue
  tags, decode common entities, and rolling-window-dedupe the overlapping lines
  auto-captions emit. The snapshot stores RAW VTT and prep cleans on demand,
  mirroring the raw-HTML → Markdown split, so a proposal's `chars:<start>-<end>`
  locator anchors to the CLEANED transcript exactly as it anchors to an html
  page's Markdown. Promoted from the one-off session script proven on three real
  videos in the 2026-07-04 knowledge-kit dogfood (kontourai/ops#72).

## Boundary (ADR 0001)

The adapter ACQUIRES and PREPARES only — it stages no knowledge, owns no review,
defines no field vocabulary. The knowledge store keeps the manifest record and
copies staged bytes into its own CAS; this snapshot store stays operational,
replayable, and prunable. Politeness is DELEGATED to `yt-dlp` (its own
acquisition channel) rather than double-governed by traverse's robots/per-host
delay machinery.
