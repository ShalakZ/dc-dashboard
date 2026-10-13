import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** Text of the confirming button; "Delete" by default (this hook is for the confirmations that need no server preview). */
  confirmLabel?: string;
  tone?: "danger" | "primary";
}

/**
 * The styled replacement for `window.confirm`: `const [ask, dialog] = useConfirm()`, render `{dialog}` anywhere (it goes into the body),
 * then `if (!(await ask({ title, message }))) return;`. True on the confirming button; false on Cancel, on Escape, when the owner
 * unmounts with the question open, and when asked a second time while one question is open (one dialog at a time; the first is left alone).
 * Unlike ImpactDeleteDialog it asks the server nothing: the caller runs the request after the answer and shows its own failure.
 */
export function useConfirm(): [ask: (options: ConfirmOptions) => Promise<boolean>, dialog: ReactNode] {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  // A ref besides the state: two calls in the same tick must see the first as open before React has rendered it.
  const pending = useRef<((answer: boolean) => void) | null>(null);

  const settle = useCallback((answer: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setOptions(null);
    resolve?.(answer);
  }, []);
  const ask = useCallback((next: ConfirmOptions) => {
    if (pending.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
      setOptions(next);
    });
  }, []);
  // Nothing may stay waiting for a dialog that is gone: its owner's code after the await would never run, or run on a stale page.
  useEffect(() => () => {
    pending.current?.(false);
    pending.current = null;
  }, []);

  const dialog = options && (
    <ConfirmDeleteDialog
      title={options.title}
      message={options.message}
      confirmLabel={options.confirmLabel ?? "Delete"}
      tone={options.tone}
      onConfirm={async () => settle(true)}
      onCancel={() => settle(false)}
    />
  );
  return [ask, dialog];
}
