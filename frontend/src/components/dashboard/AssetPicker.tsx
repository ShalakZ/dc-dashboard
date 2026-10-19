import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Asset } from "../../api/types";
import {
  ancestorsOf, buildPickerModel, countsBelow, filterPicker, isFolded, pickAllUnder, sameAssets, visibleRows,
  type PickerNode,
} from "../../lib/pickerModel";
import { Icon } from "../Icon";

// The helpers live in lib/pickerRows.ts; they stay importable from here for the pages and dialogs that use them.
export { assetLabels, assetOptions, pickerLabel, pickerRows } from "../../lib/pickerRows";
export type { PickerRow } from "../../lib/pickerRows";

interface Props {
  assets: Asset[];
  selected: number[];
  onChange: (ids: number[]) => void;
  /** One asset only (stat, gauge): radios instead of checkboxes. */
  single: boolean;
  /** Most assets a widget may have (checkboxes stop at this). */
  max: number;
  /** The whole asset tree, when `assets` lists only some of it (see `pickerRows`). */
  tree?: Asset[];
  /** A short note shown in brackets after an asset's name, e.g. "no voltage_v". */
  notes?: ReadonlyMap<number, string>;
  /** What to say when there is nothing to pick (default "No assets yet."). */
  empty?: string;
  /** The legend (default "Asset" when single, else "Assets"). */
  label?: string;
}

/** Rows drawn at first, and how many more each "Show more" adds: a long list stays quick to draw. */
const ROW_STEP = 200;

/** Keeps the previous array while the next one has the same content (the editor rebuilds `offered` on every pick although it does not change). */
function useStableAssets(list: Asset[]): Asset[] {
  const kept = useRef(list);
  if (kept.current !== list && !sameAssets(kept.current, list)) kept.current = list;
  return kept.current;
}

/** What a row can do. One object for the whole picker: its methods read the latest props and state, so the memoised rows never change for it. */
interface RowKit {
  toggle(id: number, on: boolean): void;
  fold(id: number): void;
  pickAll(id: number): void;
}

interface RowProps {
  node: PickerNode;
  single: boolean;
  group: string;
  checked: boolean;
  disabled: boolean;
  note: string | undefined;
  foldable: boolean;
  open: boolean;
  locked: boolean;
  canPickAll: boolean;
  allPicked: boolean;
  kit: RowKit;
}

/** The row's label split into the name, the parent path (read by a screen reader, not drawn) and a trailing " #id" (drawn). */
function labelParts(node: PickerNode): { path: string; id: string; whole: string | null } {
  if (!node.label.startsWith(node.name)) return { path: "", id: "", whole: node.label };
  const rest = node.label.slice(node.name.length);
  const id = /\s#\d+$/.exec(rest)?.[0] ?? "";
  return { path: rest.slice(0, rest.length - id.length), id, whole: null };
}

const Row = memo(function Row({ node, single, group, checked, disabled, note, foldable, open, locked, canPickAll, allPicked, kit }: RowProps) {
  const parts = node.offered ? labelParts(node) : null;
  return (
    <li className="picker-line" aria-level={node.depth + 1} data-context={node.offered ? undefined : "true"} style={{ "--depth": node.depth } as CSSProperties}>
      {foldable ? (
        <button type="button" className="picker-fold" aria-expanded={open} aria-label={`Children of ${node.buttonLabel}`} disabled={locked} onClick={() => kit.fold(node.id)}>
          <Icon name="caret" />
        </button>
      ) : (
        <span className="picker-fold-sp" />
      )}
      {parts ? (
        <label className="picker-row">
          <input type={single ? "radio" : "checkbox"} name={single ? group : undefined} checked={checked} disabled={disabled} onChange={(e) => kit.toggle(node.id, e.target.checked)} />
          {parts.whole ?? node.name}
          {parts.path !== "" && <span className="sr-only">{parts.path}</span>}
          {parts.id}
          {note !== undefined ? ` (${note})` : ""}
        </label>
      ) : (
        <span className="picker-context">{node.name}</span>
      )}
      {canPickAll ? (
        <button
          type="button" className="picker-all" aria-label={`Pick all under ${node.buttonLabel}`}
          aria-disabled={allPicked ? true : undefined} title={allPicked ? "Everything under it is picked" : undefined}
          onClick={() => kit.pickAll(node.id)}
        >
          <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M4 12h6M4 17h9" /><path d="m14 14 2.5 2.5L21 11" /></svg>
        </button>
      ) : (
        <span className="picker-all-sp" />
      )}
    </li>
  );
});

