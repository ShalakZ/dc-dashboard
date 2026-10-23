import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { keys, loadSourceImpact, useCollectorStatus, useInvalidate, useSecretKeyStatus, useSite, useSources } from "../api/queries";
import type { Source, SourceImpact } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { meets } from "../auth/need";
import { ConnectionCheck } from "../components/ConnectionCheck";
import { HistoryFillDialog } from "../components/HistoryFillDialog";
import { ImpactDeleteDialog } from "../components/ImpactDeleteDialog";
import { ImportDialog } from "../components/ImportDialog";
import { JobStatus } from "../components/JobStatus";
import { Modal } from "../components/Modal";
import { MoveSourceDialog } from "../components/MoveSourceDialog";
import { PAGE_NEED } from "../components/navItems";
import { PageHeader } from "../components/PageHeader";
import { RowActions, type RowAction } from "../components/RowActions";
import { ActionsSpace, TableSkeleton } from "../components/Skeleton";
import { SourceForm } from "../components/SourceForm";
import { TagListDialog } from "../components/TagListDialog";
import { useToast } from "../components/Toasts";
import { TrashButton } from "../components/TrashButton";
import { useAction } from "../hooks/useAction";
import { useMovedToast } from "../hooks/useMovedToast";
import { useNow } from "../hooks/useNow";
import { ageNow, formatAge, formatSpan, secondsSince } from "../lib/age";
import { historyLine } from "../lib/historyLine";
import { metersLine } from "../lib/liveStatus";
import { sourceDeletePath, sourceImpact, sourceLoss, sourceNote } from "../lib/impact";
import { DIFFERENT_SERVER_ROW, differentServerWhy, offerOf, twoServersText } from "../lib/moves";
import { formatSiteDateTime } from "../lib/siteTime";
import { formatOfflineSince, longOffline, MOVE_LINK_TEXT, offlineBannerParts, sourceStatusText } from "../lib/sourceStatus";

/** The collector status counts as unreadable when its last answer is older than this. It is the backend's STALE_AFTER_SECONDS (backend/dcdash/core/heartbeat.py), the age at which a heartbeat reads as silent. */
const COLLECTOR_STATUS_STALE_SECONDS = 30;
/** How often the ages on the page are brought up to date between answers. */
const TICK_MS = 5_000;
/** The chip of a polled source's stored status; anything else the collector may write reads as unknown (hollow dot). */
const STATUS_CHIP: Record<string, string> = { online: "chip-ok", offline: "chip-bad" };

/** A source is polled, tested and browsed unless its connector says it is filled by importing files (`polls` false). A row without the field (an older API) counts as polled. */
const polls = (s: Pick<Source, "polls">) => s.polls !== false;

// Inline SVG, 24-unit viewBox, decoration only (the text next to it says everything).
const WarnIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>
);
const SourcesIcon = () => (
  <svg className="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" /><path d="M12 17v4" /></svg>
);

