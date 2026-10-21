import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { useSources } from "../api/queries";
import type { ImportProfile, ImportReport } from "../api/types";
import { probeFetches, CacheProbes, probeRoutes } from "../test/cacheProbes";
import { mockFetch, type Routes } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { ImportDialog } from "./ImportDialog";

const IMPORT = "/api/sources/3/import";
const CSV = "tag,timestamp,value\nA,2026-01-01T00:00:00Z,1\n";
const HOSTILE = "<img src=x onerror=alert(1)>";
const SHA = "ab".repeat(32);
const FILE_DIFFERS = "this is not the file that was checked; check it again before importing";

const profile = (name: string, over: Partial<ImportProfile> = {}): ImportProfile => ({
  name, tag: "tag", time: "timestamp", value: "value", unit: null, quality: null, delimiter: null, decimal: ".", time_format: "iso",
  zone: null, reading: "counter", period_seconds: null, stamp: null, good_codes: ["good"], ...over,
});

const report = (over: Partial<ImportReport> = {}): ImportReport => ({
  dry_run: true, source_id: 3, profile: "hourly", sha256: SHA, size: 1000,
  rows_read: 12_480, new: 12_000, already: 480, differing: 0, rejected: 0, unknown_rows: 0,
  unknown_tags: { count: 0, names: [] }, rejected_by: {}, closed_months: {}, differing_samples: [], problems: [], problems_total: 0,
  refresh: { state: "not_needed", days: 0, note: null }, complete: true, error: null,
  text: "12,480 rows read, 12,000 new, 480 already there, 0 differing, 0 rejected", ...over,
});
const done = (over: Partial<ImportReport> = {}) => report({ dry_run: false, ...over });

function SourcesProbe() {
  useSources();
  return null;
}

/** A page with an opener between two other buttons; the dialog closes through `onClose` first, as the Sources page's does. */
function Host({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">before</button>
      <button type="button" onClick={() => setOpen(true)}>Import file...</button>
      <CacheProbes />
      <SourcesProbe />
      {open && <ImportDialog source={{ id: 3, name: "Plant A" }} onClose={() => { onClose?.(); setOpen(false); }} />}
    </>
  );
}

let profiles: ImportProfile[];
let queries: URLSearchParams[]; // the query string of every import request (mockFetch drops it from `path`)
beforeEach(() => {
  profiles = [profile("hourly")];
  queries = [];
});

/** A check answers `dry`; a real import answers `real` (a report, or a { status, body } refusal). */
function importRoute(dry: ImportReport | { status: number; body: unknown } = report(), real: ImportReport | { status: number; body: unknown } = done()): Routes {
  const reply = (r: ImportReport | { status: number; body: unknown }) => ("status" in r ? r : { body: r });
  return {
    [`POST ${IMPORT}`]: ({ url }) => {
      const query = new URL(url, "http://host").searchParams;
      queries.push(query);
      return reply(query.get("dry_run") === "1" ? dry : real);
    },
  };
}

const base = (): Routes => ({
  "GET /api/me": { body: userFor("admin") },
  "GET /api/setup": { body: { needed: false } },
  "GET /api/import-profiles": () => ({ body: { profiles } }),
  "PUT /api/import-profiles/hourly": ({ body }) => { profiles = profiles.map((p) => (p.name === "hourly" ? (body as ImportProfile) : p)); return { body }; },
  "PUT /api/import-profiles/Night%20export": ({ body }) => { profiles = [...profiles.filter((p) => p.name !== "Night export"), body as ImportProfile]; return { body }; },
  "PUT /api/import-profiles/Draft": ({ body }) => { profiles = [...profiles.filter((p) => p.name !== "Draft"), body as ImportProfile]; return { body }; },
  "DELETE /api/import-profiles/hourly": () => { profiles = profiles.filter((p) => p.name !== "hourly"); return { status: 204 }; },
  "GET /api/sources": { body: [] },
  ...probeRoutes,
});

async function open(routes: Routes = {}, onClose?: () => void) {
  const calls = mockFetch({ ...base(), ...routes });
  const toasts = spyToasts();
  renderWithProviders(<Host onClose={onClose} />, { toasts: toasts.api });
  const opener = screen.getByRole("button", { name: "Import file..." });
  await userEvent.click(opener);
  await screen.findByRole("option", { name: "hourly" }); // the saved profiles have arrived (the account is known)
  return { calls, toasts, opener };
}

type Call = { method: string; path: string; body: unknown };
const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST" && c.path === IMPORT);
const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");

