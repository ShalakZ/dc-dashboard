import type { ReactElement } from "react";
import { ToastContext, type ToastApi } from "../components/Toasts";

export type ToastCall = { kind: "success" | "info" | "error"; text: string };

/**
 * A toast api that only records. Pass `api` to `renderWithProviders(ui, { toasts: api })`, or put a component in `wrap(ui)`, then read `calls`.
 * The page tests do not mount the real provider: its timers and the account it watches are not what they are about.
 */
export function spyToasts() {
  const calls: ToastCall[] = [];
  const api: ToastApi = {
    success: (text) => { calls.push({ kind: "success", text }); },
    info: (text) => { calls.push({ kind: "info", text }); },
    error: (text) => { calls.push({ kind: "error", text }); },
  };
  const wrap = (ui: ReactElement) => <ToastContext.Provider value={api}>{ui}</ToastContext.Provider>;
  return { api, calls, wrap };
}
