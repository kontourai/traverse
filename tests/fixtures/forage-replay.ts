import { createHash } from "node:crypto";
import { decodeTextBody, parseDeclaredCharset } from "@kontourai/forage";
import type { CrawlManifest, Page, Snapshot } from "@kontourai/forage";
import { buildSnapshotSourceRef } from "@kontourai/forage/fetch";

export const FORAGE_REPLAY_BODY = "<h1>Sample heading</h1><p>Requested detail.</p>";

/**
 * Generic byte-stable page fixture shaped like a Forage replay manifest. The
 * text snapshot fields (bytes, declared charset, decoded body, byte hash) and
 * the durable sourceRef come from Forage's own exported builders, so the
 * fixture follows Forage's current record format instead of a hand copy.
 */
export function createForageReplayManifest(): CrawlManifest {
  const headers = { "content-type": "text/html; charset=utf-8" };
  const bytes = new TextEncoder().encode(FORAGE_REPLAY_BODY);
  const declaredCharset = parseDeclaredCharset(headers["content-type"]).charset;
  const snapshot: Snapshot = {
    sourceId: "generic-source",
    url: "https://example.test/generic",
    status: 200,
    fetchedAt: "2026-07-20T00:00:00.000Z",
    body: decodeTextBody(bytes, declaredCharset).text,
    bytes,
    declaredCharset,
    bodyHash: createHash("sha256").update(bytes).digest("hex"),
    headers,
  };
  const page: Page = {
    url: snapshot.url,
    status: snapshot.status,
    body: snapshot.body,
    snapshot,
    sourceRef: buildSnapshotSourceRef(snapshot),
    depth: 0,
    rendered: false,
    warnings: [],
  };
  return { seed: snapshot.url, pages: [page], truncated: false, warnings: [] };
}
