import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import type { Timers } from "../lib/progress";
import { Icon } from "./Icon";

/**
 * A small confirmation in the bottom right corner for an action that has no confirming control of its own (see the W7k plan, Task 5, for who
 * toasts and who does not). It goes away by itself; hovering or focusing it holds it; an error stays twice as long. The CSS is
 * `styles/feedback-toasts.css`.
 */
export interface ToastApi {
  success(text: string, options?: ToastOptions): void;
  info(text: string, options?: ToastOptions): void;
  error(text: string, options?: ToastOptions): void;
}

/** A button after the message ("Undo"). Pressing it runs `onAction` once and dismisses the toast. */
export interface ToastAction { label: string; onAction: () => void }
export interface ToastOptions {
  /**
   * A toast with an action never collapses into another toast and nothing collapses into it (two quick "Moved" toasts must keep one Undo each),
   * and when the cap of three sends one away it goes after the toasts without an action. It is announced as one message: the action is part of
   * the toast node, not a second addition to the live region.
   */
  action?: ToastAction;
  /** Replaces the default life of this toast (hovered or focused time is still not counted). Zero, negative or not a number: the default. */
  durationMs?: number;
}

const NO_TOASTS: ToastApi = { success() {}, info() {}, error() {} };
/** The default is a no-op: hundreds of page tests render without a provider, and production mounts it once in main.tsx. A test that checks toasts supplies `spyToasts()`'s api. */
export const ToastContext = createContext<ToastApi>(NO_TOASTS);
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

type Kind = "success" | "info" | "error";
interface ToastItem { id: number; kind: Kind; text: string; count: number; leaving: boolean; action?: ToastAction }

/** How long a toast stays, hovered or focused time not counted. */
const LIFE_MS: Record<Kind, number> = { success: 4000, info: 4000, error: 8000 };
const lifeOf = (kind: Kind, options?: ToastOptions) => {
  const ms = options?.durationMs;
  return ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : LIFE_MS[kind];
};
/** The same kind and text arriving this soon after the previous toast's last arrival is counted into it, not stacked beside it. */
const COLLAPSE_MS = 1500;
/** A toast that was held until it was almost due still gets a moment to be read once it is let go. */
const MIN_RESUME_MS = 1000;
/** The fade, also how long a leaving toast stays mounted (the CSS transition is the same length). */
const FADE_MS = 150;
const MAX_TOASTS = 3;

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** No fade to wait for: the stylesheet has no transition under reduced motion either. The guard is the one of lib/sidebarState.ts (jsdom has no matchMedia). */
function reducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** What the store keeps of a toast that the screen does not show. */
interface Life {
  /** The running timer: the expiry while the toast is shown, the removal once it is leaving. */
  timer: unknown;
  /** When the expiry is due, and how much was left when the toast was held. */
  deadline: number;
  remaining: number;
  hover: boolean;
  focus: boolean;
  leaving: boolean;
  /** This toast's own full life: the default of its kind, or the `durationMs` it was raised with. */
  lifeMs: number;
  /** The last arrival of this message (a collapse counts), for the 1500 ms rule. */
  arrivedAt: number;
}

/**
 * The toasts, their timers and the rules, apart from React so the timers (injected: the tests move them by hand) never depend on a render.
 * A toast leaves in two steps, both by `timers`, never by an animation event: it is marked leaving (the CSS fades it), and after FADE_MS it is removed.
 */
