import { useState } from "react";
import { ApiError } from "../api/client";
import { useChangePassword } from "../api/queries";
import { PageHeader } from "../components/PageHeader";

export function PasswordPage() {
  const change = useChangePassword();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const apiError = change.error instanceof ApiError ? change.error.message : change.error ? "request failed" : null;
  return (
    <section className="password-page">
      <PageHeader title="Change password" />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (next !== repeat) {
            setLocalError("passwords do not match");
            return;
          }
          if (next.length < 8) {
            setLocalError("new password must be at least 8 characters");
            return;
          }
          setLocalError(null);
          change.mutate(
            { current_password: current, new_password: next },
            { onSuccess: () => { setCurrent(""); setNext(""); setRepeat(""); } },
          );
        }}
      >
        <label>
          Current password{" "}
          <input type="password" autoComplete="current-password" value={current} required onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label>
          New password{" "}
          <input type="password" autoComplete="new-password" value={next} required onChange={(e) => setNext(e.target.value)} />
        </label>
        <label>
          Repeat new password{" "}
          <input type="password" autoComplete="new-password" value={repeat} required onChange={(e) => setRepeat(e.target.value)} />
        </label>
        <button type="submit" className="primary" disabled={change.isPending}>Change password</button>
        {localError && <p className="error" role="alert">{localError}</p>}
        {apiError && <p className="error" role="alert">{apiError}</p>}
        {change.isSuccess && (
          <p className="form-ok">
            <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
            Password changed. Other sessions were signed out.
          </p>
        )}
      </form>
    </section>
  );
}
