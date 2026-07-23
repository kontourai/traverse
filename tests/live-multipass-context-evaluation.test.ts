import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";

const config = JSON.parse(fs.readFileSync(
  new URL("../evals/grounded-extraction/live-multipass-context.v1.json", import.meta.url),
  "utf8",
));

describe("live multipass context evaluation configuration", () => {
  it("freezes provider identity and stays below the authorized spend", () => {
    assert.equal(config.provider, "claude-code");
    assert.equal(config.model, "claude-sonnet-4-6");
    assert.equal(config.limits.maxProviderCalls, 6);
    assert.equal(config.thresholds.maximumAuthorizedSpendUsd, 10);
    assert.ok(config.thresholds.maximumRateEquivalentSpendUsd < 10);
    const calculated = config.limits.maxProviderCalls * (
      config.limits.maxEstimatedInputTokensPerCall * config.rateEquivalent.inputUsdPerMillionTokens
      + config.limits.maxOutputTokensPerCall * config.rateEquivalent.outputUsdPerMillionTokens
    ) / 1_000_000;
    assert.equal(calculated, config.thresholds.maximumRateEquivalentSpendUsd);
  });
});
