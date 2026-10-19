import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo } from "react";
import { Link } from "react-router";
import { keys, useAssets } from "../../api/queries";
import type { Asset, WidgetConfig, WidgetData, DataWidgetType } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { meets } from "../../auth/need";
import { useNow } from "../../hooks/useNow";
import { insideOthersText, kindNoun, moreFigure, narrowLabel, parentIds } from "../../lib/breakdown";
import { changeLine, changeMarks, costMarkMeanings, detailNotes, measureUnit, NOTHING_YET, sideText, windowDates } from "../../lib/compare";
import { TYPE_LABELS } from "../../lib/dashboardEdit";
import { liveOrFetched } from "../../lib/live";
import {
  aggregationWords, assetRows, bucketStartText, figuresText, freshnessLine, hasNoRate, isLatestReading, markerMeanings, noMetricIds,
  rangeWords, removedCount, seriesSummary, sourceWords, windowText, type AssetRow, type DetailFigure, type SeriesSummaryRow, type SummaryKey,
} from "../../lib/widgetDetails";
import { figureOrNoData, figureText, flagsOf, noMetricText, removedText, unitSuffix } from "../../lib/widgetFormat";
import { Drawer } from "../Drawer";
import { Icon } from "../Icon";
import { PAGE_NEED } from "../navItems";
import { useFocus } from "./FocusContext";
import { useLiveValue } from "./LiveValuesContext";
import { useCsvExport, type CsvSource } from "./WidgetFrame";

export interface WidgetDetailsProps {
  /** The widget's own title; the drawer is named "Details: <title>". */
  title: string;
  type: DataWidgetType;
  /** The answer the card shows: nothing here is fetched again. */
  data: WidgetData;
  config: WidgetConfig;
  timezone: string;
  /** The card follows the dashboard's stream (a stat or gauge on a live range): then so do the reading times here. */
  following: boolean;
  /** Present = the footer offers Download CSV, the same export as the card's button. */
  csv?: CsvSource;
  onClose: () => void;
  returnFocus?: () => HTMLElement | null;
}

/** The names of the assets, linked to their pages for a role that may open them. */
function AssetName({ id, name, linked }: { id: number; name: string; linked: boolean }) {
  return linked ? <Link to={`/assets/${id}`}>{name}</Link> : <>{name}</>;
}

/** One asset's reading time. Its own component because the stream's entry for the asset is a hook (`useLiveValue`), and the card reads it the same way. */
function FreshnessRow({ row, name, follows, latest, now, timezone }: {
  row: WidgetData["values"][number]; name: string; follows: boolean; latest: boolean; now: number; timezone: string;
}) {
  const reading = liveOrFetched(useLiveValue(follows ? row.point_id : null), row);
  return (
    <div>
      <dt>{name}</dt>
      <dd>{freshnessLine(reading.ts, now, timezone, reading.stale, latest)}</dd>
    </div>
  );
}

/**
 * The comparison with the same days of last month: BOTH measures for both windows (the windows by date), the changes, and every note in full (the card
 * shows one line of them). A cost the rates did not reach and a side without readings are dashes, as on the card.
 */
