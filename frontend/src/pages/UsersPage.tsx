import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { RequirePermission } from "../auth/RequireAuth";
import { PageHeader } from "../components/PageHeader";
import { RolesPanel } from "../components/RolesPanel";
import { Tabs, type TabDef } from "../components/Tabs";
import { NotFoundPage } from "./NotFoundPage";
import { UsersTab } from "./UsersTab";

const USERS_PATH = "/users";
const ROLES_PATH = "/users/roles";

/** The page with its tabs; reached only by a person who may open the Users tab or the Roles tab, and drawn for the tab in the address. */
function UsersAndRoles({ active }: { active: "users" | "roles" }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  // After a delete the row and its Delete button are gone, so the dialog has nowhere to give focus back to: keep the keyboard user on the page.
  const heading = useRef<HTMLHeadingElement>(null);
  const [deletions, setDeletions] = useState(0);
  // preventScroll: focusing an element far from the viewport scrolls the page to it; the owner saw the Asset kinds page jump to the top after each delete.
  useEffect(() => { if (deletions > 0) heading.current?.focus({ preventScroll: true }); }, [deletions]);

  const tabs: TabDef[] = [
    ...(can("users.view") ? [{ id: "users", label: "Users" }] : []),
    ...(can("roles.manage") ? [{ id: "roles", label: "Roles" }] : []),
  ];
  return (
    <section className="admin-page users-page">
      <PageHeader
        title="Users & Roles"
        sub="Who can sign in, and what each role lets them do."
        crumbs={[{ label: "Users & Roles", to: USERS_PATH }, { label: active === "roles" ? "Roles" : "Users" }]}
        headingRef={heading}
      />
      {/* A push, not a replace: the Back button returns to the tab before. */}
      <Tabs label="Users and roles" tabs={tabs} active={active} onSelect={(id) => navigate(id === "roles" ? ROLES_PATH : USERS_PATH)}>
        {active === "roles" ? <RolesPanel /> : <UsersTab onDeleted={() => setDeletions((n) => n + 1)} />}
      </Tabs>
    </section>
  );
}

/**
 * Users & Roles: the accounts on the Users tab (`/users`, users.view) and the roles on the Roles tab (`/users/roles`, roles.manage). The route
 * opens for either permission (PAGE_NEED.users), so each tab checks its own. Any other tab name is an unknown address.
 */
export function UsersPage() {
  const { tab } = useParams();
  const { can } = useAuth();
  if (tab !== undefined && tab !== "roles") return <NotFoundPage />;
  // Someone who may manage roles but not see accounts has no Users tab: the page opens on Roles.
  if (tab === undefined && !can("users.view") && can("roles.manage")) return <Navigate to={ROLES_PATH} replace />;
  return (
    <RequirePermission need={tab === "roles" ? "roles.manage" : "users.view"}>
      <UsersAndRoles active={tab === "roles" ? "roles" : "users"} />
    </RequirePermission>
  );
}
