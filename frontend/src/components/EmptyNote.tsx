import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

/** A compact empty state for inside a card: one row with a small icon tile, one sentence and an optional action at the end (the large `.empty` box is for a whole page). */
export function EmptyNote({ icon, action, children }: { icon: IconName; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="empty-note">
      <span className="empty-note-icon" aria-hidden="true"><Icon name={icon} /></span>
      <p>{children}</p>
      {action}
    </div>
  );
}
