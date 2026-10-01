// A loopback HTTP server that serves the same heading three ways: as latin1,
// as UTF-8 behind a byte-order mark, and as plain UTF-8. The bytes are built
// here by hand so a test can hash exactly what went over the wire.

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** The heading every page carries. Its accented letters differ between latin1 and UTF-8. */
export const CHARSET_HEADING = "Café Señor Session";

const LATIN1_HTML = `<html><body><h1>${CHARSET_HEADING}</h1><a href="/bom">next</a></body></html>`;
const BOM_HTML = `<html><body><h1>${CHARSET_HEADING}</h1></body></html>`;
const PLAIN_HTML = `<html><body><h1>${CHARSET_HEADING}</h1><p>plain</p></body></html>`;

export interface CharsetPage {
  path: string;
  contentType: string;
  /** exactly what the server writes. */
  bytes: Uint8Array;
  /** the text a correct decode yields. */
  text: string;
  /** SHA-256 of `bytes`, computed here rather than by the code under test. */
  sha256: string;
}

function page(path: string, contentType: string, bytes: Uint8Array, text: string): CharsetPage {
  return { path, contentType, bytes, text, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export const CHARSET_PAGES = {
  latin1: page("/latin1", "text/html; charset=iso-8859-1", new Uint8Array(Buffer.from(LATIN1_HTML, "latin1")), LATIN1_HTML),
  bom: page(
    "/bom",
    "text/html; charset=utf-8",
    new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BOM_HTML, "utf8")])),
    BOM_HTML,
  ),
  plain: page("/plain", "text/html; charset=utf-8", new Uint8Array(Buffer.from(PLAIN_HTML, "utf8")), PLAIN_HTML),
} as const;

export interface CharsetServer {
  origin: string;
  close(): Promise<void>;
}

export async function startCharsetServer(): Promise<CharsetServer> {
  const byPath = new Map<string, CharsetPage>(Object.values(CHARSET_PAGES).map((p) => [p.path, p]));
  const server: Server = createServer((req, res) => {
    const found = byPath.get(req.url ?? "");
    if (!found) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": found.contentType, "content-length": String(found.bytes.byteLength) });
    res.end(found.bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
