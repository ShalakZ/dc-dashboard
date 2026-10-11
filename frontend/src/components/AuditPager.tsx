import { useId, useState } from "react";
import { lastOffset, nextOffset, offsetOfPage, pageCount, pageOf, PAGE_SIZES, previousOffset } from "../lib/auditFilters";

interface Props {
  total: number;
  offset: number;
  size: number;
  onOffset: (offset: number) => void;
  onSize: (size: number) => void;
}

/** First / Previous / Next / Last, a page box, the page size and the range shown. The offset may sit between page boundaries (after "Go to a date"). */
export function AuditPager({ total, offset, size, onOffset, onSize }: Props) {
  const sizeId = useId();
  // What is typed in the page box and not applied yet, tied to the position it was typed at so a move elsewhere drops it.
  const position = `${offset}/${size}/${total}`;
  const [draft, setDraft] = useState<{ at: string; text: string } | null>(null);
  if (total === 0) return null;

  const pages = pageCount(total, size);
  const next = nextOffset(offset, size, total);
  const pastEnd = offset >= total;
  const atStart = offset === 0;
  const atEnd = next === null && !pastEnd; // the rows shown already reach the last entry; past the end, Last is the way back
  // Past the end there is no page to name: an en dash, never "Page 4 of 2" (the box is empty then).
  const shown = draft && draft.at === position ? draft.text : pastEnd ? "" : String(pageOf(offset, size));

  function applyDraft() {
    if (draft === null || draft.at !== position) return;
    const wanted = Number(draft.text);
    setDraft(null);
    if (draft.text.trim() === "" || !Number.isFinite(wanted)) return;
    onOffset(offsetOfPage(wanted, size, total));
  }

  return (
    <div className="row pager">
      <button type="button" onClick={() => onOffset(0)} disabled={atStart}>First</button>
      <button type="button" onClick={() => onOffset(previousOffset(offset, size))} disabled={atStart}>Previous</button>
      <button type="button" onClick={() => next !== null && onOffset(next)} disabled={next === null}>Next</button>
      <button type="button" onClick={() => onOffset(lastOffset(size, total))} disabled={atEnd}>Last</button>
      <input
        type="number"
        aria-label="Page"
        min={1}
        max={pages}
        value={shown}
        onChange={(e) => setDraft({ at: position, text: e.target.value })}
        onBlur={applyDraft}
        onKeyDown={(e) => { if (e.key === "Enter") applyDraft(); }}
      />
      <span className="muted">{`Page ${pastEnd ? "–" : pageOf(offset, size)} of ${pages}`}</span>
      <div className="pager-end">
        <label htmlFor={sizeId}>Rows per page</label>
        <select id={sizeId} value={size} onChange={(e) => onSize(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {!pastEnd && <span className="muted">{`Showing ${offset + 1}–${Math.min(offset + size, total)} of ${total}`}</span>}
      </div>
    </div>
  );
}
