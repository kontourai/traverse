/**
 * YouTube / transcript acquisition — a fetch adapter that shells out to `yt-dlp`
 * to acquire a video's auto/manual captions (as WebVTT) plus its metadata, and
 * returns them TRAVERSE-SHAPED: a `FetchResult` whose `Snapshot` carries the RAW
 * VTT (`contentType: "transcript"`), so content-prep's `vttToText` cleans it and
 * an extraction proposal's `chars:<start>-<end>` locator anchors to the cleaned
 * transcript — identical to how an `"html"` snapshot's proposals anchor to its
 * Markdown. The kit's `ingest-source --kind transcript` and `extract()` therefore
 * both consume the output unchanged (issue #31).
 *
 * BOUNDARY (docs/adr/0001-proposals-only.md): this adapter ACQUIRES and PREPARES
 * only. It stages no knowledge, owns no review, defines no field vocabulary — it
 * hands back a snapshot + metadata and stops. The knowledge store keeps the
 * manifest record and copies staged bytes into its own CAS; this snapshot store
 * stays operational / replayable / prunable (kontourai/ops#72).
 *
 * OPTIONAL DEPENDENCY, same posture as the Anthropic SDK: `yt-dlp` is an optional
 * external binary, NOT a bundled dependency. Its presence is DETECTED
 * (`YtDlp.available()`); when it is absent, `fetchYouTube` DEGRADES to a typed
 * `dependency-missing` FetchError rather than throwing — a consumer that never
 * fetches transcripts pays nothing. NEVER THROWS, mirroring `fetchSource`: a
 * missing binary, a tool failure, or an unparseable URL all surface as a typed
 * `FetchError` on the result.
 *
 * POLITENESS: unlike `fetchSource`, this adapter does NOT run robots.txt / per-
 * host delay / retry logic. `yt-dlp` is its own acquisition channel with its own
 * rate handling and its own relationship to the site; the adapter deliberately
 * DELEGATES politeness to it rather than double-governing it (issue #31).
 *
 * TESTABILITY: the whole `yt-dlp` seam is the injectable {@link YtDlp} interface
 * (`available`/`metadata`/`captions`), exactly the way the Anthropic adapter
 * injects a messages client — tests pass a fake and never spawn a subprocess or
 * touch the network. The default implementation ({@link createDefaultYtDlp})
 * shells out to a real `yt-dlp` binary and is the only untested-by-unit part,
 * mirroring the untested `globalThis.fetch` default of `fetchSource`.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sha256Hex } from "./fetch-source.js";
import type { FetchResult, Snapshot } from "./types.js";

const execFileAsync = promisify(execFile);

/** Canonical watch-URL host + path prefix every acquired transcript is keyed to. */
const CANONICAL_WATCH_PREFIX = "https://www.youtube.com/watch?v=";

/**
 * A caller-owned description of one YouTube source to acquire. Deliberately
 * NARROWER than {@link SourceConfig}: the http-only knobs (politeness, timeout,
 * retries, robots) do not apply here — `yt-dlp` owns acquisition politeness.
 */
export interface YouTubeSourceConfig {
  /** stable, caller-owned identity for this source — groups snapshots in the store. */
  id: string;
  /**
   * Any YouTube URL form: `watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`,
   * `/live/`, with or without tracking (`si=`/`is=`) and a `t=` start time. The
   * VIDEO ID is the canonical identity; tracking params are stripped and `t=` is
   * surfaced as metadata, never identity (issue #31).
   */
  url: string;
}

/**
 * Metadata acquired for one video. `videoId` is the canonical identity (parsed
 * from the URL, cross-checked against `yt-dlp`); every other field is best-effort
 * — `yt-dlp` may not report all of them, so they are optional.
 */
