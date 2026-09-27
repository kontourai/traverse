import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { extract } from "../src/index.js";
import type { ExtractionProvider, TargetFieldSchema } from "../src/index.js";
import { createAnthropicExtractionProvider } from "../src/anthropic.js";
import { createOpenAIExtractionProvider } from "../src/openai.js";

// A local stub that answers every request with 429. It counts HTTP requests so
// a test sees what the SDK actually sent, not what extract() counted.
const schema: TargetFieldSchema[] = [{ path: "title", type: "string" }];
let server: Server;
let baseUrl = "";
let requests = 0;

before(async () => {
  server = createServer((req, res) => {
    requests++;
    req.resume();
    req.on("end", () => {
      // retry-after-ms keeps opted-in SDK retries fast.
      res.writeHead(429, { "content-type": "application/json", "retry-after-ms": "1" });
      res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "limited" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function requestsFor(provider: ExtractionProvider): Promise<number> {
  requests = 0;
  const result = await extract({ content: "Title: Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider });
  assert.equal(result.providerCalls, 1);
  assert.equal(result.providerFailures?.[0]?.kind, "rate-limit", JSON.stringify(result.warnings));
  return requests;
}

const adapters: Array<[string, (opts: { maxRetries?: number }) => ExtractionProvider]> = [
  ["anthropic", (opts) => createAnthropicExtractionProvider({ apiKey: "test-key", baseUrl, ...opts })],
  ["openai", (opts) => createOpenAIExtractionProvider({ apiKey: "test-key", baseUrl, ...opts })],
];

describe("direct SDK adapters make one provider request per counted call", () => {
  for (const [label, create] of adapters) {
    it(`${label} sends exactly one HTTP request on a 429 by default`, async () => {
      assert.equal(await requestsFor(create({})), 1);
    });

    it(`${label} retries only when the caller opts in with maxRetries`, async () => {
      assert.equal(await requestsFor(create({ maxRetries: 2 })), 3);
    });

    it(`${label} refuses a maxRetries that is not a non-negative integer`, async () => {
      for (const maxRetries of [-1, 1.5, Number.NaN]) {
        requests = 0;
        const result = await extract({ content: "Title: Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider: create({ maxRetries }) });
        assert.match(result.providerFailures?.[0]?.message ?? "", /maxRetries must be a non-negative integer/, String(maxRetries));
        assert.equal(requests, 0);
      }
    });
  }

  it("leaves an injected client's configuration untouched", async () => {
    const anthropicClient = {
      maxRetries: 5,
      async create() { throw Object.assign(new Error("limited"), { status: 429 }); },
    };
    const openaiClient = {
      maxRetries: 5,
      async create() { throw Object.assign(new Error("limited"), { status: 429 }); },
    };
    await extract({ content: "Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider: createAnthropicExtractionProvider({ client: anthropicClient, maxRetries: 0 }) });
    await extract({ content: "Alpine", contentType: "text", sourceRef: "fixture", targetSchema: schema, provider: createOpenAIExtractionProvider({ client: openaiClient, maxRetries: 0 }) });
    assert.equal(anthropicClient.maxRetries, 5);
    assert.equal(openaiClient.maxRetries, 5);
  });
});
