import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, setForbiddenHandler, setUnauthorizedHandler } from "../api/client";
import { ROLE_LEVEL, type Role, type User } from "../api/types";

export const RETURN_KEY = "dcdash.returnTo";

/** At most one /api/me check per this long, whatever asks for it (focus, tab visible, a 403). A request inside the window is answered at its end. */
const ROLE_CHECK_GAP_MS = 10_000;

interface AuthState {
  user: User | null;
  /** Set when the server says the signed-in user now has another role than the page loaded with. `user` itself is left alone. */
  roleChange: { from: Role; to: Role } | null;
  setupNeeded: boolean;
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
  const [roleChange, setRoleChange] = useState<AuthState["roleChange"]>(null);
  const queryClient = useQueryClient();
  // The latest signed-in user, for callbacks that must not depend on it. The role the page "loaded with" is this user's role.
  const userRef = useRef<User | null>(null);
  const lastRoleCheck = useRef<number | null>(null);
  /** The one check that waits for the end of the 10 second window; further requests inside the window reuse it. */
  const trailingCheck = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    let cancelled = false;
    (async () => {
      try {
        const status = await api.get<{ needed: boolean }>("/api/setup");
        if (cancelled) return;
        setSetupNeeded(status.needed);
        if (!status.needed) {
          try {
            replaceUser(await api.get<User>("/api/me"));
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 401)) throw error;
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
  }, [replaceUser]);

  const setup = useCallback(async (username: string, password: string) => {
    replaceUser(await api.post<User>("/api/setup", { username, password }));
    setSetupNeeded(false);
  }, [replaceUser]);

  const logout = useCallback(async () => {
    await api.post("/api/logout");
    endSession();
  }, [endSession]);

  const value = useMemo<AuthState>(
    () => ({
      user, roleChange, setupNeeded, loading, login, setup, logout,
      hasRole: (min) => user !== null && ROLE_LEVEL[user.role] >= ROLE_LEVEL[min],
    }),
    [user, roleChange, setupNeeded, loading, login, setup, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
