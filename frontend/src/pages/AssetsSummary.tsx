import { Link } from "react-router";
import { useAssets, useFleetSummary, useSite } from "../api/queries";
import type { Asset, AttentionItem, FleetSummary } from "../api/types";
import { CostTile } from "../components/CostTile";
import { EnergyTile } from "../components/EnergyTile";
import { Icon } from "../components/Icon";
import { fmt } from "../components/MetricsTable";
import { PageHeader } from "../components/PageHeader";
import { kindIcon } from "../lib/kindIcon";
import { cleanKind, kindKey } from "../lib/kinds";
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

/** The body of the page for a site that has assets: the four tiles, the kinds, the readings that need attention. */
function Fleet({ assets }: { assets: readonly Asset[] }) {
  const { data, error, isLoading } = useFleetSummary();
  const site = useSite();
  if (isLoading) return <p className="muted">loading…</p>;
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
          <li key={name}><span className="kind-name"><Icon name={kindIcon(name)} />{name}</span> <span className="kind-count">{count}</span></li>
        ))}
      </ul>
      <Attention attention={data.attention} timezone={site.data?.timezone} />
    </>
  );
}

/** `/assets` itself, the Assets workspace's landing page: the whole site at a glance. A site with no assets gets the empty card and asks for no figures. */
export function AssetsSummary() {
  const { data: assets = [], isLoading } = useAssets();
  const ctx = useAssetsContext();
  return (
    <>
      <PageHeader title="Assets" actions={assetActions(ctx, null)} />
      {isLoading ? <p className="muted">loading…</p> : assets.length === 0 ? (
        <div className="empty">
          <span className="empty-icon"><svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 3 7.5 12 12l9-4.5L12 3Z" /><path d="m3 12 9 4.5 9-4.5" /><path d="m3 16.5 9 4.5 9-4.5" /></svg></span>
          <p className="empty-title">No assets yet.</p>
        </div>
      ) : (
        <Fleet assets={assets} />
      )}
    </>
  );
}