const textFile = (text = CSV, name = "export.csv") => new File([text], name, { type: "text/csv" });
const bytesFile = (bytes: number[], name = "export.csv") => new File([new Uint8Array(bytes)], name, { type: "text/csv" });
const chooseFile = (file: File = textFile()) => userEvent.upload(screen.getByLabelText("File"), file);

const fileInput = () => screen.getByLabelText("File");
const profileSelect = () => screen.getByLabelText("Profile");
const checkButton = () => screen.getByRole("button", { name: "Check file" });
const closeButton = () => screen.getByRole("button", { name: "Close" });
const goButton = () => within(screen.getByRole("dialog")).getByRole("button", { name: /^Import(ed|ing)?( |…|$)/ });
const chooseSaved = (name = "hourly") => userEvent.selectOptions(profileSelect(), name);
const check = async () => { await userEvent.click(checkButton()); };
const waitingLabel = () => screen.getByRole("dialog").querySelector(".import-report");

async function checked(routes: Routes = importRoute(), file: File = textFile()) {
  const opened = await open(routes);
  await chooseSaved();
  await chooseFile(file);
  await check();
  await screen.findByText(/^Checked:/);
  return opened;
}

describe("ImportDialog: the frame", () => {
  it("is a modal dialog titled with the source, with the focus on the file chooser, and gives the focus back to the opener", async () => {
    const { opener } = await open();
    const dialog = screen.getByRole("dialog", { name: "Import readings: Plant A" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(fileInput()).toHaveFocus();
    expect(fileInput()).toHaveAttribute("type", "file");
    expect(fileInput()).toHaveAttribute("accept", ".csv,.txt,text/csv,text/plain");
    await userEvent.click(closeButton());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("Escape closes the dialog and sends nothing", async () => {
    const onClose = vi.fn();
    const { calls, opener } = await open({}, onClose);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(posts(calls)).toHaveLength(0);
  });

  it("Escape closes only the innermost layer: an open explanation first, the dialog on the next press", async () => {
    await open();
    await userEvent.click(screen.getAllByRole("button", { name: "What does this mean?" })[0]);
    expect(screen.getByRole("note")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Tab wraps from the last control to the first and Shift+Tab back, so the page behind is never reached", async () => {
    await open();
    expect(fileInput()).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(goButton()).toHaveFocus();
    await userEvent.tab();
    expect(fileInput()).toHaveFocus();
  });

  it("every button that does not submit is type=button, and the dialog has no form", async () => {
    await open();
    const dialog = screen.getByRole("dialog");
    for (const button of within(dialog).getAllByRole("button")) expect(button).toHaveAttribute("type", "button");
    expect(dialog.querySelector("form")).toBeNull();
  });

  it("asks for the saved profiles only when the role may import readings", async () => {
    const calls = mockFetch({ ...base(), "GET /api/me": { body: userFor("operator") } });
    renderWithProviders(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "Import file..." }));
    await screen.findByRole("dialog");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls.filter((c) => c.path === "/api/import-profiles")).toEqual([]);
  });

  it("says so under the profile when the saved profiles cannot be read, and still lets a new one be described", async () => {
    mockFetch({ ...base(), "GET /api/import-profiles": { status: 500, body: { detail: "boom" } } });
    renderWithProviders(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "Import file..." }));
    expect(await screen.findByText(/^Could not load the saved profiles:/)).toBeInTheDocument();
    expect(screen.getByLabelText("Profile name")).toBeEnabled();
  });
});

