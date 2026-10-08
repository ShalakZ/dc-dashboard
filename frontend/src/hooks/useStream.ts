import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { applyUpdates, parseStreamMessage, type LiveValue } from "../lib/stream";

export interface StreamState {
  values: Map<number, LiveValue>;
  connected: boolean;
}

/** `EventSource.CLOSED`, compared as a number so that a test double without the constant cannot arm a reopen. */
const CLOSED = 2;
const FIRST_RETRY_MS = 5_000;
const MAX_RETRY_MS = 60_000;

export function useStream(wanted: Set<number>): StreamState {
  const [live, setLive] = useState<Map<number, LiveValue>>(() => new Map());
  const [connected, setConnected] = useState(false);
  // Bumped to open a fresh EventSource after the browser gave up on the old one.
  const [retry, setRetry] = useState(0);
  const failures = useRef(0);
  const key = [...wanted].sort((a, b) => a - b).join(",");
  useEffect(() => {
    if (key === "") return;
    const ids = new Set(key.split(",").map(Number));
    const source = new EventSource("/api/stream");
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => {
      failures.current = 0;
      setConnected(true);
    };
    source.onerror = () => {
      setConnected(false);
      // EventSource gives up silently after a 401 (or a 502 while the api restarts). The probe lets the api client
      // notice a lost session: /api/me is exempt from the 401 handler, a plain data request such as /api/site is not.
      api.get("/api/site").catch(() => undefined);
      // CLOSED means the browser will not retry by itself (CONNECTING means it will): reopen with a growing pause.
      if (source.readyState === CLOSED && timer === undefined) {
        const delay = Math.min(FIRST_RETRY_MS * 2 ** failures.current, MAX_RETRY_MS);
        failures.current += 1;
        timer = setTimeout(() => setRetry((n) => n + 1), delay);
      }
    };
    source.onmessage = (event) => setLive((current) => applyUpdates(current, parseStreamMessage(event.data), ids));
    return () => {
      clearTimeout(timer);
      source.close();
      setConnected(false);
    };
  }, [key, retry]);
  return { values: live, connected };
}
