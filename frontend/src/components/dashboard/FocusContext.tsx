import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useAssets } from "../../api/queries";
import type { Asset } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { FOCUS_DENIED_NOTICE, FOCUS_GONE_NOTICE, parseFocusParam, topLevel, withFocus } from "../../lib/focus";

/**
 * The dashboard's focus asset: one asset of the tree that the widgets which follow the focus look at, held in the address as `?asset=<id>`.
 * `allowed` is the permission to choose and open assets (R3); `assets` is the asset list once it is loaded (it is only asked for while an
 * `asset` parameter is present); `name` is the focus asset's name, once the list has it.
 */
export interface FocusState {
  focus: number | null;
  allowed: boolean;
  assets: Asset[] | undefined;
  name: string | null;
  /** A sentence for the page when a link's focus was refused or is gone; null when there is nothing to say. */
  notice: string | null;
  /** Push the address with this focus (null = the whole site). Does nothing for the focus it already is, or without permission. */
  setFocus(id: number | null): void;
  /** The server says this asset is gone. Clears the focus only if it is still the one in the address. */
  reportGone(id: number): void;
}

const noop = () => {};
/** A widget drawn without a provider (the unit tests of a lone card) follows nothing. */
const NO_FOCUS: FocusState = { focus: null, allowed: false, assets: undefined, name: null, notice: null, setFocus: noop, reportGone: noop };

export const FocusContext = createContext<FocusState>(NO_FOCUS);
export const useFocus = () => useContext(FocusContext);

/** The quiet line under the trail when a link's focus was refused or is gone. */
export function FocusNotice() {
  const { notice } = useFocus();
  return notice ? <p className="muted" aria-live="polite">{notice}</p> : null;
}

/**
 * Reads `?asset=` and offers it to everything below (R3, R4, R5). Mount it where the dashboard is drawn, in the viewer and the editor alike
 * and in the same place for both, so that switching between them keeps what it remembers.
 */
export function FocusProvider({ children }: { children: ReactNode }) {
  const { user, can } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [gone, setGone] = useState(false);

  // Until the signed-in user is known `can` says no to everything; that is not a refusal, so nothing is decided yet.
  const settled = user !== null;
  const allowed = settled && can("assets.view");
  const raw = params.get("asset");
  const parsed = useMemo(() => parseFocusParam(raw), [raw]);
  const focus = allowed && parsed.kind === "id" ? parsed.id : null;

  // The list is asked for only while a valid id is in the address; its cache is shared, so a list that is already loaded is used as is.
  const list = useAssets(allowed && parsed.kind === "id");
  // A list that was cached before this screen mounted may be stale: only one read after the mount may say that an asset is not there.
  const fresh = list.isFetchedAfterMount && list.isSuccess ? list.data : undefined;
  const assets = allowed ? list.data : undefined;

  // The address as the callbacks must see it: re-read when the location changes, and written ahead by our own navigations (they commit a
  // moment later), so that N cards reporting the same gone asset, or a doubled effect, make one navigation and not N.
  const here = useRef({ key: location.key, pathname: location.pathname, search: location.search, hash: location.hash, state: location.state as unknown, raw });
  if (here.current.key !== location.key) here.current = { key: location.key, pathname: location.pathname, search: location.search, hash: location.hash, state: location.state, raw };
  const live = useRef({ allowed, navigate, fresh });
  live.current = { allowed, navigate, fresh };

  /** Remove `asset` from the address by `replace`, but only if it still reads `expected` (a later change or an earlier call wins); `sentence` also says why. */
  const clear = useCallback((expected: string, sentence: boolean) => {
    const now = here.current;
    if (now.raw !== expected) return;
    const search = withFocus(now.search, null);
    live.current.navigate({ pathname: now.pathname, search, hash: now.hash }, { replace: true, state: now.state });
    here.current = { ...now, search, raw: null };
    if (sentence) setGone(true);
  }, []);

  useEffect(() => {
    if (allowed && parsed.kind === "invalid" && raw !== null) clear(raw, true);
  }, [allowed, parsed.kind, raw, clear]);

  useEffect(() => {
    if (!allowed || parsed.kind !== "id" || !fresh || raw === null) return;
    if (!fresh.some((asset) => asset.id === parsed.id)) clear(raw, true);
    else {
      const roots = topLevel(fresh);
      if (roots.length === 1 && roots[0].id === parsed.id) clear(raw, false);
    }
  }, [allowed, parsed, raw, fresh, clear]);

  const setFocus = useCallback((chosen: number | null) => {
    const now = here.current;
    if (!live.current.allowed) return;
    // The only top-level asset is the whole site (R5): choosing it is choosing no focus. Only a fresh list may say so, as in the effect above, and mapping it here
    // lets the no-op check below stop a push that the effect would at once replace away (Back would land on the same page).
    const roots = live.current.fresh ? topLevel(live.current.fresh) : [];
    const id = chosen !== null && roots.length === 1 && roots[0].id === chosen ? null : chosen;
    const current = parseFocusParam(now.raw);
    if ((current.kind === "id" ? current.id : null) === id) return;
    const search = withFocus(now.search, id);
    live.current.navigate({ pathname: now.pathname, search, hash: now.hash }, { state: null });
    here.current = { ...now, search, raw: id === null ? null : String(id) };
  }, []);

  const reportGone = useCallback((id: number) => {
    if (live.current.allowed) clear(String(id), true);
  }, [clear]);

  const name = focus === null ? null : (assets?.find((asset) => asset.id === focus)?.name ?? null);
  const notice = !settled ? null : !allowed ? (raw !== null ? FOCUS_DENIED_NOTICE : null) : gone ? FOCUS_GONE_NOTICE : null;
  const value = useMemo<FocusState>(
    () => ({ focus, allowed, assets, name, notice, setFocus, reportGone }),
    [focus, allowed, assets, name, notice, setFocus, reportGone],
  );
  return <FocusContext.Provider value={value}>{children}</FocusContext.Provider>;
}
