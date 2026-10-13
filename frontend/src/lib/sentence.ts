import { upperFirst } from "./upperFirst";

/** An API message (`detail` texts are written in lower case without a full stop) as a sentence for a person: a capital letter, ended with "." unless it ends a sentence already. Display only. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const capitalised = upperFirst(trimmed);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}
