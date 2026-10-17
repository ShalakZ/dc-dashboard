import { Panel } from "@xyflow/react";
import type { RefObject } from "react";
import type { FindEntry, FindResult } from "../../lib/graphFind";
import { FindBox } from "./FindBox";

/**
 * The Find card of the Discovery canvas, in the top-right panel: it opens over the canvas and moves nothing. The BUTTON lives in the bar
 * (`FindButton`), and so does the open state (the page's), so this panel draws the card while `open` and nothing else. The panel spans the
 * canvas width, so the card's width is the room the canvas has; the empty part of it lets every click through (graph-tools.css).
 *
 * `triggerRef` is the bar's Find button: the card gives the focus back to it when nothing better is known, and a press on it is not an
 * outside press (its click toggles). `cardId` is the id that button's `aria-controls` names.
 */
export function CanvasTools({ search, onChoose, open, onClose, triggerRef, cardId }: {
  search: (query: string) => FindResult;
  onChoose: (entry: FindEntry) => void;
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  cardId: string;
}) {
  if (!open) return null;
  return (
    <Panel position="top-right" className="graph-tools">
      <FindBox id={cardId} search={search} onChoose={onChoose} onClose={onClose} trigger={triggerRef} />
    </Panel>
  );
}
