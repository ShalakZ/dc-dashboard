import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "../../api/client";
import { keys, useInvalidate } from "../../api/queries";
import type { AcceptResult, GraphModel, GraphSource, Metric } from "../../api/types";
import { acceptBody, assetChoices, bulkGroups, type BulkGroup, type ReviewRow } from "../../lib/drop";
import { assetLabels } from "../dashboard/AssetPicker";
import { useToast } from "../Toasts";

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** The longest asset name the server accepts (AssetName in api/asset_names.py). */
const MAX_NAME = 100;
/** Two non-breaking spaces per level: a browser strips ordinary leading spaces from an option (as assetOptions in AssetPicker does). */
const INDENT = String.fromCharCode(0xa0, 0xa0);
const GUESSES = "These are the scan's guesses. To change a metric or a scale first, use New asset... on the group instead.";

/** The server's key for comparing sibling names (api/asset_names.py): trimmed, runs of spaces folded to one, lower case. */
const nameKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** How each metric's own unit is usually written (lower case, no blanks). A point whose hint is none of these is read in another unit, and the scale is what bridges it. */
const OWN_UNITS: Record<Exclude<Metric, "custom">, readonly string[]> = {
  active_power_kw: ["kw"], energy_kwh: ["kwh"], voltage_v: ["v"], current_a: ["a"], power_factor: ["pf", "cosphi", "cosφ"],
  frequency_hz: ["hz"], reactive_power_kvar: ["kvar"], apparent_power_kva: ["kva"],
};
/** The point's unit hint when it is not the unit of the metric it is mapped to (so the person can see what the scale has to bridge); null when there is nothing to say. */
function foreignUnit(row: ReviewRow): string | null {
  const hint = row.unitHint?.trim();
  if (row.metric === "custom" || !hint) return null;
  return OWN_UNITS[row.metric].includes(hint.toLowerCase().replace(/\s+/g, "")) ? null : hint;
}
const mappedText = (r: ReviewRow) => `${r.name}: ${r.metric === "custom" ? `custom (${(r.customUnit ?? "").trim()})` : r.metric} ×${r.scale}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Create one asset for each group of a source in one go (W7r): choose ONE parent (or the top level), tick the groups, adjust their names and
 * press the button. The dialog shows what each asset would get, metric by metric and scale by scale, and which points stay unmapped, so a
 * wrong guess is seen before the click; nothing here changes a guess (New asset... on the group does). Each group is its own
 * POST /api/discovery/accept, one after the other: every call is atomic, so a failure leaves the others made and says which one is not.
 *
 * The groups are read once, when the dialog opens: a refetch of the graph while the person types must not wipe their names. Focus moves to the
 * parent select and Tab stays inside; when the dialog goes away it does NOT give the focus back (the page knows what is left to focus).
 */
export function BulkCreateDialog({ model, source, onClose }: { model: GraphModel; source: GraphSource; onClose: () => void }) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const dialog = useRef<HTMLDivElement>(null);
  const parentSelect = useRef<HTMLSelectElement>(null);
  const rowsBox = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const parentId = useId();
  const noteId = useId();
  const statusId = useId();

  const [groups] = useState(() => {
    const all = bulkGroups(source);
    return { offered: all.filter((g) => g.mapped > 0), leftOut: all.filter((g) => g.mapped === 0) };
  });
  const [parent, setParent] = useState<number | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({}); // absent = ticked
  const [names, setNames] = useState<Record<string, string>>({}); // absent = the group's own name
  const [created, setCreated] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<Record<string, string>>({}); // the server's words, per group that was not created
  const [outcome, setOutcome] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ at: number; of: number } | null>(null);
  const [busy, setBusy] = useState(false);
  // The height the list had when the batch started. Rows that were created leave it, and a dialog that shrinks would carry its buttons up from under the pointer.
  const [held, setHeld] = useState<number | null>(null);
  const running = useRef(false);
  const alive = useRef(true);
  const close = useRef(onClose);
  close.current = onClose;

  const choices = useMemo(() => assetChoices(model.assets), [model.assets]);
  const labels = useMemo(() => assetLabels(model.assets.map((a) => ({ ...a, sort_order: 0 }))), [model.assets]);

  const open = groups.offered.filter((g) => !created.has(g.key));
  const isTicked = (g: BulkGroup) => ticked[g.key] !== false;
  const nameOf = (g: BulkGroup) => names[g.key] ?? g.key;
  const chosen = open.filter(isTicked);

  // The names the chosen parent already has, in the server's key. Recomputed when the parent changes (or the assets do).
  const taken = useMemo(() => new Set(model.assets.filter((a) => a.parent_id === parent).map((a) => nameKey(a.name))), [model.assets, parent]);
  const where = parent === null ? "at the top level" : `under "${model.assets.find((a) => a.id === parent)?.name ?? ""}"`;
  // Only the ticked groups are compared with each other: a group left out sends no name.
  const uses = new Map<string, number>();
  for (const g of chosen) uses.set(nameKey(nameOf(g)), (uses.get(nameKey(nameOf(g))) ?? 0) + 1);
  const problems: Record<string, string> = {};
  for (const g of chosen) {
    const key = nameKey(nameOf(g));
    if (key === "") problems[g.key] = "Enter a name.";
    else if (taken.has(key)) problems[g.key] = `"${nameOf(g).trim()}" already exists ${where}.`;
    else if ((uses.get(key) ?? 0) > 1) problems[g.key] = "Another group in this batch has the same name.";
  }
  const messageOf = (g: BulkGroup) => problems[g.key] ?? failures[g.key] ?? null;

  const wrong = chosen.filter((g) => problems[g.key]);
  let reason: string | null = null;
  if (groups.offered.length === 0) reason = "No group of this source can become an asset without a decision.";
  else if (chosen.length === 0) reason = "Tick at least one group.";
  else if (wrong.length > 0) reason = `${wrong[0].key}: ${problems[wrong[0].key]}${wrong.length > 1 ? ` ${plural(wrong.length - 1, "more name")} to fix.` : ""}`;
  const ready = !busy && reason === null;
  // One slot. The outcome of the batch comes first: after a partial one the graph that was read again holds the very clash that failed the row,
  // and the dialog's own check would otherwise hide "Created 9 of 10" behind it. Any edit drops the outcome (it described the rows as they were).
  const status = busy && progress ? `Creating ${progress.at} of ${progress.of}...` : (outcome ?? reason ?? "");

  async function createAll() {
    if (running.current || !ready) return;
    running.current = true;
    // What was ticked and typed when the button was pressed is what is sent, whatever is edited while it runs.
    const plan = chosen.map((g) => ({ group: g, name: nameOf(g).trim() }));
    const target = parent;
    setBusy(true);
    setHeld(rowsBox.current?.getBoundingClientRect().height ?? null);
    setFailures({});
    setOutcome(null);
    const failed: string[] = [];
    let made = 0;
    try {
      for (const [index, { group, name }] of plan.entries()) {
        if (alive.current) setProgress({ at: index + 1, of: plan.length });
        try {
          await api.post<AcceptResult>("/api/discovery/accept", acceptBody(source.id, { kind: "new", name, parentId: target }, group.rows));
          made += 1;
          if (alive.current) setCreated((current) => new Set(current).add(group.key));
        } catch (e) {
          failed.push(group.key);
          if (alive.current) setFailures((current) => ({ ...current, [group.key]: e instanceof Error ? e.message : String(e) }));
        }
      }
    } finally {
      // Once, for the whole batch, and before the page is told: its focus rules read the refreshed graph.
      try { await invalidate(keys.graph, keys.sources, keys.assets, keys.fleet, keys.auditAll); } finally { running.current = false; }
    }
    if (alive.current) {
      setProgress(null);
      setBusy(false);
    }
    if (failed.length === 0) {
      toast.success(`Created ${plural(made, "asset")}`);
      close.current();
      return;
    }
    toast.error(`Created ${made} of ${plural(plan.length, "asset")}`);
    // No names in it: the rows that are still listed are the ones that failed, and a list of names has no length limit (the line is a fixed slot).
    if (alive.current) setOutcome(`Created ${made} of ${plan.length}. The groups still listed were not created: fix the rows marked and press the button again.`);
  }

  // Focus moves in and stays in (Tab wraps, a focus that lands outside is pulled back). When the dialog goes away nothing is restored: the page decides.
  useEffect(() => {
    alive.current = true;
    const root = dialog.current;
    if (!root) return;
    const first = () => root.querySelector<HTMLElement>(FOCUSABLE) ?? root;
    (parentSelect.current ?? first()).focus();
    const keepFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.contains(event.target)) first().focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!running.current) close.current(); // not while the batch is being written
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (controls.length === 0) return;
      const [firstControl, lastControl] = [controls[0], controls[controls.length - 1]];
      const at = document.activeElement;
      if (event.shiftKey ? at === firstControl || at === root : at === lastControl) {
        event.preventDefault();
        (event.shiftKey ? lastControl : firstControl).focus();
      }
    };
    document.addEventListener("focusin", keepFocus);
    document.addEventListener("keydown", onKey);
    return () => {
      alive.current = false;
      document.removeEventListener("focusin", keepFocus);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  // A created row leaves the list: if the focus was in it, it would be on nothing. Put it on the button that does the next thing.
  useEffect(() => {
    const root = dialog.current;
    if (root && !root.contains(document.activeElement)) root.querySelector<HTMLElement>(".bulk-go")?.focus();
  }, [created]);

  return (
    <div className="dialog-backdrop">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="dialog bulk-dialog">
        <h2 id={titleId}>Create an asset for each group</h2>
        {/* No count in it: the groups leave as they are created, and a sentence that changes length would move the buttons. */}
        <p className="muted">{`Source "${source.name}". Each ticked group becomes one asset that holds the points of that group.`}</p>

        <div className="field">
          <label htmlFor={parentId}>Parent asset</label>
          <select
            id={parentId} ref={parentSelect} value={parent ?? ""} disabled={busy}
            onChange={(e) => { setParent(e.target.value === "" ? null : Number(e.target.value)); setFailures({}); setOutcome(null); }}
          >
            <option value="">(root)</option>
            {choices.map((a) => <option key={a.id} value={a.id}>{INDENT.repeat(a.depth) + (labels.get(a.id) ?? a.name)}</option>)}
          </select>
        </div>

        <div ref={rowsBox} className="dialog-rows bulk-rows" style={held === null ? undefined : { minHeight: held }}>
          <table aria-label="Groups to create assets from">
            <thead>
              <tr><th>Use</th><th>Group</th><th>Points mapped</th><th>Asset name</th><th>What the scan guessed</th></tr>
            </thead>
            <tbody>
              {open.map((g) => {
                const message = messageOf(g);
                const id = `${noteId}-${g.key}`;
                return (
                  <tr key={g.key}>
                    <td>
                      <input
                        type="checkbox" aria-label={`Include ${g.key}`} checked={isTicked(g)} disabled={busy}
                        onChange={(e) => { setTicked((current) => ({ ...current, [g.key]: e.target.checked })); setOutcome(null); }}
                      />
                    </td>
                    <td className="bulk-group">{g.key}</td>
                    <td className="bulk-count">{`${g.mapped} of ${g.points.length}`}</td>
                    <td>
                      <input
                        className="bulk-name" aria-label={`Asset name for ${g.key}`} value={nameOf(g)} maxLength={MAX_NAME} readOnly={busy}
                        aria-invalid={isTicked(g) && message !== null ? true : undefined}
                        aria-describedby={isTicked(g) && message !== null ? id : undefined}
                        onChange={(e) => {
                          setNames((current) => ({ ...current, [g.key]: e.target.value }));
                          setOutcome(null);
                          setFailures((current) => { const { [g.key]: _gone, ...rest } = current; return rest; });
                        }}
                      />
                      <span id={id} className="bulk-name-note">{isTicked(g) ? message : null}</span>
                    </td>
                    <td>
                      <ul className="bulk-list">
                        {g.rows.filter((r) => r.checked).map((r) => {
                          const foreign = foreignUnit(r);
                          return (
                            <li key={r.pointId}>
                              {mappedText(r)}
                              {foreign !== null && <span className="bulk-unit">{` (point unit ${foreign})`}</span>}
                            </li>
                          );
                        })}
                        {g.rows.filter((r) => !r.checked).map((r) => (
                          <li key={r.pointId} className="bulk-skip">{`${r.name} stays unmapped.${r.note ? ` ${r.note}` : ""}`}</li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="bulk-notes">
          <p className="muted">{GUESSES}</p>
          {groups.leftOut.length > 0 && (
            <p className="muted">{`Left out, because every point in them needs a decision: ${groups.leftOut.map((g) => g.key).join(", ")}. Use New asset... on the group.`}</p>
          )}
        </div>

        <p id={statusId} className="bulk-status">{status}</p>
        <div className="row">
          <button type="button" className="bulk-cancel" aria-disabled={busy ? true : undefined} onClick={() => { if (!busy) onClose(); }}>
            {created.size > 0 ? "Close" : "Cancel"}
          </button>
          <button type="button" className="primary bulk-go" aria-disabled={ready ? undefined : true} aria-describedby={statusId} onClick={() => void createAll()}>
            {`Create ${plural(chosen.length, "asset")}`}
          </button>
        </div>
      </div>
    </div>
  );
}
