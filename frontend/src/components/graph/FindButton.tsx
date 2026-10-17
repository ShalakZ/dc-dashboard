import type { Ref } from "react";
import { Icon } from "../Icon";

/**
 * The Find button of the Discovery bar. The CARD stays in the canvas (`CanvasTools`), so the button only reports a press and says whether the
 * card is open and which element it is (`aria-controls` while it exists). Its word sits in `.gbar-lbl`, which the bar hides visually (never
 * `display: none`) when it runs out of room, so the button keeps its name as an icon.
 */
export function FindButton({ open, cardId, onToggle, buttonRef }: {
  open: boolean;
  cardId: string;
  onToggle: () => void;
  buttonRef: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      type="button"
      ref={buttonRef}
      aria-expanded={open}
      aria-controls={open ? cardId : undefined}
      aria-keyshortcuts="Control+K Meta+K"
      title="Find on the canvas (Ctrl+K)"
      onClick={onToggle}
    >
      <Icon name="search" />
      <span className="gbar-lbl gbar-lbl-find">Find</span>
    </button>
  );
}
