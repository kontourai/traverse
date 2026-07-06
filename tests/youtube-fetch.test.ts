// YouTube / transcript adapter tests. Every test injects a FAKE YtDlp (the
// `available`/`metadata`/`captions` seam) — no subprocess, no network — mirroring
// the Anthropic adapter's injected-client discipline. Cover URL parsing +
// identity normalization, the en/en-orig pick-one rule, the traverse-shaped
// snapshot output (raw VTT body so content-prep cleans it), metadata surfacing,
// and the never-throws typed-error degradations (missing binary, tool failure,
// bad URL).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  fetchYouTube,
  parseYouTubeUrl,
  pickCaptionTrack,
} from "../src/fetch/youtube.js";
import type { YtDlp, YtDlpCaptionTrack, YtDlpMetadata } from "../src/fetch/youtube.js";
import { prepareContent, vttToText } from "../src/content-prep.js";
import { sha256Hex } from "../src/fetch/fetch-source.js";

const rawVtt = readFileSync(new URL("../../tests/fixtures/auto-captions.vtt", import.meta.url), "utf8");

function fakeYtDlp(opts: {
  available?: boolean;
  metadata?: YtDlpMetadata;
  captions?: YtDlpCaptionTrack[];
  throwOn?: "metadata" | "captions";
}): YtDlp {
  return {
    async available() {
      return opts.available ?? true;
    },
    async metadata() {
      if (opts.throwOn === "metadata") throw new Error("private video");
      return opts.metadata ?? {};
    },
    async captions() {
      if (opts.throwOn === "captions") throw new Error("no subtitles");
      return opts.captions ?? [];
    },
  };
}

