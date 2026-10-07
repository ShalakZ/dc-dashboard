import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { keys, useConnectors, useInvalidate } from "../api/queries";
import type { SourceIn } from "../api/types";
import { coerceValues, fieldsFromSchema, initialValues, type RawValues } from "../lib/schemaForm";
import { SchemaForm } from "./SchemaForm";

export function SourceForm({ onDone }: { onDone: () => void }) {
  const { data: connectors = [], error: loadError } = useConnectors(true);
  const invalidate = useInvalidate();
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [values, setValues] = useState<RawValues>({});
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const connector = connectors.find((c) => c.type === type) ?? connectors[0];
  const fields = useMemo(() => (connector ? fieldsFromSchema(connector.config_schema) : []), [connector]);
  useEffect(() => { if (connector && type !== connector.type) setType(connector.type); }, [connector, type]);
  useEffect(() => { setValues(initialValues(fields)); }, [fields]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const body: SourceIn = { name, connector_type: connector!.type, config: coerceValues(fields, values), secret: secret || null, enabled };
    try {
      await api.post("/api/sources", body);
      setSecret("");
      await invalidate(keys.sources);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loadError) return <p className="error" role="alert">{loadError.message}</p>;
  if (!connector) return <p className="muted">loading connectors…</p>;
  return (
    <form onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Connector
        <select value={connector.type} onChange={(e) => setType(e.target.value)}>
          {connectors.map((c) => <option key={c.type} value={c.type}>{c.type}</option>)}
        </select>
      </label>
      <SchemaForm fields={fields} values={values} onChange={setValues} />
      <label>Secret<input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
      <label>Enabled<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button type="submit">Save</button><button type="button" onClick={onDone}>Cancel</button></div>
    </form>
  );
}
