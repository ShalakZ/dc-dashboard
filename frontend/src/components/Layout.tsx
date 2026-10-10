import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { CertificateNotice } from "./CertificateNotice";
import { RoleChangedNotice } from "./RoleChangedNotice";

// Billing's day columns and a dashboard on a wall screen use the whole window; every other page keeps the 1200 px column.
const WIDE = /^\/(billing|dashboards\/[^/]+)\/?$/;

export function Layout() {
  const { user, hasRole, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault(); // a hash in the URL would be one more history entry
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
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
      <main id="main" tabIndex={-1} className={WIDE.test(pathname) ? "wide" : undefined}>
        <RoleChangedNotice />
        {hasRole("admin") && <CertificateNotice />}
        <Outlet />
      </main>
    </>
  );
}