function ComparisonSection({ data }: { data: WidgetData }) {
  const compare = data.compare!;
  const costUnit = measureUnit("cost", compare.currency);
  return (
    <>
      <h3 className="wd-heading">Comparison</h3>
      {compare.state === "nothing_yet" || compare.assets.length === 0 ? (
        <p className="wd-note">{NOTHING_YET}</p>
      ) : compare.assets.map((asset) => {
        const notes = detailNotes(compare, asset);
        return (
          <div key={asset.asset_id}>
            <div className="wd-table-wrap">
              <table className="wd-table">
                <caption>{asset.name}</caption>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Dates</th>
                    <th className="num">Energy (kWh)</th>
                    <th className="num">{costUnit ? `Cost (${costUnit})` : "Cost"}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>This month so far</td>
                    <td>{compare.this_window ? windowDates(compare.this_window) : DASH}</td>
                    <td className="num">{sideText(asset.this, "kwh", compare.days)}</td>
                    <td className="num">{sideText(asset.this, "cost", compare.days)}</td>
                  </tr>
                  <tr>
                    <td>Same days last month</td>
                    <td>{compare.last_window ? windowDates(compare.last_window) : DASH}</td>
                    <td className="num">{sideText(asset.last, "kwh", compare.days)}</td>
                    <td className="num">{sideText(asset.last, "cost", compare.days)}</td>
                  </tr>
                  <tr>
                    <td>Change</td>
                    <td />
                    <td className="num">{changeLine(asset.kwh, "kWh", changeMarks(asset, "kwh"))}</td>
                    <td className="num">{changeLine(asset.cost, costUnit, changeMarks(asset, "cost"))}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            {notes.length > 0 && <ul className="wd-list wd-markers">{notes.map((text) => <li key={text}>{text}</li>)}</ul>}
          </div>
        );
      })}
    </>
  );
}

/** The counts behind a breakdown by kind: what the chart draws, what it leaves out and why. */
function BreakdownSection({ data }: { data: WidgetData }) {
  const b = data.breakdown!;
  const left = moreFigure(b, data.unit);
  const inside = insideOthersText(b);
  return (
    <>
      <h3 className="wd-heading">Breakdown</h3>
      <dl className="kv wd-kv">
        <div><dt>Kind</dt><dd>{b.kind}</dd></div>
        <div><dt>Looking under</dt><dd>{b.root?.name ?? "The whole site"}</dd></div>
        <div><dt>Assets of this kind</dt><dd>{b.count}</dd></div>
        <div><dt>Bars drawn</dt><dd>{b.shown}</dd></div>
        {b.more.count > 0 && (
          <div>
            <dt>Not drawn</dt>
            <dd>{`${b.more.count} ${kindNoun(b.kind, b.more.count)}: ${left.text}${left.text === DASH ? "" : " in all"}${left.without > 0 ? ` (${left.without} with no data)` : ""}`}</dd>
          </div>
        )}
        <div><dt>With no data</dt><dd>{b.no_data}</dd></div>
        {inside && <div><dt>Inside others</dt><dd>{inside}</dd></div>}
      </dl>
    </>
  );
}

const DASH = "—";
/** A figure with its markers and unit, kept on one line (the number never parts from its unit); a dash when there is none. */
function Figure({ figure, unit }: { figure: DetailFigure | null; unit: string | null }) {
  return figure ? <span className="wd-fig">{`${figureText(figure.value, figure)}${unitSuffix(unit)}`}</span> : <>{DASH}</>;
}

/** One cell of the figures table. A cost whose highest hour cannot be named says why in words, not with a number. */
function SummaryCell({ column, row, states, data, timezone }: {
  column: SummaryKey; row: SeriesSummaryRow; states: string[]; data: WidgetData; timezone: string;
}) {
  switch (column) {
    case "lowest": return <Figure figure={row.lowest} unit={data.unit} />;
    case "highest":
      if (!row.highest && states.includes("no rate")) return <>{`${DASH} unpriced hours`}</>;
      return (
        <>
          <Figure figure={row.highest} unit={data.unit} />
          {row.highest && row.highestFrom && <small className="wd-sub">bucket from <span className="wd-fig">{bucketStartText(row.highestFrom, timezone, data)}</span></small>}
        </>
      );
    case "total": return <Figure figure={row.total} unit={data.unit} />;
    case "last":
      return (
        <>
          <Figure figure={row.last} unit={data.unit} />
          {row.lastFrom && <small className="wd-sub">from <span className="wd-fig">{bucketStartText(row.lastFrom, timezone, data)}</span></small>}
        </>
      );
  }
}

/**
 * The "Details" drawer of a widget: what it shows, the time window, how fresh its readings are, what the markers in its figures
 * mean, and the figures as text (a chart is a picture). It is built from the answer the card already has, through the pure helpers of
 * `lib/widgetDetails.ts`, which say only what that answer proves. The ages count up every second while it is open.
 */
