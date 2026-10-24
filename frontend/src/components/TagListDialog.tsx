import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { api, ApiError } from "../api/client";
import { useInvalidate } from "../api/queries";
import { METRICS, type TagListChanged, type TagListReport, type TagListUndoResult } from "../api/types";
import { UNDO_MS } from "../lib/mappingActions";
import { TAG_LIST_REFRESHED, undoSentence } from "../lib/tagListUndo";
import { UNIT_LABELS } from "../lib/unitFit";
import { upperFirst } from "../lib/upperFirst";
import { InfoTip } from "./InfoTip";
import { useToast, type ToastApi, type ToastOptions } from "./Toasts";

const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** The server's limits (ingest/tag_list.py MAX_BYTES, MAX_ROWS): a list over them is refused here, with the same words, before anything is sent. */
const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 1000;
/** The longest file name shown. */
const NAME_MAX = 60;

type Invalidate = ReturnType<typeof useInvalidate>;
type Busy = "check" | "create";
/** A report together with the exact text and option it was made for: the Create button follows only a report of what is in the dialog NOW. */
interface Checked { text: string; createAssets: boolean; report: TagListReport }
interface Message { tone: "info" | "error"; text: string }

const grouped = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string) => `${grouped(n)} ${n === 1 ? one : `${one}s`}`;
const clip = (name: string) => (name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name);
const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why the list is not even sent (the server says the same, but a 1 MB paste should not travel to hear it); null when it may be. */
function refusalOf(text: string): string | null {
  if (text.trim() === "") return "Paste a tag list or load a file first.";
  if (new Blob([text]).size > MAX_BYTES) return "The list is larger than 1 MB; split it into smaller lists.";
  // The server's count: lines with something on them, less the header. It splits on the line feed only.
  const lines = text.split("\n").filter((line) => line.trim() !== "").length - 1;
  if (lines > MAX_ROWS) return `The list has ${grouped(lines)} lines; a list holds at most ${grouped(MAX_ROWS)}: split it into smaller lists.`;
  return null;
}

/** The text of a chosen file: `File.text()` where the browser has it, a FileReader otherwise. */
function readText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * What the person reads after a real run that was refused. A 409 (the plan differs, or someone was in the way) and a 422 (a problem line showed up under the
 * locks) both mean the check they relied on is out of date, so the report goes and the sentence sends them back to "Check list". The server's own sentence
 * is shown as it is; the new numbers are added only when it does not carry them.
 */
function refusedText(error: unknown): { text: string; outdated: boolean } {
  const text = reasonOf(error);
  if (!(error instanceof ApiError) || (error.status !== 409 && error.status !== 422)) return { text, outdated: false };
  const body = (typeof error.body === "object" && error.body !== null ? error.body : {}) as Partial<TagListChanged>;
  let said = text;
  if (error.status === 409 && [body.points, body.assets, body.mappings].every((n) => typeof n === "number") && !/now creates/i.test(said)) {
    said += ` Now it would create ${plural(body.points!, "point")}, ${plural(body.assets!, "asset")} and ${plural(body.mappings!, "mapping")}.`;
  }
  if (!/check/i.test(said)) said += `${/[.!?]$/.test(said) ? "" : "."} Press "Check list" again.`;
  return { text: said, outdated: true };
}

/** The Undo of the toast. Module level on purpose: it runs up to 10 seconds after the dialog has gone, so it holds the toast api, the refresh function and the id, never component state. */
async function undoTagList(auditId: number, toast: ToastApi, invalidate: Invalidate): Promise<void> {
  try {
    toast.success(undoSentence(await api.post<TagListUndoResult>(`/api/tag-lists/${auditId}/undo`)));
  } catch (error) {
    toast.error(upperFirst(reasonOf(error))); // "already undone", "changed since ...", "no longer possible": the server's sentence, which it writes in lower case
  } finally {
    try { await invalidate(...TAG_LIST_REFRESHED); } catch { /* the lists fetch themselves again on their next visit */ }
  }
}

/**
 * The toast leaves with its Undo button, and a focus that was on the button would fall to the body. It goes where the dialog's own close put it: the source's row
 * menu button, as long as the page still shows the row (the Sources page's `tr[data-source]`), else the page's heading. Only a focus that is on the toast moves: a
 * person who has gone elsewhere in the 10 seconds keeps their place. Run while the button still has the focus, before the toast fades.
 */
