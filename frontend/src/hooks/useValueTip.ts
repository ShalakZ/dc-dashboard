import { useEffect, useMemo, useState } from "react";
import type { Timers } from "../lib/progress";
import { canHover } from "./useGraphHighlight";

/** How long a node must be hovered or focused before its last-value card shows, and how long a leave waits before the card goes (a new enter cancels the wait). */
export const VALUE_DWELL_MS = 350;
export const VALUE_GRACE_MS = 100;

/** The mapped point the card is for, with its node's rectangle in window coordinates at the moment the card was shown. */
export interface ValueTipTarget {
  nodeId: string;
  mappingId: number;
  rect: DOMRect;
}

export interface ValueTip {
  target: ValueTipTarget | null;
  /** The pointer came onto a mapped point's node (a device that cannot hover is ignored). */
  enter: (nodeId: string, mappingId: number, el: Element) => void;
  /** The pointer left it. The card stays for a short grace, so sweeping across the node's own edge or to the next node flashes nothing. */
  leave: () => void;
  /** The keyboard focused a mapped point's node. The caller decides what counts as keyboard focus (the highlight's `:focus-visible` rule). */
  focus: (nodeId: string, mappingId: number, el: Element) => void;
  blur: () => void;
  /** The card goes now and forgets the hover and the focus: a drag, a pan or zoom, a removed node, Escape. */
  hide: () => void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Candidate { nodeId: string; mappingId: number; el: Element }

/**
 * Decides when the last-value card of a mapped point shows. The pointer and the keyboard focus are two wishes; the pointer wins while it rests on a node.
 * A wish for a node other than the card's drops the card at once and starts the dwell for the new one; a wish for the same node cancels a pending
 * leave, so the card keeps its place. Every function returned has one identity for the life of the component (the state lives in refs and in the
 * closure): the page puts them in handlers the canvas receives, and a new handler identity would re-render every node. `timers` must be stable too.
 */
export function useValueTip(timers: Timers = realTimers): ValueTip {
  const [target, setTarget] = useState<ValueTipTarget | null>(null);

  const machine = useMemo(() => {
    let hover: Candidate | null = null;
    let focused: Candidate | null = null;
    let shown: Candidate | null = null;
    let dwell: unknown = null;
    let grace: unknown = null;

    const stopDwell = () => { if (dwell !== null) timers.clear(dwell); dwell = null; };
    const stopGrace = () => { if (grace !== null) timers.clear(grace); grace = null; };
    const stopAll = () => { stopDwell(); stopGrace(); };
    const same = (a: Candidate | null, b: Candidate | null) => a !== null && b !== null && a.nodeId === b.nodeId && a.mappingId === b.mappingId;
    const hideNow = () => { shown = null; setTarget(null); };

    const settle = () => {
      const want = hover ?? focused;
      stopDwell();
      if (want === null) {
        if (shown !== null && grace === null) {
          grace = timers.set(() => { grace = null; hideNow(); }, VALUE_GRACE_MS);
        }
        return;
      }
      stopGrace();
      if (same(shown, want)) return;
      if (shown !== null) hideNow();
      dwell = timers.set(() => {
        dwell = null;
        shown = want;
        setTarget({ nodeId: want.nodeId, mappingId: want.mappingId, rect: want.el.getBoundingClientRect() });
      }, VALUE_DWELL_MS);
    };

    const api: Omit<ValueTip, "target"> = {
      enter: (nodeId, mappingId, el) => {
        if (!canHover()) return;
        hover = { nodeId, mappingId, el };
        settle();
      },
      leave: () => { hover = null; settle(); },
      focus: (nodeId, mappingId, el) => { focused = { nodeId, mappingId, el }; settle(); },
      blur: () => { focused = null; settle(); },
      hide: () => { stopAll(); hover = null; focused = null; hideNow(); },
    };
    return { api, stopAll };
  }, [timers]);

  useEffect(() => machine.stopAll, [machine]);

  return { target, ...machine.api };
}
