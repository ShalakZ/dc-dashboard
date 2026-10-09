import { useMemo, useState, type FormEvent } from "react";
import {
  useAssets, useBillingSettings, useCreateTariff, useDeleteTariff, usePutBillingSettings, useTariffs, useUpdateTariff,
} from "../api/queries";
import type { Asset, Tariff, TariffPatch } from "../api/types";
import { assetLabels } from "../components/dashboard/AssetPicker";
import { fmtRate } from "../lib/billing";

/** ApiError.message already carries the API's `detail` (a string for 404/409, a joined list for 422); drop pydantic's prefix. */
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : "request failed").replace(/Value error, /g, "");
}

const validRate = (text: string) => text.trim() !== "" && Number.isFinite(Number(text)) && Number(text) >= 0;

function CurrencyForm() {
  const settings = useBillingSettings();
  const put = usePutBillingSettings();
  const [typed, setTyped] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (settings.isPending) return <p className="muted">loading…</p>;
  if (settings.isError) return <p className="error" role="alert">{errorText(settings.error)}</p>;
  const stored = settings.data.currency;
  const shown = typed ?? stored ?? "";
  const save = (e: FormEvent) => {
    e.preventDefault();
    const code = shown.trim().toUpperCase();
    if (code !== "" && !/^[A-Z]{3}$/.test(code)) return setProblem("Use a three-letter currency code, for example QAR.");
    setProblem(null);
    const next = code === "" ? null : code;
    // Past figures are recalculated, never converted: a new code only changes the label on every one of them.
    if (stored !== null && next !== stored) {
      const change = next === null ? `Remove the currency ${stored}? Costs will show without a unit.` : `Change the currency from ${stored} to ${next}?`;
      if (!window.confirm(`${change} This relabels all past figures; no conversion is applied.`)) return;
    }
    put.mutate({ currency: next });
  };
  return (
    <>
      {stored === null && (
        <p role="status">No currency is set, so costs show without a unit. Enter a three-letter code such as QAR.</p>
      )}
      <form aria-label="Site currency" noValidate onSubmit={save}>
        <label>
          Currency
          <input
            value={shown}
            maxLength={3}
            onChange={(e) => {
              setTyped(e.target.value.toUpperCase());
              put.reset();
            }}
          />
        </label>
        <button type="submit" disabled={put.isPending}>Save</button>
        {put.isSuccess && <span className="muted"> saved</span>}
        {problem && <p className="error" role="alert">{problem}</p>}
        {put.isError && <p className="error" role="alert">{errorText(put.error)}</p>}
      </form>
    </>
  );
}

/** `assets === null` adds a site default rate; otherwise an override for an asset picked from the list. */
function AddTariff({ assets, labels, assetsError = null }: {
  assets: Asset[] | null; labels: ReadonlyMap<number, string>; assetsError?: string | null;
}) {
  const create = useCreateTariff();
  const [assetId, setAssetId] = useState("");
  const [from, setFrom] = useState("");
  const [rate, setRate] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (assets !== null && assetId === "") return setProblem("Choose an asset.");
    if (from === "") return setProblem("Choose the date the rate takes effect.");
    if (!validRate(rate)) return setProblem("Enter a rate of zero or more.");
    setProblem(null);
    create.mutate(
      { asset_id: assets === null ? null : Number(assetId), rate_per_kwh: Number(rate), effective_from: from },
      { onSuccess: () => { setRate(""); setFrom(""); } },
    );
  };
  return (
    <form aria-label={assets === null ? "Add site default rate" : "Add asset override"} noValidate onSubmit={submit}>
      {assets !== null && (
        <label>
          Asset
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">Choose an asset…</option>
            {assets.map((a) => <option key={a.id} value={a.id}>{labels.get(a.id) ?? a.name}</option>)}
          </select>
        </label>
      )}
      <label>
        Effective from
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
      </label>
      <label>
        Rate per kWh
        <input type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
      </label>
      <button type="submit" disabled={create.isPending}>Add rate</button>
      {assetsError !== null && <p className="error" role="alert">Could not load the assets: {assetsError}</p>}
      {problem && <p className="error" role="alert">{problem}</p>}
      {create.isError && <p className="error" role="alert">{errorText(create.error)}</p>}
    </form>
  );
}

