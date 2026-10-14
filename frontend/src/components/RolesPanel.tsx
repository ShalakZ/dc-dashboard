import { useEffect, useId, useRef, useState } from "react";
import { useDeleteRole, useDuplicateRole, usePermissions, useRoles } from "../api/queries";
import type { RoleRow } from "../api/types";
import { roleDisplayName } from "../lib/roleEditor";
import { sentence } from "../lib/sentence";
import { ConfirmDeleteDialog } from "./ConfirmDeleteDialog";
import { PageCard } from "./PageCard";
import { RoleEditor, type EditorMode } from "./RoleEditor";
import { RowActions } from "./RowActions";
import { TableSkeleton } from "./Skeleton";
import { useToast } from "./Toasts";
import { TrashButton } from "./TrashButton";

const messageOf = (error: unknown) => sentence(error instanceof Error ? error.message : "request failed");

function RoleRowView({ role, canOpen, onOpen, onDuplicate, onDelete }: {
  role: RoleRow; canOpen: boolean; onOpen: (role: RoleRow) => void; onDuplicate: (role: RoleRow) => void; onDelete: (role: RoleRow) => void;
}) {
  const reasonId = useId();
  const display = roleDisplayName(role);
  const reason = `In use by ${role.user_count} account(s). Give them another role first.`;
  const inUse = role.user_count > 0;
  return (
    <tr>
      <td className="role-name" title={display}>{display}{role.builtin ? <span className="role-badge">Built in</span> : null}</td>
      <td>{role.description}</td>
      <td className="num">{role.user_count}</td>
      <td>
        <div className="row-actions">
          <RowActions
            label={`Actions for ${display}`}
            items={[
              { label: role.builtin ? "View" : "Edit", disabled: !canOpen, onSelect: () => onOpen(role) },
              { label: "Duplicate", disabled: !canOpen, onSelect: () => onDuplicate(role) },
            ]}
          />
          {role.builtin ? (
            <span className="icon-btn-spacer" aria-hidden="true" />
          ) : (
            <TrashButton
              label={`Delete ${role.name}`}
              disabled={inUse}
              title={inUse ? reason : undefined}
              describedBy={inUse ? reasonId : undefined}
              onClick={() => onDelete(role)}
            />
          )}
        </div>
        {inUse && !role.builtin ? <span id={reasonId} className="sr-only">{reason}</span> : null}
      </td>
    </tr>
  );
}

/**
 * The Roles tab: every role with its users, and the way to make, view, edit, duplicate and delete one. The editor is a dialog over the
 * list. A Duplicate keeps the copy even if the editor is cancelled (it is a real role by then, deletable from the list).
 */
export function RolesPanel() {
  const roles = useRoles();
  const permissions = usePermissions();
  const duplicate = useDuplicateRole();
  const remove = useDeleteRole();
  const toast = useToast();
  const [editor, setEditor] = useState<EditorMode | null>(null);
  const [deleting, setDeleting] = useState<RoleRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deletions, setDeletions] = useState(0);
  const newButton = useRef<HTMLButtonElement>(null);
  // The deleted row and its bin are gone, so the dialog has nowhere to give the focus back to: it goes to the button above the list.
  // preventScroll: focusing an element far from the viewport scrolls the page to it; the owner saw the Asset kinds page jump to the top after each delete.
  useEffect(() => { if (deletions > 0) newButton.current?.focus({ preventScroll: true }); }, [deletions]);

  const canOpen = permissions.data !== undefined; // the editor draws its grid from the server's catalogue
  const open = (role: RoleRow) => { setNotice(null); setEditor({ kind: "edit", role }); };
  const makeCopy = async (role: RoleRow) => {
    const copy = await duplicate.mutateAsync({ id: role.id });
    setEditor({ kind: "edit", role: copy, justCopied: true });
  };

  return (
    <PageCard
      icon="users"
      title="Roles"
      purpose="A role is a set of permissions. Built-in roles are locked: duplicate one to make your own."
      className="roles-panel"
    >
      <div className="roles-bar">
        <button ref={newButton} type="button" className="primary" disabled={!canOpen} onClick={() => { setNotice(null); setEditor({ kind: "new" }); }}>New role</button>
      </div>
      {notice && <p className="error" role="alert">{notice}</p>}
      {permissions.isError && <p className="error" role="alert">{`The permission list did not load. ${messageOf(permissions.error)}`}</p>}
      {roles.isPending ? (
        <TableSkeleton columns={4} rows={3} label="Loading roles" />
      ) : roles.isError ? (
        <p className="error" role="alert">{messageOf(roles.error)}</p>
      ) : (
        <div className="table-wrap">
          <table aria-label="Roles" className="roles-table">
            <thead>
              <tr><th>Name</th><th>Description</th><th className="num">Users</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {roles.data.map((role) => (
                <RoleRowView
                  key={role.id}
                  role={role}
                  canOpen={canOpen}
                  onOpen={open}
                  onDuplicate={(each) => { setNotice(null); makeCopy(each).catch((e: unknown) => setNotice(messageOf(e))); }}
                  onDelete={setDeleting}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editor && permissions.data && (
        <RoleEditor
          key={editor.kind === "edit" ? `edit-${editor.role.id}` : "new"}
          mode={editor}
          roles={roles.data ?? []}
          permissions={permissions.data}
          onClose={() => setEditor(null)}
          onDuplicate={makeCopy}
        />
      )}
      {deleting && (
        <ConfirmDeleteDialog
          title={`Delete role ${roleDisplayName(deleting)}?`}
          message="Accounts can no longer be given this role. This cannot be undone. The change is recorded in the Audit log."
          confirmLabel="Delete role"
          onConfirm={async () => {
            try {
              await remove.mutateAsync(deleting.id);
            } catch (e) {
              throw new Error(messageOf(e)); // shown in the dialog; the list has been refreshed (the role may be in use now)
            }
            toast.success(`Role "${roleDisplayName(deleting)}" deleted`);
            setDeleting(null);
            setDeletions((n) => n + 1);
          }}
          onCancel={() => setDeleting(null)}
        />
      )}
    </PageCard>
  );
}
