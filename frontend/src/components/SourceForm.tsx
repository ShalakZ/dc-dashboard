import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { keys, useConnectors, useInvalidate } from "../api/queries";
import type { Source, SourceIn } from "../api/types";
import { coerceValues, fieldsFromSchema, initialValues, valuesFromConfig, type RawValues } from "../lib/schemaForm";
import { SchemaForm } from "./SchemaForm";

/** Without `source` the form adds one; with it, it edits that source (its connector cannot change). */
export function SourceForm({ source, onDone }: { source?: Source; onDone: () => void }) {
  const { data, error: loadError } = useConnectors(true);
  const connectors = data ?? [];
  const invalidate = useInvalidate();
  const secretHintId = useId();
  const [name, setName] = useState(source?.name ?? "");
  const [type, setType] = useState("");
  const [values, setValues] = useState<RawValues>({});
  const [secret, setSecret] = useState("");
  const [removeSecret, setRemoveSecret] = useState(false);
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  // An edit never falls back to another connector: its fields would replace the stored config.
  const connector = source ? connectors.find((c) => c.type === source.connector_type) : connectors.find((c) => c.type === type) ?? connectors[0];
  const fields = useMemo(() => (connector ? fieldsFromSchema(connector.config_schema) : []), [connector]);
  useEffect(() => { if (!source && connector && type !== connector.type) setType(connector.type); }, [source, connector, type]);
  // `source` must be a stable object (the page keeps the one it was opened with): a new one would reset what is typed.
  useEffect(() => { setValues(source ? valuesFromConfig(fields, source.config) : initialValues(fields)); }, [fields, source]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      if (source) {
        // No `secret` key keeps the stored secret; "" would erase it.
        const body: Partial<Omit<SourceIn, "connector_type">> = {
          name, config: coerceValues(fields, values), enabled, ...(removeSecret ? { secret: null } : secret ? { secret } : {}),
        };
        await api.patch(`/api/sources/${source.id}`, body);
        setSecret("");
        await invalidate(keys.sources, keys.secretKey, keys.graph);
      } else {
        const body: SourceIn = { name, connector_type: connector!.type, config: coerceValues(fields, values), secret: secret || null, enabled };
        await api.post("/api/sources", body);
        setSecret("");
        await invalidate(keys.sources, keys.secretKey);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loadError) return <p className="error" role="alert">{loadError.message}</p>;
  if (!connector) {
    if (source && data) {
      return (
        <>
          <p className="error">This connector type is not available.</p>
          <div className="row"><button type="button" onClick={onDone}>Cancel</button></div>
        </>
      );
    }
    return <p className="muted">loading connectors…</p>;
  }
  return (
    <form onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      {source ? (
        <p className="muted">Connector: {source.connector_type}</p>
      ) : (
        <label>Connector
          <select value={connector.type} onChange={(e) => setType(e.target.value)}>
            {connectors.map((c) => <option key={c.type} value={c.type}>{c.type}</option>)}
          </select>
        </label>
      )}
      <SchemaForm fields={fields} values={values} onChange={setValues} />
      <label>Secret
        <input type="password" autoComplete="off" value={secret} disabled={removeSecret} aria-describedby={source?.has_secret ? secretHintId : undefined}
          onChange={(e) => setSecret(e.target.value)} />
      </label>
      {source?.has_secret && (
        <>
          <small id={secretHintId} className="muted">A secret is stored; leave blank to keep it.</small>
          <label>Remove the stored secret
            <input type="checkbox" checked={removeSecret} onChange={(e) => { setRemoveSecret(e.target.checked); if (e.target.checked) setSecret(""); }} />
          </label>
        </>
      )}
      <label>Enabled<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button type="submit">Save</button><button type="button" onClick={onDone}>Cancel</button></div>
    </form>
  );
}
