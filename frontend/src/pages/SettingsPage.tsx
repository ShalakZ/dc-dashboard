import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import type { TlsStatus } from "../api/types";
import { useGeneralSettings, usePutGeneralSettings, useTlsStatus } from "../api/queries";
import { daysLeftText } from "../components/CertificateNotice";
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

const ZONES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

export function SettingsPage() {
  const settings = useGeneralSettings();
  const put = usePutGeneralSettings();
  const tls = useTlsStatus();
  const [timezone, setTimezone] = useState("");
  useEffect(() => {
    if (settings.data) setTimezone(settings.data.timezone);
  }, [settings.data]);
  if (settings.isPending) return <p>loading…</p>;
  if (settings.isError) return <p className="error" role="alert">{detailText(settings.error)}</p>;
  return (
    <section>
      <h1>Settings</h1>
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
        <button type="submit" disabled={put.isPending}>Save</button>
        {put.isSuccess && <span className="muted"> saved</span>}
        {put.isError && <p className="error" role="alert">{detailText(put.error)}</p>}
      </form>
      {tls.data?.enabled && <p>Certificate: {certificateText(tls.data, settings.data.timezone)}</p>}
    </section>
  );
}
