import { useEffect, type RefObject } from "react";

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Dialogs currently open, last = top-most. Only the top-most one traps focus and answers Escape. */
const open: HTMLElement[] = [];

/**
 * Accessibility behaviour shared by the dashboard dialogs (it mirrors `ReviewDialog`): focus moves into the dialog
 * (to `options.initial` if given, else the first control), stays inside while it is the top-most dialog, and goes back
 * to what had it when the dialog goes away. Escape calls `onClose`, except while `options.busy`.
 */
export function useDialogFocus(
  root: RefObject<HTMLElement | null>,
  onClose: () => void,
  options: { busy?: boolean; initial?: RefObject<HTMLElement | null> } = {},
): void {
  const { busy = false, initial } = options;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = () => element.querySelector<HTMLElement>(FOCUSABLE);
    open.push(element);
    (initial?.current ?? first())?.focus();
    const keepFocus = (event: FocusEvent) => {
      if (open[open.length - 1] !== element) return;
      if (event.target instanceof Node && !element.contains(event.target)) first()?.focus();
    };
    document.addEventListener("focusin", keepFocus);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      open.splice(open.indexOf(element), 1);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const element = root.current;
      if (element && open[open.length - 1] === element) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
}
