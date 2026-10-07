import { useState } from "react";
import { ApiError } from "../api/client";
import { useCreateUser, usePatchUser, useUsers } from "../api/queries";
import type { Role, UserRow } from "../api/types";
import { useAuth } from "../auth/AuthProvider";

const ROLES: Role[] = ["viewer", "operator", "admin"];

/** ApiError.message already carries the API's `detail` (string or formatted validation list). */
function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : "request failed";
}

function UserRowView({ user, self }: { user: UserRow; self: boolean }) {
  const patch = usePatchUser();
  const [newPassword, setNewPassword] = useState("");
  const [resetting, setResetting] = useState(false);
  return (
    <tr>
      <td>{user.username}</td>
      <td>
        <select
          aria-label={`Role for ${user.username}`}
          value={user.role}
          disabled={self || patch.isPending}
          onChange={(e) => patch.mutate({ id: user.id, body: { role: e.target.value as Role } })}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </td>
      <td>{user.active ? "active" : "inactive"}</td>
      <td>
        <button
          disabled={self || patch.isPending}
          onClick={() => patch.mutate({ id: user.id, body: { active: !user.active } })}
        >
          {user.active ? "Deactivate" : "Activate"}
        </button>{" "}
        {resetting ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              patch.mutate(
                { id: user.id, body: { password: newPassword } },
                { onSuccess: () => { setResetting(false); setNewPassword(""); } },
              );
            }}
          >
            <input
              aria-label={`New password for ${user.username}`}
              type="password"
              minLength={8}
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button type="submit" disabled={patch.isPending}>Save</button>
            <button type="button" onClick={() => setResetting(false)}>Cancel</button>
          </form>
        ) : (
          <button onClick={() => setResetting(true)}>Reset password</button>
        )}
        {patch.isError && <span className="error" role="alert"> {errorText(patch.error)}</span>}
      </td>
    </tr>
  );
}

export function UsersPage() {
  const { user: me } = useAuth();
  const users = useUsers();
  const create = useCreateUser();
  const [form, setForm] = useState({ username: "", password: "", role: "viewer" as Role });
  if (users.isPending) return <p>loading…</p>;
  if (users.isError) return <p className="error" role="alert">{errorText(users.error)}</p>;
  return (
    <section>
      <h1>Users</h1>
      <table>
        <thead>
          <tr><th>Username</th><th>Role</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
          {users.data.map((u) => <UserRowView key={u.id} user={u} self={u.id === me?.id} />)}
        </tbody>
      </table>
      <h2>Create user</h2>
      <form
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
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={create.isPending}>Create user</button>
        {create.isError && <p className="error" role="alert">{errorText(create.error)}</p>}
      </form>
    </section>
  );
}
