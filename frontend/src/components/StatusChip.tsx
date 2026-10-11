import { useStatus } from "../api/queries";
import { statusView } from "../lib/liveStatus";

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
      <b role="status">{view.word}</b>
      {view.detail && <span className="detail"> · {view.detail}</span>}
    </span>
  );
}
