import { describe, it, expect, vi, beforeEach } from 'vitest';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let rpcImpl: (method: string, params: Record<string, unknown>) => Promise<unknown>;

vi.mock('./gateway-rpc.js', () => ({
  gatewayRpcCall: (method: string, params: Record<string, unknown>) => rpcImpl(method, params),
}));

const { coalescedGatewayCall, clearWsCoalesceCaches, COALESCEABLE_WS_METHODS } = await import('./ws-coalesce.js');

beforeEach(() => {
  clearWsCoalesceCaches();
});

describe('ws-coalesce', () => {
  it('exposes sessions.list as coalesceable', () => {
    expect(COALESCEABLE_WS_METHODS.has('sessions.list')).toBe(true);
  });

  it('dedupes concurrent identical calls into one upstream', async () => {
    let calls = 0;
    rpcImpl = async () => {
      calls++;
      await sleep(20);
      return { sessions: [], n: calls };
    };

    const results = await Promise.all([
      coalescedGatewayCall('sessions.list', { limit: 10 }),
      coalescedGatewayCall('sessions.list', { limit: 10 }),
      coalescedGatewayCall('sessions.list', { limit: 10 }),
      coalescedGatewayCall('sessions.list', { limit: 10 }),
    ]);

    expect(calls).toBe(1);
    expect((results[0] as { n: number }).n).toBe(1);
    expect(results.every((r) => (r as { n: number }).n === 1)).toBe(true);
  });

  it('serves repeat calls from cache for the ttl window', async () => {
    let calls = 0;
    rpcImpl = async () => {
      calls++;
      return { sessions: [], n: calls };
    };

    const first = await coalescedGatewayCall('sessions.list', { limit: 10 });
    const second = await coalescedGatewayCall('sessions.list', { limit: 10 });
    expect(calls).toBe(1);
    expect((second as { n: number }).n).toBe((first as { n: number }).n);
  });

  it('treats param-order changes as the same key', async () => {
    let calls = 0;
    rpcImpl = async () => {
      calls++;
      return { calls };
    };

    await coalescedGatewayCall('sessions.list', { a: 1, b: 2 });
    await coalescedGatewayCall('sessions.list', { b: 2, a: 1 });
    expect(calls).toBe(1);
  });

  it('treats different params as separate keys', async () => {
    let calls = 0;
    rpcImpl = async () => {
      calls++;
      return { calls };
    };

    await Promise.all([
      coalescedGatewayCall('sessions.list', { limit: 10 }),
      coalescedGatewayCall('sessions.list', { limit: 20 }),
    ]);
    expect(calls).toBe(2);
  });

  it('does not cache errors but still dedupes concurrent failures', async () => {
    let calls = 0;
    rpcImpl = async () => {
      calls++;
      await sleep(10);
      throw new Error('boom');
    };

    const settled = await Promise.allSettled([
      coalescedGatewayCall('sessions.list', { limit: 5 }),
      coalescedGatewayCall('sessions.list', { limit: 5 }),
    ]);
    expect(calls).toBe(1);
    expect(settled.every((s) => s.status === 'rejected')).toBe(true);

    // Second wave hits the underlying call again.
    await expect(coalescedGatewayCall('sessions.list', { limit: 5 })).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
});
