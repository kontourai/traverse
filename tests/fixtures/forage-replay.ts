import { createHash } from "node:crypto";
import type { CrawlManifest, Page } from "@kontourai/forage";

export const FORAGE_REPLAY_BODY = "<h1>Sample heading</h1><p>Requested detail.</p>";

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Generic byte-stable page fixture shaped exactly like a Forage replay manifest. */
export function createForageReplayManifest(): CrawlManifest {
  const bodyHash = digest(FORAGE_REPLAY_BODY);
  const snapshot = {
    sourceId: "generic-source",
    url: "https://example.test/generic",
    status: 200,
    fetchedAt: "2026-07-20T00:00:00.000Z",
    body: FORAGE_REPLAY_BODY,
    bodyHash,
    headers: { "content-type": "text/html; charset=utf-8" },
  };
  const params = new URLSearchParams({
    url: snapshot.url,
    sha256: snapshot.bodyHash,
    fetchedAt: snapshot.fetchedAt,
  });
  const page: Page = {
    url: snapshot.url,
    status: snapshot.status,
    body: snapshot.body,
    snapshot,
    sourceRef: `forage-snapshot:${encodeURIComponent(snapshot.sourceId)}?${params.toString()}`,
    depth: 0,
    rendered: false,
    warnings: [],
  };
  return { seed: snapshot.url, pages: [page], truncated: false, warnings: [] };
}
