import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, isUnreachable, setForbiddenHandler, setUnauthorizedHandler } from "../api/client";
import { ROLE_LEVEL, type Role, type User } from "../api/types";

export const RETURN_KEY = "dcdash.returnTo";

/** At most one /api/me check per this long, whatever asks for it (focus, tab visible, a 403). A request inside the window is answered at its end. */
const ROLE_CHECK_GAP_MS = 10_000;

/** The gaps between the first sign-in check's attempts while the server cannot be reached: 3 s, 6 s, 10 s, then 15 s each time. */
const RETRY_GAPS_MS = [3_000, 6_000, 10_000, 15_000];

/** The shape of what /api/me answers for a signed-in user, as far as the app relies on it: a name and one of the three roles. */
const isUser = (value: unknown): value is User =>
  typeof value === "object" && value !== null
  && typeof (value as { username?: unknown }).username === "string"
  && typeof (value as { role?: unknown }).role === "string"
  && Object.hasOwn(ROLE_LEVEL, (value as { role: string }).role);

interface AuthState {
  user: User | null;
  /** Set when the server says the signed-in user now has another role than the page loaded with. `user` itself is left alone. */
  roleChange: { from: Role; to: Role } | null;
  setupNeeded: boolean;
  /** True while the first sign-in check gets no answer (no network, or the proxy answers 502, 503 or 504). It tries again by itself; until it is answered nobody is signed in and nothing redirects. */
  unreachable: boolean;
  /** Asks the first sign-in check again now. Does nothing while a request of it is already out. */
  retryNow(): void;
  /** True from the start of an explicit sign-out until the next sign-in: RequireAuth then does not remember the page the user left from. A 401 does not set it. */
  signedOutOnPurpose: boolean;
  /** Ends the mark above. The sign-in page calls it once it shows, so the mark only covers the render that follows the sign-out. */
  clearSignOutMark(): void;
  loading: boolean;
  login(username: string, password: string): Promise<void>;
  setup(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  hasRole(min: Role): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const [signedOutOnPurpose, setSignedOutOnPurpose] = useState(false);
  const [roleChange, setRoleChange] = useState<AuthState["roleChange"]>(null);
  const queryClient = useQueryClient();
  // The latest signed-in user, for callbacks that must not depend on it. The role the page "loaded with" is this user's role.
  const userRef = useRef<User | null>(null);
  const lastRoleCheck = useRef<number | null>(null);
  /** The one check that waits for the end of the 10 second window; further requests inside the window reuse it. */
  const trailingCheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The running first sign-in check (its current effect run): asking again, and ending it once somebody has signed in. */
  const bootstrap = useRef<{ retryNow(): void; stop(): void } | null>(null);

  const cancelTrailingCheck = useCallback(() => {
    if (trailingCheck.current !== null) clearTimeout(trailingCheck.current);
    trailingCheck.current = null;
  }, []);

  /** Every change of who is signed in goes through here, so an announcement never outlives the session it was about. */
  const replaceUser = useCallback((next: User | null) => {
    userRef.current = next; // at once, so a focus event right after sign-in already finds the user
    cancelTrailingCheck();
    setUser(next);
    setRoleChange(null);
  }, [cancelTrailingCheck]);

  const endSession = useCallback(() => {
    replaceUser(null);
    queryClient.clear();
  }, [replaceUser, queryClient]);

  /** Ask the server who we are now, to notice a role changed under an open page. Never throws; does nothing while signed out. */
  const askRole = useCallback(async () => {
    const loadedWith = userRef.current;
    if (!loadedWith) return;
    lastRoleCheck.current = Date.now();
    try {
      const fresh = await api.get<User>("/api/me");
      if (userRef.current !== loadedWith) return; // signed out, or in as someone else, while the request was out
      setRoleChange((current) => {
        if (fresh.role === loadedWith.role) return null;
        return current?.to === fresh.role ? current : { from: loadedWith.role, to: fresh.role };
      });
    } catch (error) {
      // /api/me is an auth path, so the unauthorized handler never sees its 401: the account was deactivated or the session expired.
      if (error instanceof ApiError && error.status === 401 && userRef.current === loadedWith) endSession();
      // Any other failure (network, 5xx) says nothing about the role; the next focus tries again.
    }
  }, [endSession]);

  /** Ask now, or, inside the window after the last check, once at its end: a 403 is often the first sign of a demotion, so it is not dropped. */
  const checkRole = useCallback(() => {
    if (!userRef.current) return;
    const sinceLast = lastRoleCheck.current === null ? Infinity : Date.now() - lastRoleCheck.current;
    if (sinceLast >= 0 && sinceLast < ROLE_CHECK_GAP_MS) {
      trailingCheck.current ??= setTimeout(() => {
        trailingCheck.current = null;
        void askRole();
      }, ROLE_CHECK_GAP_MS - sinceLast);
      return;
    }
    cancelTrailingCheck(); // this check answers whatever was waiting
    void askRole();
  }, [askRole, cancelTrailingCheck]);

  useEffect(() => cancelTrailingCheck, [cancelTrailingCheck]);

  useEffect(() => {
    let cancelled = false; // this run of the effect was cleaned up (unmount; in development, StrictMode's first pass)
    let superseded = false; // somebody signed in meanwhile: nothing this check finds may replace them
    let running = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };

    const attempt = async () => {
      if (running || cancelled || superseded) return;
      clearTimer();
      running = true;
      try {
        const status = await api.get<{ needed: boolean }>("/api/setup");
        let found: User | null = null;
        if (!status.needed) {
          try {
            const me = await api.get<unknown>("/api/me");
            // A 200 that is not a user (a captive portal's page, say) must not become one: it ends like any other answer this check cannot use.
            if (!isUser(me)) throw new Error("/api/me did not answer with a user");
            found = me;
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 401)) throw error;
          }
        }
        if (cancelled || superseded) return;
        // All together, after the last request: a frame between them (no longer unreachable, nobody found yet) would send the visitor to the sign-in page.
        setSetupNeeded(status.needed);
        if (found) replaceUser(found);
        setUnreachable(false);
      } catch (error) {
        if (!isUnreachable(error)) {
          // The server answered, with something this check does not handle; what follows is what always followed (nobody signed in, the
          // visitor lands on /login). Logged and not thrown: nobody awaits this, so a throw could only end as an unhandled rejection.
          if (!cancelled && !superseded) setUnreachable(false);
          console.error(error);
          return;
        }
        if (cancelled || superseded) return;
        setUnreachable(true); // before `loading` ends in the finally, so the first frame after it is the panel and not the sign-in page
        timer = setTimeout(() => {
          timer = null;
          void attempt();
        }, RETRY_GAPS_MS[Math.min(failures, RETRY_GAPS_MS.length - 1)]);
        failures += 1;
      } finally {
        running = false;
        if (!cancelled) setLoading(false);
      }
    };

