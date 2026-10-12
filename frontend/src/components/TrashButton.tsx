import { Icon } from "./Icon";

/** The delete button of a row or page: a bin whose lid lifts on hover and focus (app.css, `.trash-btn`). Confirming is the caller's job. */
export function TrashButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="icon-btn trash-btn" aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon name="trash" />
    </button>
  );
}