export function WidgetDetails({ title, type, data, config, timezone, following, csv, onClose, returnFocus }: WidgetDetailsProps) {
  const now = useNow(1000);
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const csvExport = useCsvExport(csv);
  const linked = can(PAGE_NEED.assets);
  // w25 (R10): the keyboard way to the drill-through of the chart. A bar whose asset has children gets a button that narrows the dashboard to it. The list is the
  // one the chart already loaded (same query); it is asked for here only by a breakdown, and only for a role that may open assets (the panel is the viewer's). Where no
  // card of the dashboard follows the focus (`anyFollowing`) narrowing would change nothing, so there is no button (W2).
  const { allowed, anyFollowing, setFocus } = useFocus();
  const assetList = useAssets(allowed && anyFollowing && data.breakdown != null).data;
  const parents = useMemo(() => (assetList ? parentIds(assetList) : null), [assetList]);

  const latest = isLatestReading(data, config);
  // A reading time only means something for the latest reading of a metric (the backend's `ts` of a stat, gauge or table row)
  const fresh = data.mode === "values" && data.source === "metric" && config.aggregation === "last" && (type === "stat" || type === "gauge" || type === "table");
  const rows: AssetRow[] = assetRows(data).map((row) => ({ ...row, states: fresh ? row.states.filter((s) => s !== "stale") : row.states })); // "stale" is the Freshness section's
  const summary = seriesSummary(data, config);
  const meanings = [...markerMeanings(data), ...costMarkMeanings(data)]; // the cost column of a comparison of energy has marks the card does not draw
  // The "no rate" line sits after the "~" and "*" lines (the fixed order of `markerMeanings`); it offers the page that fixes it
  // to a role that may open that page (the sidebar's own check), never to one that would be refused.
  const flags = flagsOf(data);
  const tariffsAt = hasNoRate(data) && meets(PAGE_NEED.tariffs, can) ? Number(flags.estimated) + Number(flags.partial) : -1;

  // Names for the assets without the metric come from the list the page already holds; this panel never asks the server for it
  // (a role without assets.view would be refused).
  const cached = queryClient.getQueryData<Asset[]>(keys.assets);
  const noMetric = noMetricIds(data);
  const noMetricAssets = cached ? noMetric.flatMap((id) => cached.filter((a) => a.id === id)) : [];
  const namedNoMetric = noMetric.length > 0 && noMetricAssets.length === noMetric.length;
  const removed = removedCount(data);

  const perValue = type === "bar" && data.mode === "values";
  const narrowable = allowed && anyFollowing && perValue && data.breakdown != null && parents !== null;
  const showTable = rows.length > 0 && (summary !== null || perValue || rows.some((r) => r.states.length > 0));
  const totalsHidden = summary !== null && data.source !== "metric" && summary.rows.some((r) => r.total === null);

  return (
    <Drawer
      title={`Details: ${title}`}
      wide
      onClose={onClose}
      returnFocus={returnFocus}
      footer={csv && (
        <div className="wd-foot">
          <button type="button" aria-disabled={csvExport.busy ? true : undefined} onClick={() => void csvExport.run()}>
            <Icon name="download" />Download CSV
          </button>
          {csvExport.error && <p className="error wd-error" role="alert">CSV export failed: {csvExport.error}</p>}
        </div>
      )}
    >
      <div className="wd-body">
        <h3 className="wd-heading">What it shows</h3>
        <dl className="kv wd-kv">
          <div><dt>Type</dt><dd>{TYPE_LABELS[type]}</dd></div>
          <div><dt>Source</dt><dd>{sourceWords(data)}</dd></div>
          <div><dt>Figure</dt><dd>{aggregationWords(type, data, config)}</dd></div>
          <div>
            <dt>Assets</dt>
            <dd>
              {rows.length === 0 ? "None" : (
                <ul className="wd-list">
                  {rows.map((row) => <li key={row.assetId}><AssetName id={row.assetId} name={row.name} linked={linked} /></li>)}
                </ul>
              )}
            </dd>
          </div>
          {(removed > 0 || noMetric.length > 0) && (
            <div>
              <dt>Left out</dt>
              <dd>
                <ul className="wd-list">
                  {removed > 0 && <li>{removedText(removed)}</li>}
                  {noMetric.length > 0 && (
                    <li>
                      {namedNoMetric ? (
                        <>
                          {"Without this metric: "}
                          {noMetricAssets.map((a, i) => (
                            <Fragment key={a.id}>{i > 0 && ", "}<AssetName id={a.id} name={a.name} linked={linked} /></Fragment>
                          ))}
                        </>
                      ) : noMetricText(noMetric.length)}
                    </li>
                  )}
                </ul>
              </dd>
            </div>
          )}
        </dl>

        <h3 className="wd-heading">Time window</h3>
        <dl className="kv wd-kv">
          <div><dt>Window</dt><dd>{windowText(data.range, timezone)}</dd></div>
          <div><dt>Range</dt><dd>{rangeWords(data.range.preset)}</dd></div>
          <div><dt>Data</dt><dd>{figuresText(data, config)}</dd></div>
        </dl>

        {data.compare && <ComparisonSection data={data} />}
        {data.breakdown && <BreakdownSection data={data} />}

        {fresh && (
          <>
            <h3 className="wd-heading">Freshness</h3>
            <dl className="kv wd-kv">
              {data.values.map((row, i) => (
                <FreshnessRow key={row.asset_id} row={row} name={rows[i].name} follows={following} latest={latest} now={now} timezone={timezone} />
              ))}
            </dl>
          </>
        )}

        {meanings.length > 0 && (
          <>
            <h3 className="wd-heading">What the markers mean here</h3>
            <ul className="wd-list wd-markers">
              {meanings.map((text, i) => (
                <li key={text}>
                  {text}
                  {i === tariffsAt && <>{" "}<Link to="/tariffs">Set a rate in Tariffs</Link></>}
                </li>
              ))}
            </ul>
          </>
        )}

        {showTable && (
          <>
            <h3 className="wd-heading">Per asset</h3>
            <div className="wd-table-wrap">
              <table className="wd-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    {perValue && <th className="num">{data.unit ? `Value (${data.unit})` : "Value"}</th>}
                    {summary?.columns.map((column) => <th key={column.key} className="num">{column.heading}</th>)}
                    {narrowable && <th><span className="sr-only">Actions</span></th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => (
                    <tr key={row.assetId}>
                      <td>
                        {row.name}
                        {row.states.length > 0 && <small className="wd-sub">{row.states.join(", ")}</small>}
                      </td>
                      {perValue && <td className="num">{figureOrNoData(data.values[i].value, data.values[i], data.values[i].no_data, data.source)}</td>}
                      {summary?.columns.map((column) => (
                        <td key={column.key} className="num"><SummaryCell column={column.key} row={summary.rows[i]} states={row.states} data={data} timezone={timezone} /></td>
                      ))}
                      {narrowable && (
                        <td className="drill-cell">
                          {parents.has(row.assetId) && (
                            // Closing the drawer gives focus back to the card's Details button (Drawer's returnFocus); the dashboard behind it follows the new focus.
                            <button type="button" className="quiet" aria-label={narrowLabel(row.name)} onClick={() => { setFocus(row.assetId); onClose(); }}>Narrow</button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {summary && (
              <p className="wd-note">
                Figures are of the buckets shown in the chart.
                {data.source === "metric" && " Lowest and highest are the extremes of the stored readings; the time is the start of that bucket."}
              </p>
            )}
            {totalsHidden && <p className="wd-note">A total is shown only when every bucket has a value.</p>}
          </>
        )}
      </div>
    </Drawer>
  );
}
