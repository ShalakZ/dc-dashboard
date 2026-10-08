import { NavLink, Outlet, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";

export function Layout() {
  const { user, hasRole, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <nav>
        <strong>DC Dashboard</strong>
        <NavLink to="/assets">Assets</NavLink>
        <NavLink to="/dashboards">Dashboards</NavLink>
        <NavLink to="/billing">Billing</NavLink>
        {hasRole("operator") && <NavLink to="/sources">Sources</NavLink>}
        {hasRole("operator") && <NavLink to="/scans">Scans</NavLink>}
        {hasRole("operator") && <NavLink to="/discovery">Discovery</NavLink>}
        {hasRole("admin") && <NavLink to="/users">Users</NavLink>}
        {hasRole("admin") && <NavLink to="/settings">Settings</NavLink>}
        {hasRole("admin") && <NavLink to="/tariffs">Tariffs</NavLink>}
        {hasRole("admin") && <NavLink to="/storage">Storage</NavLink>}
        {hasRole("admin") && <NavLink to="/audit">Audit</NavLink>}
        <span className="spacer" />
        <span className="muted">{user?.username} ({user?.role})</span>
        <NavLink to="/password">Password</NavLink>
        <button onClick={() => logout().then(() => navigate("/login"))}>Sign out</button>
      </nav>
      <main>
        <Outlet />
      </main>
    </>
  );
}
