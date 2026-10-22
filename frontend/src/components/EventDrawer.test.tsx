import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import type { EventDetail, Incident, SystemEvent } from "../api/types";
import { spyToasts } from "../test/toasts";
import { EventDrawer, EventSteps } from "./EventDrawer";

const NOW = new Date("2026-10-22T12:00:00Z");
const stored = (extra: Partial<SystemEvent> = {}): SystemEvent => ({
  id: 7, ts: "2026-10-22T08:00:00Z", level: "warning", component: "collector", source_id: 4, source_name: "OPC UA server at 172.20.0.3:4840", source_deleted: false,
  kind: "source.offline", code: "unreachable", message: "[Errno 111] Connect call failed ('172.20.0.3', 4840)", detail: { interval: 10 }, incident: null, ...extra,
});
const incident = (extra: Partial<Incident> = {}): Incident => ({
  state: "open", count: 1204, first_at: "2026-10-18T04:52:00Z", last_at: "2026-10-22T11:59:00Z", closed_at: null, duration_seconds: 4 * 86400 + 2 * 3600, closed_by: null, ...extra,
});

function show(ui: ReactElement, toasts = spyToasts()) {
  const view = render(<MemoryRouter>{toasts.wrap(ui)}</MemoryRouter>);
  return { ...view, toasts, dialog: () => screen.getByRole("dialog", { name: "System event" }) };
}
const drawer = (props: Partial<Parameters<typeof EventDrawer>[0]> = {}) => (
  <EventDrawer event={stored()} status="ready" timezone="Asia/Qatar" now={NOW} onClose={() => {}} {...props} />
);
const facts = (root: HTMLElement) =>
  Object.fromEntries([...root.querySelectorAll(".kv > div")].map((row) => [row.querySelector("dt")!.textContent, row.querySelector("dd")!]));
const labels = (root: HTMLElement) => [...root.querySelectorAll(".kv dt")].map((dt) => dt.textContent);

