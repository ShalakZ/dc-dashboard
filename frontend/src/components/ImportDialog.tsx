import { useId, useRef, useState, type ChangeEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import { keys, useDeleteImportProfile, useImportProfiles, useInvalidate, useSaveImportProfile } from "../api/queries";
import type { ImportProfile, ImportReport } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useDialogFocus } from "../hooks/useDialogFocus";
import { CLOSED_MONTH_NOTE, closedMonthLines, importButtonText, importSentence, rejectedText } from "../lib/importReport";
import { upperFirst } from "../lib/upperFirst";
import { Icon } from "./Icon";
import { DEFAULT_DRAFT, ImportProfileFields, draftProblem, draftToProfile, profileToDraft, sameProfile, type ProfileDraft } from "./ImportProfileFields";
import { useToast } from "./Toasts";

/** The largest file the server takes (importer.MAX_BYTES). A bigger one is refused here, before a byte is read. */
const MAX_BYTES = 20 * 1024 * 1024;
/** The longest file name shown: a name is only displayed, never opened or sent. */
const NAME_CLIP = 60;
const MAX_PROFILE_NAME = 60;

const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string) => `${num(n)} ${n === 1 ? one : `${one}s`}`;
const rowsText = (n: number) => plural(n, "row");

/** A file name as shown: clipped to NAME_CLIP characters (by code point, so a pair is never cut in two). */
function clipName(name: string): string {
  const chars = [...name];
  return chars.length > NAME_CLIP ? `${chars.slice(0, NAME_CLIP - 1).join("")}…` : name;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The server's own sentences for a file it cannot read (importer.pre_scan), used when the browser finds the same fault first. */
const UTF16_SENTENCE =
  "This file is saved as UTF-16 (or UTF-32), which the import does not read; open it in a spreadsheet or a text editor, save it as CSV UTF-8 and choose it again.";
const NOT_UTF8_SENTENCE = "This file is not UTF-8 text; save it as CSV UTF-8 and choose it again.";

function readBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(new Error("The file could not be read. Choose it again."));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * The text of the file, decoded strictly as UTF-8. Not `readAsText`: that follows a byte order mark into UTF-16 and replaces every bad byte with a
 * replacement character, so the server would never see the fault it refuses with a sentence of its own. The BOM of a UTF-8 file is dropped by the
 * decoder (the server accepts the file with or without it). The check and the import both read the file here, so the text, and the SHA-256 the server
 * computes from it, is the same on both.
 */
async function readCsvText(file: File): Promise<string> {
  const bytes = await readBytes(file);
  if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) throw new Error(UTF16_SENTENCE);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(NOT_UTF8_SENTENCE);
  }
}

/** `dry_run` is always written out: the server's default is a check, but a request that says what it is cannot be misread. */
function importPath(sourceId: number, profile: string, dryRun: boolean, sha256?: string): string {
  const query = new URLSearchParams({ profile, dry_run: dryRun ? "1" : "0" });
  if (sha256 !== undefined) query.set("expect_sha256", sha256);
  return `/api/sources/${sourceId}/import?${query}`;
}

type Busy = "check" | "import" | "save" | "delete";
interface Note { text: string; error: boolean }

