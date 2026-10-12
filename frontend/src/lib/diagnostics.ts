import type { CheckStep, CheckStepError, ConnectionCheckResult, ReportPart, ReportReply } from "../api/types";

/** The check polls for this long before the page says it is still going (a full OPC UA check has a 60 s budget of its own). */
export const CHECK_MAX_WAIT_MS = 120_000;

/** Step names the backend sends, for a stored result that lacks one (the collector's names win). */
const STEP_NAMES: Record<string, string> = {
  dns: "DNS resolution", tcp: "TCP connection", endpoints: "Server endpoints", certificates: "Certificates", session: "Session",
  server_time: "Server clock", namespaces: "Namespaces", read_points: "Reading the points", timing: "Read timing", test: "Connection test",
};

export const stepLabel = (step: Pick<CheckStep, "id" | "name">): string => step.name || STEP_NAMES[step.id] || step.id;

export type StepState = "ok" | "failed" | "skipped";
export const stepState = (step: Pick<CheckStep, "ok">): StepState => (step.ok === true ? "ok" : step.ok === false ? "failed" : "skipped");

/** "12 ms", "1.2 s"; nothing for a step that did not run. */
export function formatMs(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** The exact error of a failed step on one line: `BadUserAccessDenied (0x801F0000): the user has no access`. The class is shown when it adds something. */
export function describeStepError(error: CheckStepError | null | undefined): string {
  if (!error) return "";
  const parts: string[] = [];
  if (error.class && error.class !== error.status_name) parts.push(error.class);
  if (error.status_name) parts.push(error.status_hex ? `${error.status_name} (${error.status_hex})` : error.status_name);
  else if (error.status_hex) parts.push(`(${error.status_hex})`);
  const head = parts.join(" / ");
  if (!error.message) return head;
  return head ? `${head}: ${error.message}` : error.message;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A job's `result` as a check result, or null when it is not one (nothing yet, or `{ "error": ... }` of a failed job). */
export function asCheckResult(result: unknown): ConnectionCheckResult | null {
  if (!isRecord(result) || !Array.isArray(result.steps)) return null;
  const steps = result.steps.filter(isRecord).map((s) => s as unknown as CheckStep);
  return { ...(result as unknown as ConnectionCheckResult), steps };
}

/** The line above the steps once the check is over. */
export function checkVerdict(result: ConnectionCheckResult): string {
  if (result.ok === true) return "Every step passed.";
  if (result.ok === false) {
    const failed = result.steps.find((s) => s.id === result.first_failed) ?? result.steps.find((s) => s.ok === false);
    return failed ? `The check failed at: ${stepLabel(failed)}.` : "The check failed.";
  }
  return "The check finished without a verdict.";
}

/** "1 character", "12,034 characters". */
const count = (n: number, noun: string) => `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;

/** "12,034 characters, 210 lines": the server's figures, which are the ones in the part's footer line (line breaks are not counted). */
export const partSize = (part: Pick<ReportPart, "chars" | "lines">): string => `${count(part.chars, "character")}, ${count(part.lines, "line")}`;

/** The whole report as one text, exactly what `format=text` returns: the parts with one blank line between them. */
export const reportText = (report: Pick<ReportReply, "parts">): string => report.parts.map((p) => p.text).join("\n\n");

/** `dcdash-report-227bd6a-summary.txt`; the build id is made safe for a file name. */
export function reportFileName(report: Pick<ReportReply, "build_id" | "detail" | "mask">): string {
  const build = report.build_id.replace(/[^\w.-]+/g, "_") || "build";
  return `dcdash-report-${build}-${report.detail}${report.mask ? "-masked" : ""}.txt`;
}

/** Hands text the page already holds to the browser as a UTF-8 file. No request is made. */
export function saveTextFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Puts `text` on the clipboard. The clipboard API only exists in a secure context (https or localhost), so otherwise (and when it
 * refuses) the text area's own selection is copied the old way. Resolves false when neither worked; the text is then left selected.
 */
export async function copyText(text: string, area: HTMLTextAreaElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // refused (no permission, or the page lacks focus): fall through to the selection
  }
  if (!area) return false;
  area.focus();
  area.select();
  try {
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  }
}