/**
 * The asset field of the widget editor: a search box and a kind filter over a folded tree of checkboxes (radios when single), the picks as
 * removable chips, and "Pick all under" a row. A name used twice shows its parent path to a screen reader. It knows nothing of widget forms.
 */
export function AssetPicker({ assets, selected, onChange, single, max, tree, notes, empty = "No assets yet.", label }: Props) {
  const group = useId();
  const stableAssets = useStableAssets(assets);
  const stableTree = useStableAssets(tree ?? assets);
  const model = useMemo(() => buildPickerModel(stableAssets, stableTree), [stableAssets, stableTree]);

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const kindNow = model.kinds.some((k) => k.key === kind) ? kind : "";
  const [limit, setLimit] = useState(ROW_STEP);
  const [refusal, setRefusal] = useState("");
  const view = useMemo(() => filterPicker(model, query, kindNow), [model, query, kindNow]);
  const pickedSet = useMemo(() => new Set(selected), [selected]);
  const below = useMemo(() => countsBelow(model, view, pickedSet), [model, view, pickedSet]);

  // The fold is the person's: a mark per branch (true = folded), changed only by a click or a pick, never by an effect. A branch that held a pick
  // when the picker opened starts open.
  const [marks, setMarks] = useState<ReadonlyMap<number, boolean>>(() => new Map());
  const [seedIds] = useState(selected);
  const seedOpen = useMemo(() => ancestorsOf(model, seedIds), [model, seedIds]);
  const foldState = useMemo(() => ({ marks, seedOpen }), [marks, seedOpen]);
  const all = useMemo(() => visibleRows(model, view, foldState), [model, view, foldState]);
  const rows = all.length > limit ? all.slice(0, limit) : all;

  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const chipButtons = useRef(new Map<number, HTMLButtonElement>());
  const focusAfter = useRef<number | "search" | null>(null); // where the focus goes after a chip is removed
  const moreAt = useRef<number | null>(null); // the index of the first row "Show more" adds
  const lastFocus = useRef<HTMLElement | null>(null);

  const latest = useRef({ model, view, foldState, selected, single, max, onChange });
  latest.current = { model, view, foldState, selected, single, max, onChange };

  const kit = useMemo<RowKit>(() => {
    // The branches above what was just picked open (a pick made in a filtered list is still in place when the search is cleared).
    const openWay = (ids: number[]) => {
      const ancestors = ancestorsOf(latest.current.model, ids);
      if (ancestors.size === 0) return;
      setMarks((current) => {
        if ([...ancestors].every((a) => current.get(a) === false)) return current;
        const next = new Map(current);
        for (const a of ancestors) next.set(a, false);
        return next;
      });
    };
    return {
      toggle(id, on) {
        const { selected: picked, single: one, max: most, onChange: change } = latest.current;
        setRefusal("");
        if (one) {
          change([id]);
          openWay([id]);
        } else if (on) {
          if (picked.includes(id) || picked.length >= most) return;
          change([...picked, id]);
          openWay([id]);
        } else {
          change(picked.filter((x) => x !== id));
        }
      },
      fold(id) {
        const { model: m, view: v, foldState: f } = latest.current;
        const folded = isFolded(m, v, f, id);
        setMarks((current) => new Map(current).set(id, !folded));
      },
      pickAll(id) {
        const { model: m, view: v, selected: picked, max: most, onChange: change } = latest.current;
        const result = pickAllUnder(m, v, id, picked, most);
        if (result.kind === "add") {
          setRefusal("");
          change([...picked, ...result.ids]);
          openWay(result.ids);
        } else if (result.kind === "refuse") {
          setRefusal(`${result.count} asset${result.count === 1 ? "" : "s"} under ${m.byId.get(id)?.buttonLabel ?? ""}, room for ${result.room}: nothing was picked`);
        }
      },
    };
  }, []);

  const remove = (id: number) => {
    const at = selected.indexOf(id);
    const neighbour = selected[at + 1] ?? selected[at - 1];
    focusAfter.current = neighbour ?? "search";
    setRefusal("");
    onChange(selected.filter((x) => x !== id));
  };
  const clearAll = () => {
    if (selected.length === 0) return;
    setRefusal("");
    onChange([]);
  };
  const showMore = () => {
    moreAt.current = rows.length;
    setLimit((l) => l + ROW_STEP);
  };

  // After every render: the focus a chip removal or "Show more" asked for; else, when the row that had the focus is gone (an unpicked row that is
  // no longer offered) and the focus fell to the page, the search box.
  useLayoutEffect(() => {
    const target = focusAfter.current;
    const first = moreAt.current;
    focusAfter.current = null;
    moreAt.current = null;
    if (target !== null) {
      (target === "search" ? search.current : chipButtons.current.get(target) ?? search.current)?.focus();
    } else if (first !== null) {
      list.current?.children[first]?.querySelector<HTMLElement>("input, button")?.focus();
    } else if (lastFocus.current && !lastFocus.current.isConnected && document.activeElement === document.body) {
      search.current?.focus();
    }
  });

  const full = !single && selected.length >= max;
  const liveText = refusal || (view.filtering ? (view.count === 0 ? "No match" : `${view.count} match`) : "");
  const removable = !single || selected.length > 1;

  return (
    <fieldset className="asset-picker" onFocus={(e) => { lastFocus.current = e.target as HTMLElement; }}>
      <legend>{label ?? (single ? "Asset" : "Assets")}</legend>
      {model.nodes.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <>
          <div className="picker-tools">
            <input
              type="search" className="picker-search" ref={search} aria-label="Search assets" placeholder="Name or kind"
              autoComplete="off" spellCheck={false} value={query}
              onChange={(e) => { setQuery(e.target.value); setLimit(ROW_STEP); setRefusal(""); }}
              onKeyDown={(e) => {
                // Escape clears a typed search and stops there; in an empty box it goes on and closes the dialog.
                if (e.key === "Escape" && !e.nativeEvent.isComposing && query !== "") {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery("");
                  setLimit(ROW_STEP);
                  setRefusal("");
                }
              }}
            />
            <select className="picker-kind" aria-label="Filter by kind" value={kindNow} onChange={(e) => { setKind(e.target.value); setLimit(ROW_STEP); setRefusal(""); }}>
              <option value="">All kinds</option>
              {model.kinds.map((k) => <option key={k.key} value={k.key}>{`${k.name.trim().replace(/\s+/g, " ")} (${k.count})`}</option>)}
            </select>
          </div>
          <p className="muted picker-live" aria-live="polite">{liveText}</p>
          <div className="picker-chip-box">
            {selected.length === 0 ? (
              <span className="muted picker-none">{single ? "No asset picked yet." : "Nothing picked yet."}</span>
            ) : (
              <ul className="picker-chips" aria-label="Picked assets">
                {selected.map((id) => {
                  const labelOnly = model.byId.get(id)?.label ?? `Asset #${id}`;
                  const text = labelOnly + (notes?.has(id) ? ` (${notes.get(id)})` : "");
                  return (
                    <li key={id} className="picker-chip" title={text}>
                      <span className="picker-chip-text">{text}</span>
                      {removable && (
                        <button
                          type="button" className="picker-chip-x" aria-label={`Remove ${labelOnly}`} onClick={() => remove(id)}
                          ref={(el) => { if (el) chipButtons.current.set(id, el); else chipButtons.current.delete(id); }}
                        >
                          <Icon name="close" />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <ul className="picker-list" ref={list}>
            {rows.map(({ node, foldable, open, locked }) => (
              <Row
                key={node.id} node={node} single={single} group={group}
                checked={pickedSet.has(node.id)} disabled={full && !pickedSet.has(node.id)} note={notes?.get(node.id)}
                foldable={foldable} open={open} locked={locked}
                canPickAll={!single && below.results[node.index] > 0} allPicked={below.pending[node.index] === 0} kit={kit}
              />
            ))}
            {all.length === 0 && view.filtering && <li className="picker-empty muted">No asset matches.</li>}
            {all.length > rows.length && (
              <li className="picker-more">
                <span className="muted">{`Showing ${rows.length} of ${all.length}`}</span>
                <button type="button" className="quiet picker-more-btn" onClick={showMore}>{`Show ${Math.min(ROW_STEP, all.length - rows.length)} more`}</button>
              </li>
            )}
          </ul>
        </>
      )}
      {!single && (
        <div className="picker-foot">
          <p className="muted">{selected.length} selected (up to {max})</p>
          <button type="button" className="quiet picker-clear" aria-disabled={selected.length === 0 ? true : undefined} onClick={clearAll}>Clear all</button>
        </div>
      )}
    </fieldset>
  );
}
