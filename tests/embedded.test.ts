import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  harvestEmbeddedState,
  detectJsShell,
  inspectHtml,
  SHELL_WARNING_CODE,
  SHELL_WARNING_CODE_EMBEDDED,
  SHELL_PREPARED_TEXT_FLOOR,
  MAX_JSONLD_BLOCKS,
  MAX_RAW_BLOCK_CHARS,
} from "../src/embedded.js";
import { prepareContent } from "../src/content-prep.js";
import { extract } from "../src/extract.js";
import { createMockExtractionProvider } from "./fixtures/mock-provider.js";
import { genericTargetSchema } from "./fixtures/generic-target-schema.js";

function fixture(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), "utf8");
}

const JSONLD_EVENT = `<script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Event","name":"Beginner Bouldering Session","startDate":"2026-08-05T18:30:00-07:00","offers":{"@type":"Offer","price":"24","priceCurrency":"USD"}}
</script>`;

const JSONLD_COURSE = `<script type="application/ld+json">
  {"@context":"https://schema.org","@type":"Course","name":"Intro to Rope Climbing","provider":{"@type":"Organization","name":"Riverside Climbing"}}
</script>`;

// ---------------------------------------------------------------------------
// harvestEmbeddedState — JSON-LD
// ---------------------------------------------------------------------------

describe("harvestEmbeddedState — JSON-LD", () => {
  it("harvests a single JSON-LD block as a parsed object", () => {
    const { embedded, warnings } = harvestEmbeddedState(`<html><head>${JSONLD_EVENT}</head><body></body></html>`);
    assert.equal(warnings.length, 0);
    assert.ok(embedded);
    assert.equal(embedded.jsonLd.length, 1);
    const evt = embedded.jsonLd[0] as { "@type": string; name: string };
    assert.equal(evt["@type"], "Event");
    assert.equal(evt.name, "Beginner Bouldering Session");
  });

  it("harvests multiple JSON-LD blocks in document order", () => {
    const { embedded, warnings } = harvestEmbeddedState(
      `<html><body>${JSONLD_EVENT}<p>hi</p>${JSONLD_COURSE}</body></html>`,
    );
    assert.equal(warnings.length, 0);
    assert.ok(embedded);
    assert.equal(embedded.jsonLd.length, 2);
    assert.equal((embedded.jsonLd[0] as { "@type": string })["@type"], "Event");
    assert.equal((embedded.jsonLd[1] as { "@type": string })["@type"], "Course");
  });

  it("drops a malformed JSON-LD block with a warning and NEVER throws", () => {
    const html = `<html><body><script type="application/ld+json">{ not: valid json, }</script></body></html>`;
    let result!: ReturnType<typeof harvestEmbeddedState>;
    assert.doesNotThrow(() => {
      result = harvestEmbeddedState(html);
    });
    // The one malformed block is the only embedded candidate -> nothing harvested.
    assert.equal(result.embedded, undefined);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^embedded-jsonld-parse-failed:/);
  });

  it("keeps the good blocks when one of several is malformed", () => {
    const html = `<html><body>${JSONLD_EVENT}<script type="application/ld+json">{bad}</script>${JSONLD_COURSE}</body></html>`;
    const { embedded, warnings } = harvestEmbeddedState(html);
    assert.ok(embedded);
    assert.equal(embedded.jsonLd.length, 2);
    assert.equal(warnings.filter((w) => w.startsWith("embedded-jsonld-parse-failed")).length, 1);
  });

  it("returns no embedded state (and no warnings) for a page with none", () => {
    const { embedded, warnings } = harvestEmbeddedState("<html><body><p>just content</p></body></html>");
    assert.equal(embedded, undefined);
    assert.equal(warnings.length, 0);
  });
});

// ---------------------------------------------------------------------------
// harvestEmbeddedState — __NEXT_DATA__ and hydration blobs
// ---------------------------------------------------------------------------

