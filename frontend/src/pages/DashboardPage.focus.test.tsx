import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FOCUS_DENIED_NOTICE, FOCUS_GONE_NOTICE } from "../lib/focus";
import type { PermissionId } from "../lib/permissions";
import { assetList, authed, dashboard } from "../test/dashboardFixtures";
import { FakeEventSource } from "../test/fakeEventSource";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithDataRouter } from "../test/render";
import { accountKnown, SignedIn } from "../test/signedIn";
import { userFor } from "../test/users";
import { DashboardPage } from "./DashboardPage";

vi.mock("echarts-for-react", () => ({ default: (props: { option: unknown }) => <pre data-testid="chart">{JSON.stringify(props.option)}</pre> }));
// The editor's grid needs a measured width; a plain stand-in is enough here, nothing is dragged.
vi.mock("react-grid-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-grid-layout")>();
  return {
    ...actual,
    default: (props: { children?: React.ReactNode }) => <div data-testid="rgl">{props.children}</div>,
    useContainerWidth: () => ({ width: 1000, mounted: true, containerRef: { current: null }, measureWidth: () => {} }),
  };
});

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal("EventSource", FakeEventSource);
});

type Call = { method: string; path: string; body: unknown };
const listCalls = (calls: Call[]) => calls.filter((c) => c.path === "/api/assets");
/** A role called "custom" that holds `permissions`. */
const custom = (permissions: PermissionId[]): Routes => ({ "GET /api/me": { body: userFor("custom", { permissions }) } });

function open(role: string, entry: string, over: Routes = {}) {
  const calls = mockFetch({
    ...authed(role),
    "GET /api/dashboards/3": { body: dashboard() },
    "GET /api/assets": { body: assetList },
    ...over,
  });
  const view = renderWithDataRouter(<><DashboardPage /><SignedIn /></>, { route: entry, path: "/dashboards/:id" });
  return { calls, ...view, where: () => view.router.state.location.pathname + view.router.state.location.search };
}
const settle = async () => {
  await screen.findByRole("heading", { name: "Hall A" });
  await accountKnown();
};

describe("DashboardPage: the focus in the address", () => {
  it("with no parameter asks for no asset list and says nothing", async () => {
    const { calls, where } = open("viewer", "/dashboards/3");
    await settle();
    expect(listCalls(calls)).toHaveLength(0);
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
    expect(screen.queryByText(FOCUS_DENIED_NOTICE)).not.toBeInTheDocument();
    expect(where()).toBe("/dashboards/3");
  });

  it("with a valid id asks for the asset list once and leaves the address and the page as they are", async () => {
    const { calls, where } = open("viewer", "/dashboards/3?asset=5");
    await settle();
    await waitFor(() => expect(listCalls(calls)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(where()).toBe("/dashboards/3?asset=5");
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
    expect(listCalls(calls)).toHaveLength(1);
  });

  it("an id that is not in the list: the notice under the trail, and the parameter is replaced away while the others stay", async () => {
    const { where, router } = open("viewer", "/dashboards/3?asset=99&x=1");
    const notice = await screen.findByText(FOCUS_GONE_NOTICE);
    expect(notice).toHaveClass("muted");
    expect(notice).toHaveAttribute("aria-live", "polite");
    expect(where()).toBe("/dashboards/3?x=1");
    expect(router.state.historyAction).toBe("REPLACE");
    // Right after the trail, before the page itself.
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(trail.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(notice.compareDocumentPosition(screen.getByRole("heading", { name: "Hall A" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([["abc"], [""]])("an invalid parameter (%j): the same notice, the parameter gone and no list request", async (raw) => {
    const { calls, where } = open("viewer", `/dashboards/3?asset=${raw}`);
    expect(await screen.findByText(FOCUS_GONE_NOTICE)).toBeInTheDocument();
    expect(where()).toBe("/dashboards/3");
    expect(listCalls(calls)).toHaveLength(0);
  });

  it("without assets.view: the denied notice, no list request, and the parameter stays in the address", async () => {
    const { calls, where } = open("custom", "/dashboards/3?asset=5", custom(["dashboards.view"]));
    expect(await screen.findByText(FOCUS_DENIED_NOTICE)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(listCalls(calls)).toHaveLength(0);
    expect(where()).toBe("/dashboards/3?asset=5");
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
  });

  it("one top-level asset that is the focus: the parameter is removed and nothing is said", async () => {
    const { where } = open("viewer", "/dashboards/3?asset=1");
    await waitFor(() => expect(where()).toBe("/dashboards/3"));
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
  });

  it("two top-level assets: the parameter stays", async () => {
    const { calls, where } = open("viewer", "/dashboards/3?asset=1", { "GET /api/assets": { body: [...assetList, { id: 9, parent_id: null, name: "Annex", kind: "site", sort_order: 1 }] } });
    await settle();
    await waitFor(() => expect(listCalls(calls)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(where()).toBe("/dashboards/3?asset=1");
    expect(screen.queryByText(FOCUS_GONE_NOTICE)).not.toBeInTheDocument();
  });

  it("the notice is shown once and survives going into edit mode and back", async () => {
    open("operator", "/dashboards/3?asset=abc");
    expect(await screen.findByText(FOCUS_GONE_NOTICE)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await screen.findByLabelText("Dashboard name");
    expect(screen.getAllByText(FOCUS_GONE_NOTICE)).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("heading", { name: "Hall A" });
    expect(screen.getAllByText(FOCUS_GONE_NOTICE)).toHaveLength(1);
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).getByText("Hall A")).toBeInTheDocument();
  });
});
