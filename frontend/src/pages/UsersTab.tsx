import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../api/client";
import { useCreateUser, useDeleteUser, usePatchUser, useRoles, useUnblockUser, useUsers } from "../api/queries";
import type { RoleRow, UserRow } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { RowActions, type RowAction } from "../components/RowActions";
import { TableSkeleton } from "../components/Skeleton";
import { useToast } from "../components/Toasts";
import { TrashButton } from "../components/TrashButton";
import { roleLabel } from "../components/navItems";
import { sentence } from "../lib/sentence";

/** The built-in roles in the order they are offered. They stand in for the server's list of roles while it is not known (still loading, or its answer failed), which is the page as it was before roles could be made. */
const BUILTIN_ROLES: string[] = ["viewer", "operator", "admin"];

/** The roles this person may give to an account: the built-in ones first, in their order, then the others by name. */
function offeredRoles(roles: RoleRow[] | undefined): string[] {
  if (!roles) return BUILTIN_ROLES;
  const handed = roles.filter((r) => r.assignable).map((r) => r.name);
  return [
    ...BUILTIN_ROLES.filter((name) => handed.includes(name)),
    ...handed.filter((name) => !BUILTIN_ROLES.includes(name)).sort((a, b) => a.localeCompare(b)),
  ];
}

/**
 * Whether this person may change the account behind a row. The server lets you manage an account only when its role grants nothing you
 * lack, which is the list's `assignable` flag, so a row is read-only exactly when its role is not assignable (or not listed). While the list is not known every row is open, as before.
 */
const manageable = (roles: RoleRow[] | undefined, role: string) => !roles || roles.some((r) => r.name === role && r.assignable);

/** ApiError.message already carries the API's `detail` (string or formatted validation list), written in lower case: shown as a sentence. */
function errorText(error: unknown): string {
  if (error instanceof ApiError) return sentence(error.message);
  return sentence(error instanceof Error ? error.message : "request failed");
}

/** What the role is for, in the role's own words, or undefined when it has none (or the roles are not known). */
const descriptionOf = (roles: RoleRow[] | undefined, name: string) => roles?.find((r) => r.name === name)?.description || undefined;

/** `canEdit` (users.edit): the role select and the actions column; without it the row is read-only. `open`: this person may manage the account (its role is one they may hand out); a closed row is read-only too, and says why. `offered`: the roles for the select. `about`: the role's description, the hover text of its cell. */
function UserRowView({ user, self, canEdit, offered, open, about, onDeleted }: { user: UserRow; self: boolean; canEdit: boolean; offered: string[]; open: boolean; about: string | undefined; onDeleted: () => void }) {
  const patch = usePatchUser();
  const remove = useDeleteUser();
  const unblock = useUnblockUser();
  const toast = useToast();
  const [newPassword, setNewPassword] = useState("");
  const [resetting, setResetting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const row = useRef<HTMLTableRowElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (resetting) field.current?.focus(); }, [resetting]);

  // Save and Cancel remove the form their button sits in: the focus goes to the row's menu button, unless the user already moved on.
  const closeReset = () => {
    const at = document.activeElement;
    const kept = !at || at === document.body || form.current?.contains(at);
    setResetting(false);
    if (kept) row.current?.querySelector<HTMLElement>(".row-menu-btn")?.focus();
  };
  const items: RowAction[] = [
    { label: user.active ? "Deactivate" : "Activate", disabled: self || patch.isPending, onSelect: () => patch.mutate({ id: user.id, body: { active: !user.active } }) },
    { label: "Reset password", onSelect: () => setResetting((open) => !open) },
    ...(user.blocked ? [{ label: "Unblock", disabled: unblock.isPending, onSelect: () => unblock.mutate(user.id) }] : []),
  ];
  return (
    <tr ref={row}>
      <td className="cell-user" title={user.username}>{user.username}</td>
      <td title={canEdit && !open ? "This account has a role with more access than yours, so you cannot change it." : about}>
        {canEdit && open ? (
          <select
            aria-label={`Role for ${user.username}`}
            value={user.role}
            disabled={self || patch.isPending}
            onChange={(e) => patch.mutate({ id: user.id, body: { role: e.target.value } })}
          >
            {offered.map((r) => (
              <option key={r} value={r}>{roleLabel(r)}</option>
            ))}
            {!offered.includes(user.role) && <option value={user.role} disabled>{roleLabel(user.role)}</option>}
          </select>
        ) : roleLabel(user.role)}
      </td>
      <td>
        <span className="chips">
          <span className={user.active ? "chip chip-ok" : "chip chip-off"}>{user.active ? "active" : "inactive"}</span>
          {user.blocked && <span className="chip chip-bad">blocked</span>}
        </span>
      </td>
      {canEdit && !open && <td />}
      {canEdit && open && (
        <td>
          <div className="row-actions">
            {resetting && (
              <form
                ref={form}
                className="reset-form"
                onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); closeReset(); } }}
                onSubmit={(e) => {
                  e.preventDefault();
                  patch.mutate(
                    { id: user.id, body: { password: newPassword } },
                    {
                      onSuccess: () => {
                        setNewPassword("");
                        closeReset();
                        // The form closes exactly as Cancel does and nothing else on the row changes: the toast is the only sign it worked.
                        toast.success(`Password reset for ${user.username}`);
                      },
                    },
                  );
                }}
              >
                <input
                  ref={field}
                  aria-label={`New password for ${user.username}`}
                  type="password"
                  minLength={8}
                  required
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <button type="submit" disabled={patch.isPending}>Save</button>
                <button type="button" className="quiet" onClick={closeReset}>Cancel</button>
              </form>
            )}
            <RowActions label={`Actions for ${user.username}`} items={items} />
            <TrashButton label={`Delete ${user.username}`} disabled={self} onClick={() => setDeleting(true)} />
          </div>
          {patch.isError && <span className="error row-error" role="alert"> {errorText(patch.error)}</span>}
          {unblock.isError && <span className="error row-error" role="alert"> {errorText(unblock.error)}</span>}
          {deleting && (
            <ConfirmDeleteDialog
              title={`Delete user ${user.username}?`}
              message={`${user.username} will no longer be able to sign in. This cannot be undone. Their name stays in the audit log. To keep the account but stop it signing in, deactivate it instead.`}
              confirmLabel="Delete user"
              onConfirm={async () => {
                try {
                  await remove.mutateAsync(user.id);
                } catch (e) {
                  throw new Error(errorText(e)); // the dialog shows the message as it is: a sentence, like the row's own errors
                }
                toast.success(`User "${user.username}" deleted`); // right after the request, before the row goes
                setDeleting(false);
                onDeleted();
              }}
              onCancel={() => setDeleting(false)}
            />
          )}
        </td>
      )}
    </tr>
  );
}

