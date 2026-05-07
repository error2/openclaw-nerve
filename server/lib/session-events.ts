/**
 * In-process pub/sub for gateway `sessions.changed` events.
 *
 * Decouples consumers (kanban, subagent-spawn) from the gateway-rpc client.
 * gateway-rpc forwards every received `sessions.changed` event here via
 * `emitSessionsChanged`. Consumers register with `onSessionsChanged`.
 */

export type SessionsChangedPayload = unknown;
export type SessionsChangedListener = (payload: SessionsChangedPayload) => void;

const listeners = new Set<SessionsChangedListener>();

export function onSessionsChanged(listener: SessionsChangedListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitSessionsChanged(payload: SessionsChangedPayload): void {
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (err) {
      console.warn('[session-events] listener threw:', err);
    }
  }
}

/** @internal */
export function __resetSessionEventsForTesting(): void {
  listeners.clear();
}
