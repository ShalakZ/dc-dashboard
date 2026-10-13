import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { ServerUnreachable } from "../components/ServerUnreachable";
import { upperFirst } from "../lib/upperFirst";
import { AuthBrand } from "./LoginPage";

export function SetupPage() {
  const { setup, setupNeeded, loading, unreachable, user } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  // No answer yet is not "no first user needed": stay here (a first install opened while the server starts), and show the form once it answers.
  if (!loading && unreachable) return <ServerUnreachable />;
  // After a successful setup the user is signed in; go straight to the app rather than /login.
  if (!loading && !setupNeeded) return <Navigate to={user ? "/assets" : "/login"} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) return setError("passwords do not match");
    if (password.length < 8) return setError("password must be at least 8 characters");
    try {
      await setup(username, password);
      navigate("/assets", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <AuthBrand />
        <h1>First-run setup</h1>
        <p className="auth-lead">Create the first administrator account.</p>
        <form onSubmit={submit}>
          <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus /></label>
          <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <label>Confirm password<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
          {error && <p className="error" role="alert">{upperFirst(error)}</p>}
          <button type="submit" className="primary" disabled={!username || !password}>Create admin</button>
        </form>
      </div>
    </main>
  );
}
