import { useEffect, useRef, useState, type Ref } from "react";
import { ApiError } from "../api/client";
import { useCreateUser, useDeleteUser, usePatchUser, useRoles, useUnblockUser, useUsers } from "../api/queries";
import type { RoleRow, UserRow } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { RowActions, type RowAction } from "../components/RowActions";
import { TableSkeleton } from "../components/Skeleton";
import { TrashButton } from "../components/TrashButton";

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

/** ApiError.message already carries the API's `detail` (string or formatted validation list). */
function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "request failed";
}

/** `canEdit` (users.edit): the role select and the actions column; without it the row is read-only. `open`: this person may manage the account (its role is one they may hand out); a closed row is read-only too, and says why. `offered`: the roles for the select. */
function UserRowView({ user, self, canEdit, offered, open, onDeleted }: { user: UserRow; self: boolean; canEdit: boolean; offered: string[]; open: boolean; onDeleted: () => void }) {
  const patch = usePatchUser();
  const remove = useDeleteUser();
  const unblock = useUnblockUser();
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
      <td title={canEdit && !open ? "This account has a role with more access than yours, so you cannot change it." : undefined}>
        {canEdit && open ? (
          <select
            aria-label={`Role for ${user.username}`}
            value={user.role}
            disabled={self || patch.isPending}
            onChange={(e) => patch.mutate({ id: user.id, body: { role: e.target.value } })}
          >
            {offered.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
            {!offered.includes(user.role) && <option value={user.role} disabled>{user.role}</option>}
          </select>
        ) : user.role}
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
                    { onSuccess: () => { setNewPassword(""); closeReset(); } },
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
                await remove.mutateAsync(user.id);
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

/** PageHeader's markup, written out because the h1 must take focus after a delete (PageHeader forwards no ref). The skeleton shows it too: nothing in it waits for data. */
function UsersHead({ heading }: { heading?: Ref<HTMLHeadingElement> }) {
  return (
    <header className="page-head">
      <h1 ref={heading} tabIndex={-1}>Users</h1>
      <p className="sub">Who can sign in, and what each account may do.</p>
    </header>
  );
}

export function UsersPage() {
  const { user: me, can } = useAuth();
  const canEdit = can("users.edit");
  const users = useUsers();
  const roles = useRoles(canEdit); // only the people who can change an account need to know which roles they may hand out
  const offered = offeredRoles(roles.data);
  const create = useCreateUser();
  const [form, setForm] = useState({ username: "", password: "", role: "viewer" });
  // The form starts on viewer; a person who may not hand that out starts on the first role they may.
  const chosen = offered.includes(form.role) ? form.role : (offered[0] ?? "");
  // The deleted row and its Delete button are gone, so the dialog has nowhere to give focus back to: keep the keyboard user on the page.
  const heading = useRef<HTMLHeadingElement>(null);
  const [deletions, setDeletions] = useState(0);
  useEffect(() => { if (deletions > 0) heading.current?.focus(); }, [deletions]);
  if (users.isPending) {
    return (
      <section className="admin-page users-page">
        <UsersHead heading={heading} />
        <TableSkeleton columns={canEdit ? 4 : 3} rows={3} label="Loading users" />
      </section>
    );
  }
  if (users.isError) return <p className="error" role="alert">{errorText(users.error)}</p>;
  return (
    <section className="admin-page users-page">
      <UsersHead heading={heading} />
      <div className="table-wrap">
        <table className="users-table">
          <thead>
            <tr><th>Username</th><th>Role</th><th>Status</th>{canEdit && <th></th>}</tr>
          </thead>
          <tbody>
            {users.data.map((u) => <UserRowView key={u.id} user={u} self={u.id === me?.id} canEdit={canEdit} offered={offered} open={manageable(roles.data, u.role)} onDeleted={() => setDeletions((n) => n + 1)} />)}
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
              create.mutate({ ...form, role: chosen }, { onSuccess: () => setForm({ username: "", password: "", role: "viewer" }) });
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
              <select value={chosen} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {offered.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="primary" disabled={create.isPending || offered.length === 0}>Create user</button>
            {create.isError && <p className="error" role="alert">{errorText(create.error)}</p>}
          </form>
        </div>
      )}
    </section>
  );
}