export function SourcesPage() {
  const { can } = useAuth();
  const { data, error, isLoading, errorUpdateCount, dataUpdatedAt: sourcesAnsweredAt } = useSources();
  const sources = data ?? [];
  const collector = useCollectorStatus();
  const secretKey = useSecretKeyStatus();
  // The ages in both answers are the server's, as of the answer. Against a database that stops answering, the last answers stay on the
  // page, so the page adds the time elapsed since them (its own elapsed time, not its clock against the server's).
  const now = useNow(TICK_MS);
  const statusSilentFor = secondsSince(collector.dataUpdatedAt, now);
  const statusUnreadable = collector.dataUpdatedAt > 0 && statusSilentFor > COLLECTOR_STATUS_STALE_SECONDS;
  const site = useSite();
  const invalidate = useInvalidate();
  const toast = useToast();
  const movedToast = useMovedToast(); // (w33) "Moved ... 12 mappings kept." with an Undo for 10 seconds
  const [jobs, setJobs] = useState<Record<number, number>>({});
  const [showAdd, setShowAdd] = useState(false);
  // The source as it was when Edit was pressed, not a lookup into the list: the list is fetched every 10 s with new objects, which would reset the open form.
  const [editing, setEditing] = useState<Source | null>(null);
  // The source whose delete confirmation is open. It opens at once (the trash is the only way in) and asks the server what goes with it.
  const [deleting, setDeleting] = useState<{ id: number; name: string } | null>(null);
  // The source whose step-by-step connection check is open in a dialog.
  const [checking, setChecking] = useState<{ id: number; name: string } | null>(null);
  // The three w31 dialogs, each with the source as it was when its menu item was chosen (a snapshot, like `checking`: the list is replaced every 10 s).
  const [importing, setImporting] = useState<{ id: number; name: string } | null>(null);
  const [mapping, setMapping] = useState<{ id: number; name: string; connector_type: string } | null>(null);
  const [filling, setFilling] = useState<{ id: number; name: string } | null>(null);
  // (w33) The Move to new address... dialog, with the two sources as they were when it was asked for: the old one (id and name) and the new one a scan found.
  const [moving, setMoving] = useState<{ oldId: number; oldName: string; newId: number } | null>(null);
  const { run, busy, error: actionError } = useAction();
  // While a test runs or a delete confirmation, a check or one of the w31 or w33 dialogs is open, no form may open next to it (two dialogs would share Escape and the focus trap).
  const locked = busy || deleting !== null || checking !== null || importing !== null || mapping !== null || filling !== null || moving !== null;
  const openAdd = () => { if (!locked) setShowAdd(true); };
  const openEdit = (s: Source) => { if (!locked) setEditing(s); };
  const openCheck = (s: Source) => { if (!locked) setChecking({ id: s.id, name: s.name }); };
  const openImport = (s: Source) => { if (!locked) setImporting({ id: s.id, name: s.name }); };
  const openMapping = (s: Source) => { if (!locked) setMapping({ id: s.id, name: s.name, connector_type: s.connector_type }); };
  const openFill = (s: Source) => { if (!locked) setFilling({ id: s.id, name: s.name }); };
  const openMove = (s: Source) => {
    const offer = offerOf(s);
    if (!locked && offer) setMoving({ oldId: s.id, oldName: s.name, newId: offer.to_source_id });
  };

  // A dialog gives the focus back to what had it when it opened, the row's menu button, as long as that is still in the page. When the list moved on
  // under the dialog and the row is gone (the source was deleted, or the list was empty), the focus would drop to the body: it goes to the heading instead.
  const heading = useRef<HTMLHeadingElement>(null);
  const [refocus, setRefocus] = useState<number | null>(null);
  const closeDialog = (close: () => void, id: number) => { close(); setRefocus(id); };
  useEffect(() => {
    if (refocus === null) return;
    const at = document.activeElement;
    if (!(at instanceof HTMLElement) || at === document.body || !at.isConnected) {
      const trigger = document.querySelector<HTMLElement>(`tr[data-source="${refocus}"] .row-menu-btn`);
      (trigger ?? heading.current)?.focus({ preventScroll: true });
    }
    setRefocus(null);
  }, [refocus]);

  const testOne = (id: number) => run(async () => {
    const { job_id } = await api.post<{ job_id: number }>(`/api/sources/${id}/test`);
    setJobs((j) => ({ ...j, [id]: job_id }));
  });
  const testAll = () => run(async () => {
    const { job_ids } = await api.post<{ job_ids: number[] }>("/api/sources/test-all");
    // The API creates one job per enabled source in Source.id order, leaving out a source that is filled by importing files (nothing to test); the list itself is sorted by name.
    const enabled = sources.filter((s) => s.enabled && polls(s)).map((s) => s.id).sort((a, b) => a - b);
    setJobs(Object.fromEntries(enabled.map((id, i) => [id, job_ids[i]])));
  });
  // `seen`: the counts the dialog showed; the server refuses (and the dialog shows the new numbers) if more would go now.
  const removed = async (id: number, name: string, seen: SourceImpact) => {
    await api.del(sourceDeletePath(id, seen));
    // Right after the request, before the bookkeeping: a failing refresh must not swallow the one confirmation the person gets.
    toast.success(`Source "${name}" deleted`);
    setDeleting(null);
    // Its points and mappings go with it, so what the assets, the graph, Billing, the dashboards' widgets and the tariff list show can change too.
    await invalidate(keys.sources, keys.secretKey, keys.billing, keys.widgetData, keys.tariffs, keys.assets, keys.graph);
  };
  const remove = (id: number, name: string) => { if (!locked) setDeleting({ id, name }); };

  // Each control asks for the permission of the call it makes. A person with none of them gets an empty menu, which renders nothing.
  const canTest = can("sources.test");
  const canCheck = can("diagnostics.run");
  const canEdit = can("sources.edit"); // add, edit, delete and browse
  const canOpenPoints = meets(PAGE_NEED.sourcePoints, can); // the points page has its own permission
  const canImport = can("readings.import");
  const canMapTags = can("discovery.accept"); // the tag list creates mappings (and, if asked, assets) the way accepting a scan result does
  const canSeeEvents = meets(PAGE_NEED.events, can); // the System events page has its own need (w32): the journal's permission, and the sources it names
  // The w31 items come after the old ones, which keep their order and their words, and the w32 Events item comes last. Test and Check connection are for a source that is polled: a
  // source filled by importing files has nothing to reach. Fill older range needs a connector that keeps history (the list row says so).
  // (w33) Move to new address... comes first: it is the reason the row is worth a look. It is offered for an offline source that a scan found again at a new address.
  const actionsOf = (s: Source): RowAction[] => [
    ...(canEdit && offerOf(s) !== null ? [{ label: MOVE_LINK_TEXT, onSelect: () => openMove(s), disabled: locked }] : []),
    ...(canTest && polls(s) ? [{ label: "Test", onSelect: () => testOne(s.id), disabled: locked }] : []),
    ...(canCheck && polls(s) ? [{ label: "Check connection", onSelect: () => openCheck(s), disabled: locked }] : []),
    ...(canEdit ? [{ label: "Edit", onSelect: () => openEdit(s), disabled: locked }] : []),
    ...(canOpenPoints ? [{ label: "Points", to: `/sources/${s.id}/points` }] : []),
    ...(canImport ? [{ label: "Import file...", onSelect: () => openImport(s), disabled: locked }] : []),
    ...(canMapTags ? [{ label: "Map tag list...", onSelect: () => openMapping(s), disabled: locked }] : []),
    ...(canEdit && s.history?.supports_history ? [{ label: "Fill older range...", onSelect: () => openFill(s), disabled: locked }] : []),
    ...(canSeeEvents ? [{ label: "Events", to: `/events?source=${s.id}` }] : []), // every source has events, a file source too
  ];
  // The banner: the sources that have been offline for more than two minutes. `now` ticks every few seconds, so the banner appears when a source
  // crosses the line without waiting for a refetch, and it is built from the answer the page already holds: a refetch that brings the same facts changes nothing.
  const timezone = site.data?.timezone;
  const longDown = longOffline(sources, now);
  // (w33) A source a scan found again at a new address says where; the person who can edit sources gets the button that opens the dialog (one source only: with several
  // the sentence sends them to the row menus).
  const banner = offlineBannerParts(longDown, timezone, canEdit);
  const bannerSource = banner.move === null ? null : longDown.find((item) => item.source.id === banner.move?.sourceId)?.source ?? null;

  if (isLoading) {
    // The 10 s poll sets a list that failed before pending again for a second, with no error: the skeleton would take turns with the error at every poll.
    return errorUpdateCount > 0 ? <p className="muted">loading…</p> : (
      <>
        <PageHeader title="Sources" actions={<ActionsSpace />} />
        {/* Seven of the table's nine columns: nine rows of placeholders are 1300px wide at 1440, wider than the page, and would be cut at its edge.
            The Name cell has two lines (the history line under the name), as the loaded rows of a source that keeps history or is filled by files do. */}
        <TableSkeleton columns={7} rows={5} label="Loading sources" twoLine={[0]} />
      </>
    );
  }
  // A failed refetch keeps the last list (and any open dialog, with what was typed in it) and shows the error above the table.
  if (error && data === undefined) return <p className="error" role="alert">{error.message}</p>;
  return (
    <>
      <PageHeader
        title="Sources"
        headingRef={heading}
        actions={<>
          {canTest && <button onClick={testAll} disabled={!sources.some(polls) || busy}>Test all</button>}
          {canEdit && <button className="primary" onClick={openAdd} disabled={locked}>Add source</button>}
        </>}
      />
      {error && <p className="error" role="alert">{error.message}</p>}
      {actionError && <p className="error" role="alert">{actionError}</p>}
      {secretKey.data && !secretKey.data.ok && (
        <div className="banner banner-bad error" role="alert">
          <WarnIcon />
          <span>
            {`The DCDASH_SECRET_KEY in .env ${secretKey.data.key_changed ? "is different from the one this database was set up with" : "does not open the stored secrets"}: `}
            {`the secrets of ${secretKey.data.unreadable.map((s) => s.name).join(", ")} cannot be decrypted, so those sources stay offline. `}
            Put the original .env back, or have an admin type each source's secret in again.
          </span>
        </div>
      )}
      {statusUnreadable ? (
        <div className="banner banner-warn warning" role="alert">
          <WarnIcon />
          <span>{`Collector status cannot be read (no answer for ${formatSpan(statusSilentFor)}). Last-reading ages are counted from the last answer.`}</span>
        </div>
      ) : collector.data && !collector.data.alive && (
        <div className="banner banner-warn warning" role="alert">
          <WarnIcon />
          <span>
            {collector.data.age_seconds === null
              ? "The collector has not reported yet. No readings are collected until it does."
              : `The collector has not reported for ${formatSpan(ageNow(collector.data.age_seconds, collector.dataUpdatedAt, now))}. No readings are collected while it is silent.`}
          </span>
        </div>
      )}
      {longDown.length > 0 && (
        // Not an alert and not a live region (the page has two alert banners already and the list is fetched every 10 s): it is read where it stands.
        <div className="banner banner-warn offline-banner">
          <WarnIcon />
          <span>{banner.text}</span>
          {bannerSource !== null && <button type="button" className="b-act" aria-disabled={locked ? true : undefined} onClick={() => openMove(bannerSource)}>{MOVE_LINK_TEXT}</button>}
          {canSeeEvents &&<Link className="b-link" to={longDown.length === 1 ? `/events?source=${longDown[0].source.id}` : "/events"}>See its events</Link>}
        </div>
      )}
      {showAdd && (
        <Modal title="Add source" onClose={() => setShowAdd(false)}>
          <SourceForm onDone={() => setShowAdd(false)} />
        </Modal>
      )}
      {editing && (
        <Modal title={`Edit source ${editing.name}`} onClose={() => setEditing(null)}>
          <SourceForm source={editing} onDone={() => setEditing(null)} />
        </Modal>
      )}
      {checking && (
        <Modal title={`Check connection: ${checking.name}`} onClose={() => setChecking(null)}>
          <ConnectionCheck sourceId={checking.id} autoStart />
          <div className="row"><button type="button" onClick={() => setChecking(null)}>Close</button></div>
        </Modal>
      )}
      {importing && <ImportDialog source={importing} onClose={() => closeDialog(() => setImporting(null), importing.id)} />}
      {mapping && <TagListDialog source={mapping} onClose={() => closeDialog(() => setMapping(null), mapping.id)} />}
      {filling && <HistoryFillDialog source={filling} onClose={() => closeDialog(() => setFilling(null), filling.id)} />}
      {moving && (
        <MoveSourceDialog
          oldId={moving.oldId} oldName={moving.oldName} newId={moving.newId}
          onClose={() => closeDialog(() => setMoving(null), moving.oldId)}
          onDone={(done, preview) => {
            closeDialog(() => setMoving(null), moving.oldId);
            movedToast(done, preview.mappings);
          }}
        />
      )}
      {deleting && (
        <ImpactDeleteDialog<SourceImpact>
          title={`Delete source "${deleting.name}"?`}
          queryKey={["impact", "source", deleting.id]}
          load={() => loadSourceImpact(deleting.id)}
          loss={sourceLoss}
          note={sourceNote}
          isPlain={(impact) => impact.points === 0 && impact.mappings === 0}
          // The preview counts only MAPPED points; the unmapped ones of a source are deleted with it too, so the plain sentence says so.
          plainMessage="Its points go with it. This can't be undone."
          grown={sourceImpact}
          onConfirm={(seen) => removed(deleting.id, deleting.name, seen)}
          onCancel={() => setDeleting(null)}
        />
      )}
      {sources.length === 0 ? (
        <div className="empty"><div className="empty-icon"><SourcesIcon /></div><p>No sources yet.</p></div>
      ) : (
        <div className="table-wrap dense">
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Enabled</th><th>Status</th><th>Last seen</th><th className="num">Last reading</th><th>Last error</th><th>Test result</th><th className="row-actions"></th></tr></thead>
            <tbody>
              {sources.map((s) => {
                const status = sourceStatusText(s);
                const history = historyLine(s, now);
                const meters = metersLine(s.meters);
                // The chip's tooltip dates an outage in the site zone; with no zone to read it in, it says nothing rather than a time in the browser's zone.
                const offlineAt = s.status === "offline" && s.offline_since && timezone ? formatOfflineSince(s.offline_since, timezone) : null;
                // (w33) Two new servers look like this one: the tooltip says why no move is offered, after the date when there is one.
                const chipTitle = s.status === "offline" && s.move_candidate?.kind === "two"
                  ? `${offlineAt ? `offline since ${offlineAt}. ` : ""}${twoServersText(s.move_candidate.count)}.`
                  : offlineAt ? `offline since ${offlineAt}` : undefined;
                return (
                  <tr key={s.id} data-source={s.id}>
                    <td>
                      <span className="cell-name" title={s.name}>{s.name}</span>
                      {/* A second line inside the name cell: the table keeps its columns, and the skeleton its shape */}
                      {history !== null && <span className="cell-history muted" title={history}>{history}</span>}
                    </td>
                    <td>{s.connector_type}</td><td>{s.enabled ? "yes" : "no"}</td>
                    <td>
                      {status.polled ? <span className={`chip ${STATUS_CHIP[status.text] ?? "chip-stale"}`} title={chipTitle}>{status.text}</span> : <span className="muted st st-off note">{status.text}</span>}
                      {/* (w33) A scan, test or check met another server at this address; polling goes on for an enabled source, so the row must not look healthy without saying it. A block under the chip. */}
                      {s.identity_different === true && <span className="cell-different warning" title={differentServerWhy(s.enabled)}>{DIFFERENT_SERVER_ROW}</span>}
                    </td>
                    <td className="nowrap">{s.last_seen && site.data ? formatSiteDateTime(s.last_seen, site.data.timezone) : "—"}</td>
                    <td className="num">
                      {formatAge(ageNow(s.last_reading_age_seconds, sourcesAnsweredAt, now))}
                      {/* (w35) The data watchdog's word under the age, only while it sees trouble: a row without any is as tall as before. Text, not a live region. */}
                      {meters !== null && <span className={`cell-meters ${meters.stale ? "warning" : "muted"}`}>{meters.text}</span>}
                    </td>
                    <td className="error">{s.last_error ?? ""}</td>
                    <td><JobStatus jobId={jobs[s.id] ?? null} /></td>
                    <td className="row-actions">
                      <RowActions label={`Actions for ${s.name}`} items={actionsOf(s)} />
                      {canEdit && <TrashButton label={`Delete ${s.name}`} onClick={() => remove(s.id, s.name)} disabled={locked} />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
