import { Icon } from "./Icon";

/**
 * The delete button of a row or page: a bin whose lid lifts on hover and focus (app.css, `.trash-btn`). Confirming is the caller's job.
 * `title` and `describedBy` (the id of a visually hidden text) say WHY a disabled button is disabled, to a mouse and to a screen reader.
 */
export function TrashButton({ label, onClick, disabled, title, describedBy }: { label: string; onClick: () => void; disabled?: boolean; title?: string; describedBy?: string }) {
  return (
    <button type="button" className="icon-btn trash-btn" aria-label={label} aria-describedby={describedBy} title={title} disabled={disabled} onClick={onClick}>
      <Icon name="trash" />
    </button>
  );
}
