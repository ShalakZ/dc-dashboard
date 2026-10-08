import { useId, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { useCreateDashboard } from "../../api/queries";
import type { RangePreset } from "../../api/types";
import { useAction } from "../../hooks/useAction";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import { RANGE_LABELS, RANGE_PRESETS } from "../../lib/ranges";

/** Name and default range; on success the new (empty) dashboard opens in edit mode. */
export function CreateDashboardDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateDashboard();
  const { run, busy, error } = useAction();
  const root = useRef<HTMLDivElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameId = useId();
  const rangeId = useId();
  const [name, setName] = useState("");
  const [range, setRange] = useState<RangePreset>("24h");
  useDialogFocus(root, onClose, { busy, initial: nameInput });
  const trimmed = name.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (trimmed === "" || busy) return;
    void run(async () => {
      const created = await create.mutateAsync({ name: trimmed, range });
      navigate(`/dashboards/${created.id}`, { state: { edit: true } });
    });
  };

  return (
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-label="New dashboard" className="dialog narrow">
        <h2>New dashboard</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor={nameId}>Name</label>
            <input id={nameId} ref={nameInput} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={rangeId}>Range</label>
            <select id={rangeId} value={range} onChange={(e) => setRange(e.target.value as RangePreset)}>
              {RANGE_PRESETS.map((p) => <option key={p} value={p}>{RANGE_LABELS[p]}</option>)}
            </select>
          </div>
          {trimmed === "" && <p className="muted">Enter a name.</p>}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="row">
            <button type="submit" disabled={busy || trimmed === ""}>Create</button>
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
