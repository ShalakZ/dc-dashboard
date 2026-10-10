import { useSite, useTlsStatus } from "../api/queries";
import { formatSiteDateTime } from "../lib/siteTime";

/** "29 days left", "1 day left" or "less than a day left" for the whole days the API counts. */
export function daysLeftText(days: number): string {
  if (days <= 0) return "less than a day left";
  return days === 1 ? "1 day left" : `${days} days left`;
}

/**
 * The HTTPS certificate warning in the app shell. Admins only (the status endpoint is admin-only), and only for the states that need
 * action: expiring, expired and unreadable. Nothing for ok, for "not checked lately" (the collector may simply be down, and the
 * Sources page says so) or when HTTPS is not configured. A failed fetch shows nothing: the notice is an extra, not a gate.
 */
export function CertificateNotice() {
  const tls = useTlsStatus();
  const site = useSite();
  const status = tls.data;
  // Hold the notice until the site time zone is known (or has failed), so the date does not flip from UTC to the site clock.
  if (!status?.enabled || site.isPending) return null;
  const on = status.not_after ? ` on ${formatSiteDateTime(status.not_after, site.data?.timezone ?? "UTC")}` : "";
  const left = status.days_left === null ? "" : ` (${daysLeftText(status.days_left)})`;
  switch (status.state) {
    case "expiring":
      return (
        <p role="status" className="warning">
          {`The HTTPS certificate expires${on}${left}. Renew it before then: once it expires, browsers warn everyone who opens the dashboard.`}
        </p>
      );
    case "expired":
      return (
        <p role="status" className="error">
          {`The HTTPS certificate expired${on}. Browsers already warn everyone who opens the dashboard. Replace the certificate and restart the web service.`}
        </p>
      );
    case "unreadable":
      return (
        <p role="status" className="warning">
          {`The HTTPS certificate file cannot be read${status.error ? `: ${status.error}` : ""}. Its expiry is not being watched until that is fixed.`}
        </p>
      );
    default:
      return null;
  }
}
