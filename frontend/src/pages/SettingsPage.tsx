import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { useGeneralSettings, usePutGeneralSettings } from "../api/queries";

/** ApiError.message already carries the API's `detail`; drop pydantic's "Value error, " prefix. */
function detailText(error: unknown): string {
  if (error instanceof ApiError) return error.message.replace(/^Value error, /, "");
  return error instanceof Error ? error.message : "request failed";
}

const ZONES: string[] = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

export function SettingsPage() {
  const settings = useGeneralSettings();
  const put = usePutGeneralSettings();
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
        <p className="muted">Used for "today" in energy totals. Readings are stored in UTC.</p>
        <button type="submit" disabled={put.isPending}>Save</button>
        {put.isSuccess && <span className="muted"> saved</span>}
        {put.isError && <p className="error" role="alert">{detailText(put.error)}</p>}
      </form>
    </section>
  );
}