export interface YouTubeVideoMetadata {
  /** canonical identity: the parsed video id (tracking params stripped). */
  videoId: string;
  /** the normalized canonical watch URL: `https://www.youtube.com/watch?v=<id>`. */
  url: string;
  title?: string;
  channel?: string;
  /** duration in whole seconds, when reported. */
  durationSeconds?: number;
  /** upload date as `yt-dlp` reports it (`YYYYMMDD`), when present. */
  uploadDate?: string;
  /**
   * The `t=` start timestamp from the input URL in whole seconds, surfaced as
   * METADATA (a deep-link offset), never part of identity — two links to the
   * same video at different `t=` are the same source.
   */
  timestampSeconds?: number;
  /**
   * Which caption track fed the snapshot's VTT — the language tag `yt-dlp`
   * reported for it (e.g. `"en"`, `"en-orig"`). Absent when no caption track was
   * available.
   */
  captionLang?: string;
}

/** A `FetchResult` extended with the acquired {@link YouTubeVideoMetadata}. */
export interface YouTubeFetchResult extends FetchResult {
  /** acquired video metadata — present whenever a snapshot was produced. */
  metadata?: YouTubeVideoMetadata;
}

/** One caption track `yt-dlp` produced: its language tag and raw WebVTT text. */
export interface YtDlpCaptionTrack {
  /** the language tag from the track (e.g. `"en"`, `"en-orig"`, `"en-US"`). */
  lang: string;
  /** the raw WebVTT body — cleaned to transcript text later by `vttToText`. */
  vtt: string;
}

/** Best-effort metadata `yt-dlp` reports for a video. Every field is optional. */
export interface YtDlpMetadata {
  id?: string;
  title?: string;
  channel?: string;
  /** duration in whole seconds. */
  duration?: number;
  /** upload date, `YYYYMMDD`. */
  uploadDate?: string;
}

/**
 * The injectable `yt-dlp` seam. The default ({@link createDefaultYtDlp}) shells
 * out to the real binary; tests inject a fake so no subprocess or network is
 * touched. Mirrors the Anthropic adapter's injected messages-client seam.
 */
export interface YtDlp {
  /** whether the `yt-dlp` binary is present/runnable. Must not throw — returns false on any failure. */
  available(): Promise<boolean>;
  /** acquire video metadata for `url`. */
  metadata(url: string): Promise<YtDlpMetadata>;
  /** acquire the available caption tracks (auto + manual) for `url`. */
  captions(url: string): Promise<YtDlpCaptionTrack[]>;
}

/** Injectable seams for {@link fetchYouTube}. Every default is a real primitive. */
export interface YouTubeFetchOptions {
  /** the `yt-dlp` implementation; defaults to {@link createDefaultYtDlp}. */
  ytdlp?: YtDlp;
  /** ISO-timestamp source for `Snapshot.fetchedAt`; defaults to `new Date().toISOString()`. */
  clock?: () => string;
}

interface ParsedYouTubeUrl {
  videoId: string;
  /** normalized `https://www.youtube.com/watch?v=<id>`. */
  canonicalUrl: string;
  /** `t=` start time in whole seconds, when present. */
  timestampSeconds?: number;
}

/** A video id is url-safe base64-ish; accept the standard shape without over-fitting to 11 chars. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

/**
 * Parse a `t=` value (`"90"`, `"90s"`, `"1m30s"`, `"1h2m3s"`) into whole
 * seconds, or `undefined` if it is empty/unparseable.
 */
function parseTimestampSeconds(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const m = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return undefined;
  const [, h, min, s] = m;
  return (Number(h ?? 0) * 3600) + (Number(min ?? 0) * 60) + Number(s ?? 0);
}

/**
 * Parse any YouTube URL form into its canonical `{ videoId, canonicalUrl }` plus
 * an optional `t=` `timestampSeconds`, or `undefined` when it is not a
 * recognizable YouTube video URL. Tracking params (`si=`/`is=`) are dropped;
 * `t=` is surfaced as metadata, NOT identity. Handles `watch?v=`, `youtu.be/`,
 * `/shorts/`, `/embed/`, and `/live/` on `youtube.com` and its `www.`/`m.`/
 * `music.` subdomains.
 */
