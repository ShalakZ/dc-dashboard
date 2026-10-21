import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { ImportProfile } from "../api/types";
import {
  DEFAULT_DRAFT, ImportProfileFields, draftProblem, draftToProfile, parseCodes, profileToDraft, sameProfile, type ProfileDraft,
} from "./ImportProfileFields";

const SERVER_FIELDS = [
  "name", "tag", "time", "value", "unit", "quality", "delimiter", "decimal", "time_format", "zone", "reading", "period_seconds", "stamp", "good_codes",
];

const saved = (over: Partial<ImportProfile> = {}): ImportProfile => ({
  name: "hourly", tag: "tag", time: "timestamp", value: "value", unit: null, quality: null, delimiter: null, decimal: ".", time_format: "iso",
  zone: null, reading: "counter", period_seconds: null, stamp: null, good_codes: ["good"], ...over,
});

describe("draftToProfile (the body of PUT /api/import-profiles/{name})", () => {
  it("turns the defaults into exactly the fourteen fields of the server's model, with null for what is left out", () => {
    const body = draftToProfile("hourly", DEFAULT_DRAFT);
    expect(body).toEqual(saved());
    expect(Object.keys(body).sort()).toEqual([...SERVER_FIELDS].sort());
  });

  it("trims every text, sends a blank unit, quality or zone as null (a blank string is a 422) and keeps a tab delimiter as a tab", () => {
    const body = draftToProfile("  night export ", {
      ...DEFAULT_DRAFT, tag: " meter ", time: " when ", value: " kwh ", unit: "   ", quality: "", zone: " \t", delimiter: "\t", decimal: ",",
    });
    expect(body).toMatchObject({ name: "night export", tag: "meter", time: "when", value: "kwh", unit: null, quality: null, zone: null, delimiter: "\t", decimal: "," });
  });

  it("sends the unit, the quality column and the zone when they are named", () => {
    const body = draftToProfile("x", { ...DEFAULT_DRAFT, unit: " u ", quality: " q ", zone: " Africa/Cairo " });
    expect(body).toMatchObject({ unit: "u", quality: "q", zone: "Africa/Cairo" });
  });

  it("uses the written pattern for a custom time format and the plain name for the others", () => {
    expect(draftToProfile("x", { ...DEFAULT_DRAFT, timeFormat: "custom", customFormat: " %d.%m.%Y %H:%M " }).time_format).toBe("%d.%m.%Y %H:%M");
    expect(draftToProfile("x", { ...DEFAULT_DRAFT, timeFormat: "epoch_s", customFormat: "%Y" }).time_format).toBe("epoch_s");
    expect(draftToProfile("x", { ...DEFAULT_DRAFT, timeFormat: "epoch_ms" }).time_format).toBe("epoch_ms");
  });

  it("sends the period as a NUMBER and the stamp for an interval reading", () => {
    const body = draftToProfile("x", { ...DEFAULT_DRAFT, reading: "interval", periodSeconds: " 3600 ", stamp: "end" });
    expect(body.reading).toBe("interval");
    expect(body.period_seconds).toBe(3600);
    expect(typeof body.period_seconds).toBe("number");
    expect(body.stamp).toBe("end");
  });

  it("forces the period and the stamp to null unless the reading is an interval (switching back to a counter must not be a 422)", () => {
    const left = { ...DEFAULT_DRAFT, periodSeconds: "900", stamp: "start" as const };
    for (const reading of ["counter", "power"] as const) {
      const body = draftToProfile("x", { ...left, reading });
      expect([body.reading, body.period_seconds, body.stamp]).toEqual([reading, null, null]);
    }
  });

  it("carries no field of the form that is not the server's (no customFormat, no timeFormat choice)", () => {
    const body = draftToProfile("x", { ...DEFAULT_DRAFT, timeFormat: "custom", customFormat: "%Y%m%d", reading: "interval", periodSeconds: "60", stamp: "start" });
    expect(Object.keys(body).sort()).toEqual([...SERVER_FIELDS].sort());
  });

  it("does not turn a period that is not a whole number of seconds into one (the form's own sentence stops it before it is sent)", () => {
    for (const bad of ["", "0", "1.5", "1e3", "abc", "-5"]) {
      expect(draftToProfile("x", { ...DEFAULT_DRAFT, reading: "interval", periodSeconds: bad, stamp: "start" }).period_seconds).toBeNull();
    }
  });
});

describe("parseCodes", () => {
  it("keeps the codes as the server keeps them: trimmed, lower case, each once, in the order written", () => {
    expect(parseCodes(" Good, OK ,good,, 192 ")).toEqual(["good", "ok", "192"]);
    expect(parseCodes("")).toEqual([]);
    expect(parseCodes(" , ,")).toEqual([]);
  });
});

