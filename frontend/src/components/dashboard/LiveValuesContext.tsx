import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStream } from "../../hooks/useStream";
import type { LiveValue } from "../../lib/stream";

interface LiveContextValue {
  values: ReadonlyMap<number, LiveValue>;
  connected: boolean;
  /** Replace the points `owner` wants from the stream; an empty list withdraws the owner. */
  register: (owner: string, pointIds: readonly number[]) => void;
}

const NONE: ReadonlyMap<number, LiveValue> = new Map();
/** Without a provider (a widget rendered on its own) nothing is live and registering does nothing. */
export const LiveValuesContext = createContext<LiveContextValue>({ values: NONE, connected: false, register: () => {} });

/** Widgets register as their own answers arrive; the union is applied once this long after the last change. */
const SETTLE_MS = 50;

const sameIds = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * One `useStream` for the whole dashboard: the union of what the live widgets registered. Registrations are applied
 * after a short quiet period, so widgets that finish loading one after the other open the stream once, not once each.
 */
export function LiveValuesProvider({ children }: { children: ReactNode }) {
  const owners = useRef(new Map<string, readonly number[]>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gone = useRef(false);
  const [wanted, setWanted] = useState<Set<number>>(() => new Set());

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      const next = new Set([...owners.current.values()].flat());
      setWanted((current) => (current.size === next.size && [...next].every((id) => current.has(id)) ? current : next));
    }, SETTLE_MS);
  }, []);
  const register = useCallback((owner: string, pointIds: readonly number[]) => {
    if (sameIds(owners.current.get(owner) ?? [], pointIds)) return;
    if (pointIds.length === 0) owners.current.delete(owner);
    else owners.current.set(owner, pointIds);
    if (!gone.current) schedule(); // children withdraw after this cleanup has run: no timer may outlive the provider
  }, [schedule]);
  useEffect(() => {
    gone.current = false;
    if (owners.current.size > 0) schedule(); // a development remount re-registers its children before this runs
    return () => {
      gone.current = true;
      clearTimeout(timer.current);
    };
  }, [schedule]);

  const { values, connected } = useStream(wanted);
  const value = useMemo(() => ({ values, connected, register }), [values, connected, register]);
  return <LiveValuesContext.Provider value={value}>{children}</LiveValuesContext.Provider>;
}

/** Ask the dashboard's stream for these points while the caller is mounted. */
export function useLiveRegistration(owner: string, pointIds: readonly number[]): void {
  const { register } = useContext(LiveValuesContext);
  const key = pointIds.join(",");
  useEffect(() => {
    register(owner, key === "" ? [] : key.split(",").map(Number));
    return () => register(owner, []);
  }, [owner, key, register]);
}

/**
 * The latest stream entry for a point; undefined when there is none yet, no point, or the stream is down (its entries
 * are then stale, and the widget's own fetched figures, refreshed every 30 s, are the better answer).
 */
export function useLiveValue(pointId: number | null): LiveValue | undefined {
  const { values, connected } = useContext(LiveValuesContext);
  return pointId === null || !connected ? undefined : values.get(pointId);
}
