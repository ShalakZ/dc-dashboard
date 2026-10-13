import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useCreateRole, usePatchRole } from "../api/queries";
import type { PermissionRow, RoleRow } from "../api/types";
import { PERMISSION_LABELS, isPermissionId } from "../lib/permissions";
import { groupPermissions, LOCKED_PERMISSION, needSentence, offerFor, offerWords, permissionGaps, roleDisplayName, summarizeRole, type DependencyOffer, type OfferWords } from "../lib/roleEditor";
import { sentence } from "../lib/sentence";
import { DependencyPrompt } from "./DependencyPrompt";
import { InfoTip } from "./InfoTip";
import { Modal, useModalBusy } from "./Modal";
import { roleLabel } from "./navItems";
import { useToast } from "./Toasts";

/** `justCopied`: the role was made by Duplicate a moment ago, so Cancel does not undo it (the copy already exists). */
export type EditorMode = { kind: "new" } | { kind: "edit"; role: RoleRow; justCopied?: boolean };

interface Props {
  mode: EditorMode;
  /** All roles, for "Start from" (the built-in ones' permissions). */
  roles: RoleRow[];
  /** GET /api/permissions: the catalogue as the server words it. */
  permissions: PermissionRow[];
  onClose: () => void;
  onSaved?: (role: RoleRow) => void;
  /** Make a copy of a built-in role (the Roles list does the request and swaps this editor for the copy's). A rejection is shown here. */
  onDuplicate?: (role: RoleRow) => Promise<unknown>;
}

/** The built-in roles "Start from" offers, in this order. Admin is not one of them: it holds permissions a custom role never can. */
const START_FROM = ["viewer", "operator"];

const messageOf = (error: unknown) => sentence(error instanceof Error ? error.message : "request failed");

/** The open offer, as the one `Item` it is about receives it. `serial` only keys the card: see `toggle`. */
interface Prompt { words: OfferWords; serial: number; onAccept: () => void; onDecline: () => void }

/**
 * One permission: a checkbox with its label and, NEXT to the label (never inside it, or the tip's button would be part of the checkbox's
 * name), a tip carrying the server's description. The offer card, when this is the box it is about, sits between the two: right after the
 * label, so Tab goes from the box into the card.
 */
function Item({ entry, ticked, locked, onToggle, prompt }: { entry: PermissionRow; ticked: boolean; locked: boolean; onToggle: (id: string) => void; prompt?: Prompt }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="role-perm">
      <label className="check">
        <input ref={input} type="checkbox" checked={ticked} disabled={locked} onChange={() => onToggle(entry.id)} />
        {entry.label}
      </label>
      {prompt && (
        <DependencyPrompt
          key={prompt.serial}
          anchor={input}
          sentence={prompt.words.sentence}
          items={prompt.words.items}
          acceptLabel={prompt.words.accept}
          declineLabel={prompt.words.decline}
          onAccept={prompt.onAccept}
          onDecline={prompt.onDecline}
        />
      )}
      {entry.description ? <InfoTip>{entry.description}</InfoTip> : null}
    </div>
  );
}

/**
 * Makes, edits or shows (a built-in role) one role: a name, a description, the permission grid by area (See and Change), the sensitive
 * actions, and a plain summary of what the ticks add up to. Dependencies between permissions are hints and offers, never automatic ticks:
 * clicking a box may open a card that offers to tick what it needs (or to untick what needs it), but the server accepts any combination,
 * a role may be deliberately odd, and declining loses nothing. The parent gives it a `key` per role, so nothing typed leaks to another role.
 */
export function RoleEditor({ mode, roles, permissions, onClose, onSaved, onDuplicate }: Props) {
  const title = mode.kind === "new" ? "New role" : mode.role.builtin ? `Role ${roleDisplayName(mode.role)}` : `Edit role ${mode.role.name}`;
  return (
    <Modal title={title} onClose={onClose}>
      <EditorForm mode={mode} roles={roles} permissions={permissions} onClose={onClose} onSaved={onSaved} onDuplicate={onDuplicate} />
    </Modal>
  );
}

