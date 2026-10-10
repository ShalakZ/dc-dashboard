import { useEffect, useId, useRef, type ReactNode } from "react";

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog over the page in today's `.dialog` look. Focus moves in (onto the first field; onto the dialog itself while its content
 * is not ready), stays in, and goes back to what had it when the dialog goes away. Escape closes. A click on the backdrop does not:
 * a half-typed form must not vanish.
 */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }); // the latest callback, without re-running the focus effect
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = () => el.querySelector<HTMLElement>(FOCUSABLE) ?? el; // the dialog itself (tabIndex -1) when its content is not ready yet
    first().focus();
    const keepFocus = (e: FocusEvent) => { if (e.target instanceof Node && !el.contains(e.target)) first().focus(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close.current(); };
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
        {children}
      </div>
    </div>
  );
}
