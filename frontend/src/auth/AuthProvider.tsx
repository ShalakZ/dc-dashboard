import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, setUnauthorizedHandler } from "../api/client";
import { ROLE_LEVEL, type Role, type User } from "../api/types";

export const RETURN_KEY = "dcdash.returnTo";

interface AuthState {
  user: User | null;
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
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await api.get<{ needed: boolean }>("/api/setup");
        if (cancelled) return;
        setSetupNeeded(status.needed);
        if (!status.needed) {
          try {
            setUser(await api.get<User>("/api/me"));
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
    setUnauthorizedHandler(() => {
      setUser(null);
      queryClient.clear();
    });
    return () => setUnauthorizedHandler(null);
  }, [queryClient]);

  const login = useCallback(async (username: string, password: string) => {
    setUser(await api.post<User>("/api/login", { username, password }));
  }, []);

  const setup = useCallback(async (username: string, password: string) => {
    setUser(await api.post<User>("/api/setup", { username, password }));
    setSetupNeeded(false);
  }, []);

  const logout = useCallback(async () => {
    await api.post("/api/logout");
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo<AuthState>(
    () => ({
      user, setupNeeded, loading, login, setup, logout,
      hasRole: (min) => user !== null && ROLE_LEVEL[user.role] >= ROLE_LEVEL[min],
    }),
    [user, setupNeeded, loading, login, setup, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