function keepFocusAfterUndo(sourceId: number): void {
  const at = document.activeElement;
  if (!(at instanceof HTMLElement) || at.closest(".toast") === null) return;
  const target = document.querySelector<HTMLElement>(`tr[data-source="${sourceId}"] .row-menu-btn`) ?? document.querySelector<HTMLElement>("h1");
  target?.focus({ preventScroll: true });
}

/** The toast options of a finished tag list: the Undo button. Exported for the other pages that write through the tag-list route (Map by shape). */
export function undoOptions(auditId: number, sourceId: number, toast: ToastApi, invalidate: Invalidate): ToastOptions {
  return {
    durationMs: UNDO_MS,
    // No Ctrl+Z here: that shortcut belongs to the mapping Undo of the pages that mount useMappingActions, and a second listener could race it.
    action: { label: "Undo", title: "Undo this tag list", onAction: () => { keepFocusAfterUndo(sourceId); void undoTagList(auditId, toast, invalidate); } },
  };
}

/** The sentence under the buttons' area once a check has come back: the server's own, and what has to happen next. */
function checkedSentence(report: TagListReport): string {
  const text = report.text.trim().replace(/\.$/, "");
  return report.ok && report.problems_total === 0 ? `${text}. Nothing is created until you press Create.` : `${text}.`;
}

