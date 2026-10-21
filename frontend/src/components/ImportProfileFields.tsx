import { useId, type ReactNode } from "react";
import type { ImportProfile, ImportReading } from "../api/types";
import { InfoTip } from "./InfoTip";

/** How the time column is written: the three the server knows by name, or a pattern the person writes (`custom`). */
export type TimeFormatChoice = "iso" | "epoch_s" | "epoch_ms" | "custom";

/**
 * The profile as the form holds it: every field is the text of a control. `draftToProfile` makes the body the server takes; nothing here is sent as it is
 * (a blank optional column is `null` there, a period is a number, `stamp` and the period are left out unless the reading is an interval).
 */
export interface ProfileDraft {
  tag: string; time: string; value: string; unit: string; quality: string;
  /** "" = found from the header line, otherwise one of `,` `;` and a tab. */
  delimiter: string;
  decimal: "." | ",";
  timeFormat: TimeFormatChoice; customFormat: string;
  zone: string;
  reading: ImportReading;
  periodSeconds: string;
  /** "" = not chosen yet: an interval needs the person's answer, so there is no default to be wrong by one period. */
  stamp: "" | "start" | "end";
  /** Codes separated by commas. */
  goodCodes: string;
}

export const DEFAULT_DRAFT: ProfileDraft = {
  tag: "tag", time: "timestamp", value: "value", unit: "", quality: "", delimiter: "", decimal: ".",
  timeFormat: "iso", customFormat: "", zone: "", reading: "counter", periodSeconds: "", stamp: "", goodCodes: "good",
};

