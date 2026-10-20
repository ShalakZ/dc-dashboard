import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Widget } from "../api/types";
import { assetList, authed, config, dashboard, textWidget, widget, widgetDataRoute } from "../test/dashboardFixtures";
import { mockFetch, type Routes } from "../test/fetchMock";
import { markGuideSeen } from "../test/guideSeen";
import { holdFetch } from "../test/holdFetch";
import { renderWithDataRouter } from "../test/render";
import { DashboardPage } from "./DashboardPage";

// w27 R12: "Updated 20:09" and Refresh in the viewer's header.
vi.mock("echarts-for-react", () => ({ default: () => <div data-testid="chart" /> }));
class FakeEventSource {
  static CLOSED = 2;
  readyState = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close() { this.readyState = 2; }
}
beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource);
  markGuideSeen();
});

const power = widget(1, "stat", { title: "Current power", config: config({ aggregation: "last" }), x: 0, y: 0, w: 3, h: 2 });
const energy = widget(2, "stat", { title: "Energy", config: config({ source: "energy", metric: null, aggregation: "sum", range: "this_month" }), x: 3, y: 0, w: 3, h: 2 });
const following = widget(3, "stat", { title: "Follows", config: config({ assets: [], source: "energy", metric: null, aggregation: "sum", range: "this_month", scope: "focus" }), x: 6, y: 0, w: 3, h: 2 });

function open(widgets: Widget[] = [power, energy], over: Routes = {}, role = "operator", route = "/dashboards/3") {
  const calls = mockFetch({
    ...authed(role),
    "GET /api/dashboards/3": { body: dashboard({ widgets }) },
    "GET /api/assets": { body: [] },
    "POST /api/widget-data": widgetDataRoute,
    ...over,
  });
  renderWithDataRouter(<DashboardPage />, { route, path: "/dashboards/:id" });
  return calls;
}
const asked = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method === "POST" && c.path === "/api/widget-data").length;
const slot = () => document.querySelector<HTMLElement>(".dash-updated");
const refresh = () => screen.getByRole("button", { name: "Refresh" });
const cards = () => screen.findAllByRole("region", { name: /Current power|Energy|Follows/ });

