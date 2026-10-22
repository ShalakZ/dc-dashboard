import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { keys, useConnectors, useInvalidate } from "../api/queries";
import type { Source, SourceIn } from "../api/types";
import { coerceValues, fieldsFromSchema, initialValues, valuesFromConfig, type RawValues } from "../lib/schemaForm";
import { useModalBusy } from "./Modal";
import { SchemaForm } from "./SchemaForm";
import { useToast } from "./Toasts";

/** Without `source` the form adds one; with it, it edits that source (its connector cannot change). */
export function SourceForm({ source, onDone }: { source?: Source; onDone: () => void }) {
  const { data, error: loadError } = useConnectors(true);
  const connectors = data ?? [];
  const invalidate = useInvalidate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const secretHintId = useId();
  const connectorHintId = useId();
  const hiddenNoteId = useId();
  const [name, setName] = useState(source?.name ?? "");
  const [type, setType] = useState("");
  const [values, setValues] = useState<RawValues>({});
  const [secret, setSecret] = useState("");
  const [removeSecret, setRemoveSecret] = useState(false);
  const [clearKeys, setClearKeys] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useModalBusy(submitting); // Escape must not close the dialog on a save that is still running

  // An edit never falls back to another connector: its fields would replace the stored config.
  const connector = source ? connectors.find((c) => c.type === source.connector_type) : connectors.find((c) => c.type === type) ?? connectors[0];
  const fields = useMemo(() => (connector ? fieldsFromSchema(connector.config_schema) : []), [connector]);
  // A connector that does not poll (`file`) reaches nothing, so it has nothing to authenticate and the form offers no Secret. A reply without `polls` (an older server) counts as polling.
  const takesSecret = connector?.polls !== false;
  useEffect(() => { if (!source && connector && type !== connector.type) setType(connector.type); }, [source, connector, type]);
  // `source` must be a stable object (the page keeps the one it was opened with): a new one would reset what is typed.
  // The values the form was opened with (an edit only): what the fields are compared with to tell whether the config was edited at all.
  const opened = useMemo<RawValues>(() => (source ? valuesFromConfig(fields, source.config) : {}), [fields, source]);
  useEffect(() => { setValues(source ? opened : initialValues(fields)); setClearKeys([]); }, [fields, source, opened]);
  // Config keys whose stored user name and password the API hides (an edit only; the field shows the masked value).
  const hiddenKeys = source?.hidden_config_keys ?? [];
  const fieldTitle = (key: string) => fields.find((f) => f.name === key)?.label ?? key;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      if (source) {
        // No `secret` key keeps the stored secret; "" would erase it.
        // `config` goes only when a config field was edited, or credentials are to be removed (`clear_config_credentials` only takes effect together with
        // `config`). A save that is a rename, a switch or a secret must not send the config this form was opened with back: after a move of the source
        // (w33) that config holds the old address, and the save would put the source back there.
        const cleared = hiddenKeys.filter((key) => clearKeys.includes(key));
        const configEdited = cleared.length > 0 || fields.some((field) => values[field.name] !== opened[field.name]);
        const body: Partial<Omit<SourceIn, "connector_type">> & { clear_config_credentials?: string[] } = {
          name, ...(configEdited ? { config: coerceValues(fields, values) } : {}), enabled, ...(removeSecret ? { secret: null } : secret ? { secret } : {}),
          ...(cleared.length ? { clear_config_credentials: cleared } : {}),
        };
        const patched = await api.patch<Source>(`/api/sources/${source.id}`, body);
        // Put the saved source into the list first: if the refetch below fails, the next Edit must not start from (and save back) the old values.
        queryClient.setQueryData<Source[]>(keys.sources, (list) => list?.map((s) => (s.id === source.id ? { ...s, ...patched } : s)));
        setSecret("");
        await invalidate(keys.sources, keys.secretKey, keys.graph);
      } else {
        const body: SourceIn = { name, connector_type: connector!.type, config: coerceValues(fields, values), secret: takesSecret ? secret || null : null, enabled }; // a secret typed for the type chosen before is not carried over
        await api.post("/api/sources", body);
        toast.success("Source added"); // right after the request: the dialog closes and the new row is the only other sign
        setSecret("");
        await invalidate(keys.sources, keys.secretKey);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
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
        <>
          {/* The server sorts the types (a type that is filled by files comes last), so the first one, which the form starts on, is one that polls. */}
          <label>Connector
            <select value={connector.type} aria-describedby={connector.description ? connectorHintId : undefined} onChange={(e) => setType(e.target.value)}>
              {connectors.map((c) => <option key={c.type} value={c.type}>{c.type}</option>)}
            </select>
          </label>
          {/* A reply from an older server has no description */}
          {connector.description ? <small id={connectorHintId} className="muted">{connector.description}</small> : null}
        </>
      )}
      <SchemaForm fields={fields} values={values} onChange={setValues} />
      {hiddenKeys.map((key) => (
        <div key={key}>
          <small id={`${hiddenNoteId}-${key}`} className="muted">
            The user name and password stored in {fieldTitle(key)} are hidden. They are kept while you leave the address as it is;
            {" "}a different address replaces them, so type them into the address if it needs them.
          </small>
          <label>Remove the credentials stored in {fieldTitle(key)}
            <input type="checkbox" aria-describedby={`${hiddenNoteId}-${key}`} checked={clearKeys.includes(key)}
              onChange={(e) => setClearKeys((keysNow) => (e.target.checked ? [...keysNow, key] : keysNow.filter((k) => k !== key)))} />
          </label>
        </div>
      ))}
      {takesSecret && (
        <>
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
        </>
      )}
      <label>Enabled<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button type="button" onClick={onDone} disabled={submitting}>Cancel</button><button type="submit" className="primary" disabled={submitting}>Save</button></div>
    </form>
  );
}