/** The codes of a "good, ok" list as the server keeps them: trimmed, lower case, each once, in the order written. */
export function parseCodes(text: string): string[] {
  const codes: string[] = [];
  for (const part of text.split(",")) {
    const code = part.trim().toLowerCase();
    if (code !== "" && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

/** A period typed as a whole number of seconds, or null for anything else (blank, 0, 1.5, 1e3, text). */
const wholeSeconds = (text: string): number | null => (/^[0-9]+$/.test(text.trim()) && Number(text) >= 1 ? Number(text) : null);

/** The body of `PUT /api/import-profiles/{name}`: exactly the fourteen fields of the server's model (it refuses any other, and a blank string where it expects a column or `null`). */
export function draftToProfile(name: string, d: ProfileDraft): ImportProfile {
  const optional = (text: string) => (text.trim() === "" ? null : text.trim());
  const interval = d.reading === "interval";
  return {
    name: name.trim(), tag: d.tag.trim(), time: d.time.trim(), value: d.value.trim(), unit: optional(d.unit), quality: optional(d.quality),
    delimiter: d.delimiter === "" ? null : d.delimiter, decimal: d.decimal,
    time_format: d.timeFormat === "custom" ? d.customFormat.trim() : d.timeFormat,
    zone: optional(d.zone), reading: d.reading,
    period_seconds: interval ? wholeSeconds(d.periodSeconds) : null,
    stamp: interval && d.stamp !== "" ? d.stamp : null,
    good_codes: parseCodes(d.goodCodes),
  };
}

/** The form for a saved profile (the name is the dialog's, not a field here). */
export function profileToDraft(p: ImportProfile): ProfileDraft {
  const fixed = p.time_format === "iso" || p.time_format === "epoch_s" || p.time_format === "epoch_ms";
  return {
    tag: p.tag, time: p.time, value: p.value, unit: p.unit ?? "", quality: p.quality ?? "", delimiter: p.delimiter ?? "", decimal: p.decimal,
    timeFormat: fixed ? (p.time_format as TimeFormatChoice) : "custom", customFormat: fixed ? "" : p.time_format,
    zone: p.zone ?? "", reading: p.reading, periodSeconds: p.period_seconds === null ? "" : String(p.period_seconds), stamp: p.stamp ?? "",
    goodCodes: p.good_codes.join(", "),
  };
}

/** True when two profiles are the same layout under the same name (an absent optional field and a null are the same). */
export function sameProfile(a: ImportProfile, b: ImportProfile): boolean {
  const key = (p: ImportProfile) => JSON.stringify([
    p.name, p.tag, p.time, p.value, p.unit ?? null, p.quality ?? null, p.delimiter ?? null, p.decimal, p.time_format, p.zone ?? null,
    p.reading, p.period_seconds ?? null, p.stamp ?? null, p.good_codes,
  ]);
  return key(a) === key(b);
}

/**
 * The first thing in the layout that no server would accept, in a sentence, or null. Only the plain cases: the server judges the rest
 * (a time zone name, a pattern that cannot read its own output, two columns with one name) and its sentence is shown as it is.
 */
export function draftProblem(d: ProfileDraft): string | null {
  if (d.tag.trim() === "") return "Name the column that holds the tag: the text at the top of that column.";
  if (d.time.trim() === "") return "Name the column that holds the time: the text at the top of that column.";
  if (d.value.trim() === "") return "Name the column that holds the value: the text at the top of that column.";
  if (d.decimal === "," && d.delimiter === ",") return "A decimal comma needs another delimiter: a semicolon or a tab.";
  if (d.timeFormat === "custom" && d.customFormat.trim() === "") return "Write the time format, for example %d.%m.%Y %H:%M.";
  if (d.reading === "interval") {
    if (wholeSeconds(d.periodSeconds) === null) return "Say how many seconds one period lasts, as a whole number such as 3600.";
    if (d.stamp === "") return "Say whether the time marks the start or the end of each period.";
  }
  return null;
}

/** A label with the `?` explanation beside it (never inside it: a name made of both would match twice). */
function LabelRow({ id, text, tip }: { id: string; text: string; tip?: ReactNode }) {
  return tip === undefined ? <label htmlFor={id}>{text}</label> : (
    <div className="import-label-row">
      <label htmlFor={id}>{text}</label>
      <InfoTip>{tip}</InfoTip>
    </div>
  );
}

/**
 * The layout of a CSV export, as the controls of one profile (the name and the choice of a saved profile are the dialog's). Controlled: `draft` is
 * the state, `onChange` gets the whole next draft. `disabled` while the dialog is busy. The defaults are `DEFAULT_DRAFT`'s.
 */
export function ImportProfileFields({ draft, onChange, disabled = false }: { draft: ProfileDraft; onChange: (next: ProfileDraft) => void; disabled?: boolean }) {
  const ids = useId();
  const id = (part: string) => `${ids}-${part}`;
  const set = <K extends keyof ProfileDraft>(key: K, value: ProfileDraft[K]) => onChange({ ...draft, [key]: value });
  const text = (key: "tag" | "time" | "value" | "unit" | "quality" | "zone" | "customFormat" | "periodSeconds" | "goodCodes", label: string, tip?: ReactNode, extra: { placeholder?: string; inputMode?: "numeric" } = {}) => (
    <div className="field">
      <LabelRow id={id(key)} text={label} tip={tip} />
      <input
        id={id(key)} value={draft[key]} disabled={disabled} autoComplete="off" spellCheck={false}
        placeholder={extra.placeholder} inputMode={extra.inputMode} onChange={(e) => set(key, e.target.value)}
      />
    </div>
  );
  const interval = draft.reading === "interval";
  return (
    <div className="import-fields">
      {text("tag", "Tag column", "The text at the top of the column that names the meter or point, written as this source knows it (the point's address). A row whose tag is not a point of this source is counted and skipped.")}
      {text("time", "Time column")}
      {text("value", "Value column")}
      {text("unit", "Unit column (optional)", undefined, { placeholder: "none" })}
      {text("quality", "Quality column (optional)", undefined, { placeholder: "none" })}
      <div className="field">
        <label htmlFor={id("delimiter")}>Delimiter</label>
        <select id={id("delimiter")} value={draft.delimiter} disabled={disabled} onChange={(e) => set("delimiter", e.target.value)}>
          <option value="">Find it from the header line</option>
          <option value=",">Comma</option>
          <option value=";">Semicolon</option>
          <option value={"\t"}>Tab</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor={id("decimal")}>Decimal mark</label>
        <select id={id("decimal")} value={draft.decimal} disabled={disabled} onChange={(e) => set("decimal", e.target.value as "." | ",")}>
          <option value=".">Point (1234.5)</option>
          <option value=",">Comma (1234,5)</option>
        </select>
      </div>
      <div className="field">
        <LabelRow
          id={id("timeFormat")} text="Time format"
          tip="How the time column is written. ISO 8601 looks like 2026-03-29T13:45:06+02:00 and carries its own zone (or Z). Seconds or milliseconds since 1970 are plain numbers. Anything else is a custom pattern."
        />
        <select id={id("timeFormat")} value={draft.timeFormat} disabled={disabled} onChange={(e) => set("timeFormat", e.target.value as TimeFormatChoice)}>
          <option value="iso">ISO 8601 (with a zone or Z)</option>
          <option value="epoch_s">Seconds since 1970</option>
          <option value="epoch_ms">Milliseconds since 1970</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      {draft.timeFormat === "custom" && (
        <div className="field">
          <label htmlFor={id("customFormat")}>Custom time format</label>
          <input
            id={id("customFormat")} value={draft.customFormat} disabled={disabled} autoComplete="off" spellCheck={false}
            placeholder="%d.%m.%Y %H:%M" aria-describedby={id("customHint")} onChange={(e) => set("customFormat", e.target.value)}
          />
          <p id={id("customHint")} className="muted import-hint">Allowed parts: %Y %m %d %H %M %S %f %z, with plain characters between them. The year, month and day are required.</p>
        </div>
      )}
      {text("zone", "Time zone (optional)", "Only for times written without a zone or offset: the zone of the clock that wrote them, such as Africa/Cairo or UTC. Leave it empty when every time carries its own zone.", { placeholder: "Africa/Cairo" })}
      <div className="field">
        <LabelRow
          id={id("reading")} text="Value means"
          tip="A running total counts up like a meter reading (kWh). An instantaneous value is one reading at one moment (kW, V, A). A total per period is one amount for each hour, day or other period."
        />
        <select id={id("reading")} value={draft.reading} disabled={disabled} onChange={(e) => set("reading", e.target.value as ImportReading)}>
          <option value="counter">A running total (counter)</option>
          <option value="power">A value at one moment (power)</option>
          <option value="interval">A total for one period (interval)</option>
        </select>
      </div>
      {interval && text("periodSeconds", "Period in seconds", undefined, { placeholder: "3600", inputMode: "numeric" })}
      {interval && (
        <div className="field">
          <LabelRow id={id("stamp")} text="The time marks the" tip="Whether the time in each row is when its period began or when it ended. Choosing wrongly moves every value by one period." />
          <select id={id("stamp")} value={draft.stamp} disabled={disabled} onChange={(e) => set("stamp", e.target.value as ProfileDraft["stamp"])}>
            <option value="">Choose...</option>
            <option value="start">Start of the period</option>
            <option value="end">End of the period</option>
          </select>
        </div>
      )}
      {text("goodCodes", "Good quality codes", "The quality values that count as good, separated by commas. Any other value is stored as bad quality. An empty cell, or no quality column, counts as good.")}
    </div>
  );
}