describe("profileToDraft", () => {
  it("shows a saved profile in the form and gives the same profile back", () => {
    const profile = saved({
      name: "export", tag: "Meter", time: "Zeit", value: "kWh", unit: "Einheit", quality: "Q", delimiter: ";", decimal: ",",
      time_format: "%d.%m.%Y %H:%M", zone: "Europe/Berlin", reading: "interval", period_seconds: 900, stamp: "end", good_codes: ["good", "ok"],
    });
    const draft = profileToDraft(profile);
    expect(draft).toMatchObject({ timeFormat: "custom", customFormat: "%d.%m.%Y %H:%M", delimiter: ";", periodSeconds: "900", stamp: "end", goodCodes: "good, ok" });
    expect(draftToProfile("export", draft)).toEqual(profile);
  });

  it("maps the three named formats to themselves and a null delimiter, unit, quality and zone to blanks", () => {
    for (const format of ["iso", "epoch_s", "epoch_ms"]) {
      expect(profileToDraft(saved({ time_format: format }))).toMatchObject({ timeFormat: format, customFormat: "" });
    }
    expect(profileToDraft(saved())).toMatchObject({ delimiter: "", unit: "", quality: "", zone: "", periodSeconds: "", stamp: "" });
  });
});

describe("sameProfile", () => {
  it("is true for the same layout, an absent optional field counting as null", () => {
    const { unit: _unit, ...withoutUnit } = saved();
    expect(sameProfile(saved(), saved())).toBe(true);
    expect(sameProfile(saved(), withoutUnit as unknown as ImportProfile)).toBe(true);
  });

  it("is false when the name, a column, a code or anything else differs", () => {
    expect(sameProfile(saved(), saved({ name: "other" }))).toBe(false);
    expect(sameProfile(saved(), saved({ tag: "meter" }))).toBe(false);
    expect(sameProfile(saved(), saved({ good_codes: ["good", "ok"] }))).toBe(false);
    expect(sameProfile(saved(), saved({ zone: "UTC" }))).toBe(false);
    expect(sameProfile(saved(), saved({ delimiter: ";" }))).toBe(false);
  });
});

describe("draftProblem", () => {
  it("accepts the defaults", () => {
    expect(draftProblem(DEFAULT_DRAFT)).toBeNull();
  });

  it.each([
    ["tag", "Name the column that holds the tag: the text at the top of that column."],
    ["time", "Name the column that holds the time: the text at the top of that column."],
    ["value", "Name the column that holds the value: the text at the top of that column."],
  ] as const)("asks for the %s column", (field, sentence) => {
    expect(draftProblem({ ...DEFAULT_DRAFT, [field]: "  " })).toBe(sentence);
  });

  it("refuses a decimal comma with a comma delimiter, in the server's words", () => {
    expect(draftProblem({ ...DEFAULT_DRAFT, decimal: ",", delimiter: "," })).toBe("A decimal comma needs another delimiter: a semicolon or a tab.");
    expect(draftProblem({ ...DEFAULT_DRAFT, decimal: ",", delimiter: ";" })).toBeNull();
    expect(draftProblem({ ...DEFAULT_DRAFT, decimal: ",", delimiter: "" })).toBeNull();
  });

  it("asks for the pattern of a custom format", () => {
    expect(draftProblem({ ...DEFAULT_DRAFT, timeFormat: "custom", customFormat: " " })).toMatch(/^Write the time format/);
    expect(draftProblem({ ...DEFAULT_DRAFT, timeFormat: "custom", customFormat: "%Y-%m-%d" })).toBeNull();
  });

  it("asks an interval for its period and for its stamp, and no other reading", () => {
    const interval = { ...DEFAULT_DRAFT, reading: "interval" as const };
    expect(draftProblem(interval)).toMatch(/^Say how many seconds one period lasts/);
    expect(draftProblem({ ...interval, periodSeconds: "0", stamp: "start" })).toMatch(/^Say how many seconds/);
    expect(draftProblem({ ...interval, periodSeconds: "3600" })).toBe("Say whether the time marks the start or the end of each period.");
    expect(draftProblem({ ...interval, periodSeconds: "3600", stamp: "end" })).toBeNull();
    expect(draftProblem({ ...DEFAULT_DRAFT, reading: "power", periodSeconds: "", stamp: "" })).toBeNull();
  });
});