describe("harvestEmbeddedState — state blobs", () => {
  it("harvests a __NEXT_DATA__ payload", () => {
    const { embedded } = harvestEmbeddedState(fixture("js-shell-next.html"));
    assert.ok(embedded);
    assert.ok(embedded.nextData);
    const nd = embedded.nextData as { props: { pageProps: { session: { name: string; priceAmount: number } } } };
    assert.equal(nd.props.pageProps.session.name, "Community Yoga Session");
    assert.equal(nd.props.pageProps.session.priceAmount, 18);
  });

  it("harvests a window.__INITIAL_STATE__ hydration blob (balanced JSON, ignores trailing script)", () => {
    const html = `<html><body><div id="app"></div><script>
      window.__INITIAL_STATE__ = {"user":{"id":7,"name":"Ada"},"sessions":[{"id":1},{"id":2}]};
      console.log("boot");
    </script></body></html>`;
    const { embedded } = harvestEmbeddedState(html);
    assert.ok(embedded);
    const state = embedded.initialState as { user: { id: number; name: string }; sessions: unknown[] };
    assert.equal(state.user.id, 7);
    assert.equal(state.user.name, "Ada");
    assert.equal(state.sessions.length, 2);
  });

  it("harvests __PRELOADED_STATE__ too", () => {
    const html = `<html><body><script>window.__PRELOADED_STATE__ = {"ok":true};</script></body></html>`;
    const { embedded } = harvestEmbeddedState(html);
    assert.ok(embedded);
    assert.deepEqual(embedded.initialState, { ok: true });
  });

  it("warns (never throws) on a malformed __NEXT_DATA__ payload", () => {
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">{oops}</script></body></html>`;
    let result!: ReturnType<typeof harvestEmbeddedState>;
    assert.doesNotThrow(() => {
      result = harvestEmbeddedState(html);
    });
    assert.equal(result.embedded, undefined);
    assert.equal(result.warnings.filter((w) => w.startsWith("embedded-nextdata-parse-failed")).length, 1);
  });
});

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

describe("harvestEmbeddedState — size caps", () => {
  it("skips an oversized JSON-LD block (raw > MAX_RAW_BLOCK_CHARS) with a cap warning", () => {
    const huge = `{"@type":"Event","name":"${"x".repeat(MAX_RAW_BLOCK_CHARS)}"}`;
    const html = `<html><body><script type="application/ld+json">${huge}</script>${JSONLD_EVENT}</body></html>`;
    const { embedded, warnings } = harvestEmbeddedState(html);
    // Oversized one skipped; the normal one survives.
    assert.ok(embedded);
    assert.equal(embedded.jsonLd.length, 1);
    assert.equal((embedded.jsonLd[0] as { "@type": string })["@type"], "Event");
    assert.equal(warnings.filter((w) => w.startsWith("embedded-state-size-capped")).length, 1);
  });

  it("best-effort: a later small JSON-LD block still fits after an over-budget one is skipped", () => {
    // Two big blocks that together blow the cumulative serialized budget, then a
    // tiny block that DOES fit under the budget once the second big one is skipped.
    // The cumulative cap must `continue` (skip just the over-budget block), not
    // `break` (which would wrongly drop the trailing block that fits).
    const big = "x".repeat(140_000); // ~140k serialized each; 2x > 256k budget
    const html =
      `<html><body>` +
      `<script type="application/ld+json">{"@type":"Event","name":"${big}"}</script>` +
      `<script type="application/ld+json">{"@type":"Event","name":"${big}"}</script>` +
      `<script type="application/ld+json">{"@type":"Course","name":"tiny"}</script>` +
      `</body></html>`;
    const { embedded, warnings } = harvestEmbeddedState(html);
    assert.ok(embedded);
    // First big block + the trailing tiny block survive; the second big one is skipped.
    assert.equal(embedded.jsonLd.length, 2);
    assert.equal((embedded.jsonLd[0] as { "@type": string })["@type"], "Event");
    assert.equal((embedded.jsonLd[1] as { "@type": string })["@type"], "Course");
    assert.ok(warnings.some((w) => w.includes("JSON-LD total exceeded")));
  });

  it("caps the NUMBER of JSON-LD blocks at MAX_JSONLD_BLOCKS", () => {
    const many = Array.from({ length: MAX_JSONLD_BLOCKS + 5 }, (_, i) =>
      `<script type="application/ld+json">{"@type":"Event","name":"e${i}"}</script>`,
    ).join("");
    const { embedded, warnings } = harvestEmbeddedState(`<html><body>${many}</body></html>`);
    assert.ok(embedded);
    assert.equal(embedded.jsonLd.length, MAX_JSONLD_BLOCKS);
    assert.ok(warnings.some((w) => w.startsWith("embedded-state-size-capped")));
  });
});

