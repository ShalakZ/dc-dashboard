import { useEffect, useState, type ChangeEvent } from "react";
import { ApiError } from "../api/client";
import type { TlsStatus } from "../api/types";
import { useGeneralSettings, usePutGeneralSettings, usePutSignInPolicy, useSignInPolicy, useTlsStatus } from "../api/queries";
import { daysLeftText } from "../components/CertificateNotice";
import { PageHeader } from "../components/PageHeader";
import { formatSiteDateTime } from "../lib/siteTime";

/** ApiError.message already carries the API's `detail`; drop pydantic's "Value error, " prefix. */
function detailText(error: unknown): string {
  if (error instanceof ApiError) return error.message.replace(/^Value error, /, "");
  return error instanceof Error ? error.message : "request failed";
}

/** What the read-only Certificate line says, in the site's time zone. */
function certificateText(tls: TlsStatus, timezone: string): string {
  const date = tls.not_after ? formatSiteDateTime(tls.not_after, timezone) : "";
  switch (tls.state) {
    case "expired":
      return `expired on ${date}`;
    case "unreadable":
      return `cannot be read${tls.error ? `: ${tls.error}` : ""}`;
    case "ok":
    case "expiring": {
      const left = tls.days_left === null ? "" : ` (${daysLeftText(tls.days_left)})`;
      return `expires ${date}${left}${tls.subject ? `, ${tls.subject}` : ""}`;
    }
    default:
      return "not checked recently (the collector has not reported on it for over 3 hours)";
  }
}

/** How many wrong passwords block an account from a computer, and for how long. Its own query: a failure here leaves the timezone form working. */
function SignInProtection() {
  const policy = useSignInPolicy();
  const put = usePutSignInPolicy();
  const [failures, setFailures] = useState("");
  const [minutes, setMinutes] = useState("");
  useEffect(() => {
    if (policy.data) {
      setFailures(String(policy.data.max_failures));
      setMinutes(String(policy.data.block_minutes));
    }
  }, [policy.data]);
  const edit = (set: (value: string) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    put.reset();
  };
  return (
    <div className="form-card">
      <h2 id="sign-in-protection" className="section-title">Sign-in protection</h2>
      {policy.isPending && <p className="muted">loading…</p>}
      {policy.isError && <p className="error" role="alert">{detailText(policy.error)}</p>}
      {policy.data && (
        <form
          aria-labelledby="sign-in-protection"
          onSubmit={(e) => {
            e.preventDefault();
            put.mutate({ max_failures: Number(failures), block_minutes: Number(minutes) });
          }}
        >
          <label>
            Failed sign-ins before a block
            <input
              type="number"
              step={1}
              required
              min={policy.data.limits.max_failures[0]}
              max={policy.data.limits.max_failures[1]}
              value={failures}
              onChange={edit(setFailures)}
            />
          </label>
          <label>
            Block time in minutes
            <input
              type="number"
              step={1}
              required
              min={policy.data.limits.block_minutes[0]}
              max={policy.data.limits.block_minutes[1]}
              value={minutes}
              onChange={edit(setMinutes)}
            />
          </label>
          <p className="muted">
            After this many wrong passwords for one account from one computer, that account is blocked from that computer for
            this long. Restarting the api service clears every block; Unblock on the Users page lets one account in sooner.
          </p>
          <div className="row">
            <button type="submit" aria-label="Save sign-in protection" disabled={put.isPending}>Save</button>
            {put.isSuccess && <span className="muted"> saved</span>}
          </div>
          {put.isError && <p className="error" role="alert">{detailText(put.error)}</p>}
        </form>
      )}
    </div>
  );
}

const ZONES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

export function SettingsPage() {
  const settings = useGeneralSettings();
  const put = usePutGeneralSettings();
  const tls = useTlsStatus();
  const [timezone, setTimezone] = useState("");
  useEffect(() => {
    if (settings.data) setTimezone(settings.data.timezone);
  }, [settings.data]);
  if (settings.isPending) return <p className="muted">loading…</p>;
  if (settings.isError) return <p className="error" role="alert">{detailText(settings.error)}</p>;
  return (
    <section className="admin-page settings-page">
      <PageHeader title="Settings" sub="Options that apply to the whole site." />
      <div className="settings-grid">
        <div className="settings-col">
          <div className="form-card">
            <h2 className="section-title">General</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                put.mutate({ timezone });
              }}
            >
              <label>
                Timezone{" "}
                <input
                  list="tz-options"
                  value={timezone}
                  required
                  onChange={(e) => {
                    setTimezone(e.target.value);
                    put.reset();
                  }}
                />
              </label>
              <datalist id="tz-options">
                {ZONES.map((z) => <option key={z} value={z} />)}
              </datalist>
              <p className="muted">
                The site's time zone. It decides where a day and a month start (today, yesterday, this month and last month in
                energy totals, Billing and dashboard ranges) and the times shown in the app. Readings are stored in UTC.
              </p>
              <div className="row">
                <button type="submit" className="primary" disabled={put.isPending}>Save</button>
                {put.isSuccess && <span className="muted"> saved</span>}
              </div>
              {put.isError && <p className="error" role="alert">{detailText(put.error)}</p>}
            </form>
          </div>
          {tls.data?.enabled && (
            <p className="notice">
              <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
              <span>Certificate: {certificateText(tls.data, settings.data.timezone)}</span>
            </p>
          )}
        </div>
        <SignInProtection />
      </div>
    </section>
  );
}