/**
 * The Users tab: the accounts and the form that makes one. The page around it (the title, the tabs, the heading that takes the focus) is
 * UsersPage's; `onDeleted` tells it that a row and its Delete button are gone, so it can give the keyboard a place to be.
 */
export function UsersTab({ onDeleted }: { onDeleted: () => void }) {
  const { user: me, can } = useAuth();
  const canEdit = can("users.edit");
  const users = useUsers();
  const roles = useRoles(canEdit); // only the people who can change an account need to know which roles they may hand out
  const offered = offeredRoles(roles.data);
  const create = useCreateUser();
  const toast = useToast();
  const [form, setForm] = useState({ username: "", password: "", role: "viewer" });
  const noteId = useId();
  // The form starts on viewer; a person who may not hand that out starts on the first role they may.
  const chosen = offered.includes(form.role) ? form.role : (offered[0] ?? "");
  const chosenNote = descriptionOf(roles.data, chosen);
  if (users.isPending) return <TableSkeleton columns={canEdit ? 4 : 3} rows={3} label="Loading users" />;
  if (users.isError) return <p className="error" role="alert">{errorText(users.error)}</p>;
  return (
    <>
      <div className="table-wrap">
        <table className="users-table">
          <thead>
            <tr><th>Username</th><th>Role</th><th>Status</th>{canEdit && <th></th>}</tr>
          </thead>
          <tbody>
            {users.data.map((u) => (
              <UserRowView
                key={u.id}
                user={u}
                self={u.id === me?.id}
                canEdit={canEdit}
                offered={offered}
                open={manageable(roles.data, u.role)}
                about={descriptionOf(roles.data, u.role)}
                onDeleted={onDeleted}
              />
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="form-card wide">
          <h2 className="section-title">Create user</h2>
          <form
            className="create-user"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate({ ...form, role: chosen }, {
                onSuccess: () => {
                  setForm({ username: "", password: "", role: "viewer" });
                  toast.success("User created"); // the fields clear, but nothing says the account exists until the list refreshes
                },
              });
            }}
          >
            <label>
              Username{" "}
              <input value={form.username} required maxLength={64} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </label>
            <label>
              Password{" "}
              <input type="password" value={form.password} required minLength={8} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </label>
            <label>
              Role{" "}
              <select value={chosen} aria-describedby={chosenNote ? noteId : undefined} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {offered.map((r) => (
                  <option key={r} value={r}>{roleLabel(r)}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="primary" disabled={create.isPending || offered.length === 0}>Create user</button>
            {/* After the button, on a line of its own under the row (the CSS spans it): inside the label it would become part of the select's name.
                Always drawn, empty for a role without a description (hidden, no id, nothing points at it), so the card keeps its height when the role changes. */}
            <p id={chosenNote ? noteId : undefined} aria-hidden={chosenNote ? undefined : true} className="muted field-help role-note">{chosenNote}</p>
            {create.isError && <p className="error" role="alert">{errorText(create.error)}</p>}
          </form>
        </div>
      )}
    </>
  );
}
