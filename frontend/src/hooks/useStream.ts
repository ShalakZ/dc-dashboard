import { useEffect, useState } from "react";
import { applyUpdates, parseStreamMessage, type LiveValue } from "../lib/stream";

export function useStream(wanted: Set<number>): Map<number, LiveValue> {
  const [live, setLive] = useState<Map<number, LiveValue>>(() => new Map());
  const key = [...wanted].sort((a, b) => a - b).join(",");
  useEffect(() => {
    if (key === "") return;
    const ids = new Set(key.split(",").map(Number));
    const source = new EventSource("/api/stream");
    source.onmessage = (event) => setLive((current) => applyUpdates(current, parseStreamMessage(event.data), ids));
    return () => source.close();
  }, [key]);
  return live;
}