/** What a person reads under a check or an import: the sentence, then the details that need a person's eye (none of them when there is nothing to say). Every cell is a React text node, never markup. */
function ReportView({ report }: { report: ImportReport }) {
  const closed = closedMonthLines(report);
  const reasons = Object.entries(report.rejected_by).filter(([, n]) => n > 0).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const badQuality = Object.entries(report.bad_quality ?? {}).filter(([, n]) => n > 0).sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  const names = report.unknown_tags.names;
  const valueText = (v: number | null) => (v === null ? "no value" : String(v));
  const badQualityRows = badQuality.reduce((sum, [, n]) => sum + n, 0);
  const counterWarnings = report.counter_warnings ?? [];
  const counterWarningsTotal = report.counter_warnings_total ?? 0;
  return (
    <div className="import-body">
      <p className={report.complete ? "import-sentence" : "import-sentence import-warn"}>
        {!report.complete && <Icon name="alert" />}
        <span>
          {importSentence(report)}
          {!report.complete && report.dry_run && report.error ? ` ${upperFirst(report.error)}` : ""}
        </span>
      </p>
      {report.dry_run && report.complete && report.new === 0 && <p className="muted">There is nothing new to import from this file.</p>}
      {report.differing > 0 && (
        <div>
          <p className="import-head">Different from what is stored</p>
          <p className="muted">{rowsText(report.differing)} {report.differing === 1 ? "carries" : "carry"} another value for a time that is stored already. The stored value is kept.</p>
          {report.differing_samples.length > 0 && (
            <ul className="import-list">
              {report.differing_samples.map((s, i) => (
                <li key={`${s.tag}-${s.ts}-${i}`}>
                  <span className="import-cell">{s.tag}</span> at {s.ts}: stored {valueText(s.stored)}, file {valueText(s.file)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {reasons.length > 0 && (
        <div>
          <p className="import-head">Rows that were not accepted</p>
          <ul className="import-list">
            {reasons.map(([code, n]) => <li key={code}>{rejectedText(code)}: {rowsText(n)}</li>)}
          </ul>
        </div>
      )}
      {badQuality.length > 0 && (
        <div>
          <p className="import-head">Quality other than good</p>
          <p className="muted">
            {badQualityRows === 1
              ? "This row of the file has a quality other than good. If it is new, it is stored as bad quality and counts in no figure."
              : "These rows of the file have a quality other than good. The new ones are stored as bad quality and count in no figure."}
          </p>
          <ul className="import-list">{badQuality.map(([label, n]) => <li key={label}>{label}: {rowsText(n)}</li>)}</ul>
        </div>
      )}
      {counterWarningsTotal > 0 && (
        <div>
          <p className="import-head">Counter values to look at</p>
          <p className="muted">These energy counter values go down, or jump by a lot. They are stored all the same; check the file before you import it.</p>
          {counterWarnings.length > 0 && (
            <ul className="import-list">
              {counterWarnings.map((w, i) => (
                <li key={`${w.tag}-${w.ts}-${i}`}>
                  <span className="import-cell">{w.tag}</span> at {w.ts}: {valueText(w.value)} after {valueText(w.previous)}
                </li>
              ))}
            </ul>
          )}
          {counterWarningsTotal > counterWarnings.length && <p className="muted">The first {num(counterWarnings.length)} of {num(counterWarningsTotal)} {counterWarnings.length === 1 ? "is" : "are"} shown.</p>}
        </div>
      )}
      {report.unknown_rows > 0 && (
        <div>
          <p className="import-head">Tags this source does not have</p>
          <p className="muted">{rowsText(report.unknown_rows)} for {plural(report.unknown_tags.count, "tag")} {report.unknown_rows === 1 ? "is" : "are"} skipped: an import never creates a point.</p>
          {names.length > 0 && (
            <ul className="import-list">
              {names.map((tag, i) => <li key={`${tag}-${i}`}><span className="import-cell">{tag}</span></li>)}
            </ul>
          )}
          {report.unknown_tags.count > names.length && <p className="muted">and {num(report.unknown_tags.count - names.length)} more</p>}
        </div>
      )}
      {closed.length > 0 && (
        <div>
          <p className="import-head">Closed billing months</p>
          <ul className="import-list">{closed.map((line) => <li key={line}>{line}</li>)}</ul>
          <p className="muted">{CLOSED_MONTH_NOTE}</p>
        </div>
      )}
      {report.problems.length > 0 && (
        <div>
          <p className="import-head">Problem lines</p>
          <ul className="import-list">
            {report.problems.map((p, i) => <li key={`${p.line}-${i}`}>Line {num(p.line)}: {rejectedText(p.reason)}</li>)}
          </ul>
          {report.problems_total > report.problems.length && <p className="muted">The first {num(report.problems.length)} of {num(report.problems_total)} {report.problems.length === 1 ? "is" : "are"} shown.</p>}
        </div>
      )}
      {!report.dry_run && report.refresh.state === "failed" && (
        <p className="import-sentence import-warn">
          <Icon name="alert" />
          <span>{upperFirst(report.refresh.note ?? "the summaries over the imported hours could not be refreshed")}.</span>
        </p>
      )}
    </div>
  );
}

/**
 * Import readings from a CSV file into one source (w31): choose the file, choose or describe its layout (a profile), check it, read what an import would do,
 * and import. A check stores nothing; the only way to store is the button "Import N rows", which works only on the report of a check of THIS file with
 * THIS profile (changing either clears the report) and sends the SHA-256 of what was checked, so the server stores exactly that file.
 *
 * The profile a check uses is the saved one, chosen by name: a new or changed profile is saved (PUT) first and the dialog says so. The file is read in
 * the browser and sent as the request body (`api.postRaw`, text/csv). The controls wait (natively disabled) while a request runs, and the buttons wait
 * with aria-disabled, because one of them holds the focus; a second press does nothing (a ref, not state: state arrives a render late). Escape and Close
 * do nothing while a request runs. A failed real import clears the report: a re-check is the only way on, and what it stored shows up there as "already there".
 * What an import can make stale (the source list, assets, fleet, billing, the widgets, the audit log) is read again once the real import settles, whether
 * it worked or not. The caller mounts this when the row menu's "Import file..." is chosen.
 */
export function ImportDialog({ source, onClose }: { source: { id: number; name: string }; onClose: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const invalidate = useInvalidate();
  const profiles = useImportProfiles(can("readings.import"));
  const saveProfile = useSaveImportProfile();
  const deleteProfile = useDeleteImportProfile();

  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const checkButton = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const ids = useId();
  const id = (part: string) => `${ids}-${part}`;

  const [file, setFile] = useState<File | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [selected, setSelected] = useState(""); // "" = a new profile
  const [name, setName] = useState("");
  const [draft, setDraft] = useState<ProfileDraft>(DEFAULT_DRAFT);
  const [baseline, setBaseline] = useState<ImportProfile | null>(null); // the profile as the server keeps it: what the form is compared with
  const [fieldsOpen, setFieldsOpen] = useState(true);
  const [profileNote, setProfileNote] = useState<Note | null>(null);
  const [result, setResult] = useState<{ report: ImportReport; profile: string } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy | null>(null);

  const saved = profiles.data ?? [];
  const names = saved.map((p) => p.name);
  const options = selected !== "" && !names.includes(selected) ? [...names, selected] : names;
  const report = result?.report ?? null;
  const ready = busy === null && file !== null && report !== null && report.dry_run && report.complete && report.new > 0;

  const requestClose = () => { if (!inFlight.current) onClose(); };
  useDialogFocus(root, requestClose, { busy: busy !== null, initial: fileInput });

  /** One request at a time. */
  async function run(kind: Busy, work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    try {
      await work();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  /** Whatever was checked is not about what is on screen any more. */
  const forgetReport = () => { setResult(null); setRunError(null); };

  function pick(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    forgetReport();
    setFileNote(null);
    if (chosen && chosen.size > MAX_BYTES) {
      setFile(null);
      setFileNote(`This file is ${sizeText(chosen.size)}; the limit is ${MAX_BYTES / (1024 * 1024)} MB. Split it into several files.`);
      event.target.value = ""; // choosing the same file again must raise a change again
      return;
    }
    setFile(chosen);
  }

  function choose(value: string) {
    forgetReport();
    setProfileNote(null);
    setSelected(value);
    if (value === "") { // a new profile keeps the fields on screen: it is also how a saved one is copied under another name
      setName("");
      setBaseline(null);
      setFieldsOpen(true);
      return;
    }
    const found = saved.find((p) => p.name === value);
    if (found) {
      setDraft(profileToDraft(found));
      setBaseline(found);
      setFieldsOpen(false);
    }
  }

  function changeDraft(next: ProfileDraft) {
    forgetReport();
    setProfileNote(null);
    setDraft(next);
  }

  function changeName(value: string) {
    forgetReport();
    setProfileNote(null);
    setName(value);
  }

  const formProfile = (): ImportProfile => draftToProfile(selected === "" ? name : selected, draft);

  /** The first fault in the profile a person can fix before anything is sent, or null. */
  function formProblem(): string | null {
    if (selected === "") {
      const trimmed = name.trim();
      if (trimmed === "") return "Name the profile, so it can be saved and used for the check.";
      if ([...trimmed].length > MAX_PROFILE_NAME) return `The profile name can have at most ${MAX_PROFILE_NAME} characters.`;
      if (/[/\\]/.test(trimmed) || trimmed === "." || trimmed === "..") return 'The profile name cannot contain "/" or "\\", and cannot be "." or "..".';
      if (names.includes(trimmed)) return `A profile named "${trimmed}" exists already. Choose it in the list, or use another name.`;
    }
    return draftProblem(draft);
  }

  /** Save the profile as the form holds it; null (and the server's sentence under the profile) when it is refused. */
  async function persist(profile: ImportProfile): Promise<ImportProfile | null> {
    try {
      const stored = await saveProfile.mutateAsync(profile);
      setBaseline(stored);
      setSelected(stored.name);
      setName(stored.name);
      return stored;
    } catch (e) {
      setProfileNote({ text: upperFirst(messageOf(e)), error: true });
      return null;
    }
  }

  function saveClick() {
    if (inFlight.current) return;
    const problem = formProblem();
    if (problem) { setProfileNote({ text: problem, error: true }); return; }
    void run("save", async () => {
      const stored = await persist(formProfile());
      if (stored) setProfileNote({ text: `Profile "${stored.name}" saved.`, error: false });
    });
  }

  function deleteClick() {
    if (inFlight.current || selected === "") return;
    const target = selected;
    void run("delete", async () => {
      try {
        await deleteProfile.mutateAsync(target);
        forgetReport();
        setSelected("");
        setName("");
        setBaseline(null);
        setFieldsOpen(true);
        setProfileNote({ text: `Profile "${target}" deleted.`, error: false });
      } catch (e) {
        setProfileNote({ text: upperFirst(messageOf(e)), error: true });
      }
    });
  }

  function checkClick() {
    if (inFlight.current) return;
    if (!file) {
      setFileNote("Choose a file to check.");
      fileInput.current?.focus();
      return;
    }
    const problem = formProblem();
    if (problem) { setProfileNote({ text: problem, error: true }); return; }
    const chosen = file;
    void run("check", async () => {
      forgetReport();
      setFileNote(null);
      setProfileNote(null);
      let body: string;
      try {
        body = await readCsvText(chosen);
      } catch (e) {
        setFileNote(messageOf(e));
        return;
      }
      const wanted = formProfile();
      let used: ImportProfile;
      if (baseline && sameProfile(baseline, wanted)) {
        used = baseline;
      } else {
        const changed = baseline !== null && baseline.name === wanted.name;
        const stored = await persist(wanted);
        if (!stored) return;
        used = stored;
        setProfileNote({ text: `${changed ? "Changes to profile" : "Profile"} "${used.name}" saved before the check.`, error: false });
      }
      try {
        const out = await api.postRaw<ImportReport>(importPath(source.id, used.name, true), body);
        setResult({ report: out, profile: used.name });
      } catch (e) {
        setRunError(upperFirst(messageOf(e)));
      }
    });
  }

  function importClick() {
    if (inFlight.current || !ready || !file || !result) return;
    const { report: checked, profile } = result;
    const chosen = file;
    void run("import", async () => {
      setRunError(null);
      let body: string;
      try {
        body = await readCsvText(chosen);
      } catch (e) {
        setFileNote(messageOf(e));
        setResult(null);
        return;
      }
      try {
        const out = await api.postRaw<ImportReport>(importPath(source.id, profile, false, checked.sha256), body);
        setResult({ report: out, profile });
        if (out.complete) toast.success(`Imported ${rowsText(out.new)} into ${source.name}`);
      } catch (e) {
        // Rows may be stored (a 500 after some batches) or none (a 409: the file differs, or another import is running). Either way the check is void.
        setResult(null);
        setRunError(upperFirst(messageOf(e)));
        checkButton.current?.focus(); // Import waits now; the way on is a new check, and the focus was on the button that just went quiet
      } finally {
        void invalidate(keys.sources, keys.assets, keys.fleet, keys.billing, keys.widgetData, keys.auditAll);
      }
    });
  }

  const goLabel =
    busy === "import" ? "Importing…"
    : report?.dry_run && report.complete ? importButtonText(report)
    : report && !report.dry_run && report.complete ? "Imported"
    : "Import rows";
  const aria = (waiting: boolean) => (waiting ? true : undefined);
  const titleId = id("title");
  const listError = profiles.error ? `Could not load the saved profiles: ${profiles.error.message}` : null;
  const shownProfileNote: Note | null = profileNote ?? (listError ? { text: listError, error: true } : null);

  return createPortal(
    <div className="dialog-backdrop">
      <div ref={root} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className="dialog import-dialog">
        <h2 id={titleId}>Import readings: {source.name}</h2>

        <div className="field">
          <label htmlFor={id("file")}>File</label>
          <input
            ref={fileInput} id={id("file")} type="file" accept=".csv,.txt,text/csv,text/plain" disabled={busy !== null}
            aria-describedby={id("file-note")} onChange={pick}
          />
          <div id={id("file-note")} className="import-slot">
            {fileNote ? <p className="error">{fileNote}</p>
              : file ? <p>{clipName(file.name)} ({sizeText(file.size)})</p>
              : <p className="muted">A CSV file with a header line, up to {MAX_BYTES / (1024 * 1024)} MB.</p>}
          </div>
        </div>

        <div className="import-profile">
          <div className="import-pair">
            <div className="field">
              <label htmlFor={id("profile")}>Profile</label>
              <select id={id("profile")} value={selected} disabled={busy !== null} aria-describedby={id("profile-note")} onChange={(e) => choose(e.target.value)}>
                <option value="">New profile</option>
                {options.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            {selected === "" && (
              <div className="field">
                <label htmlFor={id("name")}>Profile name</label>
                <input
                  id={id("name")} value={name} maxLength={MAX_PROFILE_NAME} disabled={busy !== null} autoComplete="off"
                  aria-invalid={profileNote?.error && name.trim() === "" ? true : undefined} aria-describedby={id("profile-note")}
                  onChange={(e) => changeName(e.target.value)}
                />
              </div>
            )}
          </div>
          <div id={id("profile-note")} className="import-slot">
            {shownProfileNote && <p className={shownProfileNote.error ? "error" : "muted"}>{shownProfileNote.text}</p>}
          </div>
          <div className="row import-tools">
            <button
              type="button" className="quiet import-toggle" aria-expanded={fieldsOpen} aria-controls={fieldsOpen ? id("fields") : undefined}
              onClick={() => setFieldsOpen((open) => !open)}
            >
              Profile fields<Icon name={fieldsOpen ? "caretUp" : "caret"} />
            </button>
            <span className="spacer" />
            <button type="button" className="import-save" aria-disabled={aria(busy !== null)} onClick={saveClick}>Save profile</button>
            {selected !== "" && <button type="button" className="import-delete" aria-disabled={aria(busy !== null)} onClick={deleteClick}>Delete profile</button>}
          </div>
          {fieldsOpen && (
            <div id={id("fields")}>
              <ImportProfileFields draft={draft} onChange={changeDraft} disabled={busy !== null} />
            </div>
          )}
        </div>

        <div
          className="import-report" role="region" aria-label="Report of the check" tabIndex={0} aria-live="polite"
          aria-busy={busy === "check" || busy === "import" ? true : undefined}
        >
          {busy === "check" ? <p className="muted">Checking the file…</p>
            : busy === "import" ? <p className="muted">Importing… a large file can take a minute. Keep this window open.</p>
            : runError ? <p className="error">{runError}</p>
            : report ? <ReportView report={report} />
            : <p className="muted">Check the file to see what an import would do. Nothing is stored until you import.</p>}
        </div>

        <div className="row import-foot">
          <button type="button" className="import-close" aria-disabled={aria(busy !== null)} onClick={requestClose}>Close</button>
          <button ref={checkButton} type="button" className="import-check" aria-disabled={aria(busy !== null)} onClick={checkClick}>Check file</button>
          <button type="button" className="primary import-go" aria-disabled={aria(!ready)} onClick={importClick}>{goLabel}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