describe("EventDrawer: one event (w32)", () => {
  it("is a dialog called System event, and an older row (no incident) has what happened, source, level, kind, code, when, message and the event", () => {
    const { dialog } = show(drawer());
    expect(labels(dialog())).toEqual(["What happened", "Source", "Level", "Kind", "Code", "When", "Message", "Event"]);
  });

  it("says what happened in plain words with the reason under it, and keeps the stored text in its own row", () => {
    const { dialog } = show(drawer());
    const rows = facts(dialog());
    expect(rows["What happened"]).toHaveTextContent("Went offline: could not reach the server");
    expect(rows["What happened"]).toHaveTextContent("Could not connect: the connection was refused.");
    expect(rows.Message).toHaveTextContent("[Errno 111] Connect call failed ('172.20.0.3', 4840)");
    expect(rows.Level.querySelector(".ev-tag")).toHaveClass("ev-tag-warning");
    expect(rows.Level).toHaveTextContent("Warning");
    expect(rows.Kind).toHaveTextContent("Source went offline");
    expect(rows.Kind.querySelector("code")).toHaveTextContent("source.offline");
    expect(rows.Code.querySelector("code")).toHaveTextContent("unreachable");
  });

  it("says when in the site's zone, with the zone and how long ago", () => {
    const { dialog } = show(drawer());
    expect(facts(dialog()).When).toHaveTextContent("2026-10-22 11:00:00"); // 08:00Z in Asia/Qatar (UTC+3)
    expect(facts(dialog()).When).toHaveTextContent("Asia/Qatar");
    expect(facts(dialog()).When).toHaveTextContent("4 h ago");
  });

  it("links the source to Sources, writes a deleted source without a link and an event of no source as a dash", () => {
    const { dialog, rerender, toasts } = show(drawer());
    expect(within(facts(dialog()).Source as HTMLElement).getByRole("link", { name: "OPC UA server at 172.20.0.3:4840" })).toHaveAttribute("href", "/sources");
    rerender(<MemoryRouter>{toasts.wrap(drawer({ event: stored({ source_id: 3, source_name: null, source_deleted: true }) }))}</MemoryRouter>);
    expect(facts(dialog()).Source).toHaveTextContent("deleted source #3");
    expect(within(facts(dialog()).Source as HTMLElement).queryByRole("link")).toBeNull();
    rerender(<MemoryRouter>{toasts.wrap(drawer({ event: stored({ source_id: null, source_name: null, kind: "collector.started", code: null }) }))}</MemoryRouter>);
    expect(facts(dialog()).Source).toHaveTextContent("—");
  });

  it("shows an open incident with when it began, its latest failure, that it is still open, the count and how long it has lasted", () => {
    const { dialog } = show(drawer({ event: stored({ incident: incident() }) }));
    expect(labels(dialog())).toEqual(["What happened", "Source", "Level", "Kind", "Code", "Began", "Latest", "Ended", "Count", "Duration", "Message", "Event"]);
    const rows = facts(dialog());
    expect(rows.Began).toHaveTextContent("2026-10-18 07:52:00");
    expect(rows.Latest).toHaveTextContent("2026-10-22 14:59:00");
    expect(rows.Ended).toHaveTextContent("Still open");
    expect(rows.Count).toHaveTextContent("failed 1,204 times");
    expect(rows.Duration).toHaveTextContent("ongoing, 4 d 2 h");
  });

  it("shows a closed incident with when and how it ended", () => {
    const closed = incident({ state: "closed", closed_at: "2026-10-22T09:00:00Z", closed_by: "recovered", count: 30, duration_seconds: 3600 });
    const { dialog, rerender, toasts } = show(drawer({ event: stored({ incident: closed }) }));
    expect(facts(dialog()).Ended).toHaveTextContent("2026-10-22 12:00:00");
    expect(facts(dialog()).Ended).toHaveTextContent("the source answered again");
    expect(facts(dialog()).Duration).toHaveTextContent("lasted 1 h");
    rerender(<MemoryRouter>{toasts.wrap(drawer({ event: stored({ incident: { ...closed, closed_by: "polling_stopped" } }) }))}</MemoryRouter>);
    expect(facts(dialog()).Ended).toHaveTextContent("the source stopped being read");
  });

  it("keeps the stored JSON behind a button under Details, closed to begin with and not built while it is closed", async () => {
    const stringify = vi.spyOn(JSON, "stringify");
    const event = stored({ detail: { interval: 10, marker: "unique-marker" } });
    const { dialog } = show(drawer({ event }));
    expect(within(dialog()).getByRole("heading", { name: "Details" })).toBeInTheDocument();
    const toggle = within(dialog()).getByRole("button", { name: "Show the stored JSON" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("type", "button");
    expect(dialog().querySelector("pre")).toBeNull();
    expect(stringify.mock.calls.some(([value]) => value === event.detail)).toBe(false);
    await userEvent.click(toggle);
    expect(dialog().querySelector("pre")!.textContent).toBe(JSON.stringify(event.detail, null, 2));
    await userEvent.click(within(dialog()).getByRole("button", { name: "Hide the stored JSON" }));
    expect(dialog().querySelector("pre")).toBeNull();
  });

  it("closes the JSON again when the drawer steps to another event", async () => {
    const { dialog, rerender, toasts } = show(drawer());
    await userEvent.click(within(dialog()).getByRole("button", { name: "Show the stored JSON" }));
    expect(dialog().querySelector("pre")).not.toBeNull();
    rerender(<MemoryRouter>{toasts.wrap(drawer({ event: stored({ id: 6 }) }))}</MemoryRouter>);
    expect(dialog().querySelector("pre")).toBeNull();
  });

  it("says nothing in its live line until the drawer has moved to another event, then says each one with its number", () => {
    const { dialog, rerender, toasts } = show(drawer());
    const live = () => dialog().querySelector('[aria-live="polite"]')!;
    expect(dialog().querySelectorAll("[aria-live], [role=status]")).toHaveLength(1);
    expect(live()).toBeEmptyDOMElement();
    rerender(<MemoryRouter>{toasts.wrap(drawer({ event: stored({ id: 6, kind: "collector.started", code: null }) }))}</MemoryRouter>);
    expect(live()).toHaveTextContent("Event #6: The collector started");
  });

  it("names an event of a kind it does not know by its stored text", () => {
    const { dialog } = show(drawer({ event: stored({ kind: "brand.new", code: null, message: "something new happened" }) }));
    expect(facts(dialog())["What happened"]).toHaveTextContent("something new happened");
    expect(facts(dialog()).Kind).toHaveTextContent("brand.new");
    expect(labels(dialog())).not.toContain("Code");
  });
});

describe("EventDrawer: who started it (w32)", () => {
  const check = (extra: Partial<EventDetail> = {}): EventDetail => ({
    ...stored({ kind: "check.finished", code: null, level: "info", message: "connection check passed (7 steps)", detail: { job_id: 42, ok: true, steps: 7 } }),
    started_by: { audit_id: 231, username: "admin", ts: "2026-10-22T07:59:00Z" },
    ...extra,
  });

  it("shows Started by with the person, the time and a link to the audit entry for a finished check, as the row before the event", () => {
    const { dialog } = show(drawer({ event: check() }));
    expect(labels(dialog()).slice(-2)).toEqual(["Started by", "Event"]);
    const row = facts(dialog())["Started by"];
    expect(row).toHaveTextContent("admin, 22 Oct 10:59");
    expect(within(row as HTMLElement).getByRole("link", { name: "Open the audit entry" })).toHaveAttribute("href", "/audit/231");
  });

  it("holds the row's place with a skeleton while the single event is read, and says so with a dash when nobody started it or the account may not see who", () => {
    const { dialog, rerender, toasts } = show(drawer({ event: stored({ kind: "check.finished", code: null, detail: { ok: true } }), startedByPending: true }));
    expect(labels(dialog())).toContain("Started by");
    expect(facts(dialog())["Started by"].querySelector(".sk")).not.toBeNull();
    rerender(<MemoryRouter>{toasts.wrap(drawer({ event: check({ started_by: null }) }))}</MemoryRouter>);
    expect(facts(dialog())["Started by"]).toHaveTextContent("—");
    expect(within(dialog()).queryByRole("link", { name: "Open the audit entry" })).toBeNull();
  });

  it("names a removed account", () => {
    const { dialog } = show(drawer({ event: check({ started_by: { audit_id: 9, username: null, ts: "2026-10-22T07:59:00Z" } }) }));
    expect(facts(dialog())["Started by"]).toHaveTextContent("a removed account, 22 Oct 10:59");
  });

  it("asks for it for a job of a test or a check only, and for no other kind", () => {
    const { dialog, rerender, toasts } = show(drawer({ event: stored({ kind: "job.finished", detail: { ok: false, kind: "test_source", job_id: 3 } }) }));
    expect(labels(dialog())).toContain("Started by");
    rerender(<MemoryRouter>{toasts.wrap(drawer({ event: stored({ kind: "job.finished", detail: { ok: true, kind: "scan", job_id: 4 } }) }))}</MemoryRouter>);
    expect(labels(dialog())).not.toContain("Started by");
    rerender(<MemoryRouter>{toasts.wrap(drawer({ event: stored() }))}</MemoryRouter>);
    expect(labels(dialog())).not.toContain("Started by");
  });
});

describe("EventDrawer: Copy (w32)", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else delete (navigator as unknown as Record<string, unknown>).clipboard;
    delete (document as unknown as Record<string, unknown>).execCommand;
  });

  it("puts the event as one block of text on the clipboard and raises one toast", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { dialog, toasts } = show(drawer());
    await userEvent.click(within(dialog()).getByRole("button", { name: "Copy event details" }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = String(writeText.mock.calls[0][0]);
    expect(copied).toContain("Event #7");
    expect(copied).toContain("2026-10-22 11:00:00 Asia/Qatar");
    expect(copied).toContain("Warning");
    expect(copied).toContain("OPC UA server at 172.20.0.3:4840");
    expect(copied).toContain("source.offline / unreachable");
    expect(copied).toContain("[Errno 111] Connect call failed");
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "info", text: "Event copied" }]));
  });

  it("says so, with an error toast, when nothing could copy", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    document.execCommand = vi.fn(() => false);
    const { dialog, toasts } = show(drawer());
    await userEvent.click(within(dialog()).getByRole("button", { name: "Copy event details" }));
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "error", text: "Could not copy the event" }]));
  });
});