// ---------------------------------------------------------------------------
// detectJsShell — heuristic + false-positive discipline
// ---------------------------------------------------------------------------

describe("detectJsShell — heuristic", () => {
  it("flags a script-dominated page with an empty mount and no embedded state", () => {
    const html = fixture("spa-shell-empty.html");
    const prepared = prepareContent(html, "html").text ?? "";
    const { warning, signals } = detectJsShell(html, prepared, false);
    assert.ok(warning, "expected a shell warning");
    assert.ok(warning.startsWith(SHELL_WARNING_CODE + ":"), `stable code prefix, got: ${warning}`);
    assert.equal(signals.suspected, true);
    assert.equal(signals.emptyRootMount, true);
    assert.ok(signals.preparedTextChars < SHELL_PREPARED_TEXT_FLOOR);
    // Machine-actionable: the ratio numbers are present in the message.
    assert.match(warning, /prepared text \d+ chars/);
    assert.match(warning, /scripts \d+\.\d%/);
  });

  it("downgrades to the embedded-state code when a shell carries harvestable state", () => {
    const html = fixture("js-shell-next.html");
    const prepared = prepareContent(html, "html").text ?? "";
    const { warning, signals } = detectJsShell(html, prepared, true);
    assert.ok(warning);
    assert.ok(warning.startsWith(SHELL_WARNING_CODE_EMBEDDED + ":"), `downgraded code, got: ${warning}`);
    assert.equal(signals.suspected, true);
    assert.match(warning, /WITHOUT a browser render/);
  });

  it("does NOT flag a content-rich page even when it is script-dominated (false-positive guard)", () => {
    const html = fixture("content-rich-heavy-scripts.html");
    const prepared = prepareContent(html, "html").text ?? "";
    const { warning, signals } = detectJsShell(html, prepared, true);
    assert.equal(warning, undefined, `content-rich page must not be flagged; signals=${JSON.stringify(signals)}`);
    assert.equal(signals.suspected, false);
    // The absolute prepared-text floor is what saves it despite a high script ratio.
    assert.ok(signals.preparedTextChars >= SHELL_PREPARED_TEXT_FLOOR);
  });

  it("does not flag when scripts are light and the mount is not empty, even with little text", () => {
    const html = `<html><body><div id="root"><p>hi there friend</p></div></body></html>`;
    const { warning, signals } = detectJsShell(html, "hi there friend", false);
    assert.equal(warning, undefined);
    assert.equal(signals.emptyRootMount, false);
  });

  it("handles empty HTML without throwing or flagging", () => {
    const { warning, signals } = detectJsShell("", "", false);
    assert.equal(warning, undefined);
    assert.equal(signals.suspected, false);
  });

  it("stays linear (no quadratic blowup) on adversarial script-heavy HTML", () => {
    // 80k unterminated `<script>` tags (~640KB). The prior lazy-regex script scan
    // was O(n^2) and took ~6.6s here; the indexOf scan is O(n) and finishes in ms.
    const html = "<html><body>" + "<script>".repeat(80_000) + "</body></html>";
    const t0 = Date.now();
    const { signals } = detectJsShell(html, "", false);
    const elapsed = Date.now() - t0;
    assert.ok(signals.scriptRatio > 0, "unterminated scripts are still counted");
    assert.ok(elapsed < 2_000, `script-char scan must be linear; took ${elapsed}ms`);
  });
});

// ---------------------------------------------------------------------------
// prepareContent integration — sidecar + warnings on the prep result
// ---------------------------------------------------------------------------

