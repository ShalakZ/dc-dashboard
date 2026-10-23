import { useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type RefObject } from "react";
import { shapesOptions, type FindEntry, type FindResult, type ShapesTarget } from "../../lib/graphFind";
import { Icon, type IconName } from "../Icon";

export interface FindBoxProps {
  /** The search is injected (the page passes `(q) => findMatches(index, q)`): the card knows nothing about the graph. */
  search: (query: string) => FindResult;
  onChoose: (entry: FindEntry) => void;
  /**
   * (w36) The large sources whose tags the card can search (the page gives none to a person who may not open Map by shape): each adds one LAST option to a query
   * of 2 to 100 characters, and choosing it calls `onShapes` with the address of that source's shapes page. The card does not navigate itself.
   */
  shapes?: readonly ShapesTarget[];
  onShapes?: (to: string) => void;
  onClose: () => void;
  /** The button that opened the card: where the focus goes when nothing better is known, and a press on it is not an "outside" press (its click toggles). */
  trigger?: RefObject<HTMLElement | null>;
  id?: string;
}

const NONE: FindResult = { items: [], more: 0 };
const NO_TARGETS: readonly ShapesTarget[] = [];

/** One line of the list: a canvas match (`entry`) or the search of a large source's tags (`to`). */
interface Row { id: string; icon: IconName; label: string; context: string; entry: FindEntry | null; to: string | null }

/** The live line under the list: what a screen reader hears after each keystroke, and what everyone reads. `searches` = the tag searches of large sources the list ends with (w36). */
function noteOf(query: string, { items, more }: FindResult, searches: number) {
  if (query.trim() === "") return "";
  const who = searches === 1 ? "a large source" : `${searches} large sources`;
  if (items.length === 0) return searches === 0 ? "No match" : `No match on the canvas. You can search the tags of ${who}.`;
  const found = `${items.length} ${items.length === 1 ? "result" : "results"}${more > 0 ? `, ${more} more not shown` : ""}`;
  return searches === 0 ? found : `${found}. You can also search the tags of ${who}.`;
}

/**
 * The Find card of the Discovery canvas: an ARIA 1.2 combobox with a listbox popup. The focus stays in the field and
 * `aria-activedescendant` names the option the arrows are on; the listbox is in the DOM only while there is something to list; the one
 * live line is always mounted (a region added together with its text is not announced). The active option is kept by the entry's id, so a
 * new `search` function with the same results (a graph read again while the card is open) leaves it where it was.
 *
 * Escape and a choice put the focus back where it was when the card opened (else on `trigger`) BEFORE `onChoose` runs, so it is never on
 * the body while the camera glides; Escape is heard by nobody else.
 */
export function FindBox({ search, onChoose, shapes = NO_TARGETS, onShapes, onClose, trigger, id }: FindBoxProps) {
  const uid = useId();
  const listId = `${uid}-list`;
  const inputId = `${uid}-input`;
  const optionId = (index: number) => `${uid}-opt-${index}`;
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [before] = useState<Element | null>(() => document.activeElement); // read during the first render, before the field takes the focus
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const closed = useRef(false); // onClose is called once per card: moving the focus back (which blurs the card) must not close it a second time

  const result = useMemo(() => (query.trim() === "" ? NONE : search(query)), [search, query]);
  // (w36) The canvas matches, then one tag search per large source: the arrows, the active option and Enter run over the whole list.
  const tagSearches = useMemo(() => shapesOptions(shapes, query), [shapes, query]);
  const items = useMemo<Row[]>(() => [
    ...result.items.map((entry): Row => ({ id: entry.id, icon: entry.icon, label: entry.label, context: entry.context, entry, to: null })),
    ...tagSearches.map((option): Row => ({ id: option.id, icon: "search", label: option.label, context: "opens Map by shape", entry: null, to: option.to })),
  ], [result, tagSearches]);
  const active = items.length === 0 ? -1 : Math.max(0, items.findIndex((item) => item.id === activeId));
  const listed = items.length > 0;

  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (active >= 0) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps -- optionId only closes over the stable uid

  // The zone a press or a focus may land in without closing the card: the whole tools panel it sits in (the Find button's own click toggles).
  const inZone = (target: EventTarget | null) =>
    target instanceof Node && !!((root.current?.closest(".graph-tools") ?? root.current)?.contains(target) || trigger?.current?.contains(target));

  const close = () => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => { if (!inZone(event.target)) close(); };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]); // eslint-disable-line react-hooks/exhaustive-deps -- inZone and close read refs and onClose

  const restoreFocus = () => {
    const back = before instanceof HTMLElement && before.isConnected && before !== document.body && !root.current?.contains(before) ? before : trigger?.current;
    back?.focus({ preventScroll: true });
  };
  const choose = (row: Row) => {
    close();
    restoreFocus();
    if (row.entry) onChoose(row.entry);
    else if (row.to !== null) onShapes?.(row.to);
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
    setActiveId(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (items.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveId(items[(active + step + items.length) % items.length].id);
    } else if (event.key === "Enter") {
      if (active < 0) return;
      event.preventDefault();
      choose(items[active]);
    } else if (event.key === "Escape") {
      event.preventDefault(); // some browsers clear a field on Escape
      event.stopPropagation(); // the innermost layer only: a dialog around the canvas stays
      close();
      restoreFocus();
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.key ?? "").toLowerCase() === "k") {
      event.preventDefault(); // the top bar's quick find listens on the document; Ctrl+K here just selects what was typed
      event.stopPropagation();
      input.current?.select();
    }
  };

  return (
    <div
      ref={root}
      id={id}
      role="search"
      aria-label="Graph search"
      className="graph-find"
      onBlur={(event) => { if (event.relatedTarget && !inZone(event.relatedTarget)) close(); }} // Tab out; a click elsewhere is the pointer listener's
    >
      <label className="sr-only" htmlFor={inputId}>Search the graph</label>
      <div className="graph-find-field">
        <Icon name="search" />
        <input
          id={inputId}
          ref={input}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          placeholder="Source, group, point or asset"
          value={query}
          aria-expanded={listed}
          aria-controls={listed ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={listed ? optionId(active) : undefined}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
      </div>
      {listed && (
        // A press on an option must not take the focus from the field (the click would be lost).
        <ul id={listId} role="listbox" aria-label="Matches" className="graph-find-list" onMouseDown={(event) => event.preventDefault()}>
          {items.map((item, index) => (
            <li
              key={item.id}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              className="graph-find-opt"
              data-kind={item.to !== null ? "tags" : undefined} // the search of a large source's tags: its long label may wrap (graph-tools.css)
              onClick={() => choose(item)}
            >
              <Icon name={item.icon} />
              <span className="graph-find-label">{item.label}</span>
              <small className="graph-find-context">{item.context}</small>
            </li>
          ))}
        </ul>
      )}
      <p className="graph-find-note" aria-live="polite" aria-atomic="true">{noteOf(query, result, tagSearches.length)}</p>
    </div>
  );
}