function ReportView({ report }: { report: TagListReport }) {
  const moreAssets = report.assets_to_create_total - report.assets_to_create.length;
  const moreProblems = report.problems_total - report.problems.length;
  return (
    <>
      <dl className="taglist-tiles">
        <div><dt>Points to create</dt><dd>{grouped(report.points_to_create)}</dd></div>
        <div><dt>Assets to create</dt><dd>{grouped(report.assets_to_create_total)}</dd></div>
        <div><dt>Mappings to create</dt><dd>{grouped(report.mappings_to_create)}</dd></div>
      </dl>
      {report.problems.length > 0 && (
        <section>
          <h3>Problem lines</h3>
          <table>
            <thead><tr><th className="num">Line</th><th>Tag</th><th>Reason</th></tr></thead>
            <tbody>
              {report.problems.map((problem, i) => (
                <tr key={`${problem.line}-${i}`}><td className="num">{problem.line}</td><td className="taglist-cell">{problem.tag}</td><td className="taglist-cell">{problem.reason}</td></tr>
              ))}
            </tbody>
          </table>
          {moreProblems > 0 && <p className="muted">{`and ${grouped(moreProblems)} more`}</p>}
        </section>
      )}
      {report.units.length > 0 && (
        <section>
          <h3>Units</h3>
          <table>
            <thead><tr><th>Unit</th><th>Metric</th><th className="num">Scale</th><th className="num">Count</th></tr></thead>
            <tbody>
              {report.units.map((unit, i) => (
                <tr key={`${unit.unit ?? ""}-${unit.metric}-${i}`}>
                  <td className="taglist-cell">{unit.unit ?? "none"}</td>
                  <td className="taglist-cell">{unit.metric}</td>
                  <td className="num">{String(unit.scale)}</td>
                  <td className="num">{grouped(unit.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {report.assets_to_create.length > 0 && (
        <section>
          <h3>New assets</h3>
          <ul className="taglist-paths">{report.assets_to_create.map((path, i) => <li key={`${i}-${path}`}>{path}</li>)}</ul>
          {moreAssets > 0 && <p className="muted">{`and ${grouped(moreAssets)} more`}</p>}
        </section>
      )}
    </>
  );
}

/**
 * Map a whole list of tags at once (w31, the row menu's "Map tag list..."): paste it or load a file, "Check list" shows what it would create (a dry run,
 * nothing is written), and only a check of what is in the dialog NOW, without problem lines, lets "Create N mappings" through. The create call sends back the
 * numbers and the digest of the check it follows; if the server's plan has moved since, it answers 409 with the new numbers and writes nothing, and the report
 * goes. On success the dialog closes and ONE toast, "Created N mappings", carries an Undo for 10 seconds (the same call as the Audit drawer's button).
 *
 * The frame is BulkCreateDialog's: focus moves to the text field and Tab stays inside, Escape closes (not while the create call runs: its outcome must
 * reach the person), and the focus goes back to what had it when the dialog opened. The report sits in a box of a fixed height, so a report arriving moves
 * no button; one status line speaks for the whole dialog.
 */
export function TagListDialog({ source, onClose }: { source: { id: number; name: string; connector_type: string }; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const dialog = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const areaId = useId();
  const helpId = useId();
  const fileId = useId();
  const statusId = useId();

  const [text, setText] = useState("");
  const [createAssets, setCreateAssets] = useState(false);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const running = useRef<Busy | null>(null);
  const alive = useRef(true);
  const close = useRef(onClose);
  close.current = onClose;

  // The report counts only for what it was made for; any change to the text or the option takes it away without any clearing code.
  const current = checked !== null && checked.text === text && checked.createAssets === createAssets ? checked.report : null;
  const canCreate = current !== null && current.ok && current.problems_total === 0 && current.mappings_to_create > 0 && busy === null;
  const goLabel = current !== null && current.ok ? `Create ${plural(current.mappings_to_create, "mapping")}` : "Create mappings";
  const status =
    busy === "check" ? "Checking the list..."
    : busy === "create" ? "Creating the mappings..."
    : message?.text ?? (current !== null ? checkedSentence(current) : "");

  function edited(next: string) {
    if (running.current) return;
    setText(next);
    setFileNote(null);
    setMessage(null);
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = ""; // so that choosing the same file again is a change; the name is shown by the dialog
    if (!file || running.current) return;
    if (file.size > MAX_BYTES) {
      setMessage({ tone: "error", text: `${clip(file.name)} is larger than 1 MB; split it into smaller lists.` });
      return;
    }
    try {
      const content = await readText(file);
      if (!alive.current || running.current) return;
      setText(content);
      setFileNote(`${clip(file.name)}, ${Math.max(1, Math.round(file.size / 1024))} KB`);
      setMessage(null);
    } catch {
      if (alive.current) setMessage({ tone: "error", text: `${clip(file.name)} could not be read.` });
    }
  }

  async function check() {
    if (running.current) return;
    const refusal = refusalOf(text);
    if (refusal !== null) {
      setMessage({ tone: "error", text: refusal });
      return;
    }
    running.current = "check";
    setBusy("check");
    setMessage(null);
    const sent = { text, createAssets };
    try {
      const report = await api.postRaw<TagListReport>(`/api/sources/${source.id}/tag-list?dry_run=1&create_assets=${sent.createAssets ? 1 : 0}`, sent.text);
      if (alive.current) setChecked({ ...sent, report });
    } catch (error) {
      if (alive.current) setMessage({ tone: "error", text: reasonOf(error) });
    } finally {
      running.current = null;
      if (alive.current) setBusy(null);
    }
  }

  async function create() {
    if (running.current || !canCreate || checked === null) return;
    // What was checked is what is sent, with the numbers and the digest of that check.
    const { text: sent, createAssets: withAssets, report } = checked;
    running.current = "create";
    setBusy("create");
    setMessage(null);
    const query = new URLSearchParams({
      dry_run: "0", create_assets: withAssets ? "1" : "0",
      expect_points: String(report.points_to_create), expect_assets: String(report.assets_to_create_total), expect_mappings: String(report.mappings_to_create),
      expect_plan: report.plan_digest,
    });
    let done: TagListReport | null = null;
    try {
      done = await api.postRaw<TagListReport>(`/api/sources/${source.id}/tag-list?${query}`, sent);
    } catch (error) {
      const refused = refusedText(error);
      if (alive.current) {
        if (refused.outdated) setChecked(null);
        setMessage({ tone: "error", text: refused.text });
      }
    } finally {
      // The lists are out of date after a failure too (a 409 means somebody else changed something). Before the person is told: their view must already be right.
      try { await invalidate(...TAG_LIST_REFRESHED); } catch { /* the lists fetch themselves again on their next visit */ }
      running.current = null;
      if (alive.current) setBusy(null);
    }
    if (done === null) return;
    const createdText = `Created ${plural(done.mappings_to_create, "mapping")}`;
    toast.success(createdText, done.audit_id === null ? undefined : undoOptions(done.audit_id, source.id, toast, invalidate));
    close.current();
  }

  // Focus moves in and stays in (Tab wraps, a focus that lands outside is pulled back) and goes back to what had it when the dialog goes away (Modal's rules).
  useEffect(() => {
    alive.current = true;
    const root = dialog.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = () => root.querySelector<HTMLElement>(FOCUSABLE) ?? root;
    (area.current ?? first()).focus();
    const keepFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !root.contains(event.target)) first().focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (running.current !== "create") close.current(); // a tip that is open took this Escape in the capture phase: it never gets here
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (controls.length === 0) return;
      const [firstControl, lastControl] = [controls[0], controls[controls.length - 1]];
      const at = document.activeElement;
      if (event.shiftKey ? at === firstControl || at === root : at === lastControl) {
        event.preventDefault();
        (event.shiftKey ? lastControl : firstControl).focus();
      }
    };
    document.addEventListener("focusin", keepFocus);
    document.addEventListener("keydown", onKey);
    return () => {
      alive.current = false;
      document.removeEventListener("focusin", keepFocus);
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const own = source.connector_type === "file";
  return (
    <div className="dialog-backdrop">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="dialog taglist-dialog">
        <h2 id={titleId}>{`Map tag list: ${source.name}`}</h2>
        <p className="muted">
          {`Each line names a tag, the asset it belongs to and what it measures. ${own ? "The tags become points of this source." : "The tags must already be points of this source: run Browse first."}`}
        </p>

        <div className="field">
          <label htmlFor={areaId}>Tag list</label>
          <textarea
            id={areaId} ref={area} className="taglist-input" rows={7} spellCheck={false} value={text} readOnly={busy !== null} aria-describedby={helpId}
            onChange={(event) => edited(event.target.value)}
          />
          <div id={helpId} className="taglist-help">
            <p className="muted">The first line names the columns: tag, asset, metric, unit, scale, interval_seconds, kind, reading. tag, asset and metric are required. An asset is a path such as Hall 1 / Row A / Rack 01.</p>
            {/* A file is never polled, so for it the interval is not "how often" but the spacing of the rows of the export; the energy of a power tag is worked out from it, so the server wants it on every power line. */}
            {own && <p className="muted">interval_seconds is the spacing of the export in seconds (3600 for an hourly file). Every active_power_kw line of a file source needs it, because the energy of a meter that records only power is worked out from that spacing.</p>}
            <p className="muted">{`metric is one of ${METRICS.join(", ")}. Units: ${UNIT_LABELS.active_power_kw} for active power; ${UNIT_LABELS.energy_kwh} for energy; the other metrics take their base unit only.`}</p>
          </div>
        </div>

        <div className="taglist-options">
          <div className="field">
            <label htmlFor={fileId}>Or load a file</label>
            <input id={fileId} type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => void onFile(event)} />
            {fileNote !== null && <span className="muted taglist-file">{fileNote}</span>}
          </div>
          <div className="taglist-create">
            <label className="inline">
              <input type="checkbox" checked={createAssets} onChange={(event) => { if (!running.current) { setCreateAssets(event.target.checked); setMessage(null); } }} />
              Create missing assets
            </label>
            <InfoTip>
              An asset a line names that does not exist yet is created, with the folders above it. Its kind is the kind column, or generic. Without this, a missing asset is a problem line.
            </InfoTip>
          </div>
        </div>

        <p id={statusId} className="taglist-status" role="status" data-tone={message?.tone === "error" && busy === null ? "error" : undefined}>{status}</p>
        <div className="taglist-report" role="region" aria-label="Result of the check" tabIndex={0}>
          {current !== null ? <ReportView report={current} /> : <p className="muted">Press Check list to see what the list would create. Nothing is created by a check.</p>}
        </div>

        <div className="row">
          <button type="button" className="taglist-cancel" aria-disabled={busy === "create" ? true : undefined} onClick={() => { if (running.current !== "create") close.current(); }}>
            Cancel
          </button>
          <button type="button" className="taglist-check" aria-disabled={busy !== null ? true : undefined} onClick={() => void check()}>Check list</button>
          <button type="button" className="primary taglist-go" aria-disabled={canCreate ? undefined : true} aria-describedby={statusId} onClick={() => void create()}>
            {goLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