/** `where` names the asset of an override (its path when the name alone is ambiguous); the API's `asset_path`, then `asset_name`, is the fallback. */
function TariffRow({ tariff, where }: { tariff: Tariff; where: string | null }) {
  const update = useUpdateTariff();
  const remove = useDeleteTariff();
  const [editing, setEditing] = useState(false);
  const [rate, setRate] = useState(String(tariff.rate_per_kwh));
  const [from, setFrom] = useState(tariff.effective_from);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = update.isPending || remove.isPending;
  const failure = problem ?? (update.isError ? errorText(update.error) : remove.isError ? errorText(remove.error) : null);

  const startEdit = () => {
    setRate(String(tariff.rate_per_kwh));
    setFrom(tariff.effective_from);
    setProblem(null);
    update.reset();
    setEditing(true);
  };
  const save = () => {
    if (!validRate(rate)) return setProblem("Enter a rate of zero or more.");
    const body: TariffPatch = {};
    if (Number(rate) !== tariff.rate_per_kwh) body.rate_per_kwh = Number(rate);
    if (from !== "" && from !== tariff.effective_from) body.effective_from = from;
    if (Object.keys(body).length === 0) return setEditing(false);
    setProblem(null);
    update.mutate({ id: tariff.id, body }, { onSuccess: () => setEditing(false) });
  };
  const del = () => {
    const forAsset = where ? ` for ${where}` : "";
    const question = `Delete the rate of ${fmtRate(tariff.rate_per_kwh)} from ${tariff.effective_from}${forAsset}? Costs for those days will change.`;
    if (window.confirm(question)) remove.mutate(tariff.id);
  };

  return (
    <tr>
      {tariff.asset_id !== null && <td>{where}</td>}
      <td>
        {editing ? <input type="date" aria-label="Effective from" value={from} onChange={(e) => setFrom(e.target.value)} /> : tariff.effective_from}
      </td>
      <td className="num">
        {editing ? (
          <input type="number" min="0" step="0.01" aria-label="Rate per kWh" value={rate} onChange={(e) => setRate(e.target.value)} />
        ) : fmtRate(tariff.rate_per_kwh)}
      </td>
      <td>
        {editing ? (
          <>
            <button type="button" onClick={save} disabled={busy}>Save</button>{" "}
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </>
        ) : (
          <>
            <button type="button" onClick={startEdit} disabled={busy}>Edit</button>{" "}
            <button type="button" onClick={del} disabled={busy}>Delete</button>
          </>
        )}
        {failure && <span className="error" role="alert"> {failure}</span>}
      </td>
    </tr>
  );
}

function TariffTables({ tariffs, assets, assetsError, currencyUnset }: {
  tariffs: Tariff[]; assets: Asset[]; assetsError: string | null; currencyUnset: boolean;
}) {
  const labels = useMemo(() => assetLabels(assets), [assets]);
  const defaults = tariffs.filter((t) => t.asset_id === null);
  const perAsset = tariffs.filter((t) => t.asset_id !== null);
  return (
    <>
      <p className="muted">
        A rate applies from its effective date (a site-local date) until the next one. An asset's override replaces the
        site default from its own effective date. Editing a past rate recalculates history.
      </p>
      {currencyUnset && (
        <p role="status">Set the currency first: rates are in the site currency, and it is not set yet.</p>
      )}
      <h2>Site default rate</h2>
      {defaults.length === 0 ? (
        <p className="muted">No site default rate yet. Until one is set, assets without their own rate show a dash for cost.</p>
      ) : (
        <table aria-label="Site default rates">
          <thead><tr><th>Effective from</th><th>Rate per kWh</th><th>Actions</th></tr></thead>
          <tbody>{defaults.map((t) => <TariffRow key={t.id} tariff={t} where={null} />)}</tbody>
        </table>
      )}
      <AddTariff assets={null} labels={labels} />
      <h2>Asset overrides</h2>
      {perAsset.length === 0 ? (
        <p className="muted">No overrides. Every asset uses the site default rate.</p>
      ) : (
        <table aria-label="Asset overrides">
          <thead><tr><th>Asset</th><th>Effective from</th><th>Rate per kWh</th><th>Actions</th></tr></thead>
          <tbody>{perAsset.map((t) => (
            <TariffRow key={t.id} tariff={t} where={(t.asset_id !== null ? labels.get(t.asset_id) : undefined) ?? t.asset_path ?? t.asset_name} />
          ))}</tbody>
        </table>
      )}
      <AddTariff assets={assets} labels={labels} assetsError={assetsError} />
    </>
  );
}

/** Admin only (the route is wrapped in RequireRole): the site currency, the site default rates and per-asset overrides. */
export function TariffsPage() {
  const tariffs = useTariffs();
  const assets = useAssets();
  const settings = useBillingSettings();
  return (
    <section>
      <h1>Tariffs</h1>
      <h2>Currency</h2>
      <CurrencyForm />
      {tariffs.isPending && <p className="muted">loading…</p>}
      {tariffs.isError && <p className="error" role="alert">{errorText(tariffs.error)}</p>}
      {tariffs.data && (
        <TariffTables
          tariffs={tariffs.data}
          assets={assets.data ?? []}
          assetsError={assets.isError ? errorText(assets.error) : null}
          currencyUnset={settings.data?.currency === null}
        />
      )}
    </section>
  );
}
