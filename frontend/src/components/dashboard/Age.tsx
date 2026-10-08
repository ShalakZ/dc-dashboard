import { useNow } from "../../hooks/useNow";
import { ageText } from "../../lib/widgetFormat";

/** "12 min ago" for a reading time, dimmed, recounted every 30 s (a silent meter sends no new data to re-render on). */
export function Age({ ts }: { ts: string }) {
  const text = ageText(ts, useNow(30_000));
  return text ? <small className="muted">{text}</small> : null;
}
