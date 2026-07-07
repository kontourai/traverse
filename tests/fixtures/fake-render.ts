// Network-free render fixtures for the rendered-fetch seam tests (traverse#41).
//
// `fakeRenderImpl` maps a URL -> a scripted `RenderResult` (or a per-call
// queue, so multi-call scenarios can vary the response across invocations),
// records every call (as a URL ledger), and can simulate a renderer throw.
// Mirrors `tests/fixtures/fake-fetch.ts`'s shape for the render seam.

import type { RenderImpl, RenderResult } from "../../src/fetch/types.js";

export interface RenderResultSpec {
  html?: string;
  finalUrl?: string;
  status?: number;
  warnings?: string[];
}

export type RenderRoute = RenderResultSpec | RenderResultSpec[] | { throws: string };

export interface FakeRenderImpl extends RenderImpl {
  /** URL per invocation, in call order — the ledger AC2 asserts against. */
  calls: string[];
}

function isThrowsRoute(route: RenderRoute): route is { throws: string } {
  return typeof (route as { throws?: unknown }).throws === "string";
}

/**
 * Build a fake `RenderImpl`. `routes` maps a URL to either a single spec, an
 * array (a queue consumed one-per-call; the last entry repeats once
 * exhausted), or `{ throws: message }` to simulate a renderer failure.
 */
export function fakeRenderImpl(routes: Record<string, RenderRoute>): FakeRenderImpl {
  const queues = new Map<string, RenderResultSpec[]>();
  const throwers = new Map<string, string>();
  for (const [url, route] of Object.entries(routes)) {
    if (isThrowsRoute(route)) {
      throwers.set(url, route.throws);
    } else {
      queues.set(url, Array.isArray(route) ? [...route] : [route]);
    }
  }
  const calls: string[] = [];

  const fn = (async (url: string, _opts: { userAgent: string; timeoutMs: number }) => {
    calls.push(url);
    const throwMessage = throwers.get(url);
    if (throwMessage !== undefined) {
      throw new Error(throwMessage);
    }
    const queue = queues.get(url);
    if (!queue || queue.length === 0) {
      // Unrouted URL => empty-html/200, so tests must be explicit about what
      // they serve (mirrors fakeFetch's unrouted-404 discipline).
      return { html: "" };
    }
    const spec = queue.length > 1 ? queue.shift()! : queue[0];
    const result: RenderResult = { html: spec.html ?? "" };
    if (spec.finalUrl !== undefined) result.finalUrl = spec.finalUrl;
    if (spec.status !== undefined) result.status = spec.status;
    if (spec.warnings !== undefined) result.warnings = spec.warnings;
    return result;
  }) as FakeRenderImpl;

  fn.calls = calls;
  return fn;
}