    bootstrap.current = {
      retryNow: () => void attempt(),
      stop: () => {
        superseded = true;
        clearTimer();
      },
    };
    void attempt();
    return () => {
      cancelled = true;
      clearTimer();
      bootstrap.current = null;
    };
  }, [replaceUser]);

  const retryNow = useCallback(() => bootstrap.current?.retryNow(), []);

  useEffect(() => {
    setUnauthorizedHandler(endSession);
    return () => setUnauthorizedHandler(null);
  }, [endSession]);

  useEffect(() => {
    setForbiddenHandler(checkRole);
    return () => setForbiddenHandler(null);
  }, [checkRole]);

  useEffect(() => {
    // checkRole does nothing while signed out, so these can stay registered for the life of the provider.
    const onFocus = () => checkRole();
    const onVisibility = () => {
      if (document.visibilityState === "visible") checkRole();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [checkRole]);

  const login = useCallback(async (username: string, password: string) => {
    replaceUser(await api.post<User>("/api/login", { username, password }));
    bootstrap.current?.stop(); // an answer came, so the first check has nothing left to find
    setUnreachable(false);
    setSignedOutOnPurpose(false);
  }, [replaceUser]);

  const setup = useCallback(async (username: string, password: string) => {
    replaceUser(await api.post<User>("/api/setup", { username, password }));
    bootstrap.current?.stop();
    setUnreachable(false);
    setSetupNeeded(false);
    setSignedOutOnPurpose(false);
  }, [replaceUser]);

  const clearSignOutMark = useCallback(() => setSignedOutOnPurpose(false), []);

  const logout = useCallback(async () => {
    // Before the request: a 401 that lands while it is out (a poll already on its way) ends the session first and must not remember the page.
    setSignedOutOnPurpose(true);
    try {
      await api.post("/api/logout");
    } catch (error) {
      setSignedOutOnPurpose(false); // still signed in
      throw error;
    }
    endSession();
  }, [endSession]);

  const value = useMemo<AuthState>(
    () => ({
      user, roleChange, setupNeeded, unreachable, retryNow, signedOutOnPurpose, clearSignOutMark, loading, login, setup, logout,
      hasRole: (min) => user !== null && ROLE_LEVEL[user.role] >= ROLE_LEVEL[min],
    }),
    [user, roleChange, setupNeeded, unreachable, retryNow, signedOutOnPurpose, clearSignOutMark, loading, login, setup, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
