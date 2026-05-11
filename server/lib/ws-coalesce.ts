/**
 * Coalesce + micro-cache for gateway WS-proxy reads.
 *
 * Companion to `server/middleware/coalesce.ts` (the Hono-REST version), but
 * sits on the JSON-RPC-over-WebSocket path that proxies browser → nerve →
 * gateway. The Control UI frontend spams `sessions.list` over this channel,
 * not through REST routes, so the REST middleware never sees it. This
 * module catches it there.
 *
 * Two layers, both keyed on `method:stable-stringify(params)`:
 *  1. In-flight Promise dedupe — concurrent identical reqs share ONE call.
 *  2. Micro-cache — successful payloads reused for `WS_COALESCE_TTL_MS`.
 *
 * Safe to apply to READ methods whose responses are identity-agnostic
 * (gateway returns the same payload regardless of which authenticated
 * caller asked). For now: `sessions.list` only. Add to
 * `COALESCEABLE_WS_METHODS` after auditing each candidate's response shape.
 *
 * Uses `gatewayRpcCall` (the shared nerve→gateway client connection) so
 * many browser tabs collapse onto a single physical WS request. Errors are
 * not cached — concurrent failures still dedupe, but subsequent retries hit
 * fresh.
 *
 * @module
 */

import { gatewayRpcCall } from './gateway-rpc.js';

interface CacheEntry {
  payload: unknown;
  expiresAt: number;
}

export const WS_COALESCE_TTL_MS = 750;
export const WS_COALESCE_MAX_ENTRIES = 100;

/**
 * JSON-RPC methods that are safe to coalesce across the WS proxy.
 *
 * Criteria: read-only, response shape identical for any authenticated
 * caller, and benign to delay by up to `WS_COALESCE_TTL_MS`. Do NOT add
 * mutation/effectful methods.
 */
export const COALESCEABLE_WS_METHODS = new Set(['sessions.list']);

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Stable JSON for use as a cache key — sorts top-level keys so semantically
 * equal params produce equal strings. Sufficient for the params we coalesce
 * today (flat objects); revisit if nested ordering becomes a concern.
 */
function stableStringify(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

/**
 * Call `gatewayRpcCall(method, params)` via cache + inflight dedupe.
 * Returns the cached/shared payload, throws on RPC error.
 */
export async function coalescedGatewayCall(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const key = `${method}:${stableStringify(params ?? {})}`;
  const now = Date.now();

  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.payload;

  let promise = inflight.get(key);
  if (!promise) {
    promise = gatewayRpcCall(method, params);
    inflight.set(key, promise);
    promise
      .then((payload) => {
        cache.set(key, { payload, expiresAt: Date.now() + WS_COALESCE_TTL_MS });
        if (cache.size > WS_COALESCE_MAX_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      })
      .catch(() => {
        // Don't cache errors; let next attempt retry.
      })
      .finally(() => inflight.delete(key));
    // Swallow late unhandled rejection for the cached promise itself —
    // awaiters get the rejection via the await below.
    promise.catch(() => {});
  }
  return promise;
}

/** Test-only: wipe the cache + inflight maps for deterministic runs. */
export function clearWsCoalesceCaches(): void {
  cache.clear();
  inflight.clear();
}
