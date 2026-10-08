import { useEffect, useState } from "react";

/** The current time (epoch milliseconds), refreshed every `everyMs`, for text such as "12 min ago" that must keep counting on a quiet page. */
export function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
