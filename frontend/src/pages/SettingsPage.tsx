import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { ApiError } from "../api/client";
import type { TlsStatus } from "../api/types";
import { useGeneralSettings, usePutGeneralSettings, usePutSignInPolicy, useSignInPolicy, useTlsStatus, useVersion } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { daysLeftText } from "../components/CertificateNotice";
import { ConfirmDeleteDialog } from "../components/ConfirmDeleteDialog";
import { PageCard } from "../components/PageCard";
import { PageHeader } from "../components/PageHeader";
import { READ_ONLY_TEXT, ReadOnlyNote } from "../components/ReadOnlyNote";
import { SaveButton } from "../components/SaveButton";
import { CTL_H, FormSkeleton, PageCardSkeleton, ParagraphSkeleton, Skeleton, SkeletonRegion } from "../components/Skeleton";
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

// The two helper paragraphs, as one string each: the loading page draws a pill per word of them, so it breaks into as many lines.
const TIMEZONE_HELP = "The site's time zone. It decides where a day and a month start (today, yesterday, this month and last month in "
  + "energy totals, Billing and dashboard ranges) and the times shown in the app. Readings are stored in UTC.";
const SIGN_IN_HELP = "After this many wrong passwords for one account from one computer, that account is blocked from that computer for "
  + "this long. Restarting the api service clears every block; Unblock on the Users & Roles page lets one account in sooner.";

// The loaded Save button (SaveButton) is this wide in every state (its widest face, the check with "Saved"); the skeleton block matches it.
const SAVE_WIDTH = 92;

// What the Sign-in protection card says to a role that has `settings.view` but not `settings.security` (W9b): the page-wide line would be
// wrong here, because the same role may well be able to change General.
const SIGN_IN_READ_ONLY_TEXT = "Your role can see this but not change it: changing sign-in protection is a separate permission.";

// Inline SVG, 24-unit viewBox, decoration only (the sentence next to it says everything).
const WarnIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
);

/** Whether wrong passwords block anyone, how many and for how long. Its own query: a failure here leaves the timezone form working. */
function SignInProtection() {
  const canEdit = useAuth().can("settings.security");
  const policy = useSignInPolicy();
  const put = usePutSignInPolicy();
  const [enabled, setEnabled] = useState(true);
  const [asking, setAsking] = useState(false);
  const [failures, setFailures] = useState("");
  const [minutes, setMinutes] = useState("");
  useEffect(() => {
    if (policy.data) {
      setFailures(String(policy.data.max_failures));
      setMinutes(String(policy.data.block_minutes));
      setEnabled(policy.data.enabled !== false); // a reply without the field means ON
    }
  }, [policy.data]);
  const values = () => ({ max_failures: Number(failures), block_minutes: Number(minutes) });
  // Cancel and Escape: the switch goes back to ON (the only state from which the dialog opens) and nothing is sent.
  const keepOn = useCallback(() => {
    setAsking(false);
    setEnabled(true);
    put.reset();
  }, [put]);
  const edit = (set: (value: string) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    put.reset();
  };
  return (
    <PageCard icon="password" title="Sign-in protection" headingId="sign-in-protection">
      {policy.isPending && <FormSkeleton rows={2} bare label="Loading sign-in protection" />}
      {policy.isError && <p className="error" role="alert">{detailText(policy.error)}</p>}
      {policy.data && (
        <form
          className="settings-form"
          aria-labelledby="sign-in-protection"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canEdit) return;
            // Only the step from ON to OFF asks first; every other save is sent as it is, without `confirm`.
            if (policy.data.enabled !== false && !enabled) setAsking(true);
            else put.mutate({ ...values(), enabled });
          }}
        >
          <label className="check">
            <input
              type="checkbox"
              role="switch"
              checked={enabled}
              disabled={!canEdit}
              onChange={(e) => {
                setEnabled(e.target.checked);
                put.reset();
              }}
            />
            Block an account after repeated wrong passwords
          </label>
          {!enabled && (
            <div role="status" className="banner banner-warn">
              <WarnIcon />
              <span>
                Sign-in protection is off. Wrong passwords no longer block anyone, so a password can be guessed without limit.
                Switch it on again unless this is a closed, trusted network.
              </span>
            </div>
          )}
          <label>
            Failed sign-ins before a block
            <input
              type="number"
              step={1}
              required
              min={policy.data.limits.max_failures[0]}
              max={policy.data.limits.max_failures[1]}
              disabled={!canEdit}
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
              disabled={!canEdit}
              value={minutes}
              onChange={edit(setMinutes)}
            />
          </label>
          {!enabled && <p className="muted">Used when protection is switched on.</p>}
          <p className="muted">{SIGN_IN_HELP}</p>
          <div className="form-foot">
            {canEdit ? (
              <>
                <div className="row">
                  <SaveButton state={put.status} className="primary" ariaLabel="Save sign-in protection" />
                </div>
                {/* One line is always reserved (the CSS): a refusal appearing here must not grow the card or push the ones below it. */}
                <div className="form-status">{put.isError && !asking && <p className="error" role="alert">{detailText(put.error)}</p>}</div>
              </>
            ) : <p className="muted">{SIGN_IN_READ_ONLY_TEXT}</p>}
          </div>
        </form>
      )}
      {asking && (
        // Outside the form: the dialog's buttons would submit it.
        <ConfirmDeleteDialog
          title="Stop blocking accounts?"
          message="Wrong passwords will no longer block anyone, and accounts that are blocked now can sign in at once. The change is recorded in the Audit log."
          confirmLabel="Switch off"
          onConfirm={async () => {
            await put.mutateAsync({ ...values(), enabled: false, confirm: true });
            setAsking(false);
          }}
          onCancel={keepOn}
        />
      )}
    </PageCard>
  );
}

