import { useIsFetching, useIsMutating, type Query } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import { progress, type Progress } from "../lib/progress";

/**
 * Initial loads only: polling and background refetches of a query that has data never show the bar. A query that has failed
 * before is not an initial load either: with no data it goes back to `pending` on every refetch, but `errorUpdateCount` survives
 * (the retries of the first load do not count, only a final failure does), so a poll that keeps failing does not flash the bar.
 */
const initialLoad = (query: Query) => query.state.data === undefined && query.state.errorUpdateCount === 0;

/** The loading bar along the top edge. It draws the phase of `progress`, which this component feeds from the route and React Query. */
export function TopProgress({ store = progress }: { store?: Progress }) {
  const phase = useSyncExternalStore(store.subscribe, store.getPhase, store.getPhase);
  const fill = useRef<HTMLSpanElement>(null);
  const { pathname } = useLocation();
  const previous = useRef(pathname); // a ref, not a "skip the first run" flag: StrictMode runs the effect twice on mount
  const fetching = useIsFetching({ predicate: initialLoad });
  const mutating = useIsMutating();

  useEffect(() => {
    store.attach();
    return () => store.detach();
  }, [store]);
  useEffect(() => {
    if (previous.current === pathname) return; // a search-param change is not a page change
    previous.current = pathname;
    store.pulse();
  }, [pathname, store]);
  useEffect(() => { store.setCount("fetching", fetching); }, [store, fetching]);
  useEffect(() => { store.setCount("mutating", mutating); }, [store, mutating]);
  // Only on unmount: zeroing in the cleanup of the effects above would cancel and restart the show delay each time a query joins.
  useEffect(() => () => {
    store.setCount("fetching", 0);
    store.setCount("mutating", 0);
  }, [store]);
  // Restart from zero: the reset style has to be computed before `run` replaces it, or the bar would sweep backwards from 100 percent.
  useLayoutEffect(() => {
    if (phase !== "reset") return;
    void fill.current?.offsetWidth;
    store.advance();
  }, [phase, store]);

  return (
    <div className="top-progress" data-phase={phase} aria-hidden="true">
      <span ref={fill} />
    </div>
  );
}