describe("parseYouTubeUrl", () => {
  it("parses a standard watch URL and strips tracking params", () => {
    const p = parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=trackingblob&feature=share");
    assert.equal(p!.videoId, "dQw4w9WgXcQ");
    assert.equal(p!.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    assert.equal(p!.timestampSeconds, undefined);
  });

  it("parses a youtu.be short link and strips si=", () => {
    const p = parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?si=abc123def");
    assert.equal(p!.videoId, "dQw4w9WgXcQ");
    assert.equal(p!.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("parses /shorts/ and /embed/ forms", () => {
    assert.equal(parseYouTubeUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")!.videoId, "dQw4w9WgXcQ");
    assert.equal(parseYouTubeUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")!.videoId, "dQw4w9WgXcQ");
  });

  it("surfaces t= as timestamp metadata (seconds and h/m/s forms), not identity", () => {
    assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=90")!.timestampSeconds, 90);
    assert.equal(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s")!.timestampSeconds, 90);
    assert.equal(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s")!.timestampSeconds, 3723);
    // identity is unaffected by t=
    assert.equal(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=90")!.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });

  it("returns undefined for non-YouTube and unparseable URLs", () => {
    assert.equal(parseYouTubeUrl("https://vimeo.com/12345"), undefined);
    assert.equal(parseYouTubeUrl("https://www.youtube.com/watch?v="), undefined);
    assert.equal(parseYouTubeUrl("not a url"), undefined);
    assert.equal(parseYouTubeUrl("ftp://youtube.com/watch?v=dQw4w9WgXcQ"), undefined);
  });
});

describe("pickCaptionTrack", () => {
  const t = (lang: string): YtDlpCaptionTrack => ({ lang, vtt: `WEBVTT ${lang}` });

  it("prefers en over en-orig when both exist", () => {
    assert.equal(pickCaptionTrack([t("en-orig"), t("en")])!.lang, "en");
  });
  it("falls back to en-orig, then any en* variant, then the first track", () => {
    assert.equal(pickCaptionTrack([t("en-orig"), t("es")])!.lang, "en-orig");
    assert.equal(pickCaptionTrack([t("en-US"), t("fr")])!.lang, "en-US");
    assert.equal(pickCaptionTrack([t("de"), t("fr")])!.lang, "de");
  });
  it("returns undefined for no tracks", () => {
    assert.equal(pickCaptionTrack([]), undefined);
  });
});

describe("fetchYouTube", () => {
  const config = { id: "yt-1", url: "https://youtu.be/dQw4w9WgXcQ?si=track&t=42" };
  const metadata: YtDlpMetadata = {
    id: "dQw4w9WgXcQ",
    title: "Test Talk",
    channel: "Test Channel",
    duration: 212,
    uploadDate: "20261004",
  };

  it("produces a traverse-shaped transcript snapshot with RAW VTT as the body", async () => {
    const ytdlp = fakeYtDlp({ metadata, captions: [{ lang: "en", vtt: rawVtt }] });
    const result = await fetchYouTube(config, { ytdlp, clock: () => "2026-07-05T00:00:00.000Z" });

    assert.equal(result.error, undefined);
    const snap = result.snapshot!;
    assert.equal(snap.sourceId, "yt-1");
    assert.equal(snap.contentType, "transcript");
    assert.equal(snap.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ"); // canonical, tracking stripped
    assert.equal(snap.status, 200);
    assert.equal(snap.fetchedAt, "2026-07-05T00:00:00.000Z");
    // Body is the RAW vtt (replayable); cleaning is content-prep's job.
    assert.equal(snap.body, rawVtt);
    assert.match(snap.body, /-->/);
    assert.equal(snap.bodyHash, sha256Hex(rawVtt));
  });

  it("content-prep cleans the snapshot body to the same transcript vttToText produces", async () => {
    const ytdlp = fakeYtDlp({ metadata, captions: [{ lang: "en", vtt: rawVtt }] });
    const result = await fetchYouTube(config, { ytdlp });
    const { text } = prepareContent(result.snapshot!.body, result.snapshot!.contentType);
    assert.equal(text, vttToText(rawVtt));
    assert.equal(text, "the quick brown\nfox jumps\nover rock & roll");
  });

  it("surfaces canonical id, title, channel, duration, upload date, t=, and picked caption lang as metadata", async () => {
    const ytdlp = fakeYtDlp({ metadata, captions: [{ lang: "en-orig", vtt: rawVtt }, { lang: "en", vtt: rawVtt }] });
    const result = await fetchYouTube(config, { ytdlp });
    assert.deepEqual(result.metadata, {
      videoId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Test Talk",
      channel: "Test Channel",
      durationSeconds: 212,
      uploadDate: "20261004",
      timestampSeconds: 42,
      captionLang: "en", // pick-one preferred en over en-orig
    });
  });

  it("degrades to a typed dependency-missing error when yt-dlp is absent (never throws)", async () => {
    const ytdlp = fakeYtDlp({ available: false });
    const result = await fetchYouTube(config, { ytdlp });
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "dependency-missing");
  });

  it("returns invalid-url for a non-YouTube URL", async () => {
    const result = await fetchYouTube({ id: "x", url: "https://vimeo.com/1" }, { ytdlp: fakeYtDlp({}) });
    assert.equal(result.error!.kind, "invalid-url");
  });

  it("returns invalid-config for a missing id", async () => {
    const result = await fetchYouTube({ id: "", url: config.url }, { ytdlp: fakeYtDlp({}) });
    assert.equal(result.error!.kind, "invalid-config");
  });

  it("maps a yt-dlp tool failure to a typed adapter-error (never throws)", async () => {
    const result = await fetchYouTube(config, { ytdlp: fakeYtDlp({ throwOn: "captions" }) });
    assert.equal(result.snapshot, undefined);
    assert.equal(result.error!.kind, "adapter-error");
    assert.match(result.error!.message, /no subtitles/);
  });

  it("warns but still produces a (empty) snapshot when no caption tracks exist", async () => {
    const result = await fetchYouTube(config, { ytdlp: fakeYtDlp({ metadata, captions: [] }) });
    assert.equal(result.snapshot!.body, "");
    assert.equal(result.metadata!.captionLang, undefined);
    assert.ok(result.warnings?.some((w) => /no caption tracks/.test(w)));
  });

  it("warns when only a non-en track is available and uses it", async () => {
    const ytdlp = fakeYtDlp({ metadata, captions: [{ lang: "de", vtt: rawVtt }] });
    const result = await fetchYouTube(config, { ytdlp });
    assert.equal(result.metadata!.captionLang, "de");
    assert.ok(result.warnings?.some((w) => /no "en"\/"en-orig"/.test(w)));
  });
});
