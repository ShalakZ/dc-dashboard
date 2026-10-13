import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useCreateRole, usePatchRole } from "../api/queries";
import type { PermissionRow, RoleRow } from "../api/types";
import { PERMISSION_LABELS, isPermissionId } from "../lib/permissions";
import { groupPermissions, joinWords, LOCKED_PERMISSION, permissionGaps, roleDisplayName, summarizeRole } from "../lib/roleEditor";
import { sentence } from "../lib/sentence";
import { InfoTip } from "./InfoTip";
import { Modal, useModalBusy } from "./Modal";
import { roleLabel } from "./navItems";

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

/**
 * One permission: a checkbox with its label and, NEXT to the label (never inside it, or the tip's button would be part of the checkbox's
 * name), a tip carrying the server's description.
 */
function Item({ entry, ticked, locked, onToggle }: { entry: PermissionRow; ticked: boolean; locked: boolean; onToggle: (id: string) => void }) {
  return (
    <div className="role-perm">
      <label className="check">
        <input type="checkbox" checked={ticked} disabled={locked} onChange={() => onToggle(entry.id)} />
        {entry.label}
      </label>
      {entry.description ? <InfoTip>{entry.description}</InfoTip> : null}
    </div>
  );
}

/**
 * Makes, edits or shows (a built-in role) one role: a name, a description, the permission grid by area (See and Change), the sensitive
 * actions, and a plain summary of what the ticks add up to. Dependencies between permissions are hints, never automatic ticks: the server
 * accepts any combination, and a role may be deliberately odd. The parent gives it a `key` per role, so nothing typed leaks to another role.
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
  const [name, setName] = useState(role ? roleDisplayName(role) : "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set(role?.permissions ?? []));
  const [startFrom, setStartFrom] = useState("");
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

  const toggle = (id: string) => setTicked((before) => {
    const next = new Set(before);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const chooseStart = (value: string) => {
    setStartFrom(value);
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

  const item = (entry: PermissionRow) => (
    <Item key={entry.id} entry={entry} ticked={ticked.has(entry.id)} locked={builtin} onToggle={toggle} />
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
                <li key={gap.id}>{`${labelOf(gap.id)} also needs ${joinWords(gap.missing.map(labelOf))} to show anything.`}</li>
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