function EditorForm({ mode, roles, permissions, onClose, onSaved, onDuplicate }: Props) {
  const role = mode.kind === "edit" ? mode.role : null;
  const builtin = role?.builtin === true;
  const create = useCreateRole();
  const patch = usePatchRole();
  const toast = useToast();
  const [name, setName] = useState(role ? roleDisplayName(role) : "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(role?.permissions ?? []));
  const [startFrom, setStartFrom] = useState("");
  // The one open offer, always the answer to a click or key on a checkbox: never the initial state, a loaded role, Start from or the server's data.
  const [offer, setOffer] = useState<DependencyOffer | null>(null);
  const [serial, setSerial] = useState(0); // bumped by every toggle, so a new offer is a new card even on the same box (it re-focuses and re-measures)
  const [duplicating, setDuplicating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false); // a double click can submit twice before the screen shows the disabled button
  const noteId = useId();
  const busy = create.isPending || patch.isPending || duplicating;
  useModalBusy(busy); // Escape must not close the dialog on a save that is still running

  const { areas, sensitive } = useMemo(() => groupPermissions(permissions), [permissions]);
  const lockedRow = permissions.find((entry) => entry.id === LOCKED_PERMISSION);
  const summary = useMemo(() => summarizeRole(permissions, ticked), [permissions, ticked]);
  const gaps = useMemo(() => permissionGaps(ticked), [ticked]);
  const labelOf = (id: string) => permissions.find((entry) => entry.id === id)?.label ?? (isPermissionId(id) ? PERMISSION_LABELS[id] : id);
  const startRoles = START_FROM.flatMap((wanted) => roles.filter((each) => each.builtin && each.name === wanted));
  const cleanName = name.trim();

  // Clicks are discrete events and React re-renders between them, so the render's `ticked` is exactly the set before this click.
  const toggle = (id: string) => {
    const next = new Set(ticked);
    if (!next.delete(id)) next.add(id);
    setTicked(next);
    setOffer(offerFor(id, ticked)); // a new tick or untick replaces an open offer; unticking the box that has a tick offer closes it
    setSerial((n) => n + 1);
  };
  const accept = () => {
    if (!offer) return;
    setTicked((prev) => {
      const next = new Set(prev);
      for (const id of offer.others) {
        if (offer.kind === "tick") next.add(id);
        else next.delete(id);
      }
      return next;
    });
    setOffer(null);
  };
  const decline = () => setOffer(null);
  const chooseStart = (value: string) => {
    setStartFrom(value);
    setOffer(null);
    const source = startRoles.find((each) => each.name === value);
    setTicked(new Set((source?.permissions ?? []).filter((id) => id !== LOCKED_PERMISSION))); // replaces what is ticked
  };

  /** The ticked ids in the server's order; an id the list does not carry (it should not happen) is kept rather than dropped by a save. */
  function tickedIds(): string[] {
    const listed = new Set(permissions.map((entry) => entry.id));
    return [...permissions.map((entry) => entry.id).filter((id) => ticked.has(id)), ...[...ticked].filter((id) => !listed.has(id))];
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || builtin || cleanName === "") return;
    const ids = tickedIds();
    const cleanDescription = description.trim();
    inFlight.current = true;
    setError(null);
    try {
      let saved: RoleRow;
      if (role) {
        const before = new Set(role.permissions ?? []);
        const body: Partial<{ name: string; description: string; permissions: string[] }> = {};
        if (cleanName !== role.name) body.name = cleanName;
        if (cleanDescription !== role.description) body.description = cleanDescription;
        if (ids.length !== before.size || ids.some((id) => !before.has(id))) body.permissions = ids;
        if (Object.keys(body).length === 0) return onClose(); // nothing to save: the server would only write an audit row about no change
        saved = await patch.mutateAsync({ id: role.id, body });
      } else {
        saved = await create.mutateAsync({ name: cleanName, description: cleanDescription, permissions: ids });
        toast.success("Role created"); // an edit closes its dialog and needs no word; a new role would otherwise vanish into the list
      }
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(messageOf(e)); // the dialog stays open with everything that was typed
    } finally {
      inFlight.current = false;
    }
  }

  async function duplicate() {
    if (!role || !onDuplicate || inFlight.current) return;
    inFlight.current = true;
    setDuplicating(true);
    setError(null);
    try {
      await onDuplicate(role);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      inFlight.current = false;
      setDuplicating(false);
    }
  }

  const words = offer ? offerWords(offer, labelOf) : null;
  const item = (entry: PermissionRow) => (
    <Item
      key={entry.id}
      entry={entry}
      ticked={ticked.has(entry.id)}
      locked={builtin}
      onToggle={toggle}
      prompt={words && offer?.id === entry.id ? { words, serial, onAccept: accept, onDecline: decline } : undefined}
    />
  );
  const none = (words: string[], empty: string) => (words.length > 0 ? words.join(", ") : empty);
  // The built-in Administrator is the one role that holds Manage roles; its box is shown ticked and locked. Everywhere else it is a line of text.
  const lockedBox = builtin && ticked.has(LOCKED_PERMISSION) ? lockedRow : undefined;

  return (
    <form className="role-editor" onSubmit={(event) => void submit(event)}>
      <div className="role-editor-body">
        {builtin && (
          <div className="role-builtin">
            <p className="muted">Built-in roles cannot be changed. Duplicate it to make your own.</p>
            {onDuplicate ? <button type="button" onClick={() => void duplicate()} disabled={busy}>Duplicate</button> : null}
          </div>
        )}
        {mode.kind === "edit" && mode.justCopied && (
          <p className="muted">This copy already exists. Cancel keeps it; delete it from the list if you do not want it.</p>
        )}
        <div className="role-fields">
          <label>Name<input value={name} maxLength={64} required readOnly={builtin} onChange={(e) => setName(e.target.value)} /></label>
          <label>Description<input value={description} maxLength={200} readOnly={builtin} onChange={(e) => setDescription(e.target.value)} /></label>
        </div>
        {mode.kind === "new" && (
          <div className="role-start">
            <label>
              Start from
              <select value={startFrom} aria-describedby={noteId} onChange={(e) => chooseStart(e.target.value)}>
                <option value="">Nothing</option>
                {startRoles.map((each) => <option key={each.id} value={each.name}>{roleLabel(each.name)}</option>)}
              </select>
            </label>
            <p id={noteId} className="muted">Choosing one replaces the ticks below.</p>
          </div>
        )}
        <div className="table-wrap">
          <table aria-label="Permissions" className="role-grid">
            <thead>
              <tr><th scope="col">Area</th><th scope="col">See</th><th scope="col">Change</th></tr>
            </thead>
            <tbody>
              {areas.map((area) => (
                <tr key={area.area}>
                  <th scope="row">{area.area}</th>
                  <td>{area.see.map(item)}</td>
                  <td>{area.change.map(item)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <fieldset className="role-sensitive">
          <legend>Sensitive actions</legend>
          {sensitive.map(item)}
          {lockedBox ? item(lockedBox) : <p className="muted">Managing roles is held by the Administrator role only.</p>}
        </fieldset>
        <section className="role-summary" aria-label="What this role can do">
          <p>{`Opens: ${none(summary.pages, "no pages")}.`}</p>
          <p>{`Can change: ${none(summary.changes, "nothing")}.`}</p>
          <p>{`Sensitive: ${none(summary.sensitive, "nothing")}.`}</p>
          {gaps.length > 0 && (
            <ul className="role-gaps muted">
              {gaps.map((gap) => (
                <li key={gap.id}>{needSentence(gap.id, gap.missing, labelOf)}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        {builtin ? (
          <button type="button" onClick={onClose} disabled={busy}>Close</button>
        ) : (
          <>
            <button type="button" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="primary" disabled={busy || cleanName === ""}>Save</button>
          </>
        )}
      </div>
    </form>
  );
}
