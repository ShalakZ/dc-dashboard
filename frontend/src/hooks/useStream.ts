import { useEffect, useState } from "react";
import { api } from "../api/client";
import { applyUpdates, parseStreamMessage, type LiveValue } from "../lib/stream";

export interface StreamState {
  values: Map<number, LiveValue>;
  connected: boolean;
}

export function useStream(wanted: Set<number>): StreamState {
  const [live, setLive] = useState<Map<number, LiveValue>>(() => new Map());
  const [connected, setConnected] = useState(false);
  const key = [...wanted].sort((a, b) => a - b).join(",");
  useEffect(() => {
    if (key === "") return;
    const ids = new Set(key.split(",").map(Number));
    const source = new EventSource("/api/stream");
    source.onopen = () => setConnected(true);
    source.onerror = () => {
      setConnected(false);
      // EventSource gives up silently after a 401; probing /api/me lets the api client notice the lost session.
      api.get("/api/me").catch(() => undefined);
    };
    source.onmessage = (event) => setLive((current) => applyUpdates(current, parseStreamMessage(event.data), ids));
    return () => {
      source.close();
      setConnected(false);
    };
  }, [key]);
  return { values: live, connected };
}
