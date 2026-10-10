import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** How a child tells the Modal around it that it is busy: calling it counts one busy child, the function it returns uncounts it. Null outside a Modal. */
const BusyContext = createContext<(() => () => void) | null>(null);

/** While `busy` is true, Escape does not close the Modal this is used in (a save is in flight). Does nothing outside a Modal. */
export function useModalBusy(busy: boolean) {
  const enter = useContext(BusyContext);
  useLayoutEffect(() => (enter && busy ? enter() : undefined), [enter, busy]);
}

/**
 * A dialog over the page in today's `.dialog` look. Focus moves in (onto the first field; onto the dialog itself while its content
 * is not ready), stays in (Tab and Shift+Tab wrap round inside it), and goes back to what had it when the dialog goes away.
 * Escape closes, except while a child reports busy (`useModalBusy`). A click on the backdrop does not close it: a half-typed form must not vanish.
 */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }); // the latest callback, without re-running the focus effect
  const busyChildren = useRef(0);
  const enterBusy = useCallback(() => { busyChildren.current += 1; return () => { busyChildren.current -= 1; }; }, []);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = () => el.querySelector<HTMLElement>(FOCUSABLE) ?? el; // the dialog itself (tabIndex -1) when its content is not ready yet
    first().focus();
    const keepFocus = (e: FocusEvent) => { if (e.target instanceof Node && !el.contains(e.target)) first().focus(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (busyChildren.current === 0) close.current();
        return;
      }
      if (e.key !== "Tab") return;
      // Wrap here instead of letting focus land on the page behind and pulling it back (keepFocus stays as the backstop).
      const controls = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (controls.length === 0) return;
      const [firstControl, lastControl] = [controls[0], controls[controls.length - 1]];
      const at = document.activeElement;
      if (e.shiftKey ? at === firstControl || at === el : at === lastControl) {
        e.preventDefault();
        (e.shiftKey ? lastControl : firstControl).focus();
      }
    };
    document.addEventListener("focusin", keepFocus);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("focusin", keepFocus);
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="dialog narrow">
        <h2 id={titleId}>{title}</h2>
        <BusyContext.Provider value={enterBusy}>{children}</BusyContext.Provider>
      </div>
    </div>
  );
}
