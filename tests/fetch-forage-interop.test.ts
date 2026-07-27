import assert from "node:assert/strict";
import test from "node:test";
import { toForageFetchOptions, toForageSourceConfig } from "../src/fetch/forage-interop.js";
import type { SourceConfig, FetchSourceOptions } from "../src/fetch/types.js";

const base: SourceConfig = {
  id: "source-1",
  url: "https://example.test/page",
  contentType: "html",
  userAgent: "traverse-test",
  timeoutMs: 5_000,
  respectRobots: true,
};

test("drops the fields forage has no home for rather than passing them through", () => {
  const translated = toForageSourceConfig(
    { ...base, revalidate: true, renderPolicy: "never" },
    { egress: { guarded: true } },
  ) as unknown as Record<string, unknown>;

  // These are Traverse's own concerns: contentType feeds the extraction prep
  // layer, revalidate drives HTTP revalidation. forage consumes neither, and
  // carrying them across would put fields on a config that nothing reads.
  assert.equal(translated.contentType, undefined, "contentType must not cross");
  assert.equal(translated.revalidate, undefined, "revalidate must not cross");
  assert.equal(translated.renderPolicy, undefined, "renderPolicy must not cross as-is");

  assert.equal(translated.id, "source-1");
  assert.equal(translated.url, "https://example.test/page");
  assert.equal(translated.userAgent, "traverse-test");
  assert.equal(translated.timeoutMs, 5_000);
  assert.equal(translated.respectRobots, true);
});

test("requires an egress policy rather than choosing one", () => {
  // forage makes egress required; Traverse has no field for it. Defaulting
  // would decide a caller's SSRF posture for them, so the type demands it and
  // whatever is supplied is what forage receives — unchanged.
  assert.deepEqual(toForageSourceConfig(base, { egress: { guarded: true } }).egress, { guarded: true });
  assert.deepEqual(toForageSourceConfig(base, { egress: { guarded: false } }).egress, { guarded: false });

  const scoped = toForageSourceConfig(base, {
    egress: { guarded: true, testOnlyAllowedLoopbackOrigins: ["http://127.0.0.1:4243"] },
  });
  assert.deepEqual(scoped.egress.testOnlyAllowedLoopbackOrigins, ["http://127.0.0.1:4243"]);
});

test("maps Traverse's render policy onto forage's render flag", () => {
  assert.equal(toForageSourceConfig({ ...base, renderPolicy: "always" }, { egress: { guarded: true } }).render, true);
  assert.equal(toForageSourceConfig({ ...base, renderPolicy: "on-shell-warning" }, { egress: { guarded: true } }).render, "on-shell");
  // "never" is the absence of a render request, not a request not to render.
  assert.equal(toForageSourceConfig({ ...base, renderPolicy: "never" }, { egress: { guarded: true } }).render, undefined);
});

test("carries every fetch option across, since that field set genuinely matches", () => {
  const politenessState = new Map<string, number>([["example.test", 1]]);
  const options: FetchSourceOptions = {
    now: () => 1,
    clock: () => "2026-07-27T00:00:00.000Z",
    sleep: async () => {},
    random: () => 0.5,
    politenessState,
  };
  const translated = toForageFetchOptions(options)!;

  assert.equal(translated.now?.(), 1);
  assert.equal(translated.clock?.(), "2026-07-27T00:00:00.000Z");
  assert.equal(translated.random?.(), 0.5);
  // Same Map instance, not a copy: these are live seams a caller inspects after
  // the fetch, and duplicating them would silently break that.
  assert.equal(translated.politenessState, politenessState);
  assert.equal(toForageFetchOptions(undefined), undefined);
});
