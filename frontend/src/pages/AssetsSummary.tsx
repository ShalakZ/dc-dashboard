import type { UseQueryResult } from "@tanstack/react-query";
import { Link } from "react-router";
import { useAssetKinds, useAssets, useFleetSummary, useSite } from "../api/queries";
import type { Asset, AssetKind, AttentionItem, FleetSummary } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { CostTile } from "../components/CostTile";
import { EnergyTile } from "../components/EnergyTile";
import { Icon } from "../components/Icon";
import { fmt } from "../components/MetricsTable";
import { PageHeader } from "../components/PageHeader";
import { FleetSkeleton } from "../components/Skeleton";
import { cleanKind, kindIconForName, kindKey } from "../lib/kinds";
import { formatSiteDateTime } from "../lib/siteTime";
import { assetActions, useAssetsContext } from "./AssetsPage";

// Code-point comparison: deterministic across runtimes (localeCompare depends on ICU collation).
const compare = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** The line under the live power figure, in the wording of the asset page's roll-up (`rollupNote`), over the whole site. */
function powerNote({ counted, of }: FleetSummary["power"]): string {
  if (of === 0) return "No power meters mapped";
  if (counted === of) return `Sum of ${of === 1 ? "1 meter" : `${of} meters`}`;
  if (counted > 0) return `Sum of ${counted} of ${of} meters; ${of - counted === 1 ? "the other is" : "the others are"} not reporting`;
  return of === 1 ? "The meter is not reporting" : `None of the ${of} meters is reporting`;
}

/** The kinds in use, one per `kindKey`: the most used spelling (ties: code-point order) and the number of assets, most first, then by kind. A blank kind is left out. */
function kindCounts(assets: readonly Asset[]): { name: string; count: number }[] {
  const groups = new Map<string, Map<string, number>>();
  for (const { kind } of assets) {
    const key = kindKey(kind);
    if (key === "") continue;
    const spellings = groups.get(key) ?? new Map<string, number>();
    const spelling = cleanKind(kind);
    spellings.set(spelling, (spellings.get(spelling) ?? 0) + 1);
    groups.set(key, spellings);
  }
  return [...groups]
    .map(([key, spellings]) => ({
      key,
      name: [...spellings].sort(([a, n], [b, m]) => m - n || compare(a, b))[0][0],
      count: [...spellings.values()].reduce((sum, n) => sum + n, 0),
    }))
    .sort((x, y) => y.count - x.count || compare(x.key, y.key));
}

/** The path without the asset's own name (the name is already in the first column). A name may hold " / " itself, so the path is cut by the name, not split. */
function placeOf({ name, path }: AttentionItem): string {
  if (path === name) return "—";
  return path.endsWith(` / ${name}`) ? path.slice(0, path.length - name.length - 3) : path;
}

function Attention({ attention, timezone }: { attention: FleetSummary["attention"]; timezone: string | undefined }) {
  const { total, items } = attention;
  return (
    <>
      <h2 className="section-title">Needs attention</h2>
      {total === 0 ? (
        <span className="chip chip-ok">Nothing needs attention</span>
      ) : (
        <>
          <div className="table-wrap attention-table">
            <table>
              <thead><tr><th>Asset</th><th>Where</th><th>Problem</th><th>Last reading</th></tr></thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.asset_id}>
                    <td className="attn-name"><Link to={`/assets/${item.asset_id}`}>{item.name}</Link></td>
                    <td className="attn-where">{placeOf(item)}</td>
                    <td className="attn-problem">
                      {item.problem === "bad" ? <span className="chip chip-bad">Bad reading</span> : <span className="chip chip-stale">No recent reading</span>}
                      {item.points > 1 && <span className="attn-points"> · {item.points} points</span>}
                    </td>
                    <td className="attn-time">{timezone ? formatSiteDateTime(item.last_ts, timezone) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > items.length && <p className="attn-more">and {total - items.length} more</p>}
        </>
      )}
    </>
  );
}

/** The body of the page for a site that has assets and whose figures are in or have failed: the four tiles, the kinds, the readings that need attention. */
function Fleet({ assets, kinds, fleet: { data, error }, timezone }: { assets: readonly Asset[]; kinds: readonly AssetKind[] | undefined; fleet: UseQueryResult<FleetSummary>; timezone: string | undefined }) {
  if (error || !data) return <p className="error" role="alert">{error?.message ?? "The fleet summary is not available."}</p>;
  return (
    <>
      <div className="tiles fleet-tiles">
        <div className="tile">
          <div className="muted tile-label"><Icon name="assets" />Assets</div>
          <div className="big">{assets.length}</div>
        </div>
        <div className="tile">
          <div className="muted tile-label"><Icon name="rate" />Live power</div>
          <div className="big">{data.power.kw === null ? "—" : `${fmt(data.power.kw)} kW`}</div>
          <small className="muted">{powerNote(data.power)}</small>
        </div>
        <EnergyTile energy={data.energy_today} />
        <CostTile cost={data.cost_today} currency={data.currency} />
      </div>
      <h2 className="section-title">By kind</h2>
      <ul className="kind-list">
        {kindCounts(assets).map(({ name, count }) => (
          <li key={name}><span className="kind-name"><Icon name={kindIconForName(name, kinds)} />{name}</span> <span className="kind-count">{count}</span></li>
        ))}
      </ul>
      <Attention attention={data.attention} timezone={timezone} />
    </>
  );
}

/**
 * `/assets` itself, the Assets workspace's landing page: the whole site at a glance. A site with no assets gets the empty card and asks for no figures.
 * The fleet query is read here, not in `Fleet`, so the one skeleton covers both waits (the list, then the figures) without the region remounting.
 */
export function AssetsSummary() {
  const { data: assets = [], isLoading } = useAssets();
  const fleet = useFleetSummary(assets.length > 0);
  // Not part of `waiting`: a registry that is slow or failed must not hold the page. Until it is there (or when it is not) the list draws the keyword guess.
  const { can } = useAuth();
  const { data: kinds } = useAssetKinds(can("assets.view") && assets.length > 0);
  const site = useSite(); // asked for here, with the figures, not when they arrive: the time column should not show a dash while the zone follows them
  const ctx = useAssetsContext();
  const waiting = isLoading || (assets.length > 0 && fleet.isLoading);
  return (
    <>
      <PageHeader title="Assets Tree" actions={assetActions(ctx, null)} />
      {waiting ? (
        // A poll that finds the query without data (it failed before) sets it pending again for a second: the error and a skeleton would take turns at every poll.
        fleet.errorUpdateCount === 0 ? <FleetSkeleton label="Loading the fleet summary" /> : <p className="muted">loading…</p>
      ) : assets.length === 0 ? (
        <div className="empty">
          <span className="empty-icon"><svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 3 7.5 12 12l9-4.5L12 3Z" /><path d="m3 12 9 4.5 9-4.5" /><path d="m3 16.5 9 4.5 9-4.5" /></svg></span>
          <p className="empty-title">No assets yet.</p>
        </div>
      ) : (
        <Fleet assets={assets} kinds={kinds} fleet={fleet} timezone={site.data?.timezone} />
      )}
    </>
  );
}
