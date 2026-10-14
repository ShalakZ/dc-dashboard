import { useEffect, useId, useRef, useState } from "react";
import { ASSET_ICONS, ICON_GROUPS } from "../lib/assetIcons";
import { iconMatches, searchWords } from "../lib/iconSearch";
import { Icon, type IconName } from "./Icon";

/**
 * The icon field of a dialog: the preview tile (the page header's), its caption and Change icon in one row, then the grid of icons.
 * `value` is a catalogue id, or null for Automatic (an id the catalogue lacks leaves no cell checked, so a stored value is never
 * rewritten by merely opening the grid). The form decides what the preview shows and what the caption says (`previewIcon`, `caption`,
 * and a second line, `hint`, that belongs to the same description); the picker owns how the grid behaves. With `automatic` the first
 * cell is Automatic: it draws the icon the kind gives and selects null. Without it there is no such cell (a kind always has an icon).
 *
 * The grid is one radiogroup (it owns radios only) cut into a section per group, with a search box ABOVE it, a sibling, that only an
 * open grid has. A search hides the cells that do not match (`hidden`, and the radio `disabled` so that every way of walking the cells
 * agrees); the checked cell and Automatic are never hidden, so a choice is never taken away from under a person.
 */
export function IconPicker({ value, onChange, previewIcon, caption, hint, automatic }: {
  value: string | null;
  onChange: (value: string | null) => void;
  previewIcon: IconName;
  caption: string;
  /** A second, quieter line under the caption, read with it. */
  hint?: string;
  automatic?: { icon: IconName; title: string };
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  // The cell that was checked when the text last changed: it stays through the search. Taken then, not read live, so that walking the
  // arrow keys does not make the cell you left vanish (and everything after it jump) one keystroke at a time.
  const [kept, setKept] = useState<string | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  // The radios of one picker share a name that no other picker has: two on one page (or one after another that is still unmounting) are two groups.
  const [labelId, captionId, gridId, groupName, headingId] = [useId(), useId(), useId(), useId(), useId()];

  // A click on the cell that is already checked fires no change, yet it is a choice (the kind dialog stops following its guess on it).
  const again = (id: string | null) => () => { if (value === id) onChange(id); };

  const typed = searchWords(query).length > 0;
  const shows = (entry: (typeof ASSET_ICONS)[number]) => !typed || entry.id === kept || iconMatches(entry, query);
  // "No icons match" speaks of the search, whatever the kept cells still show.
  const nothingFound = typed && !ASSET_ICONS.some((entry) => iconMatches(entry, query));

  function search(text: string) {
    setQuery(text);
    setKept(value);
    if (grid.current) grid.current.scrollTop = 0; // the box is a window on a shorter list now (or a longer one)
  }

  // Every way out forgets the search, so the next opening shows every icon.
  function close() {
    setPicking(false);
    setQuery("");
    setKept(null);
  }

  useEffect(() => {
    if (!picking) return;
    const inputs = grid.current!;
    // A cell the search left out is disabled, so it cannot take focus (focus would fall to the page): the checked one, else the first that can.
    const target = inputs.querySelector<HTMLInputElement>("input:checked") ?? inputs.querySelector<HTMLInputElement>("input:not(:disabled)");
    // No scroll from the focus itself: it would also scroll the dialog, which is done once, below, for the whole field. The box is scrolled
    // here, so that a checked cell far down the list (Door, Generic) is in view when the grid opens.
    target?.focus({ preventScroll: true });
    const cell = target?.closest("label");
    if (cell) {
      const [at, box] = [cell.getBoundingClientRect(), inputs.getBoundingClientRect()];
      if (at.top < box.top || at.bottom > box.bottom) inputs.scrollTop += at.top - box.top - (inputs.clientHeight - at.height) / 2;
    }
    field.current?.scrollIntoView?.({ block: "nearest" }); // the dialog: a no-op when it does not scroll; jsdom has no scrollIntoView
  }, [picking]);

  return (
    <div ref={field} role="group" aria-labelledby={labelId} aria-describedby={captionId} className="icon-field">
      <span id={labelId} className="icon-field-label">Icon</span>
      <div className="icon-field-row">
        <span className="page-tile icon-preview" aria-hidden="true"><Icon name={previewIcon} /></span>
        <span id={captionId} className="icon-caption">{caption}{hint ? <small className="icon-hint">{hint}</small> : null}</span>
        <button type="button" ref={opener} aria-expanded={picking} aria-controls={gridId} onClick={() => (picking ? close() : setPicking(true))}>Change icon</button>
      </div>
      {/* The search box is a sibling of the radiogroup (a radiogroup owns radios only) and exists only while the grid is open. It copies the
          grid's Enter rule (the form around it would save) and answers Escape in layers: the text, then the grid. The one live line is
          beside it and always as wide as its longest message, so nothing moves when the message comes or goes; it is not the caption (the
          field's description) and not a status role (a dialog has one announcer). */}
      {picking && (
        <div className="icon-search">
          <input type="search" aria-label="Search icons" placeholder="Search icons" aria-controls={gridId} autoComplete="off" spellCheck={false} value={query}
            onChange={(e) => search(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.preventDefault();
              if (e.key !== "Escape") return;
              e.stopPropagation();
              if (query !== "") { e.preventDefault(); search(""); } else { close(); opener.current?.focus(); }
            }} />
          <span className="icon-search-note" aria-live="polite" aria-atomic="true">{nothingFound ? "No icons match" : ""}</span>
        </div>
      )}
      {/* Kept mounted and hidden, so aria-controls resolves; Enter would otherwise save the form while the user is only choosing.
          Escape closes the grid only: the dialog and the typed name stay (a second Escape, from outside the grid, closes the dialog). */}
      <div id={gridId} ref={grid} role="radiogroup" aria-label="Icon choices" className="icon-grid" hidden={!picking} onKeyDown={(e) => {
        if (e.key === "Enter") e.preventDefault();
        if (e.key === "Escape") { e.stopPropagation(); close(); opener.current?.focus(); }
      }}>
        {automatic && (
          <div className="icon-cells">
            <label className="icon-cell icon-cell-auto check" title={automatic.title}>
              <input type="radio" name={groupName} checked={value === null} onChange={() => onChange(null)} onClick={again(null)} />
              <Icon name={automatic.icon} /><span className="sr-only">Automatic</span>
            </label>
          </div>
        )}
        {ICON_GROUPS.map((group, index) => {
          const entries = ASSET_ICONS.filter((entry) => entry.group === group);
          const showing = entries.map(shows);
          return (
            <div key={group} role="group" aria-labelledby={`${headingId}-${index}`} className="icon-section" hidden={!showing.some(Boolean)}>
              <div id={`${headingId}-${index}`} className="icon-group-label">{group}</div>
              <div className="icon-cells">
                {entries.map((entry, i) => (
                  <label key={entry.id} className="icon-cell check" title={entry.label} hidden={!showing[i]}>
                    <input type="radio" name={groupName} value={entry.id} checked={value === entry.id} disabled={!showing[i]} onChange={() => onChange(entry.id)} onClick={again(entry.id)} />
                    <Icon name={entry.icon} /><span className="sr-only">{entry.label}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
