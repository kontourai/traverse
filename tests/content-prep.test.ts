import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { htmlToText, prepareContent } from "../src/content-prep.js";

const fixtureUrl = new URL("../../tests/fixtures/generic-activity-page.html", import.meta.url);
const fixtureHtml = readFileSync(fixtureUrl, "utf8");

describe("htmlToText", () => {
  it("strips script/style/nav/header/footer noise but keeps body content", () => {
    const text = htmlToText(fixtureHtml);

    // Content survives.
    assert.match(text, /Beginner Bouldering Session/);
    assert.match(text, /\$24 per person/);
    assert.match(text, /Tuesday and Thursday/);

    // Noise is gone.
    assert.doesNotMatch(text, /window\.analytics/);
    assert.doesNotMatch(text, /footer widget loaded/);
    assert.doesNotMatch(text, /font-family/);
    assert.doesNotMatch(text, /All rights reserved/);
    assert.doesNotMatch(text, /Climb higher, every week/);

    // No residual tags.
    assert.doesNotMatch(text, /</);
    assert.doesNotMatch(text, />/);
  });

  it("decodes common entities", () => {
    const text = htmlToText("<p>Shoes &amp; chalk 6:00pm&ndash;7:30pm &lt;ok&gt;</p>");
    assert.match(text, /Shoes & chalk/);
    assert.match(text, /6:00pm–7:30pm/);
    assert.match(text, /<ok>/);
  });

  it("decodes typographic entities (dashes, smart quotes, ellipsis) and nbsp variants", () => {
    const text = htmlToText(
      "<p>Coach&rsquo;s note&mdash;&ldquo;bring&nbsp;chalk&rdquo;&hellip; details&#160;below&#xA0;here&#39;s more.</p>",
    );
    assert.match(text, /Coach’s note/);
    assert.match(text, /—/); // &mdash;
    assert.match(text, /“bring/); // &ldquo;
    assert.match(text, /chalk”/); // &nbsp; between "bring" and "chalk", &rdquo; after
    assert.match(text, /details below here/); // &#160; and &#xA0; both decode to a space
    assert.match(text, /…/); // &hellip;
    assert.match(text, /here's more/); // &#39;
    // No raw entity markers survive.
    assert.doesNotMatch(text, /&\w+;/);
    assert.doesNotMatch(text, /&#/);
  });

  it("truncates to maxChars", () => {
    const text = htmlToText("<p>" + "a".repeat(500) + "</p>", 100);
    assert.equal(text.length, 100);
  });
});

describe("prepareContent", () => {
  it("prepares html as markdown by default (structure-preserving), preserving headings", () => {
    const { text, error } = prepareContent(fixtureHtml, "html");
    assert.equal(error, undefined);
    assert.match(text ?? "", /Beginner Bouldering Session/);
    // Default flipped to markdown in 0.5.0: the <h1> survives as an ATX heading
    // rather than being flattened to a bare line.
    assert.match(text ?? "", /^# Beginner Bouldering Session/m);
  });

  it("honors prep:'text' as the legacy regex-strip escape hatch (no markdown syntax)", () => {
    const { text, error } = prepareContent(fixtureHtml, "html", 32_000, "text");
    assert.equal(error, undefined);
    assert.match(text ?? "", /Beginner Bouldering Session/);
    assert.doesNotMatch(text ?? "", /^#/m);
  });

  it("passes text through, truncating only", () => {
    const { text, error } = prepareContent("plain text body " + "x".repeat(50), "text", 20);
    assert.equal(error, undefined);
    assert.equal(text?.length, 20);
    assert.equal(text, "plain text body xxxx");
  });

  it("defers pdf with a typed error and never throws", () => {
    const result = prepareContent(new Uint8Array([1, 2, 3]), "pdf");
    assert.equal(result.text, undefined);
    assert.match(result.error ?? "", /not implemented/);
  });

  it("rejects binary input for non-pdf types with an error, not a throw", () => {
    const result = prepareContent(new Uint8Array([1, 2, 3]), "html");
    assert.equal(result.text, undefined);
    assert.match(result.error ?? "", /binary content is not supported/);
  });

  it("never throws on pathological HTML: degrades the markdown default to text", () => {
    // Deeply nested markup can overflow the DOM/Turndown recursion; prepareContent
    // must degrade to the regex text strip rather than propagating the throw.
    const deep = "<div>".repeat(40_000) + "needle" + "</div>".repeat(40_000);
    let result: ReturnType<typeof prepareContent> | undefined;
    assert.doesNotThrow(() => {
      result = prepareContent(deep, "html");
    });
    assert.equal(result?.error, undefined);
    assert.match(result?.text ?? "", /needle/);
  });
});
