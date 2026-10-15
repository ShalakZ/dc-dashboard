import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import { keys, useInvalidate } from "../api/queries";
import type { Scope, ScopeIn, ScopeSuggestions } from "../api/types";
import { useAction } from "../hooks/useAction";
import { knownPorts, portHints, portName, portsLine, readPorts } from "../lib/ports";
import { parsePorts, parseTargets } from "../lib/scope";
import { useToast } from "./Toasts";

interface Props {
  initial?: Scope;
  suggestions?: ScopeSuggestions;
  onSaved: () => void;
  onCancel: () => void;
}

/**
 * Create or edit a scan scope. A new scope is prefilled from the collector's networks and the known connector ports.
 *
 * Under the Ports field sits one reserved slot (`.scope-ports-note`, two lines tall whether it is empty or not, so nothing below it moves while
 * someone types). It holds the ports as typed, with the names the page knows (`502 (Modbus), 4840 (OPC UA)`; cut at two lines, the text stays
 * whole), or, when a port looks like a typo of a known one, a plain-text warning that names the likely port instead (a readout beside it would
 * be a third line). The warning never blocks the save, and the slot is no live region (it would speak on every key).
 */
export function ScopeForm({ initial, suggestions, onSaved, onCancel }: Props) {
  const invalidate = useInvalidate();
  const { run, busy, error } = useAction();
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? "");
  const [targets, setTargets] = useState((initial?.targets ?? suggestions?.targets ?? []).join("\n"));
  const [ports, setPorts] = useState((initial?.ports ?? suggestions?.ports ?? []).join(", "));
  // The guard compares with the named ports and, once they are read, the ports the server suggests: it works from the names alone until then (or when the read fails).
  const typed = readPorts(ports);
  const warnings = portHints(typed, knownPorts(suggestions?.ports));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    return run(async () => {
      const body: ScopeIn = { name, targets: parseTargets(targets), ports: parsePorts(ports) };
      if (initial) await api.patch(`/api/scopes/${initial.id}`, body);
      else {
        await api.post("/api/scopes", body);
        toast.success("Scan scope created"); // right after the request; an edit closes the form and needs no word
      }
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
      <label>Ports<input value={ports} onChange={(e) => setPorts(e.target.value)} aria-describedby="scope-ports-hint scope-ports-note" /></label>
      <small id="scope-ports-hint" className="muted">Comma or space separated TCP ports to probe on every host.</small>
      <div id="scope-ports-note" className="scope-ports-note">
        {warnings.lines.length > 0 ? (
          <>
            {warnings.lines.map((line) => <p key={line} className="warning">{line}</p>)}
            {warnings.more > 0 && <p className="warning">and {warnings.more} more</p>}
          </>
        ) : (
          typed.some((port) => portName(port)) && <p className="muted scope-ports-readout">Reads as {portsLine(typed)}</p>
        )}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={busy}>Save</button>
      </div>
    </form>
  );
}
