import type { ReactElement } from "react";
import { ToastContext, type ToastApi, type ToastOptions } from "../components/Toasts";

/** `options` is there only when the call gave some (W7p: an Undo action), so an assertion on `{ kind, text }` keeps its exact shape. */
export type ToastCall = { kind: "success" | "info" | "error"; text: string; options?: ToastOptions };

/**
 * A toast api that only records. Pass `api` to `renderWithProviders(ui, { toasts: api })`, or put a component in `wrap(ui)`, then read `calls`.
 * The page tests do not mount the real provider: its timers and the account it watches are not what they are about.
 */
const record = (kind: ToastCall["kind"], text: string, options?: ToastOptions): ToastCall => (options === undefined ? { kind, text } : { kind, text, options });

export function spyToasts() {
  const calls: ToastCall[] = [];
  const api: ToastApi = {
    success: (text, options) => { calls.push(record("success", text, options)); },
    info: (text, options) => { calls.push(record("info", text, options)); },
    error: (text, options) => { calls.push(record("error", text, options)); },
  };
  const wrap = (ui: ReactElement) => <ToastContext.Provider value={api}>{ui}</ToastContext.Provider>;
  return { api, calls, wrap };
}
