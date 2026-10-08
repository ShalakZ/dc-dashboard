/**
 * A stand-in for the browser's EventSource, shared by the tests that mount a live dashboard. Install it with
 * `vi.stubGlobal("EventSource", FakeEventSource)` and call `FakeEventSource.reset()` first, so every test sees only its own streams.
 * It has `readyState` and a static `CLOSED = 2`, because `useStream` reopens a stream that the browser closed.
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static CLOSED = 2;
  /** The streams that were not closed. */
  static get open(): FakeEventSource[] { return FakeEventSource.instances.filter((s) => !s.closed); }
  static reset(): void { FakeEventSource.instances = []; }

  readyState = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close(): void { this.closed = true; this.readyState = 2; }
  /** Deliver one stream message (the payload is JSON-encoded, as on the wire). */
  emit(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
  /** What a browser does after a 401 or a 502: the connection is CLOSED and `error` fires. */
  fail(readyState = 2): void { this.readyState = readyState; this.onerror?.(); }
}