describe("EventDrawer: states (w32)", () => {
  it("draws a skeleton while the event loads, one status region, and no facts", () => {
    const { dialog } = show(drawer({ event: undefined, status: "loading" }));
    expect(within(dialog()).getByRole("status")).toHaveTextContent("Loading the event");
    expect(dialog().querySelector(".kv")).not.toBeNull();
    expect(dialog().querySelectorAll(".kv dt .sk").length).toBeGreaterThanOrEqual(6);
  });

  it("says why it cannot show the event, as an alert", () => {
    const { dialog } = show(drawer({ event: undefined, status: "error", message: "Event not found." }));
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("Event not found.");
  });

  it("puts the footer and a Close button in the drawer, and asks the page to close", async () => {
    const onClose = vi.fn();
    const { dialog } = show(drawer({ onClose, footer: <button type="button">Next event</button> }));
    expect(within(dialog()).getByRole("button", { name: "Next event" })).toBeInTheDocument();
    await userEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

describe("EventSteps: Previous and Next (w32)", () => {
  const steps = (props: Partial<Parameters<typeof EventSteps>[0]> = {}) => {
    const onStep = vi.fn();
    render(<EventSteps previous={null} next={null} busy={false} error={null} onStep={onStep} {...props} />);
    return { onStep, previous: () => screen.getByRole("button", { name: /^Previous event/ }), next: () => screen.getByRole("button", { name: /^Next event/ }) };
  };

  it("steps to the newer event with Previous and to the older one with Next", async () => {
    const { onStep, previous, next } = steps();
    await userEvent.click(previous());
    await userEvent.click(next());
    expect(onStep.mock.calls.map(([direction]) => direction)).toEqual(["previous", "next"]);
    expect(previous()).toHaveAttribute("type", "button");
  });

  it("names the reason in a button that is off, keeps it focusable (aria-disabled, never disabled) and does nothing when it is pressed", async () => {
    const { onStep, previous, next } = steps({ previous: "this is the newest event loaded" });
    expect(previous()).toHaveAccessibleName("Previous event: this is the newest event loaded");
    expect(previous()).toHaveAttribute("aria-disabled", "true");
    expect(previous()).not.toBeDisabled();
    previous().focus();
    expect(previous()).toHaveFocus();
    await userEvent.click(previous());
    expect(onStep).not.toHaveBeenCalled();
    expect(next()).not.toHaveAttribute("aria-disabled");
  });

  it("waits on both buttons while more events are read, keeping the focus where it is", async () => {
    const { onStep, previous, next } = steps({ busy: true });
    next().focus();
    expect(next()).toHaveAccessibleName("Next event: reading more events");
    expect(previous()).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(next());
    expect(onStep).not.toHaveBeenCalled();
    expect(next()).toHaveFocus();
  });

  it("says why a step failed, as an alert", () => {
    steps({ error: "Could not read more events: the server did not answer." });
    expect(screen.getByRole("alert")).toHaveTextContent("Could not read more events");
  });
});