describe("prepareContent — embedded sidecar", () => {
  it("surfaces the embedded sidecar and shell warning on the prep result", () => {
    const result = prepareContent(fixture("js-shell-next.html"), "html");
    assert.ok(result.embedded);
    assert.ok(result.embedded.nextData);
    assert.ok(result.warnings);
    assert.ok(result.warnings.some((w) => w.startsWith(SHELL_WARNING_CODE_EMBEDDED)));
  });

  it("attaches JSON-LD but no shell warning for a content-rich page", () => {
    const result = prepareContent(fixture("content-rich-heavy-scripts.html"), "html");
    assert.ok(result.embedded);
    assert.equal(result.embedded.jsonLd.length, 1);
    const noShell = (result.warnings ?? []).every((w) => !w.startsWith("js-shell-suspected"));
    assert.ok(noShell, "content-rich page must not carry a shell warning");
  });

  it("does not false-flag a content-rich page as a shell when the caller sets a small maxChars", () => {
    // Regression: shell detection must run against the FULL prepared text, not the
    // caller's maxChars-truncated `text`. A tiny maxChars (a lightweight preview)
    // must not turn a genuinely content-rich page into a js-shell false positive.
    const html = fixture("content-rich-heavy-scripts.html");
    const result = prepareContent(html, "html", 300);
    assert.equal(result.text?.length, 300, "returned text is still truncated to maxChars");
    const noShell = (result.warnings ?? []).every((w) => !w.startsWith("js-shell-suspected"));
    assert.ok(noShell, "small maxChars must not induce a shell false positive");
  });
});

// ---------------------------------------------------------------------------
// extract() integration — sidecar survives, once, across the chunked path
// ---------------------------------------------------------------------------

describe("extract() — embedded sidecar", () => {
  it("surfaces the embedded sidecar on the ExtractionResult (single-chunk)", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "m" } });
    const result = await extract({
      content: fixture("content-rich-heavy-scripts.html"),
      contentType: "html",
      sourceRef: "https://example.test/session",
      targetSchema: genericTargetSchema,
      provider,
    });
    assert.equal(result.error, undefined);
    assert.ok(result.embedded);
    assert.equal(result.embedded.jsonLd.length, 1);
    assert.equal((result.embedded.jsonLd[0] as { "@type": string })["@type"], "Event");
  });

  it("harvests the sidecar exactly ONCE even when the page is chunked", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "m" } });
    const result = await extract({
      content: fixture("content-rich-heavy-scripts.html"),
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
      chunkSize: 300, // force the character-window chunker to split the page
    });
    // Proof the page really was chunked.
    assert.ok(provider.calls.length > 1, `expected multiple chunks, got ${provider.calls.length}`);
    // The sidecar is a single whole-page object — not one per chunk.
    assert.ok(result.embedded);
    assert.equal(result.embedded.jsonLd.length, 1);
    // No embedded-state warning is emitted more than once.
    const embeddedWarnings = (result.warnings ?? []).filter((w) => w.startsWith("embedded-"));
    assert.equal(embeddedWarnings.length, 0);
  });

  it("makes a JS shell extractable from the sidecar without a render (provider sees ~nothing)", async () => {
    const provider = createMockExtractionProvider({ proposals: [], raw: { response: "{}", model: "m" } });
    const result = await extract({
      content: fixture("js-shell-next.html"),
      contentType: "html",
      sourceRef: "ref",
      targetSchema: genericTargetSchema,
      provider,
    });
    // The provider had almost no visible text to work with...
    assert.equal(result.proposals.length, 0);
    // ...but the __NEXT_DATA__ sidecar carries the record, and the warning is the
    // downgraded, machine-actionable code telling the caller NOT to bother rendering.
    assert.ok(result.embedded);
    assert.ok(result.embedded.nextData);
    assert.ok((result.warnings ?? []).some((w) => w.startsWith(SHELL_WARNING_CODE_EMBEDDED)));
  });

  it("inspectHtml composes harvest + shell warning in one call", () => {
    const html = fixture("spa-shell-empty.html");
    const prepared = prepareContent(html, "html").text ?? "";
    const { embedded, warnings } = inspectHtml(html, prepared);
    assert.equal(embedded, undefined);
    assert.ok(warnings.some((w) => w.startsWith(SHELL_WARNING_CODE + ":")));
  });
});