/**
 * The version line, in the site's time zone. "Version 227bd6a, built 2026-10-12 14:03:11" when the build time is known (also for the id
 * `dev`, which a stack built from a checkout without a commit time can still carry). Without a readable time: "Version dev (this stack was
 * built without a build id)" for `dev`, "Version 227bd6a (build time unknown)" for a real id. Never "built unknown".
 */
export function versionText(build_id: string, build_time: string, timezone: string): string {
  if (!Number.isNaN(Date.parse(build_time))) return `Version ${build_id}, built ${formatSiteDateTime(build_time, timezone)}`;
  return build_id === "dev" ? "Version dev (this stack was built without a build id)" : `Version ${build_id} (build time unknown)`;
}

const ZONES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

export function SettingsPage() {
  const { can } = useAuth();
  const canEdit = can("settings.edit");
  const canEditSignIn = can("settings.security");
  const settings = useGeneralSettings();
  const put = usePutGeneralSettings();
  const tls = useTlsStatus();
  const version = useVersion();
  const [timezone, setTimezone] = useState("");
  useEffect(() => {
    if (settings.data) setTimezone(settings.data.timezone);
  }, [settings.data]);
  if (settings.isPending) {
    // The region IS the grid, so the two card shapes sit where the real cards do. The About card follows the data: it is not drawn here.
    return (
      <section className="admin-page settings-page">
        <PageHeader title="Settings" sub="Options that apply to the whole site." />
        <SkeletonRegion label="Loading settings" className="page-grid">
          <PageCardSkeleton>
            <div className="settings-form">
              <div className="sk-field"><Skeleton width="9ch" /><Skeleton variant="block" height={CTL_H} /></div>
              <ParagraphSkeleton text={TIMEZONE_HELP} className="muted" />
              <div className="form-foot">
                {canEdit ? <><div className="row"><Skeleton variant="block" width={SAVE_WIDTH} height={34} /></div><div className="form-status" /></> : <ParagraphSkeleton text={READ_ONLY_TEXT} className="muted" />}
              </div>
            </div>
          </PageCardSkeleton>
          <PageCardSkeleton>
            <div className="settings-form">
              <div className="sk-switch"><Skeleton variant="circle" width={16} /><Skeleton width="36ch" /></div>
              <div className="sk-field"><Skeleton width="22ch" /><Skeleton variant="block" height={CTL_H} /></div>
              <div className="sk-field"><Skeleton width="18ch" /><Skeleton variant="block" height={CTL_H} /></div>
              <ParagraphSkeleton text={SIGN_IN_HELP} className="muted" />
              <div className="form-foot">
                {canEditSignIn ? <><div className="row"><Skeleton variant="block" width={SAVE_WIDTH} height={34} /></div><div className="form-status" /></> : <ParagraphSkeleton text={SIGN_IN_READ_ONLY_TEXT} className="muted" />}
              </div>
            </div>
          </PageCardSkeleton>
        </SkeletonRegion>
      </section>
    );
  }
  if (settings.isError) return <p className="error" role="alert">{detailText(settings.error)}</p>;
  const zone = settings.data.timezone;
  const certificate = tls.data?.enabled ? certificateText(tls.data, zone) : null;
  return (
    <section className="admin-page settings-page">
      <PageHeader title="Settings" sub="Options that apply to the whole site." />
      <div className="page-grid">
        <PageCard icon="settings" title="General">
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (canEdit) put.mutate({ timezone });
            }}
          >
            <label>
              Timezone{" "}
              <input
                list="tz-options"
                value={timezone}
                disabled={!canEdit}
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
            <p className="muted">{TIMEZONE_HELP}</p>
            <div className="form-foot">
              {canEdit ? (
                <>
                  <div className="row">
                    <SaveButton state={put.status} className="primary" />
                  </div>
                  <div className="form-status">{put.isError && <p className="error" role="alert">{detailText(put.error)}</p>}</div>
                </>
              ) : <ReadOnlyNote />}
            </div>
          </form>
        </PageCard>
        <SignInProtection />
        {/* What this stack is. Drawn only when it has something to say: no version yet and no certificate line is no card. */}
        {(version.data || certificate) && (
          <PageCard icon="diagnostics" title="About" className="span-all">
            {version.data && <p className="about-line">{versionText(version.data.build_id, version.data.build_time, zone)}</p>}
            {certificate && <p className="about-line">Certificate: {certificate}</p>}
          </PageCard>
        )}
      </div>
    </section>
  );
}
