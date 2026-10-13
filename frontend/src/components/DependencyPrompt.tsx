import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { placeTip, type TipPlacement } from "../lib/placeTip";

export interface DependencyPromptProps {
  /** The checkbox the offer is about: the card sits under its label and the focus goes back to it. */
  anchor: RefObject<HTMLInputElement | null>;
  sentence: string;
  items: readonly string[];
  acceptLabel: string;
  declineLabel: string;
  /** The parent applies the ticks and removes the prompt. */
  onAccept: () => void;
  /** Not now, Escape, a press outside, focus moving outside: the parent removes the prompt. */
  onDecline: () => void;
}

/**
 * A small card under a permission's checkbox that offers to tick what it needs (or to untick what needs it). Not modal: nothing behind it
 * is blocked, and leaving it any way at all counts as "not now". It is drawn INLINE right after the checkbox's label (so Tab goes from the
 * box into it and the Modal's focus trap just works) with position: fixed (so the scrolling boxes around it neither clip it nor grow a
 * scroll bar for it); role-prompt.css.test.ts keeps the boxes around it free of a transform or filter, which would turn fixed into
 * relative-to-that-box. Where it goes comes from placeTip, and it follows its checkbox when the page scrolls.
 */
export function DependencyPrompt({ anchor, sentence, items, acceptLabel, declineLabel, onAccept, onDecline }: DependencyPromptProps) {
  const card = useRef<HTMLDivElement>(null);
  const accept = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const listId = useId();
  const [place, setPlace] = useState<TipPlacement | null>(null);
  // The latest callbacks, so the listeners below are registered once however often the parent renders.
  const latest = useRef({ onAccept, onDecline });
  useEffect(() => { latest.current = { onAccept, onDecline }; });

  // Measured before the first paint, so the card is never seen at a guessed place; it renders at 0,0 for that one pass.
  useLayoutEffect(() => {
    const box = card.current;
    if (!box) return;
    const put = () => {
      const at = anchor.current?.closest("label") ?? anchor.current;
      if (!at) return;
      const { width, height } = box.getBoundingClientRect();
      const next = placeTip(at.getBoundingClientRect(), { width, height }, { width: window.innerWidth, height: window.innerHeight });
      setPlace((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next)); // a scroll event per frame must not re-render for nothing
    };
    put();
    // Capture: a scroll in any box of the page (the grid's wrapper, the editor body) does not bubble, but it passes the window on the way down.
    window.addEventListener("scroll", put, true);
    window.addEventListener("resize", put);
    return () => {
      window.removeEventListener("scroll", put, true);
      window.removeEventListener("resize", put);
    };
  }, [anchor]);

  useEffect(() => {
    const box = card.current;
    if (!box) return;
    accept.current?.focus({ preventScroll: true });
    const inside = (target: EventTarget | null) => target instanceof Node && box.contains(target);
    // Capture + stopPropagation: the Modal around us closes on Escape too (a document listener in the bubble phase); one press closes only the top-most thing.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      latest.current.onDecline();
      anchor.current?.focus();
    };
    const onDown = (event: PointerEvent) => {
      if (inside(event.target)) return;
      // The focus must not fall to <body> when the card's own button had it: it goes to the checkbox, and the browser's own mousedown
      // then moves it on to whatever was pressed. A focus that was already elsewhere is left alone.
      if (inside(document.activeElement)) anchor.current?.focus();
      latest.current.onDecline();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!inside(event.target) && event.target !== anchor.current) latest.current.onDecline(); // Tab past the buttons, or a click into a field: the focus stays where it went
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [anchor]);

  return (
    <div
      ref={card}
      role="group"
      aria-labelledby={titleId}
      aria-describedby={items.length > 0 ? listId : undefined}
      className="dep-prompt"
      style={place ? { top: place.top, left: place.left } : { top: 0, left: 0 }}
      // A press on the card's text or padding must not move the focus: the browser would hand it to the nearest focusable ancestor
      // (the Modal's dialog box), which is "outside the card" and would decline the offer.
      onMouseDown={(event) => { if (!(event.target as Element).closest("button")) event.preventDefault(); }}
    >
      <p id={titleId}>{sentence}</p>
      {items.length > 0 && <ul id={listId}>{items.map((item) => <li key={item}>{item}</li>)}</ul>}
      <div className="dep-prompt-actions">
        {/* type="button" on both: the card sits inside the editor's <form>, where a default button would submit it. */}
        <button type="button" ref={accept} className="primary" onClick={() => { latest.current.onAccept(); anchor.current?.focus(); }}>{acceptLabel}</button>
        <button type="button" onClick={() => { latest.current.onDecline(); anchor.current?.focus(); }}>{declineLabel}</button>
      </div>
    </div>
  );
}
