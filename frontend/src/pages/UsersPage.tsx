import { useEffect, useRef, useState, type Ref } from "react";
import { ApiError } from "../api/client";
import { useCreateUser, useDeleteUser, usePatchUser, useUnblockUser, useUsers } from "../api/queries";
import type { UserRow } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { RowActions, type RowAction } from "../components/RowActions";
import { TableSkeleton } from "../components/Skeleton";
import { TrashButton } from "../components/TrashButton";

/** The built-in roles. TEMPORARY: W9b lists the roles the server knows (GET /api/roles); until then a role an administrator made is not offered here. */
const ROLES: string[] = ["viewer", "operator", "admin"];
/** The options of a row's role select: the offered roles, and the account's own role when it is not one of them (else the select would show the first option as if it were the account's). */
const optionsFor = (role: string) => (ROLES.includes(role) ? ROLES : [...ROLES, role]);

/** ApiError.message already carries the API's `detail` (string or formatted validation list). */
function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "request failed";
}

/** `canEdit` (users.edit): the role select and the actions column; without it the row is read-only. */
function UserRowView({ user, self, canEdit, onDeleted }: { user: UserRow; self: boolean; canEdit: boolean; onDeleted: () => void }) {
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
      <td>
        {canEdit ? (
          <select
            aria-label={`Role for ${user.username}`}
            value={user.role}
            disabled={self || patch.isPending}
            onChange={(e) => patch.mutate({ id: user.id, body: { role: e.target.value } })}
          >
            {optionsFor(user.role).map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        ) : user.role}
      </td>
      <td>
        <span className="chips">
          <span className={user.active ? "chip chip-ok" : "chip chip-off"}>{user.active ? "active" : "inactive"}</span>
          {user.blocked && <span className="chip chip-bad">blocked</span>}
        </span>
      </td>
      {canEdit && (
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
  const create = useCreateUser();
  const [form, setForm] = useState({ username: "", password: "", role: "viewer" });
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
            {users.data.map((u) => <UserRowView key={u.id} user={u} self={u.id === me?.id} canEdit={canEdit} onDeleted={() => setDeletions((n) => n + 1)} />)}
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
              create.mutate(form, { onSuccess: () => setForm({ username: "", password: "", role: "viewer" }) });
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
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
            <button type="submit" className="primary" disabled={create.isPending}>Create user</button>
            {create.isError && <p className="error" role="alert">{errorText(create.error)}</p>}
          </form>
        </div>
      )}
    </section>
  );
}
