import { useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useCreateDashboard } from "../../api/queries";
import type { RangePreset } from "../../api/types";
import { useAction } from "../../hooks/useAction";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";
import { useToast } from "../Toasts";

export type StartFrom = "blank" | "power";
const STARTS: { value: StartFrom; label: string }[] = [{ value: "blank", label: "Blank" }, { value: "power", label: "Power" }];
const POWER_NAME = "Power"; // the name an empty field gets when the dashboard starts from Power (the server's 409 answers a second one)

/**
 * Name, default range and what to start from. Blank opens the new (empty) dashboard in edit mode; Power comes filled with the starter widgets
 * (the server builds them from `recipe`) and opens in view mode, with This month as its range.
 */
export function CreateDashboardDialog({ onClose, initialStart = "blank" }: { onClose: () => void; initialStart?: StartFrom }) {
  const navigate = useNavigate();
  const create = useCreateDashboard();
  const toast = useToast();
  const { run, busy, error } = useAction();
  const root = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const rangeId = useId();
  const startName = useId();
  const [name, setName] = useState("");
  const [start, setStart] = useState<StartFrom>(initialStart);
  const [range, setRange] = useState<RangePreset>(initialStart === "power" ? "this_month" : "24h");
  useDialogFocus(root, onClose, { busy, initial: nameInput });
  const power = start === "power";
  const trimmed = name.trim();
  const finalName = trimmed === "" && power ? POWER_NAME : trimmed;

  // Power sets the range its compare widgets need; going back to Blank leaves whatever range the person has by then.
  const choose = (value: StartFrom) => {
    setStart(value);
    if (value === "power") setRange("this_month");
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (finalName === "" || busy) return;
    void run(async () => {
      const created = await create.mutateAsync(power ? { name: finalName, range, recipe: "power" } : { name: finalName, range });
      toast.success("Dashboard created"); // the new page does not say it was just made
      navigate(`/dashboards/${created.id}`, power ? undefined : { state: { edit: true } });
    });
  };

  return (
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-label="New dashboard" className="dialog narrow">
        <h2>New dashboard</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor={nameId}>Name</label>
            <input id={nameId} ref={nameInput} value={name} maxLength={100} placeholder={power ? POWER_NAME : undefined} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={rangeId}>Range</label>
            <select id={rangeId} value={range} onChange={(e) => setRange(e.target.value as RangePreset)}>
              {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
            </select>
          </div>
          <fieldset>
            <legend>Start from</legend>
            {STARTS.map((s) => (
              <label key={s.value}>
                <input type="radio" name={startName} checked={start === s.value} onChange={() => choose(s.value)} />
                {s.label}
              </label>
            ))}
          </fieldset>
          {finalName === "" && <p className="muted">Enter a name.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row">
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="primary" disabled={busy || finalName === ""}>Create</button>
          </div>
        </form>
      </div>
    </div>
  );
}
