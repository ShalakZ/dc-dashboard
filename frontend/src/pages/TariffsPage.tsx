import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  useAssets, useBillingSettings, useCreateTariff, useDeleteTariff, usePutBillingSettings, useTariffs, useUpdateTariff,
} from "../api/queries";
import type { Asset, Tariff, TariffPatch } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { assetLabels } from "../components/dashboard/AssetPicker";
import { EmptyNote } from "../components/EmptyNote";
import { InfoTip } from "../components/InfoTip";
import { PageCard } from "../components/PageCard";
import { PageHeader } from "../components/PageHeader";
import { ReadOnlyNote } from "../components/ReadOnlyNote";
import { RowActions } from "../components/RowActions";
import { FormSkeleton, Skeleton, SkeletonRegion, TableSkeleton } from "../components/Skeleton";
import { TrashButton } from "../components/TrashButton";
import { fmtRate } from "../lib/billing";

/** ApiError.message already carries the API's `detail` (a string for 404/409, a joined list for 422); drop pydantic's prefix. */
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : "request failed").replace(/Value error, /g, "");
}

// Inline SVG, 24-unit viewBox, decoration only (the sentence next to it says everything).
const InfoIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.5h.01" /></svg>
);

/** The words stay a direct child of the status element (a test reads the role off the element that owns the text). */
function Note({ children }: { children: string }) {
  return <p role="status" className="banner banner-info"><InfoIcon />{children}</p>;
}

const CURRENCY_PURPOSE = "The unit costs are shown in.";
const SITE_DEFAULT_PURPOSE = "The price per kWh used for every asset that has no override on itself or on an asset above it. A new rate counts from its effective date.";
const OVERRIDES_PURPOSE = "A different price per kWh for one asset and everything under it (unless a lower asset has its own), from its effective date.";

const EFFECTIVE_TIP = "The first day (site time) this rate counts. Readings before that day keep the rate that applied then.";
const RATE_TIP = "The price of one kilowatt-hour in the site currency, for example 0.18.";

const validRate = (text: string) => text.trim() !== "" && Number.isFinite(Number(text)) && Number(text) >= 0;

const NO_CURRENCY_TEXT = "No currency is set, so costs show without a unit.";

/** `canEdit` false (tariffs.view without tariffs.edit): the currency as text, no field, no Save, nothing that could be sent. */
function CurrencyForm({ canEdit }: { canEdit: boolean }) {
  const settings = useBillingSettings();
  const put = usePutBillingSettings();
  const [typed, setTyped] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (settings.isPending) {
    // A read-only person gets a line where the value will be, not the field and the button: the card must not change height when the data lands.
    return canEdit
      ? <FormSkeleton rows={1} inline label="Loading the currency" />
      : <SkeletonRegion label="Loading the currency"><Skeleton width="4ch" /></SkeletonRegion>;
  }
  if (settings.isError) return <p className="error" role="alert">{errorText(settings.error)}</p>;
  const stored = settings.data.currency;
  if (!canEdit) return <div className="currency-row">{stored === null ? <Note>{NO_CURRENCY_TEXT}</Note> : <p className="currency-read">{stored}</p>}</div>;
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
  // The field, Save and (until a currency is set) the one message about it share a row; the message wraps under them in a narrow card.
  return (
    <div className="currency-row">
      <form aria-label="Site currency" className="inline-form" noValidate onSubmit={save}>
        <div className="has-tip currency-field">
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
          <InfoTip>A three-letter code such as QAR.</InfoTip>
        </div>
        <button type="submit" disabled={put.isPending}>Save</button>
        {put.isSuccess && <span className="muted saved"> saved</span>}
        {problem && <p className="error" role="alert">{problem}</p>}
        {put.isError && <p className="error" role="alert">{errorText(put.error)}</p>}
      </form>
      {stored === null && (
        <Note>{`${NO_CURRENCY_TEXT} Enter a three-letter code such as QAR.`}</Note>
      )}
    </div>
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
    <form aria-label={assets === null ? "Add site default rate" : "Add asset override"} className="inline-form add-form" noValidate onSubmit={submit}>
      {assets !== null && (
        <div className="has-tip asset-field">
          <label>
            Asset
            <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
              <option value="">Choose an asset…</option>
              {assets.map((a) => <option key={a.id} value={a.id}>{labels.get(a.id) ?? a.name}</option>)}
            </select>
          </label>
          <InfoTip>This asset and the assets under it are charged this rate.</InfoTip>
        </div>
      )}
      <div className="has-tip">
        <label>
          Effective from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <InfoTip>{EFFECTIVE_TIP}</InfoTip>
      </div>
      <div className="has-tip">
        <label>
          Rate per kWh
          <input type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} />
        </label>
        <InfoTip>{RATE_TIP}</InfoTip>
      </div>
      <button type="submit" disabled={create.isPending}>Add rate</button>
      {assetsError !== null && <p className="error" role="alert">Could not load the assets: {assetsError}</p>}
      {problem && <p className="error" role="alert">{problem}</p>}
      {create.isError && <p className="error" role="alert">{errorText(create.error)}</p>}
    </form>
  );
}

