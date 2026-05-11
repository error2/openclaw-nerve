/**
 * Request coalescing + micro-cache middleware for high-fanout idempotent GETs.
 *
 * Two layers, both keyed on `path?sorted-querystring`:
 *  1. In-flight Promise dedupe — concurrent identical requests share ONE upstream call.
 *  2. Micro-cache — completed 2xx/3xx responses are reused for `ttlMs` afterwards.
 *
 * Sets `X-Coalesced: hit | wait | miss` so observers can see the effective rate.
 *
 * Why this exists: Nerve's frontend (SessionContext, useModelEffort) polls
 * `/api/sessions/hidden`, `/api/sessions/runtime`, `/api/gateway/session-info`
 * every few seconds. Each call fans out to `sessions.list` on the gateway,
 * which on small hardware (2-core NAS) becomes a CPU hotspot. Until the
 * frontend migrates to `sessions.subscribe`/`sessions.changed` (mirroring
 * upstream openclaw#59317), this middleware caps the upstream rate without
 * changing user-visible behavior — the 750ms default window is well below
 * the perception threshold but absorbs the burst from a single React render
 * cycle that triggers all three pollers at once.
 *
 * Apply per-route (NOT globally) to avoid surprising effects on writes,
 * SSE, or auth-dependent responses.
 *
 * @module
 */

import type { MiddlewareHandler } from 'hono';

interface CacheEntry {
  body: string;
  status: number;
  contentType: string;
  expiresAt: number;
}

export interface CoalesceOptions {
  /** How long a successful response is reused before re-running the handler. Default 750ms. */
  ttlMs?: number;
  /** Cap on cached entries; oldest are evicted FIFO. Default 200. */
  maxEntries?: number;
}

/**
 * All caches created by `coalesce()`. Tests can call `clearAllCoalesceCaches()`
 * in `beforeEach` to keep mocked routes deterministic across runs.
 */
const allInstances: Array<{ inflight: Map<string, unknown>; cache: Map<string, CacheEntry> }> = [];

export function clearAllCoalesceCaches(): void {
  for (const inst of allInstances) {
    inst.inflight.clear();
    inst.cache.clear();
  }
}

export const coalesce = (opts: CoalesceOptions = {}): MiddlewareHandler => {
  const ttlMs = opts.ttlMs ?? 750;
  const maxEntries = opts.maxEntries ?? 200;
  const inflight = new Map<string, Promise<CacheEntry>>();
  const cache = new Map<string, CacheEntry>();
  allInstances.push({ inflight: inflight as Map<string, unknown>, cache });

  return async (c, next) => {
    if (c.req.method !== 'GET') return next();

    const u = new URL(c.req.url);
    u.searchParams.sort();
    const key = `${u.pathname}?${u.searchParams.toString()}`;

    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      return new Response(cached.body, {
        status: cached.status,
        headers: { 'Content-Type': cached.contentType, 'X-Coalesced': 'hit' },
      });
    }

    const existing = inflight.get(key);
    if (existing) {
      const entry = await existing;
      return new Response(entry.body, {
        status: entry.status,
        headers: { 'Content-Type': entry.contentType, 'X-Coalesced': 'wait' },
      });
    }

    let resolveInflight!: (e: CacheEntry) => void;
    let rejectInflight!: (err: unknown) => void;
    const promise = new Promise<CacheEntry>((res, rej) => {
      resolveInflight = res;
      rejectInflight = rej;
    });
    // Silence unhandled rejection if no awaiter joined before the handler threw.
    promise.catch(() => {});
    inflight.set(key, promise);

    try {
      await next();
      const res = c.res;
      const body = await res.clone().text();
      const entry: CacheEntry = {
        body,
        status: res.status,
        contentType: res.headers.get('content-type') ?? 'application/json',
        expiresAt: now + ttlMs,
      };
      if (res.status >= 200 && res.status < 400) {
        cache.set(key, entry);
        if (cache.size > maxEntries) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      }
      c.header('X-Coalesced', 'miss');
      resolveInflight(entry);
    } catch (err) {
      rejectInflight(err);
      throw err;
    } finally {
      inflight.delete(key);
    }
  };
};
