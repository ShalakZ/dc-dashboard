import { useStatus } from "../api/queries";
import { statusView, type StatusView } from "../lib/liveStatus";

/**
 * The word of the stale-meters state, `3 of 48 meters stale`, written as `StatusView.word` has it. The parts a narrow window drops (the `.wide` spans, hidden
 * below the width where the caption goes, app.css) are " of 48" and, for a single stale meter among several, the plural s: the narrow word is `3 meters stale`
 * or `1 meter stale`. The width threshold lives in the stylesheet, never in script. With no CSS (a test, a reader) the full word is there.
 */
function StaleMeters({ stale, total }: { stale: number; total: number | null }) {
  const plural = (total ?? stale) !== 1;
  return <>{stale}{total !== null && <span className="wide"> of {total}</span>} meter{plural && <span className={stale === 1 ? "wide" : undefined}>s</span>} stale</>;
}

const wordOf = (view: StatusView) => (view.staleMeters ? <StaleMeters {...view.staleMeters} /> : view.word);

/**
 * The top bar's state of the data in words. Only the word is a live region, so a change of state is announced and
 * the age that moves on every refresh is not. Nothing while loading or when the request fails, even after an earlier answer
 * (the query keeps its last data, which would say "Live" with the API unreachable): a missing chip is not an alert.
 */
export function StatusChip() {
  const { data, isError } = useStatus();
  const view = statusView(isError ? undefined : data);
  if (!view) return null;
  return (
    <span className="live" data-state={view.state}>
      <b role="status">{wordOf(view)}</b>
      {view.detail && <span className="detail"> · {view.detail}</span>}
    </span>
  );
}