describe("Updated and Refresh in the dashboard's header", () => {
  it("keeps the room for the time from the first paint of the header, empty until the first answer, then says Updated HH:MM", async () => {
    const calls = open();
    const held = holdFetch((method, path) => method === "POST" && path === "/api/widget-data");
    await cards();
    expect(slot(), "the slot is there").not.toBeNull();
    expect(slot()).toHaveTextContent(/^$/);
    held.release();
    await waitFor(() => expect(slot()).toHaveTextContent(/^Updated \d{2}:\d{2}$/));
    expect(asked(calls)).toBeGreaterThanOrEqual(2);
  });

  it("writes the time in the site's zone: the answer's minute on the clock of Asia/Qatar", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-20T17:09:30Z"));
      open();
      await waitFor(() => expect(slot()).toHaveTextContent("Updated 20:09"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("is not in a live region, so a refetch every 30 seconds is never read out", async () => {
    open();
    await waitFor(() => expect(slot()).toHaveTextContent(/Updated/));
    expect(slot()!.closest('[aria-live], [role="status"], [role="alert"], [role="log"]')).toBeNull();
    expect(slot()).not.toHaveAttribute("aria-live");
  });

  it("is drawn in this order: the time, Refresh, How to read this, the range, Focus with its tip, Edit - all before the cards", async () => {
    open([following, power]);
    await cards();
    const order = [
      slot()!, refresh(), screen.getByRole("button", { name: "How to read this" }), screen.getByLabelText("Dashboard range"),
      screen.getByRole("button", { name: "Focus" }), screen.getByRole("button", { name: "What does this mean?" }), screen.getByRole("button", { name: "Edit" }),
      screen.getByRole("region", { name: "Follows" }),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `item ${i} comes after item ${i - 1}`).toBeTruthy();
    }
  });

  it("has Refresh as a text button, not a primary or edged one", async () => {
    open([power]);
    await cards();
    expect(refresh()).toHaveClass("quiet");
    expect(refresh()).not.toHaveClass("primary");
  });

  it("offers neither on a dashboard with no data card", async () => {
    open([textWidget(9, "heading", "Hall")]);
    await screen.findByRole("heading", { name: "Hall A" });
    expect(slot()).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
  });

  it("Refresh reads every card on screen again, keeps the focus on itself and waits (aria-disabled, never disabled) while the reads are out", async () => {
    const calls = open();
    await waitFor(() => expect(slot()).toHaveTextContent(/Updated/));
    await waitFor(() => expect(refresh()).not.toHaveAttribute("aria-disabled"));
    const before = asked(calls);
    const held = holdFetch((method, path) => method === "POST" && path === "/api/widget-data");
    await userEvent.click(refresh());
    expect(refresh()).toHaveFocus();
    await waitFor(() => expect(refresh()).toHaveAttribute("aria-disabled", "true"));
    expect(refresh()).not.toBeDisabled();
    await userEvent.click(refresh()); // while it waits, a click does nothing more
    held.release();
    await waitFor(() => expect(refresh()).not.toHaveAttribute("aria-disabled"));
    expect(asked(calls) - before, "one read for each of the two cards").toBe(2);
    expect(refresh()).toHaveFocus();
  });

  it("is not a way to reach the figures of another dashboard: it reads only what this one has on screen", async () => {
    const calls = open([power]);
    await waitFor(() => expect(slot()).toHaveTextContent(/Updated/));
    await waitFor(() => expect(refresh()).not.toHaveAttribute("aria-disabled"));
    const before = calls.filter((c) => c.path === "/api/dashboards/3").length;
    await userEvent.click(refresh());
    await waitFor(() => expect(asked(calls)).toBe(2));
    expect(calls.filter((c) => c.path === "/api/dashboards/3").length, "the dashboard itself is not read again").toBe(before);
  });

  it("adds no more than six Tab stops between the range select and the first card's Details, whatever the role and the focus", async () => {
    open([power, energy], {}, "operator");
    await cards();
    await screen.findByRole("button", { name: "Details for Current power" });
    screen.getByLabelText("Dashboard range").focus();
    const target = screen.getByRole("button", { name: "Details for Current power" });
    let presses = 0;
    while (document.activeElement !== target && presses < 12) {
      await userEvent.tab();
      presses++;
    }
    expect(document.activeElement).toBe(target);
    expect(presses).toBeLessThanOrEqual(6);
  });

  it("keeps the order with a focus link in the header: the link comes after Focus and its tip, before Edit", async () => {
    open([following, power], { "GET /api/assets": { body: assetList } }, "operator", "/dashboards/3?asset=2");
    const link = await screen.findByRole("link", { name: /^Open .* page$/ });
    const order = [slot()!, refresh(), screen.getByLabelText("Dashboard range"), screen.getByRole("button", { name: "Focus" }), screen.getByRole("button", { name: "What does this mean?" }), link, screen.getByRole("button", { name: "Edit" })];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `item ${i} comes after item ${i - 1}`).toBeTruthy();
    }
    expect(screen.getByRole("heading", { level: 1 })).toHaveClass("dash-title");
    expect(document.querySelector(".dash-head")).toHaveClass("row");
  });

  it("holds every control in one group beside the title, so the row can wrap it as a unit (w27 P1): two parts, the figures' and the viewer's, in the order they had", async () => {
    open([following, power], { "GET /api/assets": { body: assetList } }, "operator", "/dashboards/3?asset=2");
    const link = await screen.findByRole("link", { name: /^Open .* page$/ });
    const head = document.querySelector<HTMLElement>(".dash-head")!;
    expect([...head.children].map((child) => child.tagName + "." + child.className)).toEqual(["H1.dash-title", "DIV.dash-controls"]); // nothing else is a child of the row: no spacer, no loose control
    const controls = head.querySelector<HTMLElement>(".dash-controls")!;
    expect([...controls.children].map((child) => child.className)).toEqual(["dash-info", "dash-view"]);
    const info = controls.querySelector(".dash-info")!;
    const view = controls.querySelector(".dash-view")!;
    expect(info).toContainElement(slot());
    expect(info).toContainElement(refresh());
    for (const control of [screen.getByLabelText("Dashboard range"), screen.getByRole("button", { name: "Focus" }), screen.getByRole("button", { name: "What does this mean?" }), link, screen.getByRole("button", { name: "Edit" })]) {
      expect(view, control.textContent || control.getAttribute("aria-label") || control.id).toContainElement(control as HTMLElement);
    }
    expect(view.lastElementChild).toBe(screen.getByRole("button", { name: "Edit" })); // Edit ends the group: it is never the part that is left alone
  });

  it("has no info part on a dashboard with nothing to read or refresh and no guide to offer, and the viewer's part alone is the group", async () => {
    open([textWidget(9, "heading", "Hall")]);
    await screen.findByRole("heading", { name: "Hall", level: 2 });
    const controls = document.querySelector(".dash-controls")!;
    expect(controls.querySelector(".dash-info")).toBeNull();
    expect([...controls.children].map((child) => child.className)).toEqual(["dash-view"]);
  });
});