describe("ImportDialog: the file", () => {
  it("shows the chosen file's name, clipped to 60 characters, and its size, as text", async () => {
    await open();
    const long = `${"x".repeat(80)}.csv`;
    await chooseFile(textFile(CSV, long));
    expect(screen.getByText(`${"x".repeat(59)}… (${CSV.length} bytes)`)).toBeInTheDocument();
  });

  it("refuses a file over 20 MB with a sentence before anything is sent, and Check file then asks for a file", async () => {
    const { calls } = await open();
    const big = textFile();
    Object.defineProperty(big, "size", { value: 20 * 1024 * 1024 + 1 });
    await chooseFile(big);
    expect(screen.getByText("This file is 20.0 MB; the limit is 20 MB. Split it into several files.")).toBeInTheDocument();
    await check();
    expect(screen.getByText("Choose a file to check.")).toBeInTheDocument();
    expect(fileInput()).toHaveFocus();
    expect(posts(calls)).toHaveLength(0);
  });

  it("takes a file of exactly 20 MB", async () => {
    await open();
    const edge = textFile();
    Object.defineProperty(edge, "size", { value: 20 * 1024 * 1024 });
    await chooseFile(edge);
    expect(screen.queryByText(/the limit is 20 MB/)).toBeNull();
    expect(screen.getByText(/^export\.csv \(20\.0 MB\)$/)).toBeInTheDocument();
  });

  it("refuses a UTF-16 file in the browser, in the server's words, and sends nothing", async () => {
    const { calls } = await open();
    await chooseSaved();
    await chooseFile(bytesFile([0xff, 0xfe, 0x74, 0x00, 0x61, 0x00]));
    await check();
    expect(await screen.findByText(/^This file is saved as UTF-16/)).toBeInTheDocument();
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("refuses bytes that are not UTF-8, and sends nothing", async () => {
    const { calls } = await open();
    await chooseSaved();
    await chooseFile(bytesFile([0x74, 0x61, 0x67, 0x0a, 0xe9, 0x0a]));
    await check();
    expect(await screen.findByText("This file is not UTF-8 text; save it as CSV UTF-8 and choose it again.")).toBeInTheDocument();
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("sends a UTF-8 file's text without its byte order mark, the same text on the check and on the import", async () => {
    const bom = [0xef, 0xbb, 0xbf, ...new TextEncoder().encode("tag,timestamp,value\nZürich,2026-01-01T00:00:00Z,1\n")];
    const { calls } = await open(importRoute());
    await chooseSaved();
    await chooseFile(bytesFile(bom));
    await check();
    await screen.findByText(/^Checked:/);
    await userEvent.click(goButton());
    await screen.findByText(/^Imported:/);
    expect(posts(calls).map((c) => c.body)).toEqual(["tag,timestamp,value\nZürich,2026-01-01T00:00:00Z,1\n", "tag,timestamp,value\nZürich,2026-01-01T00:00:00Z,1\n"]);
  });
});

describe("ImportDialog: check, then import", () => {
  it("posts the file's text as the raw body with text/csv, the saved profile's name and dry_run=1, and shows the report in place", async () => {
    const { calls } = await checked();
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0].body).toBe(CSV);
    expect(queries[0].get("profile")).toBe("hourly");
    expect(queries[0].get("dry_run")).toBe("1");
    expect(queries[0].has("expect_sha256")).toBe(false);
    const init = vi.mocked(fetch).mock.calls.map(([, i]) => i).find((i) => i?.method === "POST");
    expect((init?.headers as Record<string, string>)["content-type"]).toBe("text/csv");
    expect(screen.getByText("Checked: 12,480 rows read, 12,000 new, 480 already there, 0 differing, 0 rejected. Nothing is stored until you import.")).toBeInTheDocument();
  });

  it("is a button that says what it will do, enabled only after a successful check of this file", async () => {
    await open(importRoute());
    expect(goButton()).toHaveTextContent("Import rows");
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    await chooseSaved();
    await chooseFile();
    await check();
    await screen.findByText(/^Checked:/);
    expect(goButton()).toHaveTextContent("Import 12,000 rows");
    expect(goButton()).not.toHaveAttribute("aria-disabled");
    expect(goButton()).toHaveClass("primary");
    expect(goButton()).not.toHaveAttribute("disabled");
  });

  it("imports with dry_run=0 and the SHA-256 of the check, shows the final report and a success toast, and the button is done", async () => {
    const { calls, toasts } = await checked(importRoute(report(), done({ text: "12,480 rows read, 12,000 new, 480 already there, 0 differing, 0 rejected" })));
    await userEvent.click(goButton());
    expect(await screen.findByText("Imported: 12,480 rows read, 12,000 new, 480 already there, 0 differing, 0 rejected.")).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(2);
    expect(posts(calls)[1].body).toBe(CSV);
    expect(queries[1].get("dry_run")).toBe("0");
    expect(queries[1].get("expect_sha256")).toBe(SHA);
    expect(queries[1].get("profile")).toBe("hourly");
    expect(toasts.calls).toEqual([{ kind: "success", text: "Imported 12,000 rows into Plant A" }]);
    expect(goButton()).toHaveTextContent("Imported");
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("says 1 row for one row, and puts a thousands separator in a big number", async () => {
    await checked(importRoute(report({ new: 1 })));
    expect(goButton()).toHaveTextContent("Import 1 row");
    expect(goButton().textContent).not.toMatch(/rows/);
  });

  it("with nothing new the button reads Import 0 rows and waits, and the report says there is nothing to import", async () => {
    await checked(importRoute(report({ new: 0, already: 12_480, text: "12,480 rows read, 0 new, 12,480 already there, 0 differing, 0 rejected" })));
    expect(goButton()).toHaveTextContent("Import 0 rows");
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("There is nothing new to import from this file.")).toBeInTheDocument();
  });

  it("a check that did not complete cannot be imported, and is shown as a warning", async () => {
    await checked(importRoute(report({ complete: false, error: "the file ended in the middle of a line", text: "400 rows read, 400 new" })));
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    const warning = screen.getByText(/^Checked: 400 rows read/).closest("p");
    expect(warning).toHaveClass("import-warn");
    expect(warning).toHaveTextContent("The file ended in the middle of a line");
  });

  it("a click on the waiting button imports nothing", async () => {
    const { calls } = await open(importRoute());
    await userEvent.click(goButton());
    expect(posts(calls)).toHaveLength(0);
  });

  it("clears the report when another profile is chosen, when a field changes, when the name changes and when another file is chosen", async () => {
    const { calls } = await checked();
    const hint = "Check the file to see what an import would do. Nothing is stored until you import.";
    // another profile
    await userEvent.selectOptions(profileSelect(), "New profile");
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(screen.getByLabelText("Profile name"), "Night export");
    await check();
    await screen.findByText(/^Checked:/);
    // a field
    await userEvent.type(screen.getByLabelText("Value column"), "2");
    expect(screen.getByText(hint)).toBeInTheDocument();
    await check();
    await screen.findByText(/^Checked:/);
    // the name
    await userEvent.selectOptions(profileSelect(), "New profile");
    await userEvent.type(screen.getByLabelText("Profile name"), "Another");
    expect(screen.getByText(hint)).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Profile name"));
    await userEvent.type(screen.getByLabelText("Profile name"), "Night export");
    // the file
    await chooseSaved();
    await check();
    await screen.findByText(/^Checked:/);
    await chooseFile(textFile("tag,timestamp,value\nB,2026-01-01T00:00:00Z,2\n", "other.csv"));
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    expect(posts(calls).length).toBeGreaterThanOrEqual(3);
  });

  it("a second press while a request runs does nothing: aria-disabled, never the native attribute, and the focus stays", async () => {
    const calls = await (async () => (await open(importRoute())).calls)();
    await chooseSaved();
    await chooseFile();
    const gate = holdFetch((method, path) => method === "POST" && path === IMPORT);
    await userEvent.click(checkButton());
    await userEvent.click(checkButton());
    await userEvent.click(checkButton());
    expect(checkButton()).toHaveAttribute("aria-disabled", "true");
    expect(checkButton()).not.toHaveAttribute("disabled");
    expect(checkButton()).toHaveFocus();
    expect(waitingLabel()).toHaveTextContent("Checking the file…");
    expect(fileInput()).toBeDisabled();
    expect(profileSelect()).toBeDisabled();
    gate.release();
    await screen.findByText(/^Checked:/);
    expect(posts(calls)).toHaveLength(1);
    expect(checkButton()).not.toHaveAttribute("aria-disabled");
    expect(fileInput()).toBeEnabled();
  });

  it("neither Close nor Escape closes the dialog while a request runs", async () => {
    const onClose = vi.fn();
    await open(importRoute(), onClose);
    await chooseSaved();
    await chooseFile();
    const gate = holdFetch((method, path) => method === "POST" && path === IMPORT);
    await userEvent.click(checkButton());
    await userEvent.click(closeButton());
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    gate.release();
    await screen.findByText(/^Checked:/);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a second press on Import sends one request, with the button waiting and still holding the focus", async () => {
    const { calls } = await checked();
    const gate = holdFetch((method, path) => method === "POST" && path === IMPORT);
    await userEvent.click(goButton());
    await userEvent.click(goButton());
    expect(goButton()).toHaveTextContent("Importing…");
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    expect(goButton()).toHaveFocus();
    expect(waitingLabel()).toHaveTextContent("Importing… a large file can take a minute. Keep this window open.");
    gate.release();
    await screen.findByText(/^Imported:/);
    expect(posts(calls)).toHaveLength(2);
  });
});

describe("ImportDialog: the report", () => {
  it("lists the unknown tags with their rows, the rejected rows by reason in plain words, the closed months and the problem lines", async () => {
    const problems = Array.from({ length: 20 }, (_, i) => ({ line: 100 + i, reason: i % 2 ? "not_a_number" : "not_a_time" }));
    await checked(importRoute(report({
      rejected: 7, rejected_by: { value_out_of_range: 3, not_a_number: 3, duplicate_in_file: 1 },
      unknown_rows: 17, unknown_tags: { count: 25, names: ["TAG-A", "TAG-B", "TAG-C"] },
      closed_months: { "2026-09": 3, "2026-08": 1, "2026-07": 0 },
      problems, problems_total: 31,
    })));
    const dialog = screen.getByRole("dialog");
    const section = (title: string) => within(dialog).getByText(title).parentElement as HTMLElement;
    const rejected = within(section("Rows that were not accepted")).getAllByRole("listitem").map((li) => li.textContent);
    expect(rejected).toEqual([
      "The value is not a number: 3 rows", "The value is out of range: 3 rows", "The same reading is in the file more than once: 1 row",
    ]);
    const unknown = section("Tags this source does not have");
    expect(unknown).toHaveTextContent("17 rows for 25 tags are skipped: an import never creates a point.");
    expect(within(unknown).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["TAG-A", "TAG-B", "TAG-C"]);
    expect(unknown).toHaveTextContent("and 22 more");
    const closed = section("Closed billing months");
    expect(within(closed).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1 row in the closed month 2026-08", "3 rows in the closed month 2026-09"]);
    expect(closed).toHaveTextContent("A closed month keeps its frozen figures");
    const lines = within(section("Problem lines")).getAllByRole("listitem").map((li) => li.textContent);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe("Line 100: The time cannot be read");
    expect(lines[1]).toBe("Line 101: The value is not a number");
    expect(section("Problem lines")).toHaveTextContent("The first 20 of 31 are shown.");
  });

  it("shows the lines in the order the rows add up: differing samples, then rejected, then unknown tags", async () => {
    await checked(importRoute(report({
      differing: 6, differing_samples: [{ tag: "A", ts: "2026-01-01T00:00:00Z", stored: 1, file: 2 }, { tag: "B", ts: "2026-01-01T01:00:00Z", stored: null, file: 5.5 }],
      rejected: 1, rejected_by: { empty_value: 1 }, unknown_rows: 2, unknown_tags: { count: 1, names: ["Z"] },
    })));
    const heads = [...screen.getByRole("dialog").querySelectorAll(".import-head")].map((p) => p.textContent);
    expect(heads).toEqual(["Different from what is stored", "Rows that were not accepted", "Tags this source does not have"]);
    const samples = within(screen.getByText("Different from what is stored").parentElement as HTMLElement).getAllByRole("listitem").map((li) => li.textContent);
    expect(samples).toEqual(["A at 2026-01-01T00:00:00Z: stored 1, file 2", "B at 2026-01-01T01:00:00Z: stored no value, file 5.5"]);
    expect(screen.getByText(/6 rows carry another value for a time that is stored already/)).toBeInTheDocument();
  });

  it("names a reason it does not know by its code, clipped, not as a bare word", async () => {
    await checked(importRoute(report({ rejected: 1, rejected_by: { brand_new_reason: 1 } })));
    expect(screen.getByText("Not accepted (brand_new_reason): 1 row")).toBeInTheDocument();
  });

  it("shows every cell as text: a hostile tag is never markup", async () => {
    await checked(importRoute(report({
      unknown_rows: 1, unknown_tags: { count: 1, names: [HOSTILE] },
      differing: 1, differing_samples: [{ tag: HOSTILE, ts: "2026-01-01T00:00:00Z", stored: 1, file: 2 }],
    })));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText(HOSTILE)).toHaveLength(2);
    expect(dialog.querySelector("img")).toBeNull();
    expect(dialog.innerHTML).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("shows a final report that did not complete as a warning with the server's sentence and the counts written, and no success toast", async () => {
    const { toasts } = await checked(importRoute(report(), done({ complete: false, error: "the database connection was lost", new: 4_000, rows_read: 5_000, text: "5,000 rows read, 4,000 new" })));
    await userEvent.click(goButton());
    const warning = (await screen.findByText(/^The import stopped before the end/)).closest("p");
    expect(warning).toHaveClass("import-warn");
    expect(warning).toHaveTextContent("The import stopped before the end: the database connection was lost. So far 5,000 rows read, 4,000 new. Importing the same file again is safe");
    expect(toasts.calls).toEqual([]);
    expect(goButton()).toHaveTextContent("Import rows");
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("warns when the summaries could not be refreshed after the import", async () => {
    await checked(importRoute(report(), done({ refresh: { state: "failed", days: 0, note: "the readings are stored, but the hourly and minute rollups were left as they were over 2026-01-01" } })));
    await userEvent.click(goButton());
    expect(await screen.findByText("The readings are stored, but the hourly and minute rollups were left as they were over 2026-01-01.")).toBeInTheDocument();
  });

  it("reserves the room of the report in a class of its own, which holds the busy line, the error and the report alike", async () => {
    await open();
    const area = screen.getByRole("dialog").querySelector(".import-report");
    expect(area).not.toBeNull();
    expect(area).toHaveAttribute("aria-live", "polite");
  });
});

describe("ImportDialog: the server's refusals", () => {
  it.each([
    [409, "an import is running", "An import is running"],
    [413, "the file is larger than 20 MB; split it into several files", "The file is larger than 20 MB; split it into several files"],
    [415, "the content type text/html is not accepted; send the file as text/csv", "The content type text/html is not accepted; send the file as text/csv"],
    [422, "line 4 is not UTF-8 text; save the file as CSV UTF-8 and import it again", "Line 4 is not UTF-8 text; save the file as CSV UTF-8 and import it again"],
  ])("shows a %i check in the server's words and keeps Import waiting", async (status, detail, shown) => {
    await open(importRoute({ status, body: { detail } }));
    await chooseSaved();
    await chooseFile();
    await check();
    expect(await screen.findByText(shown)).toBeInTheDocument();
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("clears the report when the real import is refused because the file differs, and Check file is the way on", async () => {
    const { calls } = await checked(importRoute(report(), { status: 409, body: { detail: FILE_DIFFERS } }));
    await userEvent.click(goButton());
    expect(await screen.findByText("This is not the file that was checked; check it again before importing")).toBeInTheDocument();
    expect(screen.queryByText(/^Checked:/)).toBeNull();
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
    expect(goButton()).toHaveTextContent("Import rows");
    expect(checkButton()).toHaveFocus(); // the way on is a new check
    await check();
    expect(posts(calls)).toHaveLength(3);
  });

  it("clears the report on any refusal of the real import, a 409 for a running import included", async () => {
    await checked(importRoute(report(), { status: 409, body: { detail: "an import is running" } }));
    await userEvent.click(goButton());
    expect(await screen.findByText("An import is running")).toBeInTheDocument();
    expect(screen.queryByText(/^Checked:/)).toBeNull();
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("shows a failure of the connection as an error, not as a report", async () => {
    await checked(importRoute(report(), { status: 500, body: { detail: "boom" } }));
    await userEvent.click(goButton());
    await waitFor(() => expect(screen.queryByText(/^Checked:/)).toBeNull());
    expect(screen.getByRole("dialog").querySelector(".import-report .error")).not.toBeNull();
  });
});

describe("ImportDialog: what an import makes stale", () => {
  const stale = (calls: Call[]): Record<string, number> => ({ ...probeFetches(calls), sources: calls.filter((c) => c.method === "GET" && c.path === "/api/sources").length });

  it("reads the source list, billing and the widgets again after a real import, and not after a check", async () => {
    const { calls } = await open(importRoute());
    await waitFor(() => expect(stale(calls)).toEqual({ billing: 1, widgetData: 1, tariffs: 1, sources: 1 }));
    await chooseSaved();
    await chooseFile();
    await check();
    await screen.findByText(/^Checked:/);
    expect(stale(calls)).toEqual({ billing: 1, widgetData: 1, tariffs: 1, sources: 1 });
    await userEvent.click(goButton());
    await screen.findByText(/^Imported:/);
    await waitFor(() => expect(stale(calls)).toEqual({ billing: 2, widgetData: 2, tariffs: 1, sources: 2 }));
  });

  it("reads them again when the real import fails too (rows may be stored)", async () => {
    const { calls } = await checked(importRoute(report(), { status: 500, body: { detail: "boom" } }));
    await waitFor(() => expect(stale(calls).billing).toBe(1));
    await userEvent.click(goButton());
    await waitFor(() => expect(stale(calls)).toEqual({ billing: 2, widgetData: 2, tariffs: 1, sources: 2 }));
  });

  it("reads them again after a final report that did not complete", async () => {
    const { calls } = await checked(importRoute(report(), done({ complete: false, error: "stopped", text: "10 rows read, 5 new" })));
    await userEvent.click(goButton());
    await screen.findByText(/^The import stopped/);
    await waitFor(() => expect(stale(calls)).toEqual({ billing: 2, widgetData: 2, tariffs: 1, sources: 2 }));
  });
});

describe("ImportDialog: profiles", () => {
  it("starts with a new profile and its fields open, with the defaults", async () => {
    await open();
    expect(profileSelect()).toHaveValue("");
    expect(screen.getByRole("option", { name: "New profile" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Profile fields" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Tag column")).toHaveValue("tag");
    expect(screen.getByLabelText("Time column")).toHaveValue("timestamp");
    expect(screen.getByLabelText("Value column")).toHaveValue("value");
    expect(screen.getByLabelText("Delimiter")).toHaveValue("");
    expect(screen.getByLabelText("Decimal mark")).toHaveValue(".");
    expect(screen.getByLabelText("Time format")).toHaveValue("iso");
    expect(screen.getByLabelText("Value means")).toHaveValue("counter");
    expect(screen.queryByRole("button", { name: "Delete profile" })).toBeNull();
  });

  it("loads a saved profile into the fields and folds them away; the button opens them again", async () => {
    profiles = [profile("hourly", { tag: "Meter", time: "Zeit", value: "kWh", delimiter: ";", decimal: ",", reading: "interval", period_seconds: 3600, stamp: "end", time_format: "%d.%m.%Y %H:%M" })];
    await open();
    await chooseSaved();
    const toggle = screen.getByRole("button", { name: "Profile fields" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveAttribute("aria-controls");
    expect(screen.queryByLabelText("Tag column")).toBeNull();
    expect(screen.queryByLabelText("Profile name")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete profile" })).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAttribute("aria-controls");
    expect(screen.getByLabelText("Tag column")).toHaveValue("Meter");
    expect(screen.getByLabelText("Delimiter")).toHaveValue(";");
    expect(screen.getByLabelText("Decimal mark")).toHaveValue(",");
    expect(screen.getByLabelText("Time format")).toHaveValue("custom");
    expect(screen.getByLabelText("Custom time format")).toHaveValue("%d.%m.%Y %H:%M");
    expect(screen.getByLabelText("Period in seconds")).toHaveValue("3600");
    expect(screen.getByLabelText("The time marks the")).toHaveValue("end");
  });

  it("saves a new profile before the check, says so, and checks with it by name", async () => {
    const { calls } = await open(importRoute());
    await userEvent.type(screen.getByLabelText("Profile name"), "Night export");
    await userEvent.clear(screen.getByLabelText("Tag column"));
    await userEvent.type(screen.getByLabelText("Tag column"), "Meter");
    await userEvent.selectOptions(screen.getByLabelText("Delimiter"), ";");
    await chooseFile();
    await check();
    await screen.findByText(/^Checked:/);
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].path).toBe("/api/import-profiles/Night%20export");
    expect(puts(calls)[0].body).toEqual({
      name: "Night export", tag: "Meter", time: "timestamp", value: "value", unit: null, quality: null, delimiter: ";", decimal: ".", time_format: "iso",
      zone: null, reading: "counter", period_seconds: null, stamp: null, good_codes: ["good"],
    });
    expect(screen.getByText('Profile "Night export" saved before the check.')).toBeInTheDocument();
    expect(queries[0].get("profile")).toBe("Night export");
    expect(profileSelect()).toHaveValue("Night export");
    expect(screen.queryByLabelText("Profile name")).toBeNull();
    // the same check again: the profile is saved as shown, so it is not sent again
    await check();
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(puts(calls)).toHaveLength(1);
  });

  it("saves a changed saved profile before the check and says so; an unchanged one is not saved again", async () => {
    const { calls } = await open(importRoute());
    await chooseSaved();
    await chooseFile();
    await check();
    await screen.findByText(/^Checked:/);
    expect(puts(calls)).toEqual([]);
    expect(screen.queryByText(/saved before the check/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Profile fields" }));
    await userEvent.clear(screen.getByLabelText("Good quality codes"));
    await userEvent.type(screen.getByLabelText("Good quality codes"), "GOOD, ok, good");
    await check();
    await screen.findByText(/^Checked:/);
    expect(puts(calls)).toHaveLength(1);
    expect(puts(calls)[0].path).toBe("/api/import-profiles/hourly");
    expect((puts(calls)[0].body as ImportProfile).good_codes).toEqual(["good", "ok"]);
    expect(screen.getByText('Changes to profile "hourly" saved before the check.')).toBeInTheDocument();
    await check();
    await waitFor(() => expect(posts(calls)).toHaveLength(3));
    expect(puts(calls)).toHaveLength(1);
  });

  it("sends an interval profile with a numeric period and its stamp", async () => {
    const { calls } = await open(importRoute());
    await userEvent.type(screen.getByLabelText("Profile name"), "Night export");
    await userEvent.selectOptions(screen.getByLabelText("Value means"), "interval");
    await userEvent.type(screen.getByLabelText("Period in seconds"), "3600");
    await userEvent.selectOptions(screen.getByLabelText("The time marks the"), "end");
    await chooseFile();
    await check();
    await screen.findByText(/^Checked:/);
    expect(puts(calls)[0].body).toMatchObject({ reading: "interval", period_seconds: 3600, stamp: "end" });
  });

  it("asks for a name, and refuses a name that is a saved profile's, before anything is sent", async () => {
    const { calls } = await open();
    await chooseFile();
    await check();
    expect(screen.getByText("Name the profile, so it can be saved and used for the check.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Profile name"), "hourly");
    await check();
    expect(screen.getByText('A profile named "hourly" exists already. Choose it in the list, or use another name.')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Profile name"));
    await userEvent.type(screen.getByLabelText("Profile name"), "a/b");
    await check();
    expect(screen.getByText(/^The profile name cannot contain "\/"/)).toBeInTheDocument();
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("stops at a fault in the layout with a sentence of its own: an interval without a period", async () => {
    const { calls } = await open();
    await userEvent.type(screen.getByLabelText("Profile name"), "Night export");
    await userEvent.selectOptions(screen.getByLabelText("Value means"), "interval");
    await chooseFile();
    await check();
    expect(screen.getByText("Say how many seconds one period lasts, as a whole number such as 3600.")).toBeInTheDocument();
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("does not check when the server refuses the profile, and shows its sentence under the profile", async () => {
    const { calls } = await open({ "PUT /api/import-profiles/Night%20export": { status: 422, body: { detail: 'the time format must be "iso", "epoch_s", "epoch_ms" or a pattern' } } });
    await userEvent.type(screen.getByLabelText("Profile name"), "Night export");
    await chooseFile();
    await check();
    expect(await screen.findByText('The time format must be "iso", "epoch_s", "epoch_ms" or a pattern')).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
    expect(profileSelect()).toHaveValue("");
  });

  it("shows the server's sentence when there are 20 profiles already", async () => {
    await open({ "PUT /api/import-profiles/Draft": { status: 409, body: { detail: "there are already 20 import profiles; delete one to save another" } } });
    await userEvent.type(screen.getByLabelText("Profile name"), "Draft");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("There are already 20 import profiles; delete one to save another")).toBeInTheDocument();
  });

  it("Save profile saves a new profile under its name (PUT), says so, and selects it", async () => {
    const { calls } = await open();
    await userEvent.type(screen.getByLabelText("Profile name"), "Draft");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText('Profile "Draft" saved.')).toBeInTheDocument();
    expect(puts(calls).map((c) => c.path)).toEqual(["/api/import-profiles/Draft"]);
    expect(profileSelect()).toHaveValue("Draft");
    expect(screen.getByRole("button", { name: "Delete profile" })).toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
  });

  it("Save profile asks for a name first", async () => {
    const { calls } = await open();
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(screen.getByText("Name the profile, so it can be saved and used for the check.")).toBeInTheDocument();
    expect(puts(calls)).toEqual([]);
  });

  it("Delete profile deletes the chosen one (DELETE), says so, and goes back to a new profile", async () => {
    const { calls } = await open(importRoute());
    await chooseSaved();
    await chooseFile();
    await check();
    await screen.findByText(/^Checked:/);
    await userEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    expect(await screen.findByText('Profile "hourly" deleted.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/api/import-profiles/hourly"]);
    expect(profileSelect()).toHaveValue("");
    await waitFor(() => expect(screen.queryByRole("option", { name: "hourly" })).toBeNull());
    expect(screen.getByLabelText("Profile name")).toHaveValue("");
    expect(screen.queryByText(/^Checked:/)).toBeNull(); // the check was made with a profile that is gone
    expect(goButton()).toHaveAttribute("aria-disabled", "true");
  });

  it("shows the server's sentence when a profile cannot be deleted", async () => {
    await open({ "DELETE /api/import-profiles/hourly": { status: 404, body: { detail: "import profile not found" } } });
    await chooseSaved();
    await userEvent.click(screen.getByRole("button", { name: "Delete profile" }));
    expect(await screen.findByText("Import profile not found")).toBeInTheDocument();
  });

  it("a new profile may be started from a saved one: the fields stay, the name is empty", async () => {
    profiles = [profile("hourly", { tag: "Meter" })];
    await open();
    await chooseSaved();
    await userEvent.selectOptions(profileSelect(), "New profile");
    expect(screen.getByLabelText("Tag column")).toHaveValue("Meter");
    expect(screen.getByLabelText("Profile name")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Profile fields" })).toHaveAttribute("aria-expanded", "true");
  });
});

describe("ImportDialog: rows stored with bad quality", () => {
  it("lists them by quality label and says they count in no figure", async () => {
    await checked(importRoute(report({ new: 5, bad_quality: { uncertain: 3, "unknown:7": 2 } })));
    const dialog = screen.getByRole("dialog");
    const section = within(dialog).getByText("Stored with bad quality").parentElement as HTMLElement;
    expect(section).toHaveTextContent("do not count in any figure");
    expect(within(section).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["uncertain: 3 rows", "unknown:7: 2 rows"]);
  });

  it("shows no such block when no row was stored with bad quality", async () => {
    await checked(importRoute(report({ new: 5 })));
    expect(within(screen.getByRole("dialog")).queryByText("Stored with bad quality")).toBeNull();
  });
});
