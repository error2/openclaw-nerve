import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  emitSessionsChanged,
  onSessionsChanged,
  __resetSessionEventsForTesting,
} from './session-events.js';

describe('session-events', () => {
  beforeEach(() => __resetSessionEventsForTesting());

  it('delivers sessions.changed payloads to registered listeners', () => {
    const listener = vi.fn();
    onSessionsChanged(listener);
    emitSessionsChanged({ key: 'agent:foo:main' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ key: 'agent:foo:main' });
  });

  it('returns an unsubscribe function that stops further deliveries', () => {
    const listener = vi.fn();
    const off = onSessionsChanged(listener);
    off();
    emitSessionsChanged({ key: 'agent:foo:main' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates listeners — one throwing does not block others', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = vi.fn();
    const bad = vi.fn(() => { throw new Error('boom'); });
    onSessionsChanged(bad);
    onSessionsChanged(ok);
    emitSessionsChanged({});
    expect(ok).toHaveBeenCalledTimes(1);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});
