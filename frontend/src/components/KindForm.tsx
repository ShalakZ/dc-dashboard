import { useState, type FormEvent } from "react";
import type { AssetKind, AssetKindIn, AssetKindPatch } from "../api/types";
import { assetIcon, assetIconLabel, kindIconId } from "../lib/assetIcons";
import { cleanKind, kindKey } from "../lib/kinds";
import { IconPicker } from "./IconPicker";
import { useModalBusy } from "./Modal";
import { SaveButton } from "./SaveButton";

/** The server's limit (core/asset_kinds.py MAX_NAME), counted in code points. It applies to what a person writes, not to a name the registry was seeded with. */
const MAX_NAME = 60;

/**
 * The New kind and Edit kind dialog's form. A new kind starts on the keyword guess for its name and keeps following it until the person
 * picks an icon themselves. An existing kind (`initial`) sends only what changed, and closes without a request when nothing did.
 * `kinds` is the registry as the page knows it, for the one refusal that needs no round trip (a name another kind has); the server
 * still decides, and what it answers is shown as it is. `onSubmit` rejects to keep the dialog open and show its message.
 */
export function KindForm({ initial, kinds, onSubmit, onCancel }: {
  initial?: AssetKind;
  kinds: AssetKind[];
  onSubmit: (body: AssetKindIn | AssetKindPatch) => Promise<void>;
  onCancel: () => void;
}) {
  const [original] = useState(initial); // as the dialog opened: a refetch of the list must not change what counts as edited
  const [name, setName] = useState(original?.name ?? "");
  const [icon, setIcon] = useState(original?.icon ?? "generic"); // a catalogue id; one the catalogue lacks stays as it is until the person picks
  const [picked, setPicked] = useState(original !== undefined); // false: the icon is the guess for the name, whatever it is now
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useModalBusy(submitting); // Escape must not close the dialog on a save that is still running

  // The name as the server will store it (NFC, blanks tidied), which is also what the limits and the comparisons are about.
  const cleaned = cleanKind(name.normalize("NFC"));
  const shown = picked ? icon : kindIconId(cleaned);
  const label = assetIconLabel(shown);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    // Edited = the field no longer holds what the dialog opened with, and says more than a retyping of it. A seeded name is only tidied of
    // blanks (not NFC), so an untouched field must never count as edited: the server would rename the kind to its NFC form, and a long one
    // would be refused for a limit it was seeded past.
    const edited = original === undefined || (name !== original.name && cleaned !== cleanKind(original.name.normalize("NFC")));
    if (cleaned === "") return setError("A kind needs a name");
    // A seeded name can be longer than 60: only a name somebody edited is held to the limit, as the server does.
    if (edited && [...cleaned].length > MAX_NAME) return setError(`A kind name is at most ${MAX_NAME} characters`);
    const clash = edited ? kinds.find((k) => k.id !== original?.id && kindKey(k.name) === kindKey(cleaned)) : undefined;
    if (clash) return setError(`A kind named "${clash.name}" already exists`);
    let body: AssetKindIn | AssetKindPatch;
    if (original === undefined) {
      body = { name: cleaned, icon: shown };
    } else {
      body = {};
      if (edited) body.name = cleaned;
      if (shown !== original.icon) body.icon = shown;
      if (Object.keys(body).length === 0) return onCancel(); // nothing to save: no request, no audit row
    }
    setSubmitting(true);
    try {
      await onSubmit(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></label>
      <IconPicker
        value={shown}
        onChange={(next) => { if (next !== null) { setIcon(next); setPicked(true); } }}
        previewIcon={assetIcon({ kind: cleaned, kind_icon: shown })}
        caption={label ?? `Unknown icon "${shown}"`}
        hint={!picked && cleaned !== "" ? "Suggested from the name" : undefined}
      />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
        <SaveButton state={submitting ? "pending" : "idle"} className="primary" />
      </div>
    </form>
  );
}
