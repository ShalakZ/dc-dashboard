import { Panel } from "@xyflow/react";
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import type { FindEntry, FindResult } from "../../lib/graphFind";
import { Icon } from "../Icon";
import { FindBox } from "./FindBox";

/**
 * The canvas's own tools, in the top-right panel: the Find button (its card opens UNDER the buttons, over the canvas, and moves
 * nothing) and the Snap to grid toggle. The panel spans the canvas width, so the card's width is the room the canvas has; the empty
 * part of it lets every click through (graph-tools.css).
 *
 * `openRef` hands the page `open()` for Ctrl+K: it opens the card, or, when it is already open, takes the focus back into its field.
 */
export function CanvasTools({ search, onChoose, snap, onSnapChange, openRef }: {
  search: (query: string) => FindResult;
  onChoose: (entry: FindEntry) => void;
  snap: boolean;
  onSnapChange: (on: boolean) => void;
  openRef: RefObject<{ open(): void } | null>;
}) {
  const cardId = useId();
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const openNow = useRef(false);
  openNow.current = open;

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    openRef.current = {
      open() {
        if (!openNow.current) return setOpen(true);
        const field = panel.current?.querySelector<HTMLInputElement>('input[role="combobox"]');
        field?.focus({ preventScroll: true });
        field?.select();
      },
    };
    return () => { openRef.current = null; };
  }, [openRef]);

  return (
    <Panel position="top-right" className="graph-tools" ref={panel}>
      <div className="graph-tools-bar">
        <button
          type="button"
          ref={button}
          className="graph-find-btn"
          aria-expanded={open}
          aria-controls={open ? cardId : undefined}
          aria-keyshortcuts="Control+K Meta+K"
          title="Find on the canvas (Ctrl+K)"
          onClick={() => setOpen((was) => !was)}
        >
          <Icon name="search" />
          Find
        </button>
        <button type="button" className="graph-snap-btn" aria-pressed={snap} onClick={() => onSnapChange(!snap)}>
          {snap && <Icon name="check" />}
          Snap to grid
        </button>
      </div>
      {open && <FindBox id={cardId} search={search} onChoose={onChoose} onClose={close} trigger={button} />}
    </Panel>
  );
}
