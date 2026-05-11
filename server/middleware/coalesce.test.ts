import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { coalesce } from './coalesce.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('coalesce middleware', () => {
  it('dedupes concurrent identical GETs into one upstream call', async () => {
    let calls = 0;
    const app = new Hono();
    app.get('/test', coalesce({ ttlMs: 200 }), async (c) => {
      calls++;
      await sleep(30);
      return c.json({ n: calls });
    });

    const responses = await Promise.all([
      app.request('/test'),
      app.request('/test'),
      app.request('/test'),
      app.request('/test'),
      app.request('/test'),
    ]);

    expect(calls).toBe(1);
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as Array<{ n: number }>;
    expect(bodies.every((b) => b.n === 1)).toBe(true);

    const markers = responses.map((r) => r.headers.get('X-Coalesced'));
    expect(markers).toContain('miss');
    expect(markers.filter((m) => m === 'wait').length).toBeGreaterThan(0);
  });

  it('micro-caches for ttlMs after the first call returns', async () => {
    let calls = 0;
    const app = new Hono();
    app.get('/test', coalesce({ ttlMs: 100 }), async (c) => {
      calls++;
      return c.json({ n: calls });
    });

    const r1 = await app.request('/test');
    expect(((await r1.json()) as { n: number }).n).toBe(1);
    expect(r1.headers.get('X-Coalesced')).toBe('miss');

    const r2 = await app.request('/test');
    expect(((await r2.json()) as { n: number }).n).toBe(1);
    expect(r2.headers.get('X-Coalesced')).toBe('hit');
  });

  it('re-runs the handler after the TTL expires', async () => {
    let calls = 0;
    const app = new Hono();
    app.get('/test', coalesce({ ttlMs: 20 }), async (c) => {
      calls++;
      return c.json({ n: calls });
    });

    await app.request('/test');
    await sleep(50);
    await app.request('/test');
    expect(calls).toBe(2);
  });

  it('keys distinct query strings separately', async () => {
    let calls = 0;
    const app = new Hono();
    app.get('/test', coalesce({ ttlMs: 200 }), async (c) => {
      calls++;
      return c.json({ q: c.req.query('q') });
    });

    await Promise.all([app.request('/test?q=a'), app.request('/test?q=b')]);
    expect(calls).toBe(2);
  });

  it('treats query parameters as order-insensitive', async () => {
    let calls = 0;
    const app = new Hono();
    app.get('/test', coalesce({ ttlMs: 200 }), async (c) => {
      calls++;
      return c.json({ ok: true });
    });

    await app.request('/test?a=1&b=2');
    const r2 = await app.request('/test?b=2&a=1');
    expect(calls).toBe(1);
    expect(r2.headers.get('X-Coalesced')).toBe('hit');
  });

  it('does not cache error responses but still dedupes concurrent ones', async () => {
    let calls = 0;
    const app = new Hono();
    app.get('/test', coalesce({ ttlMs: 200 }), async (c) => {
      calls++;
      await sleep(20);
      return c.json({ error: 'boom' }, 500);
    });

    const [r1, r2] = await Promise.all([app.request('/test'), app.request('/test')]);
    expect(calls).toBe(1);
    expect(r1.status).toBe(500);
    expect(r2.status).toBe(500);

    await sleep(30);
    await app.request('/test');
    expect(calls).toBe(2);
  });

  it('bypasses non-GET methods', async () => {
    let calls = 0;
    const app = new Hono();
    app.use('/test', coalesce({ ttlMs: 200 }));
    app.post('/test', async (c) => {
      calls++;
      return c.json({ n: calls });
    });

    await app.request('/test', { method: 'POST' });
    await app.request('/test', { method: 'POST' });
    expect(calls).toBe(2);
  });

  it('evicts oldest entries when maxEntries is exceeded', async () => {
    let calls = 0;
    const app = new Hono();
    app.get('/test', coalesce({ ttlMs: 10_000, maxEntries: 2 }), async (c) => {
      calls++;
      return c.json({ q: c.req.query('q'), n: calls });
    });

    await app.request('/test?q=a');
    await app.request('/test?q=b');
    await app.request('/test?q=c');
    // After the third miss the cache holds {b, c} and q=a was evicted FIFO.
    // Check the survivors first — a miss on q=a would refill and evict q=b.
    const rB = await app.request('/test?q=b');
    expect(rB.headers.get('X-Coalesced')).toBe('hit');
    const rC = await app.request('/test?q=c');
    expect(rC.headers.get('X-Coalesced')).toBe('hit');
    const rA = await app.request('/test?q=a');
    expect(rA.headers.get('X-Coalesced')).toBe('miss');
  });
});
