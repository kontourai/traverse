// Network-free fetch fixtures for Slice-2 fetch tests.
//
// `fakeFetch` maps a URL -> a scripted response (or a per-call queue, so retry
// paths can return different results across attempts), records every request,
// and honors the AbortSignal so timeout tests are deterministic without real
// timers. Nothing here touches the network.

import type { FetchLike, FetchLikeResponse } from "../../src/fetch/types.js";

export interface FakeResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** when set, reject as if the network failed (before any response). */
  networkError?: string;
  /** when true, never resolve until aborted — used with a firing scheduler for timeouts. */
  hang?: boolean;
}

export interface FakeFetchCall {
  url: string;
  headers: Record<string, string>;
}

export interface FakeFetch extends FetchLike {
  calls: FakeFetchCall[];
}

function makeResponse(spec: FakeResponseSpec): FetchLikeResponse {
  const headers = new Map<string, string>();
  for (const [k, v] of Object.entries(spec.headers ?? {})) headers.set(k.toLowerCase(), v);
  return {
    status: spec.status ?? 200,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    async text() {
      return spec.body ?? "";
    },
  };
}

/**
 * Build a fake fetch. `routes` maps a URL to either a single spec or an array
 * (a queue consumed one-per-call; the last entry repeats once exhausted).
 */
export function fakeFetch(
  routes: Record<string, FakeResponseSpec | FakeResponseSpec[]>,
): FakeFetch {
  const queues = new Map<string, FakeResponseSpec[]>();
  for (const [url, spec] of Object.entries(routes)) {
    queues.set(url, Array.isArray(spec) ? [...spec] : [spec]);
  }
  const calls: FakeFetchCall[] = [];

  const fn = (async (url, init) => {
    calls.push({ url, headers: init.headers });
    const queue = queues.get(url);
    if (!queue || queue.length === 0) {
      // Unrouted URL => 404, so tests must be explicit about what they serve.
      return makeResponse({ status: 404, body: "" });
    }
    const spec = queue.length > 1 ? queue.shift()! : queue[0];

    if (spec.hang) {
      return new Promise<FetchLikeResponse>((_resolve, reject) => {
        if (init.signal.aborted) {
          reject(abortError());
          return;
        }
        init.signal.addEventListener("abort", () => reject(abortError()));
      });
    }
    if (spec.networkError) {
      if (init.signal.aborted) throw abortError();
      throw new Error(spec.networkError);
    }
    return makeResponse(spec);
  }) as FakeFetch;

  fn.calls = calls;
  return fn;
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/** A scheduler that fires the timeout callback immediately (for timeout tests). */
export function firingSchedule(ms: number, cb: () => void): () => void {
  cb();
  return () => {};
}

/** A scheduler that never fires (the common case: request resolves first). */
export function inertSchedule(_ms: number, _cb: () => void): () => void {
  return () => {};
}
