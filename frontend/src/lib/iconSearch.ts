/** What the picker's search reads of an icon (an ASSET_ICONS entry has all of it). */
export type SearchableIcon = { id: string; label: string; keywords: readonly string[] };

/** The words of a text: runs of letters and digits, lower case. Punctuation and blanks only separate them ("air-handling" is two words). */
export function searchWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Whether the icon answers what was typed: every typed word has to start some word of the label, a keyword or the id (a prefix counts, the
 * middle of a word does not), in any order. A query with no words matches everything. The id is searched because the abbreviation a person
 * types ("ats", "crac") is often in none of the keywords, and it is what the catalogue calls the icon.
 */
export function iconMatches(icon: SearchableIcon, query: string): boolean {
  const typed = searchWords(query);
  if (typed.length === 0) return true;
  const known = [icon.label, icon.id, ...icon.keywords].flatMap(searchWords);
  return typed.every((word) => known.some((candidate) => candidate.startsWith(word)));
}