function Harness({ initial = DEFAULT_DRAFT, seen, disabled }: { initial?: ProfileDraft; seen?: (d: ProfileDraft) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState(initial);
  return <ImportProfileFields draft={draft} disabled={disabled} onChange={(next) => { seen?.(next); setDraft(next); }} />;
}

const tips = () => screen.queryAllByRole("button", { name: "What does this mean?" });

describe("ImportProfileFields", () => {
  it("shows the defaults: tag, timestamp, value; delimiter found from the header line; decimal point; ISO 8601; a running total; the code good", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Tag column")).toHaveValue("tag");
    expect(screen.getByLabelText("Time column")).toHaveValue("timestamp");
    expect(screen.getByLabelText("Value column")).toHaveValue("value");
    expect(screen.getByLabelText("Unit column (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Quality column (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Delimiter")).toHaveValue("");
    expect(screen.getByRole("option", { name: "Find it from the header line" })).toBeInTheDocument();
    expect(screen.getByLabelText("Decimal mark")).toHaveValue(".");
    expect(screen.getByLabelText("Time format")).toHaveValue("iso");
    expect(screen.getByLabelText("Time zone (optional)")).toHaveValue("");
    expect(screen.getByLabelText("Value means")).toHaveValue("counter");
    expect(screen.getByLabelText("Good quality codes")).toHaveValue("good");
  });

  it("offers the four time formats, with the zone requirement of ISO 8601 in its name, and no %b or %y anywhere", () => {
    render(<Harness />);
    const options = screen.getByLabelText("Time format").querySelectorAll("option");
    expect([...options].map((o) => o.textContent)).toEqual(["ISO 8601 (with a zone or Z)", "Seconds since 1970", "Milliseconds since 1970", "Custom"]);
    expect([...options].map((o) => o.getAttribute("value"))).toEqual(["iso", "epoch_s", "epoch_ms", "custom"]);
    expect(document.body.textContent).not.toMatch(/%b|%y|#\d/);
  });

  it("shows the custom pattern box, with the hint listing the allowed directives, only for Custom", async () => {
    render(<Harness />);
    expect(screen.queryByLabelText("Custom time format")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Time format"), "custom");
    const box = screen.getByLabelText("Custom time format");
    expect(box).toHaveAccessibleDescription(/%Y %m %d %H %M %S %f %z/);
    expect(box).toHaveAccessibleDescription(/year, month and day are required/);
    await userEvent.selectOptions(screen.getByLabelText("Time format"), "epoch_s");
    expect(screen.queryByLabelText("Custom time format")).toBeNull();
  });

  it("shows the period and the stamp only for an interval reading, with no stamp chosen for it", async () => {
    render(<Harness />);
    expect(screen.queryByLabelText("Period in seconds")).toBeNull();
    expect(screen.queryByLabelText("The time marks the")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Value means"), "interval");
    expect(screen.getByLabelText("Period in seconds")).toHaveValue("");
    expect(screen.getByLabelText("The time marks the")).toHaveValue("");
    await userEvent.selectOptions(screen.getByLabelText("Value means"), "power");
    expect(screen.queryByLabelText("Period in seconds")).toBeNull();
  });

  it("gives the whole next draft to onChange, one field changed", async () => {
    const seen = vi.fn();
    render(<Harness seen={seen} />);
    await userEvent.clear(screen.getByLabelText("Tag column"));
    await userEvent.type(screen.getByLabelText("Tag column"), "Meter");
    expect(seen).toHaveBeenLastCalledWith({ ...DEFAULT_DRAFT, tag: "Meter" });
    await userEvent.selectOptions(screen.getByLabelText("Delimiter"), ";");
    expect(seen).toHaveBeenLastCalledWith({ ...DEFAULT_DRAFT, tag: "Meter", delimiter: ";" });
    await userEvent.selectOptions(screen.getByLabelText("Delimiter"), "Tab");
    expect(seen).toHaveBeenLastCalledWith({ ...DEFAULT_DRAFT, tag: "Meter", delimiter: "\t" });
    await userEvent.selectOptions(screen.getByLabelText("Decimal mark"), ",");
    expect(seen).toHaveBeenLastCalledWith({ ...DEFAULT_DRAFT, tag: "Meter", delimiter: "\t", decimal: "," });
  });

  it("gives a non-obvious field an explanation beside its label, never inside it", async () => {
    render(<Harness />);
    expect(tips()).toHaveLength(5); // tag, time format, time zone, value means, good quality codes
    for (const tip of tips()) expect(tip.closest("label")).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText("Value means"), "interval");
    expect(tips()).toHaveLength(6); // the stamp
    await userEvent.click(tips()[0]);
    expect(screen.getByRole("note")).toHaveTextContent(/point's address/);
  });

  it("disables every control while the dialog is busy", () => {
    render(<Harness disabled initial={{ ...DEFAULT_DRAFT, timeFormat: "custom", reading: "interval" }} />);
    for (const control of [...screen.getAllByRole("textbox"), ...screen.getAllByRole("combobox")]) expect(control).toBeDisabled();
  });

  it("has no button that submits a form", () => {
    render(<Harness />);
    for (const button of screen.getAllByRole("button")) expect(button).toHaveAttribute("type", "button");
  });
});