export function parseYouTubeUrl(input: string): ParsedYouTubeUrl | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  let videoId: string | undefined;

  if (host === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0];
  } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") {
      videoId = url.searchParams.get("v") ?? undefined;
    } else {
      const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/);
      if (m) videoId = m[1];
    }
  } else {
    return undefined;
  }

  if (!videoId || !VIDEO_ID_RE.test(videoId)) return undefined;

  const timestampSeconds = parseTimestampSeconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
  const parsed: ParsedYouTubeUrl = {
    videoId,
    canonicalUrl: `${CANONICAL_WATCH_PREFIX}${videoId}`,
  };
  if (timestampSeconds !== undefined) parsed.timestampSeconds = timestampSeconds;
  return parsed;
}

/**
 * Choose ONE caption track: prefer exact `en`, then `en-orig`, then any other
 * `en*` variant (e.g. `en-US`), then the first available track. Returns
 * `undefined` only when there are no tracks at all. This is the `en` vs
 * `en-orig` pick-one rule from the dogfood (issue #31) — YouTube auto-captions
 * frequently expose BOTH an `en` (translated/normalized) and an `en-orig`
 * (as-spoken) track; picking one avoids duplicate near-identical transcripts.
 */
export function pickCaptionTrack(tracks: YtDlpCaptionTrack[]): YtDlpCaptionTrack | undefined {
  const byLang = (want: string) => tracks.find((t) => t.lang.toLowerCase() === want);
  return (
    byLang("en") ??
    byLang("en-orig") ??
    tracks.find((t) => t.lang.toLowerCase().startsWith("en")) ??
    tracks[0]
  );
}

/**
 * Acquire a YouTube video's transcript + metadata via `yt-dlp`, returning a
 * traverse-shaped {@link YouTubeFetchResult}. NEVER THROWS: an unrecognizable
 * URL, an absent `yt-dlp`, or a tool failure surface as a typed `FetchError`.
 */
export async function fetchYouTube(
  config: YouTubeSourceConfig,
  opts: YouTubeFetchOptions = {},
): Promise<YouTubeFetchResult> {
  const warnings: string[] = [];

  if (!config || typeof config.id !== "string" || config.id.trim() === "") {
    return { error: { kind: "invalid-config", message: "YouTubeSourceConfig.id is required" } };
  }

  const parsed = parseYouTubeUrl(config.url);
  if (!parsed) {
    return {
      error: { kind: "invalid-url", message: `not a recognizable YouTube video URL: ${String(config.url)}` },
    };
  }

  const ytdlp = opts.ytdlp ?? createDefaultYtDlp();
  const clock = opts.clock ?? (() => new Date().toISOString());

  let available: boolean;
  try {
    available = await ytdlp.available();
  } catch {
    available = false;
  }
  if (!available) {
    return {
      error: {
        kind: "dependency-missing",
        message:
          "yt-dlp is not installed or not runnable — install it (an OPTIONAL binary dependency, like @anthropic-ai/sdk) to acquire YouTube transcripts",
      },
    };
  }

  let rawMeta: YtDlpMetadata;
  let tracks: YtDlpCaptionTrack[];
  try {
    [rawMeta, tracks] = await Promise.all([ytdlp.metadata(parsed.canonicalUrl), ytdlp.captions(parsed.canonicalUrl)]);
  } catch (err) {
    return {
      error: { kind: "adapter-error", message: `yt-dlp failed for ${parsed.canonicalUrl}: ${errText(err)}` },
    };
  }

  // Canonical identity stays the PARSED id, but cross-check yt-dlp's reported id
  // and surface a warning on disagreement (e.g. a redirected/renamed video)
  // rather than silently trusting one over the other.
  if (rawMeta.id && rawMeta.id !== parsed.videoId) {
    warnings.push(`yt-dlp reported video id "${rawMeta.id}" but the URL parsed to "${parsed.videoId}"; using the parsed id as identity`);
  }

  const track = pickCaptionTrack(tracks);
  if (!track) {
    warnings.push(`no caption tracks available for ${parsed.canonicalUrl}; transcript is empty`);
  } else if (track.lang.toLowerCase() !== "en" && track.lang.toLowerCase() !== "en-orig") {
    warnings.push(`no "en"/"en-orig" caption track; using "${track.lang}"`);
  }

  const vtt = track?.vtt ?? "";
  const metadata: YouTubeVideoMetadata = { videoId: parsed.videoId, url: parsed.canonicalUrl };
  if (rawMeta.title) metadata.title = rawMeta.title;
  if (rawMeta.channel) metadata.channel = rawMeta.channel;
  if (typeof rawMeta.duration === "number" && Number.isFinite(rawMeta.duration)) {
    metadata.durationSeconds = rawMeta.duration;
  }
  if (rawMeta.uploadDate) metadata.uploadDate = rawMeta.uploadDate;
  if (parsed.timestampSeconds !== undefined) metadata.timestampSeconds = parsed.timestampSeconds;
  if (track) metadata.captionLang = track.lang;

  const snapshot: Snapshot = {
    sourceId: config.id,
    url: parsed.canonicalUrl,
    fetchedAt: clock(),
    status: 200,
    contentType: "transcript",
    body: vtt,
    bodyHash: sha256Hex(vtt),
  };

  const result: YouTubeFetchResult = { snapshot, metadata };
  if (warnings.length > 0) result.warnings = warnings;
  return result;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Default (real) yt-dlp implementation — the only untested-by-unit part, on par
// with fetchSource's globalThis.fetch default and the Anthropic adapter's
// dynamic SDK import. Shells out to a real `yt-dlp` binary.
// ---------------------------------------------------------------------------

/** Tab-separated print template: id \t title \t channel \t duration \t upload_date. */
const METADATA_PRINT = "%(id)s\t%(title)s\t%(channel)s\t%(duration)s\t%(upload_date)s";
const NA = "NA"; // yt-dlp renders an absent field as the literal "NA".

function naToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" || trimmed === NA ? undefined : trimmed;
}

