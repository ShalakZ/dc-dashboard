import { Icon } from "./Icon";

/**
 * The delete button of a row or page: a bin whose lid lifts on hover and focus (app.css, `.trash-btn`). Confirming is the caller's job.
 * `title` and `describedBy` (the id of a visually hidden text) say WHY a disabled button is disabled, to a mouse and to a screen reader.
 * `labelled` is for a page header, beside buttons that carry words: the bin and the word "Delete" in an ordinary outlined button as tall
 * as its neighbours, not the compact borderless square of a table row. `label` stays its accessible name ("Delete Room A"; the visible
 * word is the start of it, so a voice user saying "Delete" reaches it).
 */
export function TrashButton({ label, onClick, disabled, title, describedBy, labelled }: { label: string; onClick: () => void; disabled?: boolean; title?: string; describedBy?: string; labelled?: boolean }) {
  return (
    <button type="button" className={labelled ? "trash-btn trash-btn-labelled" : "icon-btn trash-btn"} aria-label={label} aria-describedby={describedBy} title={title} disabled={disabled} onClick={onClick}>
      <Icon name="trash" />
      {labelled && "Delete"}
    </button>
  );
}
