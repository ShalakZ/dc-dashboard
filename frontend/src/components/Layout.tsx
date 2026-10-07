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
        {hasRole("operator") && <NavLink to="/sources">Sources</NavLink>}
        <span className="spacer" />
        <span className="muted">{user?.username} ({user?.role})</span>
        <button onClick={() => logout().then(() => navigate("/login"))}>Sign out</button>
      </nav>
      <main>
        <Outlet />
      </main>
    </>
  );
}
