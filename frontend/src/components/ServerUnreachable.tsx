import { useAuth } from "../auth/AuthProvider";
import { AuthBrand } from "../pages/LoginPage";

/**
 * What a visitor sees instead of the sign-in page when the first sign-in check gets no answer (the server is stopped or restarting).
 * It is not a redirect: the address stays, and the page asked for opens by itself once the check is answered.
 */
export function ServerUnreachable() {
  const { retryNow } = useAuth();
  return (
    <main className="auth">
      <div className="auth-card">
        <AuthBrand />
        <h1>Can't reach the server</h1>
        <p className="auth-lead">The server is not answering. It may be starting or restarting. This page tries again every few seconds.</p>
        <button type="button" className="primary" onClick={retryNow}>Retry now</button>
      </div>
    </main>
  );
}