/** `where` names the asset of an override (its path when the name alone is ambiguous); the API's `asset_path`, then `asset_name`, is the fallback. */
function TariffRow({ tariff, where, canEdit }: { tariff: Tariff; where: string | null; canEdit: boolean }) {
  const update = useUpdateTariff();
  const remove = useDeleteTariff();
  const [editing, setEditing] = useState(false);
  const [rate, setRate] = useState(String(tariff.rate_per_kwh));
  const [from, setFrom] = useState(tariff.effective_from);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = update.isPending || remove.isPending;
  const row = useRef<HTMLTableRowElement>(null);
  const fromInput = useRef<HTMLInputElement>(null);
  const wasEditing = useRef(false);
  // The menu button and the trash are gone while editing, so the first field takes the focus; when the edit ends the menu button gets it back.
  useEffect(() => {
    if (editing) fromInput.current?.focus();
    else if (wasEditing.current) {
      const active = document.activeElement;
      if (!active || active === document.body || row.current?.contains(active)) row.current?.querySelector<HTMLElement>(".row-menu-btn")?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);
  const what = tariff.asset_id === null
    ? `rate from ${tariff.effective_from} (site default)`
    : `rate from ${tariff.effective_from}${where ? ` for ${where}` : ""}`;
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
    <tr ref={row} onKeyDown={(e) => { if (editing && e.key === "Escape") { e.preventDefault(); setEditing(false); } }}>
      {tariff.asset_id !== null && <td className="asset-cell" title={where ?? undefined}>{where}</td>}
      <td className="date-cell">
        {editing ? <input ref={fromInput} type="date" aria-label="Effective from" value={from} onChange={(e) => setFrom(e.target.value)} /> : tariff.effective_from}
      </td>
      <td className="num">
        {editing ? (
          <input type="number" min="0" step="0.01" aria-label="Rate per kWh" value={rate} onChange={(e) => setRate(e.target.value)} />
        ) : fmtRate(tariff.rate_per_kwh)}
      </td>
      {canEdit && (
        <td className="actions">
          <div className={editing ? "row-actions editing" : "row-actions"}>
            {editing ? (
              <>
                <button type="button" className="quiet" onClick={save} disabled={busy}>Save</button>
                <button type="button" className="quiet" onClick={() => setEditing(false)}>Cancel</button>
              </>
            ) : (
              <>
                <RowActions label={`Actions for ${what}`} items={[{ label: "Edit", onSelect: startEdit, disabled: busy }]} />
                <TrashButton label={`Delete ${what}`} onClick={del} disabled={busy} />
              </>
            )}
          </div>
          {failure && <span className="error" role="alert"> {failure}</span>}
        </td>
      )}
    </tr>
  );
}

/** The two rate cards: static heads, so the page draws them while the rates load too (the skeleton sits under the first one, where the table will be). */
function SiteDefaultCard({ children }: { children?: ReactNode }) {
  return <PageCard icon="rate" title="Site default rate" purpose={SITE_DEFAULT_PURPOSE}>{children}</PageCard>;
}
function OverridesCard({ children }: { children?: ReactNode }) {
  return <PageCard icon="override" title="Asset overrides" purpose={OVERRIDES_PURPOSE}>{children}</PageCard>;
}

/** `tariffs === undefined` is the loading frame: the skeleton where the left table will be, and both add forms already drawn (they are pinned to the card bottoms, so they must not drop when the rates land; the same elements stay mounted, so what is typed survives). Without `canEdit` there are no add forms (in either frame) and no Actions column. */
function TariffTables({ tariffs, assets, assetsError, canEdit }: {
  tariffs: Tariff[] | undefined; assets: Asset[]; assetsError: string | null; canEdit: boolean;
}) {
  const labels = useMemo(() => assetLabels(assets), [assets]);
  const defaults = tariffs?.filter((t) => t.asset_id === null);
  const perAsset = tariffs?.filter((t) => t.asset_id !== null);
  return (
    <>
      <SiteDefaultCard>
        {defaults === undefined ? (
          <TableSkeleton columns={3} rows={2} label="Loading tariffs" />
        ) : defaults.length === 0 ? (
          <EmptyNote icon="rate">No site default rate yet. Until one is set, assets with no override show a dash for cost.{canEdit && " Add a rate below."}</EmptyNote>
        ) : (
          <div className="table-wrap">
            <table aria-label="Site default rates" className="tariff-table">
              <thead><tr><th>Effective from</th><th className="num">Rate per kWh</th>{canEdit && <th className="actions">Actions</th>}</tr></thead>
              <tbody>{defaults.map((t) => <TariffRow key={t.id} tariff={t} where={null} canEdit={canEdit} />)}</tbody>
            </table>
          </div>
        )}
        {canEdit && <AddTariff assets={null} labels={labels} />}
      </SiteDefaultCard>
      <OverridesCard>
        {perAsset === undefined ? null : perAsset.length === 0 ? (
          <EmptyNote icon="override">No overrides. Every asset uses the site default rate.</EmptyNote>
        ) : (
          <div className="table-wrap">
            <table aria-label="Asset overrides" className="tariff-table">
              <thead><tr><th>Asset</th><th>Effective from</th><th className="num">Rate per kWh</th>{canEdit && <th className="actions">Actions</th>}</tr></thead>
              <tbody>{perAsset.map((t) => (
                <TariffRow key={t.id} tariff={t} where={(t.asset_id !== null ? labels.get(t.asset_id) : undefined) ?? t.asset_path ?? t.asset_name} canEdit={canEdit} />
              ))}</tbody>
            </table>
          </div>
        )}
        {canEdit && <AddTariff assets={assets} labels={labels} assetsError={assetsError} />}
      </OverridesCard>
    </>
  );
}

const NO_ASSETS: Asset[] = [];

/**
 * Needs tariffs.view and assets.view (the route is wrapped in RequirePermission): the site currency, the site default rates and per-asset
 * overrides. Without tariffs.edit it is all read-only (W9b): the built-in Operator opens it this way.
 */
export function TariffsPage() {
  const canEdit = useAuth().can("tariffs.edit");
  const tariffs = useTariffs();
  const assets = useAssets();
  return (
    <section className="tariffs-page">
      <PageHeader
        title="Tariffs"
        sub="A rate applies from its effective date (a site-local date) until the next one. An asset's override replaces the site default from its own effective date. Editing a past rate recalculates history."
      />
      <div className="page-grid">
        {!canEdit && <div className="span-all"><ReadOnlyNote /></div>}
        <PageCard className="span-all" icon="currency" title="Currency" purpose={CURRENCY_PURPOSE}>
          <CurrencyForm canEdit={canEdit} />
        </PageCard>
        {tariffs.isError && <p className="error span-all" role="alert">{errorText(tariffs.error)}</p>}
        {(tariffs.isPending || tariffs.data) && (
          <TariffTables tariffs={tariffs.data} assets={assets.data ?? NO_ASSETS} assetsError={assets.isError ? errorText(assets.error) : null} canEdit={canEdit} />
        )}
      </div>
    </section>
  );
}
