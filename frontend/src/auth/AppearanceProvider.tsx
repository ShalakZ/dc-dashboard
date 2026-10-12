import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api/client";
import type { Preferences, User } from "../api/types";
import {
  applyAppearance, DEFAULT_APPEARANCE, normalizeAppearance, readMirror, resolveMode, writeMirror,
  type Appearance, type Mode, type ThemeId,
} from "../lib/appearance";
import { useAuth } from "./AuthProvider";

interface AppearanceState {
  mode: Mode;
  theme: ThemeId;
  /** The mode that is on the page: true when it is dark, whether chosen or followed from the device ("Match my device"). */
  dark: boolean;
  setMode(mode: Mode): void;
  setTheme(theme: ThemeId): void;
  /** Set while the last save failed; cleared by the next one that works. */
  error: string | null;
}

const NOT_SAVED = "Not saved. Check the connection and try again.";

// No provider (a component rendered alone in a test): the defaults, and choices that go nowhere.
const AppearanceContext = createContext<AppearanceState>({
  ...DEFAULT_APPEARANCE,
  dark: false,
  setMode: () => {},
  setTheme: () => {},
  error: null,
});

const same = (a: Appearance, b: Appearance) => a.mode === b.mode && a.theme === b.theme;

/** The keys of `wanted` that differ from `confirmed`: what the server still has to hear. */
function difference(confirmed: Appearance, wanted: Appearance): Partial<Appearance> {
  const keys: Partial<Appearance> = {};
  if (wanted.mode !== confirmed.mode) keys.mode = wanted.mode;
  if (wanted.theme !== confirmed.theme) keys.theme = wanted.theme;
  return keys;
}

/**
 * Keeps the look of the page (<html data-mode data-theme>, which themes.css reads) and its browser-side mirror, and saves the signed-in
 * account's choice. Inside AuthProvider, above the router. It starts from the mirror, which is what public/theme-init.js already
 * painted, and writes nothing until there is something to say: a signed-out page keeps the last look used on this browser.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [initial] = useState(() => readMirror() ?? DEFAULT_APPEARANCE);
  const [appearance, setAppearance] = useState<Appearance>(initial);
  const [dark, setDark] = useState(() => resolveMode(initial.mode) === "dark");
  const [error, setError] = useState<string | null>(null);

  // The save queue. `wanted` is the last choice (what the page shows), `confirmed` what the server last said it holds. At most one PUT
  // is out; a choice made meanwhile only moves `wanted`, and when the PUT settles one more goes out if the two still differ.
  // `epoch` changes with the account, so an answer that belongs to the previous one is ignored.
  const wanted = useRef<Appearance>(initial);
  const confirmed = useRef<Appearance>(initial);
  const inFlight = useRef(false);
  const epoch = useRef(0);
  const signedIn = useRef(false);
  const adopted = useRef<User | null>(null);

  const show = useCallback((next: Appearance) => {
    applyAppearance(next);
    setAppearance(next);
    setDark(resolveMode(next.mode) === "dark");
  }, []);

  const flush = useCallback(async () => {
    if (inFlight.current || !signedIn.current) return;
    const sending = wanted.current;
    const body = difference(confirmed.current, sending);
    if (Object.keys(body).length === 0) return;
    const mine = epoch.current;
    inFlight.current = true;
    try {
      const answer = normalizeAppearance(await api.put<Preferences>("/api/me/preferences", body));
      if (epoch.current !== mine) return;
      confirmed.current = answer;
      setError(null);
      if (same(wanted.current, sending)) {
        wanted.current = answer;
        show(answer);
        writeMirror(answer);
      }
    } catch {
      if (epoch.current !== mine) return;
      setError(NOT_SAVED);
      if (same(wanted.current, sending)) {
        wanted.current = confirmed.current;
        show(confirmed.current);
        writeMirror(confirmed.current);
      }
    } finally {
      if (epoch.current === mine) {
        inFlight.current = false;
        void flush();
      }
    }
  }, [show]);

  const choose = useCallback((patch: Partial<Appearance>) => {
    const next = { ...wanted.current, ...patch };
    if (same(next, wanted.current)) return;
    wanted.current = next;
    show(next);
    writeMirror(next);
    void flush();
  }, [show, flush]);

  const setMode = useCallback((mode: Mode) => choose({ mode }), [choose]);
  const setTheme = useCallback((theme: ThemeId) => choose({ theme }), [choose]);

  // A new account (sign-in, setup, or the first /api/me of a page load) brings its own look. The same user object again (the role
  // re-check does not replace it) changes nothing, and no user at all leaves the look and the mirror as they are.
  useEffect(() => {
    signedIn.current = user !== null;
    if (user === null || adopted.current === user) return;
    adopted.current = user;
    epoch.current += 1;
    inFlight.current = false;
    const theirs = normalizeAppearance(user.preferences);
    confirmed.current = theirs;
    wanted.current = theirs;
    setError(null);
    show(theirs);
    writeMirror(theirs);
  }, [user, show]);

  // "Match my device" follows the device while it is the chosen mode, signed in or not. Registered once per mount, removed in cleanup.
  useEffect(() => {
    if (appearance.mode !== "system" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => show(wanted.current);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [appearance.mode, show]);

  const value = useMemo<AppearanceState>(
    () => ({ mode: appearance.mode, theme: appearance.theme, dark, setMode, setTheme, error }),
    [appearance.mode, appearance.theme, dark, setMode, setTheme, error],
  );
  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceState {
  return useContext(AppearanceContext);
}
