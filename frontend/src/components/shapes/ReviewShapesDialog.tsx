import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, api } from "../../api/client";
import { useInvalidate } from "../../api/queries";
import { postShapeLines, type ShapeCheck, type ShapeDecision, type ShapeLinesAnswer } from "../../api/shapes";
import type { TagListReport } from "../../api/types";
import { useDialogFocus } from "../../hooks/useDialogFocus";
import {
  dryRunPath, grouped, hasBlocking, mappedSentence, onExistingAssets, outlierTexts, plannerStops, plural, realRunPath, shapeCountsSentence,
} from "../../lib/shapes";
import { TAG_LIST_REFRESHED } from "../../lib/tagListUndo";
import { undoOptions } from "../TagListDialog";
import { useToast } from "../Toasts";

interface Props {
  sourceId: number;
  sourceName: string;
  /** The decisions to review: at most 60, as the page checked. */
  decisions: ShapeDecision[];
  parentId: number | null;
  /** The name of the asset the new assets go under, or null for the top level. */
  parentLabel: string | null;
  createAssets: boolean;
  /** The label of a shape by its key (for a check that names a shape the answer has no row for). */
  labelOf: (key: string) => string;
  onClose: () => void;
  /** The real run worked: the page forgets its decisions. */
  onMapped: () => void;
}

interface Message { tone: "info" | "error"; text: string }
type Busy = "lines" | "check" | "map";

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function CheckList({ checks, label }: { checks: readonly ShapeCheck[]; label: (key: string) => string }) {
  if (checks.length === 0) return null;
  return (
    <ul className="shapes-checks">
      {checks.map((check, i) => (
        <li key={`${i}-${check.kind}`} data-severity={check.severity}>
          <strong>{check.severity === "blocking" ? "Blocking" : "Warning"}</strong>
          {check.shape !== null && <span className="muted">{` ${label(check.shape)}`}</span>}
          {`: ${check.text}`}
        </li>
      ))}
    </ul>
  );
}

