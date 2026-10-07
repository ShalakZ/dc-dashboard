import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import { keys, useInvalidate } from "../api/queries";
import type { Scope, ScopeIn, ScopeSuggestions } from "../api/types";
import { useAction } from "../hooks/useAction";
import { parsePorts, parseTargets } from "../lib/scope";

interface Props {
  initial?: Scope;
  suggestions?: ScopeSuggestions;
  onSaved: () => void;
  onCancel: () => void;
}

/** Create or edit a scan scope. A new scope is prefilled from the collector's networks and the known connector ports. */
export function ScopeForm({ initial, suggestions, onSaved, onCancel }: Props) {
  const invalidate = useInvalidate();
  const { run, busy, error } = useAction();
  const [name, setName] = useState(initial?.name ?? "");
  const [targets, setTargets] = useState((initial?.targets ?? suggestions?.targets ?? []).join("\n"));
  const [ports, setPorts] = useState((initial?.ports ?? suggestions?.ports ?? []).join(", "));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const body: ScopeIn = { name, targets: parseTargets(targets), ports: parsePorts(ports) };
      if (initial) await api.patch(`/api/scopes/${initial.id}`, body);
      else await api.post("/api/scopes", body);
      await invalidate(keys.scopes);
      onSaved();
    });
  };

  return (
    <form onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} /></label>
      <label>Targets<textarea rows={4} value={targets} onChange={(e) => setTargets(e.target.value)} aria-describedby="scope-targets-hint" /></label>
      <small id="scope-targets-hint" className="muted">
        One per line or comma separated: a CIDR range (10.0.0.0/24), a host name (plc-1), or a URL (http://plc-1:8080).
      </small>
      <label>Ports<input value={ports} onChange={(e) => setPorts(e.target.value)} aria-describedby="scope-ports-hint" /></label>
      <small id="scope-ports-hint" className="muted">Comma or space separated TCP ports to probe on every host.</small>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button type="submit" disabled={busy}>Save</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
