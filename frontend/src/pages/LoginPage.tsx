import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { RETURN_KEY, useAuth } from "../auth/AuthProvider";

/** The brand above a Login/Setup card; a `p`, not a heading, so the page keeps its single h1. */
export function AuthBrand() {
  return (
    <p className="auth-brand">
      <span className="auth-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></svg>
      </span>
      DC Dashboard
    </p>
  );
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      const returnTo = sessionStorage.getItem(RETURN_KEY) ?? "/assets";
      sessionStorage.removeItem(RETURN_KEY);
      navigate(returnTo, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <AuthBrand />
        <h1>Sign in</h1>
        <form onSubmit={submit}>
          <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus /></label>
          <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="primary" disabled={busy || !username || !password}>Sign in</button>
        </form>
      </div>
    </main>
  );
}
