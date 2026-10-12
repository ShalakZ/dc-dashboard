import { useRef, useState, type FormEvent } from "react";
import { useBuildReport, useSources } from "../api/queries";
import type { ReportDetail, ReportReply } from "../api/types";
import { ConnectionCheck } from "../components/ConnectionCheck";
import { PageHeader } from "../components/PageHeader";
import { copyText, partSize, reportFileName, reportText, saveTextFile } from "../lib/diagnostics";

const DETAIL_HELP: Record<ReportDetail, string> = {
  summary: "Summary: one paste with the latest connection check, the sources and the newest events. Start with this one.",
  full: "Full: everything, up to about 60,000 characters in several parts. Send it when asked.",
};

function AddressKey({ legend }: { legend: ReportReply["legend"] }) {
  return (
    <details className="address-key">
      <summary>Address key</summary>
      <p className="muted">Which alias stands for which host or address. It is not in the text above or in the downloaded file; keep it to read the answer.</p>
      {legend.length === 0 ? (
        <p>No host or address needed hiding in this report.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Alias</th><th>Original</th></tr></thead>
            <tbody>{legend.map((entry) => <tr key={entry.alias}><td>{entry.alias}</td><td className="wrap-any">{entry.original}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </details>
  );
}

function ReportResult({ report }: { report: ReportReply }) {
  const areas = useRef<Record<number, HTMLTextAreaElement | null>>({});
  const [copied, setCopied] = useState<{ index: number; ok: boolean } | null>(null);
  const n = report.parts.length;
  const characters = report.parts.reduce((sum, part) => sum + part.chars, 0);
  const copy = async (index: number, text: string) => {
    setCopied({ index, ok: await copyText(text, areas.current[index] ?? null) });
  };
  return (
    <>
      <div className="report-bar">
        <p role="status" className="report-built">
          Built a {report.detail} report in {n} {n === 1 ? "part" : "parts"}, {characters.toLocaleString("en-US")} characters, build {report.build_id}
          {report.mask ? ", host names and addresses hidden." : "."}
        </p>
        <button type="button" onClick={() => saveTextFile(reportFileName(report), reportText(report))}>Download .txt</button>
      </div>
      {report.parts.map((part) => (
        <div key={part.index} className="report-part">
          <div className="report-part-head">
            <h3>Part {part.index} of {part.of}</h3>
            <span className="muted">{partSize(part)}</span>
          </div>
          <textarea
            ref={(el) => { areas.current[part.index] = el; }}
            className="report-text"
            readOnly
            wrap="off"
            spellCheck={false}
            rows={14}
            aria-label={`Report part ${part.index} of ${part.of}`}
            value={part.text}
          />
          <div className="row">
            <button type="button" onClick={() => void copy(part.index, part.text)}>Copy part {part.index} of {part.of}</button>
            {copied?.index === part.index && (
              <span role="status" className={copied.ok ? "muted" : "warning"}>
                {copied.ok ? `Copied part ${part.index} of ${part.of}.` : "The browser would not copy it. The text is selected: press Ctrl+C."}
              </span>
            )}
          </div>
        </div>
      ))}
      {report.mask && <AddressKey legend={report.legend} />}
    </>
  );
}

export function DiagnosticsPage() {
  const sources = useSources();
  const build = useBuildReport();
  const [detail, setDetail] = useState<ReportDetail>("summary");
  const [mask, setMask] = useState(false);
  const [source, setSource] = useState<number | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    build.mutate({ detail, mask, source });
  };
  return (
    <section className="admin-page diag-page">
      <PageHeader title="Diagnostics" sub="One report to paste when something does not work, and a step-by-step check of a source's connection." />
      <div className="form-card wide">
        <h2 className="section-title">Report</h2>
        <form className="report-form" onSubmit={submit}>
          <fieldset>
            <legend>Detail</legend>
            <label><input type="radio" name="report-detail" checked={detail === "summary"} onChange={() => setDetail("summary")} />Summary</label>
            <label><input type="radio" name="report-detail" checked={detail === "full"} onChange={() => setDetail("full")} />Full</label>
            <p className="muted">{DETAIL_HELP[detail]}</p>
          </fieldset>
          <label>
            Limit to one source
            <select value={source ?? ""} onChange={(e) => setSource(e.target.value === "" ? null : Number(e.target.value))}>
              <option value="">All sources</option>
              {sources.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label><input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} />Hide host names and addresses</label>
          <p className="muted">
            A report names the machines of your network. Tick this to replace every host name and address with HOST-1, HOST-2 and so on;
            the key stays on this page. Passwords and keys are never in a report.
          </p>
          <div className="row">
            <button type="submit" className="primary" disabled={build.isPending}>Build report</button>
            {build.isPending && <span className="muted" role="status">Building the report…</span>}
          </div>
          {build.isError && <p className="error" role="alert">{build.error.message}</p>}
        </form>
        {build.data ? <ReportResult report={build.data} /> : !build.isPending && <p className="muted">Nothing built yet. Choose the detail and press Build report.</p>}
      </div>
      <div className="form-card wide">
        <h2 className="section-title">Connection check</h2>
        <p className="muted">Runs the steps one after the other and shows where a connection stops. It only reads from the source.</p>
        <ConnectionCheck />
      </div>
    </section>
  );
}