/**
 * Build the default {@link YtDlp}, backed by a real `yt-dlp` binary via
 * `execFile`. `binary` overrides the executable name/path (default `"yt-dlp"`).
 */
export function createDefaultYtDlp(binary = "yt-dlp"): YtDlp {
  return {
    async available(): Promise<boolean> {
      try {
        await execFileAsync(binary, ["--version"], { timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    },

    async metadata(url: string): Promise<YtDlpMetadata> {
      const { stdout } = await execFileAsync(
        binary,
        ["--skip-download", "--no-warnings", "--no-playlist", "--print", METADATA_PRINT, url],
        { timeout: 60_000, maxBuffer: 1024 * 1024 * 8 },
      );
      const line = stdout.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
      const [id, title, channel, duration, uploadDate] = line.split("\t");
      const meta: YtDlpMetadata = {};
      const idv = naToUndefined(id);
      if (idv) meta.id = idv;
      const titlev = naToUndefined(title);
      if (titlev) meta.title = titlev;
      const channelv = naToUndefined(channel);
      if (channelv) meta.channel = channelv;
      const durv = naToUndefined(duration);
      if (durv && /^\d+(\.\d+)?$/.test(durv)) meta.duration = Math.round(Number(durv));
      const uploadv = naToUndefined(uploadDate);
      if (uploadv) meta.uploadDate = uploadv;
      return meta;
    },

    async captions(url: string): Promise<YtDlpCaptionTrack[]> {
      const dir = await mkdtemp(path.join(os.tmpdir(), "traverse-ytdlp-"));
      try {
        await execFileAsync(
          binary,
          [
            "--write-auto-subs",
            "--write-subs",
            "--sub-langs",
            "en.*",
            "--sub-format",
            "vtt",
            "--skip-download",
            "--no-warnings",
            "--no-playlist",
            "-o",
            path.join(dir, "%(id)s.%(ext)s"),
            url,
          ],
          { timeout: 120_000, maxBuffer: 1024 * 1024 * 16 },
        );
        const names = await readdir(dir);
        const tracks: YtDlpCaptionTrack[] = [];
        for (const name of names) {
          if (!name.endsWith(".vtt")) continue;
          // Filename shape: "<id>.<lang>.vtt" — the lang is the middle segment.
          const parts = name.slice(0, -".vtt".length).split(".");
          const lang = parts.length >= 2 ? parts.slice(1).join(".") : "unknown";
          const vtt = await readFile(path.join(dir, name), "utf8");
          tracks.push({ lang, vtt });
        }
        return tracks;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