function ReportView({ report, lines }: { report: TagListReport; lines: number }) {
  const moreAssets = report.assets_to_create_total - report.assets_to_create.length;
  const moreProblems = report.problems_total - report.problems.length;
  const existing = onExistingAssets(lines, report.assets_to_create_total);
  return (
    <section>
      <h3>What the tag list planner says</h3>
      <p>{report.text}</p>
      <dl className="shapes-tiles">
        <div><dt>Points to create</dt><dd>{grouped(report.points_to_create)}</dd></div>
        <div><dt>Assets to create</dt><dd>{grouped(report.assets_to_create_total)}</dd></div>
        <div><dt>Mappings to create</dt><dd>{grouped(report.mappings_to_create)}</dd></div>
      </dl>
      {existing > 0 && <p>{`${plural(existing, "tag")} go onto assets that already exist.`}</p>}
      {report.problems.length > 0 && (
        <>
          <h4>Problem lines</h4>
          <table>
            <thead><tr><th className="num">Line</th><th>Tag</th><th>Reason</th></tr></thead>
            <tbody>
              {report.problems.map((problem, i) => (
                <tr key={`${problem.line}-${i}`}><td className="num">{problem.line}</td><td className="shapes-cell">{problem.tag}</td><td className="shapes-cell">{problem.reason}</td></tr>
              ))}
            </tbody>
          </table>
          {moreProblems > 0 && <p className="muted">{`and ${grouped(moreProblems)} more`}</p>}
        </>
      )}
      {report.units.length > 0 && (
        <>
          <h4>Units</h4>
          <table>
            <thead><tr><th>Unit</th><th>Metric</th><th className="num">Scale</th><th className="num">Count</th></tr></thead>
            <tbody>
              {report.units.map((unit, i) => (
                <tr key={`${unit.unit ?? ""}-${unit.metric}-${i}`}>
                  <td className="shapes-cell">{unit.unit ?? "none"}</td><td className="shapes-cell">{unit.metric}</td>
                  <td className="num">{String(unit.scale)}</td><td className="num">{grouped(unit.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {moreAssets > 0 && <p className="muted">{`${grouped(report.assets_to_create_total)} assets would be created, the first ${grouped(report.assets_to_create.length)} are listed by the planner.`}</p>}
    </section>
  );
}

/**
 * The Review of Map by shape: what the decisions would map, checked twice before anything is written.
 *
 * On open the server turns the decisions into tag-list lines (`POST /shapes/lines`, read-only) with its own checks: a blocking check stops everything, a warning is
 * shown. Without a blocking check the CSV goes to the EXISTING tag-list route as a dry run, and the planner's own report is shown. **Map N points** is the only way
 * on: it needs no blocking check, no planner problem and no call in flight, and it makes the real run with the numbers and the digest of that dry run, exactly as the
 * tag list dialog does. Success: one toast with an Undo (the outlier warnings repeated), the lists read again, the dialog closes, the focus returns to the opener.
 * A 409 (the plan moved) shows the server's sentence and reads everything again.
 *
 * The frame is MoveSourceDialog's: portaled, `useDialogFocus` (focus on Cancel, Tab wraps, Escape closes only this dialog and never mid-map), `type="button"`
 * everywhere, buttons that wait use aria-disabled, ONE live region (the status line, a fixed height), and the page behind is inert while it is open.
 */
export function ReviewShapesDialog({ sourceId, sourceName, decisions, parentId, parentLabel, createAssets, labelOf, onClose, onMapped }: Props) {
  const invalidate = useInvalidate();
  const toast = useToast();
  const root = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const titleId = `${ids}-title`;
  const statusId = `${ids}-status`;

  const [lines, setLines] = useState<ShapeLinesAnswer | null>(null);
  const [report, setReport] = useState<TagListReport | null>(null);
  const [busy, setBusy] = useState<Busy | null>("lines");
  const [message, setMessage] = useState<Message | null>(null);
  const alive = useRef(true);
  const latest = useRef(0); // the number of the newest load: an older answer arriving later is dropped
  const mapping = useRef(false);
  const keep = useRef({ onClose, onMapped });
  keep.current = { onClose, onMapped };

  const requestClose = () => { if (!mapping.current) keep.current.onClose(); };
  useDialogFocus(root, requestClose, { busy: busy === "map", initial: cancel });

  // The page behind is inert while the dialog is open (the shell and the skip link, never the toast stack, which is a sibling). Declared after useDialogFocus on
  // purpose: that hook saves the opener and moves the focus in first. The page comes back first on the way out, and only then can the focus go back to the opener.
  useEffect(() => {
    const made = Array.from(document.querySelectorAll<HTMLElement>(".shell, .skip-link")).filter((el) => !el.hasAttribute("inert"));
    for (const el of made) el.setAttribute("inert", "");
    return () => { for (const el of made) el.removeAttribute("inert"); };
  }, []);

  /** Ask the server for the lines of the decisions and, when nothing blocks, for the planner's dry run of them. `note` is a sentence to keep on screen (why we ask again). */
  async function load(note?: Message) {
    const mine = ++latest.current;
    setBusy("lines");
    setLines(null);
    setReport(null);
    setMessage(note ?? null);
    try {
      const answer = await postShapeLines(sourceId, { decisions, parent_id: parentId, create_assets: createAssets });
      if (!alive.current || mine !== latest.current) return;
      setLines(answer);
      if (answer.blocking || answer.lines === 0) {
        setBusy(null);
        return;
      }
      setBusy("check");
      const dry = await api.postRaw<TagListReport>(dryRunPath(sourceId, createAssets), answer.csv);
      if (!alive.current || mine !== latest.current) return;
      setReport(dry);
      setBusy(null);
    } catch (error) {
      if (!alive.current || mine !== latest.current) return;
      setMessage({ tone: "error", text: reasonOf(error) });
      setBusy(null);
    }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per open: the decisions of a dialog do not change

  const ready = lines !== null && !lines.blocking && lines.lines > 0 && report !== null && !plannerStops(report) && report.mappings_to_create > 0 && busy === null;

  async function map() {
    if (mapping.current || !ready || lines === null || report === null) return;
    mapping.current = true;
    setBusy("map");
    setMessage(null);
    const outliers = outlierTexts(lines.checks);
    let done: TagListReport | null = null;
    let stale: Message | null = null;
    try {
      done = await api.postRaw<TagListReport>(realRunPath(sourceId, createAssets, report), lines.csv);
    } catch (error) {
      const text = reasonOf(error);
      if (error instanceof ApiError && (error.status === 409 || error.status === 422)) {
        // The plan has moved (or a problem line showed up under the locks): the server's sentence, then everything is read again.
        stale = { tone: "error", text: `${text}${/[.!?]$/.test(text) ? "" : "."} The review is read again below: check the new numbers before you press Map.` };
      } else if (alive.current) {
        setMessage({ tone: "error", text });
      }
    } finally {
      // The lists are out of date after a failure too (a 409 means somebody else changed something). Before the person is told: their view must already be right.
      try { await invalidate(...TAG_LIST_REFRESHED); } catch { /* the lists fetch themselves again on their next visit */ }
      mapping.current = false;
      if (alive.current) setBusy(null);
    }
    if (done !== null) {
      toast.success(mappedSentence(done.mappings_to_create, outliers), done.audit_id === null ? undefined : undoOptions(done.audit_id, sourceId, toast, invalidate));
      keep.current.onMapped();
      keep.current.onClose();
      return;
    }
    if (stale !== null && alive.current) void load(stale);
  }

  const checks = lines?.checks ?? [];
  const blocking = lines !== null && (lines.blocking || hasBlocking(checks));
  const status =
    busy === "lines" ? "Asking the server what these decisions would map..."
    : busy === "check" ? "Checking the list with the tag list planner..."
    : busy === "map" ? "Mapping the tags..."
    : message !== null ? message.text
    : lines === null ? ""
    : blocking ? "Some checks block this. Fix them first (choose other shapes or another asset name); nothing has been mapped."
    : lines.lines === 0 ? "Nothing is left to map: every tag of these shapes is mapped already."
    : report !== null && plannerStops(report) ? "The tag list planner found problems with this list. Nothing has been mapped."
    : report !== null ? `${plural(report.mappings_to_create, "tag")} would be mapped. Nothing is mapped until you press Map.`
    : "";
  const label = (key: string) => lines?.by_shape.find((row) => row.shape === key)?.label ?? labelOf(key);
  const goLabel = report !== null && ready ? `Map ${plural(report.mappings_to_create, "point")}` : "Map points";

  return createPortal(
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="dialog shapes-dialog">
        <h2 id={titleId}>{`Review mappings by shape: ${sourceName}`}</h2>
        <p className="muted">
          {`${plural(decisions.length, "shape")} chosen. New assets go ${parentLabel === null ? "at the top level" : `under ${parentLabel}`}${createAssets ? "" : ", and an asset that is missing is a problem"}. The asset names are a guess from the tag text: check the samples.`}
        </p>

        <p id={statusId} className="shapes-status" role="status" data-tone={message?.tone === "error" && busy === null ? "error" : undefined}>{status}</p>
        <div className="shapes-report" role="region" aria-label="Result of the review" tabIndex={0}>
          {lines !== null && (
            <>
              <CheckList checks={checks} label={label} />
              {lines.by_shape.map((row) => (
                <section key={row.shape}>
                  <h3>{row.label}</h3>
                  <p>{shapeCountsSentence(row)}</p>
                  {lines.samples.some((sample) => sample.shape === row.shape) && (
                    <table>
                      <thead><tr><th>Tag</th><th>Address</th><th>Asset</th><th>Unit hint</th><th>Metric</th><th className="num">Scale</th></tr></thead>
                      <tbody>
                        {lines.samples.filter((sample) => sample.shape === row.shape).map((sample, i) => (
                          <tr key={`${i}-${sample.address}`}>
                            <td className="shapes-cell">{sample.tag}</td><td className="shapes-cell">{sample.address}</td><td className="shapes-cell">{sample.asset}</td>
                            <td className="shapes-cell">{sample.unit_hint ?? ""}</td><td className="shapes-cell">{sample.metric}</td><td className="num">{String(sample.scale)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              ))}
              {report !== null && <ReportView report={report} lines={lines.lines} />}
            </>
          )}
        </div>

        <div className="row">
          <button ref={cancel} type="button" className="shapes-cancel" aria-disabled={busy === "map" ? true : undefined} onClick={requestClose}>Cancel</button>
          <button type="button" className="primary shapes-go" aria-disabled={ready ? undefined : true} aria-describedby={statusId} onClick={() => void map()}>{goLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
