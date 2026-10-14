import { useMemo, useState, type FormEvent } from "react";
import type { Asset, AssetIn, AssetKind } from "../api/types";
import { assetIcon, assetIconLabel, iconLabelFor } from "../lib/assetIcons";
import { DEFAULT_KIND, cleanKind, kindChoices, kindKey, registersKind, resolveKind } from "../lib/kinds";
import { assetOptions } from "./dashboard/AssetPicker";
import { IconPicker } from "./IconPicker";
import { useModalBusy } from "./Modal";

/** The server's limit on a kind name (core/asset_kinds.py MAX_NAME), counted in code points. */
const MAX_KIND = 60;

/**
 * `kinds` is the registry (empty when it failed to load: the Kind select then offers the default and the asset's own kind). `onSubmit`
 * gets the body and whether this save adds the kind to the registry (the page does that once the asset is saved): the same answer the
 * note under the icon gave beforehand.
 */
export function AssetForm({ assets, kinds, initial, excludeIds, onSubmit, onCancel }: {
  assets: Asset[]; kinds: AssetKind[]; initial?: Partial<AssetIn>; excludeIds: Set<number>;
  onSubmit: (body: AssetIn, registerKind: boolean) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [parent, setParent] = useState(initial?.parent_id == null ? "" : String(initial.parent_id));
  const options = useMemo(() => kindChoices(kinds, initial?.kind), [kinds, initial?.kind]);
  const [startKind] = useState<string | null>(initial?.kind?.trim() ? initial.kind : null); // at mount, like startIcon: what "the kind changed" is measured against
  // The stored text, untouched; a blank or missing kind starts on the default (in the registry's spelling, if it has one).
  const [kind, setKind] = useState(initial?.kind?.trim() ? initial.kind : resolveKind(DEFAULT_KIND, options));
  const [other, setOther] = useState(false); // "Other…" picked
  const [typed, setTyped] = useState("");
  const [startIcon] = useState<string | null>(initial?.icon || null); // at mount: a refetch while the dialog is open must not change what counts as edited; a blank stored value counts as Automatic
  const [icon, setIcon] = useState<string | null>(startIcon); // a catalogue id, null for Automatic; a stored id the catalogue lacks stays as it is until the user picks
  const [sortOrder, setSortOrder] = useState(String(initial?.sort_order ?? 0));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useModalBusy(submitting); // Escape must not close the dialog on a save that is still running
  // The kind the asset will have, as the preview must show it (the select keeps its last value while "Other…" is picked).
  const resolvedKind = other ? resolveKind(typed, options) : kind;
  const chosenLabel = icon === null ? null : assetIconLabel(icon);
  // What the KIND gives: its icon in the registry, else (a typed kind nobody registered yet) the keyword guess, which is the icon it will be registered with.
  const registryIcon = kinds.find((k) => kindKey(k.name) === kindKey(resolvedKind))?.icon ?? null;
  const automatic = assetIcon({ kind: resolvedKind, kind_icon: registryIcon });
  const caption = icon === null ? `Automatic (${iconLabelFor(automatic)})` : chosenLabel ?? `Unknown icon "${icon}"`;
  // One answer for the note and for the page's registration: whenever the kind will be registered, whichever icon the asset itself shows.
  const registers = registersKind(resolvedKind, kinds, startKind);
  const hint = registers ? "New kind: added to Asset kinds." : undefined;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    const stored = other ? resolveKind(typed, options) : kind;
    if (stored === "") return setError("type the new kind");
    // Held to the server's limit only when the text is new: a typed name that resolves to a kind already listed may be a long seeded one.
    if (other && !options.some((o) => kindKey(o) === kindKey(typed)) && [...cleanKind(typed.normalize("NFC"))].length > MAX_KIND) {
      return setError(`A kind name is at most ${MAX_KIND} characters`);
    }
    setSubmitting(true);
    try {
      const body: AssetIn = { name, parent_id: parent === "" ? null : Number(parent), kind: stored, sort_order: Number(sortOrder) || 0 };
      if (icon !== startIcon) body.icon = icon; // only a change: a stored id the server later drops must not turn every edit into a 422
      await onSubmit(body, registers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Parent
        <select value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">(none)</option>
          {assetOptions(assets, excludeIds).map((o) => <option key={o.id} value={o.id}>{o.text}</option>)}
        </select>
      </label>
      <label>Kind
        <select value={other ? "" : kind} onChange={(e) => { setOther(e.target.value === ""); if (e.target.value !== "") setKind(e.target.value); }}>
          {options.map((k) => <option key={kindKey(k)} value={k}>{k}</option>)}
          <option value="">Other…</option>
        </select>
      </label>
      {other && <label>New kind<input value={typed} onChange={(e) => setTyped(e.target.value)} /></label>}
      <IconPicker
        value={icon}
        onChange={setIcon}
        previewIcon={assetIcon({ kind: resolvedKind, icon, kind_icon: registryIcon })}
        caption={caption}
        hint={hint}
        automatic={{ icon: automatic, title: `Automatic: follows the kind (${iconLabelFor(automatic)})` }}
      />
      <label>Sort order<input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button type="button" onClick={onCancel} disabled={submitting}>Cancel</button><button type="submit" className="primary" disabled={submitting}>Save</button></div>
    </form>
  );
}
