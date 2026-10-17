import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMappingLatest } from "../../hooks/useMappingLatest";
import { useNow } from "../../hooks/useNow";
import type { ValueTipTarget } from "../../hooks/useValueTip";
import { ageNow } from "../../lib/age";
import { placeTip, type TipPlacement } from "../../lib/placeTip";
import { describeLatest } from "../../lib/valueTip";

const NODE = ".react-flow__node";

// The layers that sit above the card and own the Escape key while the focus is in them: the Find card, the canvas menu, a dialog (the confirm, the
// forms) and anything marked modal. The card's listener is in the capture phase on the document, so it hears the key before any of them.
const ABOVE = '.graph-find, .graph-menu, [role="dialog"], [aria-modal="true"]';
const inAbove = (node: EventTarget | null) => node instanceof Element && node.closest(ABOVE) !== null;

// The node's wrapper element, found by its data-id (an id holds colons, so no id selector; the attribute value is quoted).
const wrapperOf = (nodeId: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`${NODE}[data-id="${nodeId.replace(/["\\]/g, "\\$&")}"]`);

/**
 * The last value of a mapped point, in a small card next to its node: "12.40 kW, 3 s ago". Draws nothing, and asks the server nothing, while there
 * is no target or the role may not see values (`canView`, assets.view).
 *
 * The card is a `role="tooltip"` portal on the page (position: fixed, below the node, flipped above at the window edge) and never takes the pointer.
 * While it shows, its id is appended to the node wrapper's own aria-describedby (React Flow puts its description there) and the exact previous
 * value comes back when the card hides or unmounts. It dismisses itself, and calls `onDismiss` (the caller's `hide()`), on Escape (the key goes no
 * further: the card is the innermost layer, but only when it is: with the focus or the key's target in the Find card, a menu or a dialog, or when the
 * key is already handled, the key is left for that layer), on any scroll or resize (a fixed card would be left behind) and when its node leaves the
 * DOM (a collapse, a refetch). A read that fails says so once; the next hover tries again. A node that goes while the read is in flight just drops the answer.
 */
export function PointValueTip({ target, canView, onDismiss }: { target: ValueTipTarget | null; canView: boolean; onDismiss?: () => void }) {
  const [gone, setGone] = useState<ValueTipTarget | null>(null);
  if (!target || !canView || gone === target) return null;
  return <ValueCard key={target.nodeId} target={target} onGone={() => { setGone(target); onDismiss?.(); }} />;
}

function ValueCard({ target, onGone }: { target: ValueTipTarget; onGone: () => void }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const gone = useRef(onGone);
  gone.current = onGone;
  const [place, setPlace] = useState<TipPlacement | null>(null);

  const latest = useMappingLatest(target.mappingId);
  const now = useNow(1000);
  const state = latest.data && !latest.isError ? "ok" : latest.isError ? "error" : "loading";
  const { text, tone } = describeLatest(latest.data, state, ageNow(latest.data?.age_seconds, latest.dataUpdatedAt, now) ?? null);

  // Measured before the first paint, so the card is never seen at a guessed place; again when its words (and so its width) change.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPlace(placeTip(target.rect, { width, height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [target, text]);

  useEffect(() => {
    const wrapper = wrapperOf(target.nodeId);
    if (!wrapper) return;
    const before = wrapper.getAttribute("aria-describedby");
    wrapper.setAttribute("aria-describedby", before ? `${before} ${id}` : id);
    return () => {
      if (before === null) wrapper.removeAttribute("aria-describedby");
      else wrapper.setAttribute("aria-describedby", before);
    };
  }, [target.nodeId, id]);

  useEffect(() => {
    const dismiss = () => gone.current();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (event.defaultPrevented || inAbove(event.target) || inAbove(document.activeElement)) return; // a layer above the card has this key
      event.stopPropagation();
      dismiss();
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    const wrapper = wrapperOf(target.nodeId);
    const parent = wrapper?.parentElement;
    const watch = parent ? new MutationObserver(() => { if (!wrapper!.isConnected) dismiss(); }) : null;
    if (parent) watch!.observe(parent, { childList: true });
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      watch?.disconnect();
    };
  }, [target.nodeId]);

  return createPortal(
    <div ref={box} id={id} role="tooltip" className={`gtip gtip-${tone}`} style={place ? { top: place.top, left: place.left } : { top: 0, left: 0 }}>
      <span className="gtip-text">{text}</span>
    </div>,
    document.body,
  );
}
