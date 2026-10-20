import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Widget } from "../api/types";
import { authed, config, dashboard, textWidget, widget } from "../test/dashboardFixtures";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithDataRouter } from "../test/render";
import { userFor } from "../test/users";
import { DashboardPage } from "./DashboardPage";

// w27 R10 and R11: the first-run guide, its header button and the help tips of the viewer. The cards ask for data that always fails: the guide does not depend on it.
vi.mock("echarts-for-react", () => ({ default: () => <div data-testid="chart" /> }));

const GUIDE = "How to read this dashboard";
const following = widget(1, "stat", { title: "Follows", config: config({ assets: [], source: "energy", metric: null, aggregation: "sum", range: "this_month", scope: "focus" }) });
const fixed = widget(2, "stat", { title: "Fixed", config: config({ aggregation: "last" }) });
const kinds = widget(3, "bar", { title: "Racks", config: config({ assets: [], source: "energy", metric: null, aggregation: "sum", bars: "kind", kind: "Rack", range: "this_month" }) });
const comparing = widget(4, "stat", { title: "Compared", config: config({ assets: [], source: "energy", metric: null, aggregation: "sum", range: "this_month", compare: "same_days_last_month", scope: "focus" }) });

function open(widgets: Widget[] = [following, fixed], over: Routes = {}, role = "viewer") {
  const calls = mockFetch({
    ...authed(role),
    "GET /api/dashboards/3": { body: dashboard({ widgets }) },
    "GET /api/assets": { body: [] },
    "POST /api/widget-data": { status: 500, body: { detail: "no data in this test" } },
    ...over,
  });
  renderWithDataRouter(<DashboardPage />, { route: "/dashboards/3", path: "/dashboards/:id" });
  return calls;
}
const panel = () => screen.queryByRole("heading", { name: GUIDE });
const readThis = () => screen.getByRole("button", { name: "How to read this" });
/** The page is ready when the first card's frame is in. */
const ready = () => screen.findAllByRole("region", { name: /Follows|Racks|Fixed|Compared/ });

describe("the first-run guide", () => {
  it("is in the page in the first render of the dashboard, with the cards, never inserted after them", async () => {
    open();
    await ready();
    // Synchronous from the moment a card is there: a panel that came a render later would have moved the cards.
    expect(panel()).toBeInTheDocument();
    expect(panel()!.compareDocumentPosition(screen.getByRole("region", { name: "Follows" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(panel()!.parentElement!).getAllByRole("listitem").length).toBeGreaterThanOrEqual(2);
  });

  it("Got it closes it, remembers that for this account in this browser, and moves the focus to How to read this", async () => {
    open();
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(panel()).not.toBeInTheDocument();
    expect(window.localStorage.getItem("dcdash.guide.dashboard.v1:1")).toBe("1");
    expect(readThis()).toHaveFocus();
  });

  it("does not come back for an account that has dismissed it, and the header button is still there", async () => {
    window.localStorage.setItem("dcdash.guide.dashboard.v1:1", "1");
    open();
    await ready();
    expect(panel()).not.toBeInTheDocument();
    expect(readThis()).toBeInTheDocument();
  });

  it("is per account: another account on the same browser sees it", async () => {
    window.localStorage.setItem("dcdash.guide.dashboard.v1:2", "1");
    open();
    await ready();
    expect(panel()).toBeInTheDocument();
  });

  it("How to read this opens it again and moves the focus to its heading; pressed while it is open it only moves the focus there", async () => {
    window.localStorage.setItem("dcdash.guide.dashboard.v1:1", "1");
    open();
    await ready();
    expect(panel()).not.toBeInTheDocument();
    await userEvent.click(readThis());
    expect(panel()).toBeInTheDocument();
    expect(panel()).toHaveFocus();
    readThis().focus();
    await userEvent.click(readThis());
    expect(screen.getAllByRole("heading", { name: GUIDE })).toHaveLength(1);
    expect(panel()).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(panel()).not.toBeInTheDocument();
    expect(readThis()).toHaveFocus();
  });

  it("is a text button, not a pill, and shares no name with the panel's heading for a button lookup", async () => {
    open();
    await ready();
    expect(readThis()).toHaveClass("quiet");
    expect(screen.getAllByRole("button", { name: /How to read this/ })).toHaveLength(1);
  });

  it("shows for storage that cannot be read or written: the panel is there, Got it closes it for the rest of the page, nothing throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    open(undefined, { "GET /api/me": { body: userFor("viewer", { id: 4242 }) } });
    await ready();
    expect(panel()).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(panel()).not.toBeInTheDocument();
    expect(readThis()).toHaveFocus();
  });

  it("is not offered on a dashboard where nothing follows the focus, compares or breaks down", async () => {
    open([fixed, textWidget(9, "heading", "Hall")]);
    await ready();
    expect(panel()).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "How to read this" })).not.toBeInTheDocument();
  });

  it("is offered on a dashboard that only compares, or only breaks down", async () => {
    open([comparing, fixed], { "GET /api/me": { body: userFor("custom", { permissions: ["dashboards.view"] }) } });
    await ready();
    expect(panel()).toBeInTheDocument();
  });

  it("lists the lines the dashboard has and the role can use", async () => {
    open([comparing, kinds, fixed]);
    await ready();
    const lines = within(panel()!.parentElement!).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^Energy and Cost cards set this month so far/);
    expect(lines[1]).toMatch(/^Focus picks the asset/);
    expect(lines[2]).toMatch(/^Click a bar of a breakdown: an asset with other assets inside it narrows/);
  });

  it("lists only the lines true for a role that cannot open assets (no Focus, no bar clicks)", async () => {
    open([comparing, kinds, fixed], { "GET /api/me": { body: userFor("custom", { permissions: ["dashboards.view"] }) } });
    await ready();
    const lines = within(panel()!.parentElement!).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(lines).toHaveLength(3);
    expect(lines.join(" ")).not.toMatch(/Focus|Click a bar/);
    expect(screen.queryByRole("button", { name: "Focus" })).not.toBeInTheDocument();
  });

  it("is not in the way of the cards in edit mode: the editor has no guide", async () => {
    open([following, fixed], {}, "operator");
    await ready();
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("button", { name: "Save" });
    expect(panel()).not.toBeInTheDocument();
  });
});

describe("the tip beside Focus", () => {
  beforeEach(() => {
    window.localStorage.setItem("dcdash.guide.dashboard.v1:1", "1");
  });

  it("is a What does this mean? button right after Focus that opens a one-sentence bubble, and Escape closes only the bubble", async () => {
    open();
    await ready();
    const focus = await screen.findByRole("button", { name: "Focus" });
    const tip = screen.getByRole("button", { name: "What does this mean?" });
    expect(focus.nextElementSibling).toBe(tip.closest(".tip"));
    await userEvent.click(tip);
    expect(screen.getByRole("note")).toHaveTextContent("the cards that follow the focus show it");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("is not there for a role that cannot choose a focus", async () => {
    open([following, fixed], { "GET /api/me": { body: userFor("custom", { permissions: ["dashboards.view"] }) } });
    await ready();
    expect(screen.queryByRole("button", { name: "What does this mean?" })).not.toBeInTheDocument();
  });
});