function createToastStore(timers: Timers, now: () => number) {
  let items: ToastItem[] = [];
  let nextId = 1;
  const lives = new Map<number, Life>();
  const listeners = new Set<() => void>();

  const emit = (next: ToastItem[]) => {
    items = next;
    listeners.forEach((listener) => listener());
  };
  const stop = (life: Life) => {
    if (life.timer !== null) timers.clear(life.timer);
    life.timer = null;
  };
  const held = (life: Life) => life.hover || life.focus;

  function leave(id: number) {
    const life = lives.get(id);
    if (!life || life.leaving) return;
    stop(life);
    life.leaving = true;
    emit(items.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    life.timer = timers.set(() => {
      life.timer = null;
      lives.delete(id);
      emit(items.filter((t) => t.id !== id));
    }, reducedMotion() ? 0 : FADE_MS);
  }

  function arm(id: number, life: Life, ms: number) {
    stop(life);
    life.remaining = ms;
    life.deadline = now() + ms;
    life.timer = timers.set(() => {
      life.timer = null;
      leave(id);
    }, ms);
  }

  /** A fresh full life. A held toast stays held: the timer starts when it is let go. */
  function restart(id: number, life: Life) {
    if (held(life)) {
      stop(life);
      life.remaining = life.lifeMs;
    } else arm(id, life, life.lifeMs);
  }

  function push(kind: Kind, text: string, options?: ToastOptions) {
    const action = options?.action;
    const lifeMs = lifeOf(kind, options);
    const last = items[items.length - 1];
    const lastLife = last && lives.get(last.id);
    // Only the toast just before this one, and only while it is on screen: A, B, A is three toasts, and a dismissed A is not brought back.
    // A toast with an action is never one of the two: its Undo belongs to its own batch, a count badge would keep the first handler and lose the second.
    if (!action && last && !last.action && lastLife && !lastLife.leaving && last.kind === kind && last.text === text && now() - lastLife.arrivedAt <= COLLAPSE_MS) {
      lastLife.arrivedAt = now();
      lastLife.lifeMs = lifeMs;
      emit(items.map((t) => (t.id === last.id ? { ...t, count: t.count + 1 } : t)));
      restart(last.id, lastLife);
      return;
    }
    const id = nextId++;
    const life: Life = { timer: null, deadline: 0, remaining: lifeMs, hover: false, focus: false, leaving: false, lifeMs, arrivedAt: now() };
    lives.set(id, life);
    arm(id, life, lifeMs);
    emit([...items, { id, kind, text, count: 1, leaving: false, ...(action ? { action } : {}) }]);
    // Over the cap, the oldest goes, but a slow error is not pushed out by quick successes, and a toast with an action (its Undo is still wanted)
    // goes after the plain ones; the new toast itself is never the one that goes.
    const others = items.filter((t) => t.id !== id && !lives.get(t.id)!.leaving);
    if (others.length >= MAX_TOASTS) {
      leave((others.find((t) => t.kind !== "error" && !t.action) ?? others.find((t) => t.kind !== "error") ?? others[0]).id);
    }
  }

  /** The action button. The toast is marked leaving BEFORE the handler runs, so a second click while it fades finds it leaving and does nothing, and a toast the handler raises is an ordinary new one. */
  function act(id: number) {
    const life = lives.get(id);
    const action = items.find((t) => t.id === id)?.action;
    if (!life || life.leaving || !action) return;
    leave(id);
    action.onAction();
  }

  /** Hover and focus-within each hold the timer; it runs again when neither is left. */
  function hold(id: number, source: "hover" | "focus", on: boolean) {
    const life = lives.get(id);
    if (!life || life.leaving) return;
    const was = held(life);
    life[source] = on;
    if (!was && held(life)) {
      life.remaining = Math.max(life.deadline - now(), 0);
      stop(life);
    } else if (was && !held(life)) arm(id, life, Math.max(life.remaining, MIN_RESUME_MS));
  }

  /** Every toast at once, without a fade (the account changed, or the provider is going away). */
  function clear() {
    lives.forEach(stop);
    lives.clear();
    if (items.length > 0) emit([]);
  }

  return {
    api: {
      success: (text: string, options?: ToastOptions) => push("success", text, options),
      info: (text: string, options?: ToastOptions) => push("info", text, options),
      error: (text: string, options?: ToastOptions) => push("error", text, options),
    } satisfies ToastApi,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getItems: () => items,
    dismiss: leave,
    act,
    hold,
    clear,
  };
}

type Store = ReturnType<typeof createToastStore>;

export function ToastProvider({ children, timers = realTimers, now = Date.now }: { children: ReactNode; timers?: Timers; now?: () => number }) {
  const [store] = useState(() => createToastStore(timers, now));
  const items = useSyncExternalStore(store.subscribe, store.getItems, store.getItems);
  const userId = useAuth().user?.id ?? null;
  const owner = useRef(userId);
  // A toast raised while somebody else was signed in is not for the next account to see.
  useEffect(() => {
    if (owner.current === userId) return;
    owner.current = userId;
    store.clear();
  }, [store, userId]);
  // StrictMode mounts, unmounts and mounts again: clearing is harmless then (nothing has been raised) and the store keeps working afterwards.
  useEffect(() => () => store.clear(), [store]);

  return (
    <ToastContext.Provider value={store.api}>
      {children}
      {/* One persistent region with no role of its own, so it never joins the page's role="status" or "alert" lookups; only an error toast carries a role.
          "additions text": a repeat of a toast on screen is not a new node but a changed count badge, and that change is announced too. */}
      <div className="toast-stack" aria-live="polite" aria-relevant="additions text">
        {items.map((toast) => <ToastView key={toast.id} toast={toast} store={store} />)}
      </div>
    </ToastContext.Provider>
  );
}

const ICON = { success: "check", info: "info", error: "alert" } as const;

function ToastView({ toast, store }: { toast: ToastItem; store: Store }) {
  const { id, kind, text, count, leaving, action } = toast;
  return (
    <div
      className="toast"
      data-kind={kind}
      data-leaving={leaving ? "true" : undefined}
      role={kind === "error" ? "alert" : undefined}
      onMouseEnter={() => store.hold(id, "hover", true)}
      onMouseLeave={() => store.hold(id, "hover", false)}
      onFocus={() => store.hold(id, "focus", true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) store.hold(id, "focus", false);
      }}
    >
      <span className="toast-icon"><Icon name={ICON[kind]} /></span>
      <span className="toast-text">{text}</span>
      {count > 1 && <span className="toast-count">{count}</span>}
      {action && <button type="button" className="toast-action" onClick={() => store.act(id)}>{action.label}</button>}
      <button type="button" className="icon-btn toast-close" aria-label="Dismiss notification" onClick={() => store.dismiss(id)}>
        <Icon name="close" />
      </button>
    </div>
  );
}
