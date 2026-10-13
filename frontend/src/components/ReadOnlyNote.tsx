/** The line a page shows where its form is disabled: the role may open the page but not change what is on it. */
export const READ_ONLY_TEXT = "Your role can see this page but not change it.";

export function ReadOnlyNote() {
  return <p className="muted">{READ_ONLY_TEXT}</p>;
}
