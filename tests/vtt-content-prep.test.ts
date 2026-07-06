// VTT -> transcript content-prep tests. Cover the cleanup promoted from the
// 2026-07-04 knowledge-kit dogfood session script (issue #31): strip cue
// timings / WEBVTT headers / NOTE comments / inline tags, decode entities, and
// rolling-window dedupe the overlapping lines auto-captions emit. The fixture
// is a real-shaped yt-dlp auto-caption VTT with OVERLAPPING (rolling) cues so
// the dedupe is exercised against exactly the shape it exists for.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { prepareContent, vttToText } from "../src/content-prep.js";

const fixtureUrl = new URL("../../tests/fixtures/auto-captions.vtt", import.meta.url);
const fixtureVtt = readFileSync(fixtureUrl, "utf8");

describe("vttToText", () => {
  it("cleans a real-shaped auto-caption VTT to deduped transcript text", () => {
    const text = vttToText(fixtureVtt);
    // The rolling window collapses each scrolled-up repeat: three distinct lines
    // survive, in order, with no duplicated "the quick brown".
    assert.equal(text, "the quick brown\nfox jumps\nover rock & roll");
  });

  it("dedupes the OVERLAPPING lines (each caption line appears exactly once)", () => {
    const text = vttToText(fixtureVtt);
    const occurrences = text.split("\n").filter((l) => l === "the quick brown").length;
    assert.equal(occurrences, 1, `expected 'the quick brown' once, got:\n${text}`);
  });

  it("strips cue timings, WEBVTT/Kind/Language headers, NOTE comments, and inline tags", () => {
    const text = vttToText(fixtureVtt);
    assert.doesNotMatch(text, /-->/); // cue timings gone
    assert.doesNotMatch(text, /WEBVTT/);
    assert.doesNotMatch(text, /Kind:/);
    assert.doesNotMatch(text, /Language:/);
    assert.doesNotMatch(text, /NOTE/);
    assert.doesNotMatch(text, /<[^>]+>/); // inline <c> / timestamp tags gone
    assert.doesNotMatch(text, /align:start/); // cue-setting suffix gone with its timing line
  });

  it("decodes the common entities VTT shares with HTML", () => {
    const text = vttToText(fixtureVtt);
    assert.match(text, /rock & roll/);
    assert.doesNotMatch(text, /&amp;/);
  });

  it("collapses only CONSECUTIVE duplicates, keeping a legitimately repeated non-adjacent line", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nyes\n\n00:00:01.000 --> 00:00:02.000\nno\n\n00:00:02.000 --> 00:00:03.000\nyes\n";
    // "yes" repeats but is not adjacent (a "no" sits between), so both survive —
    // the rolling window only collapses the scroll, never distinct re-utterances.
    assert.equal(vttToText(vtt), "yes\nno\nyes");
  });

  it("KEEPS spoken caption lines that merely start with Note/Style/Region (cue-aware, not header)", () => {
    // A real transcript sentence beginning with one of the WebVTT structural
    // keywords must NOT be mistaken for a metadata block: it lives inside a cue
    // payload, so it is transcript text. (Regression for the content-loss bug
    // where a bare startsWith check silently deleted these lines.)
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "Note that this is important",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "Style is a big part of writing",
      "",
      "00:00:04.000 --> 00:00:06.000",
      "Region five was affected",
      "",
    ].join("\n");
    assert.equal(
      vttToText(vtt),
      "Note that this is important\nStyle is a big part of writing\nRegion five was affected",
    );
  });

  it("strips a multi-line NOTE comment block entirely (continuation lines included)", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE",
      "this is line two of the comment",
      "this is line three of the comment",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "real caption text",
      "",
    ].join("\n");
    assert.equal(vttToText(vtt), "real caption text");
  });

  it("drops bare cue-identifier lines that precede a timing line", () => {
    const vtt = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhello\n\n2\n00:00:01.000 --> 00:00:02.000\nworld\n";
    assert.equal(vttToText(vtt), "hello\nworld");
  });

  it("truncates to maxChars", () => {
    const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n" + "a".repeat(500) + "\n";
    assert.equal(vttToText(vtt, 100).length, 100);
  });

  it("returns empty string for a header-only VTT with no caption lines", () => {
    assert.equal(vttToText("WEBVTT\nKind: captions\nLanguage: en\n"), "");
  });
});

describe("prepareContent(transcript)", () => {
  it("prepares a transcript by cleaning its VTT (no error, no throw)", () => {
    const { text, error } = prepareContent(fixtureVtt, "transcript");
    assert.equal(error, undefined);
    assert.equal(text, "the quick brown\nfox jumps\nover rock & roll");
  });

  it("honors maxChars for a transcript", () => {
    const { text } = prepareContent(fixtureVtt, "transcript", 5);
    assert.equal(text?.length, 5);
  });

  it("rejects binary input for transcript with a typed error, not a throw", () => {
    const result = prepareContent(new Uint8Array([1, 2, 3]), "transcript");
    assert.equal(result.text, undefined);
    assert.match(result.error ?? "", /binary content is not supported/);
  });
});
