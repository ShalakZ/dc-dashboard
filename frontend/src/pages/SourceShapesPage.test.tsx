import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import type { Shape, ShapesAnswer } from "../api/shapes";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { manualTimers } from "../test/manualTimers";
import { renderWithProviders } from "../test/render";
import { accountKnown, SignedIn } from "../test/signedIn";
import { answer, created, linesAnswer, PENRG_B, POWER, report, shape, VOLTAGE } from "../test/shapesFixtures";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { SourceShapesPage } from "./SourceShapesPage";

const A_KEY = "pdua#_pm#_penrg";
const B_KEY = "pdub#_pm#_penrg";
const V_KEY = "pdua#_pm#_vl#n";

function Where() {
  return <span data-testid="where">{useLocation().search}</span>;
}

interface Options {
  user?: ReturnType<typeof userFor>;
  body?: ShapesAnswer | ((q: string) => ShapesAnswer);
  route?: string;
  linesBody?: ReturnType<typeof linesAnswer>;
  debounce?: boolean;
}

/** The page over a mocked server. `reads` records the `q` of every shapes read; `state.mapped` is what the server says is mapped (the real run and the Undo move it). */
function setup({ user = userFor("admin"), body = answer(), route = "/sources/5/shapes", linesBody = linesAnswer() }: Options = {}) {
  const toasts = spyToasts();
  const clock = manualTimers();
  const reads: string[] = [];
  const state = { mapped: 12 };
  const lines: unknown[] = [];
  const calls = mockFetch({
    "GET /api/setup": { body: { needed: false } },
    "GET /api/me": { body: user },
    "GET /api/sources/5/shapes": ({ url }) => {
      const q = new URL(url, "http://x").searchParams.get("q") ?? "";
      reads.push(q);
      const base = typeof body === "function" ? body(q) : body;
      return { body: { ...base, mapped: state.mapped } };
    },
    "POST /api/sources/5/shapes/lines": ({ body: sent }) => { lines.push(sent); return { body: linesBody }; },
    "POST /api/sources/5/tag-list": ({ url }) => {
      if (url.includes("dry_run=1")) return { body: report() };
      state.mapped += 400;
      return { body: created() };
    },
    "POST /api/tag-lists/91/undo": () => { state.mapped -= 400; return { body: { mappings: 400, assets: 398, points_removed: 0, points_kept: 0 } }; },
  });
  const view = renderWithProviders(<><SignedIn /><Where /><SourceShapesPage timers={clock.timers} /></>, { route, path: "/sources/:id/shapes", toasts: toasts.api });
  return { ...view, toasts, clock, reads, calls, state, lines };
}

const decision = (label: string) => screen.getByRole("combobox", { name: `Decision for ${label}` }) as HTMLSelectElement;
const rowOf = (label: string) => screen.getByRole("group", { name: `Shape ${label}` });
const reviewButton = () => screen.getByRole("button", { name: /^Review / });
/** Waits until the page has its first answer and the account is known. */
async function ready() {
  await accountKnown();
  await screen.findByRole("heading", { level: 1 });
  await screen.findByRole("group", { name: "Shape PDUA#_PM0_PENRG" });
}

afterEach(() => cleanup());

describe("SourceShapesPage: what it shows", () => {
  it("is called <source name>: map by tag shape, with the trail back to Discovery, and says the shapes are a guess", async () => {
    setup();
    await ready();
    expect(screen.getByRole("heading", { level: 1, name: "Plant SCADA: map by tag shape" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent("Discovery");
    expect(screen.getByText(/Every shape, billing label and asset name on this page is a guess made from the tag text/)).toBeInTheDocument();
  });

  it("shows four tiles: Points, Shapes (all the shapes of the source), Mapped and Other tags, with thousands separators", async () => {
    setup({ body: answer({ shapes_total: 1234 }) });
    await ready();
    const tile = (title: string) => screen.getByText(title, { selector: ".tile-label span" }).closest(".tile") as HTMLElement;
    expect(tile("Points")).toHaveTextContent("15,000");
    expect(tile("Shapes")).toHaveTextContent("1,234");
    expect(tile("Mapped")).toHaveTextContent("12");
    expect(tile("Other tags")).toHaveTextContent("4,190");
    expect(screen.getByRole("button", { name: "About Shapes" })).toBeInTheDocument();
  });

  it("lists the billing shapes first, in the server's order, and keeps the rest behind a closed disclosure", async () => {
    setup();
    await ready();
    const labels = screen.getAllByRole("group").map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual(["Shape PDUA#_PM0_PENRG", "Shape PDUB#_PM0_PENRG", "Shape PDUA#_PM0_P"]);
    expect(screen.getByRole("heading", { name: "Suggested for billing" })).toBeInTheDocument();
    const disclosure = screen.getByRole("button", { name: "Not needed for billing (600 points)" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Shape PDUA#_PM0_VL#N" })).toBeNull();
    await userEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("group", { name: "Shape PDUA#_PM0_VL#N" })).toBeInTheDocument();
    await userEvent.click(disclosure);
    expect(screen.queryByRole("group", { name: "Shape PDUA#_PM0_VL#N" })).toBeNull();
  });

  it("every row starts at Ignore, and a row of the closed section can be decided once it is opened", async () => {
    setup();
    await ready();
    for (const label of ["PDUA#_PM0_PENRG", "PDUB#_PM0_PENRG", "PDUA#_PM0_P"]) expect(decision(label)).toHaveValue("");
    await userEvent.click(screen.getByRole("button", { name: /^Not needed for billing/ }));
    expect(decision("PDUA#_PM0_VL#N")).toHaveValue("");
    await userEvent.selectOptions(decision("PDUA#_PM0_VL#N"), "Map as voltage");
    expect(reviewButton()).toHaveTextContent("Review 600 mappings...");
  });

  it("says when no shape looks like billing", async () => {
    setup({ body: answer({ shapes: [VOLTAGE()], shapes_total: 1 }) });
    await accountKnown();
    expect(await screen.findByText("No shape looks like an energy counter or a power reading.")).toBeInTheDocument();
  });

  it("names the other tags with three examples as plain text, and the shapes it did not list", async () => {
    setup({ body: answer({ more_shapes: 12, shapes_total: 316 }) });
    await ready();
    expect(screen.getByText("Other tags (4,190)")).toBeInTheDocument();
    expect(screen.getByText(/For example PDUA01_Q1_P, PDUA02_Q1_P, PDUA03_Q1_P\./)).toBeInTheDocument();
    expect(screen.getByText(/\+ 12 more shapes/)).toBeInTheDocument();
  });

  it("links the other tags to the Points page for a role that may open it", async () => {
    setup();
    await ready();
    expect(screen.getByRole("link", { name: "See them on the Points page" })).toHaveAttribute("href", "/sources/5/points");
  });

  it("shows no link to the Points page to a role that cannot open it (sources.edit), only the examples", async () => {
    setup({ user: userFor("custom", { permissions: ["discovery.view", "discovery.accept"] }) });
    await ready();
    expect(screen.getByText("Other tags (4,190)")).toBeInTheDocument();
    expect(screen.getByText(/For example PDUA01_Q1_P/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Points page/ })).toBeNull();
  });

  it("shows a skeleton while the first answer is on its way, and the server's sentence when it cannot be read", async () => {
    mockFetch({ "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: userFor("admin") }, "GET /api/sources/5/shapes": { status: 404, body: { detail: "source not found" } } });
    renderWithProviders(<SourceShapesPage />, { route: "/sources/5/shapes", path: "/sources/:id/shapes" });
    expect(screen.getByRole("status", { name: "" })).toHaveTextContent("Loading shapes");
    expect(await screen.findByRole("alert")).toHaveTextContent("source not found");
  });

  it("never writes Search points: the box is Search tags (the Points page and its specs own the other)", async () => {
    setup();
    await ready();
    expect(screen.getByRole("searchbox", { name: "Search tags" })).toHaveAttribute("placeholder", "Search tags");
    expect(screen.queryByLabelText("Search points")).toBeNull();
  });
});

describe("SourceShapesPage: without the right to decide", () => {
  it("shows the decisions as text, no Review button, no bottom bar and no tick (discovery.view only)", async () => {
    setup({ user: userFor("operator") });
    await ready();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Review / })).toBeNull();
    expect(screen.queryByLabelText("Put new assets under")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(rowOf("PDUA#_PM0_PENRG")).toHaveTextContent("Decision: Ignore");
    expect(screen.getByText(/Your role can look at the shapes but not map them/)).toBeInTheDocument();
  });
});

describe("SourceShapesPage: the search", () => {
  it("asks the server after 300 ms of quiet, with q, and not for fewer than 2 characters", async () => {
    const { reads, clock } = setup();
    await ready();
    expect(reads).toEqual([""]);
    const box = screen.getByRole("searchbox", { name: "Search tags" });
    await userEvent.type(box, "P");
    act(() => clock.advance(1000));
    expect(reads).toEqual([""]);
    await userEvent.type(box, "ENRG");
    act(() => clock.advance(299));
    expect(reads).toEqual([""]);
    act(() => clock.advance(1));
    await waitFor(() => expect(reads).toEqual(["", "PENRG"]));
  });

  it("restarts the wait with every key, and sends no q once the text is cleared", async () => {
    const { reads, clock } = setup();
    await ready();
    const box = screen.getByRole("searchbox", { name: "Search tags" });
    await userEvent.type(box, "PE");
    act(() => clock.advance(200));
    await userEvent.type(box, "N");
    act(() => clock.advance(200));
    expect(reads).toEqual([""]);
    act(() => clock.advance(100));
    await waitFor(() => expect(reads).toEqual(["", "PEN"]));
    await userEvent.clear(box);
    act(() => clock.advance(300));
    await waitFor(() => expect(reads).toEqual(["", "PEN", ""]));
  });

  it("keeps the box and its focus while the answer for a new search is read (the page does not go back to loading)", async () => {
    const { clock } = setup();
    await ready();
    const box = screen.getByRole("searchbox", { name: "Search tags" });
    await userEvent.type(box, "PENRG");
    const hold = holdFetch((method, path) => method === "GET" && path === "/api/sources/5/shapes");
    act(() => clock.advance(300));
    await Promise.resolve();
    expect(screen.getByRole("searchbox", { name: "Search tags" })).toBe(box);
    expect(box).toHaveFocus();
    expect(screen.getByRole("group", { name: "Shape PDUA#_PM0_PENRG" })).toBeInTheDocument();
    hold.release();
  });

  it("writes the search into the address, and the address's own search is applied at once", async () => {
    const first = setup({ route: "/sources/5/shapes?q=PENRG" });
    await ready();
    expect(first.reads).toEqual(["PENRG"]);
    expect(screen.getByRole("searchbox", { name: "Search tags" })).toHaveValue("PENRG");
    expect(screen.getByTestId("where")).toHaveTextContent("?q=PENRG");
    cleanup();
    const second = setup();
    await ready();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search tags" }), "volt");
    act(() => second.clock.advance(300));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent("?q=volt"));
  });

  it("lists the first matches, and the row of a match is highlighted and focused", async () => {
    const withMatches = (q: string) => answer({
      matches: q === "" ? undefined : {
        count: 12,
        first: [
          { name: "PDUB01_PM0_PENRG", address: "ns=3;s=1:Site.PDUB01_PM0_PENRG", shape: B_KEY },
          { name: "PDUA01_Q1_P", address: "ns=3;s=1:Site.PDUA01_Q1_P", shape: null },
        ],
      },
    });
    const { clock } = setup({ body: withMatches });
    await ready();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search tags" }), "PENRG");
    act(() => clock.advance(300));
    expect(await screen.findByText('12 tags match "PENRG", in 4 shapes.')).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Matching tags" });
    expect(list).toHaveTextContent("PDUA01_Q1_P is in no shape (see Other tags)");
    expect(list).toHaveTextContent("and 10 more");
    await userEvent.click(within(list).getByRole("button", { name: "PDUB01_PM0_PENRG" }));
    const row = rowOf("PDUB#_PM0_PENRG");
    await waitFor(() => expect(row).toHaveFocus());
    expect(row).toHaveAttribute("data-focus", "true");
    expect(rowOf("PDUA#_PM0_PENRG")).not.toHaveAttribute("data-focus");
    expect(screen.getByTestId("where")).toHaveTextContent("focus=pdub%23_pm%23_penrg");
  });

  it("opens the closed section when the match is a row in it", async () => {
    const withMatches = (q: string) => answer({ matches: q === "" ? undefined : { count: 1, first: [{ name: "PDUA01_PM0_VL1N", address: "a", shape: V_KEY }] } });
    const { clock } = setup({ body: withMatches });
    await ready();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search tags" }), "VL1N");
    act(() => clock.advance(300));
    await userEvent.click(await screen.findByRole("button", { name: "PDUA01_PM0_VL1N" }));
    expect(screen.getByRole("button", { name: /^Not needed for billing/ })).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(rowOf("PDUA#_PM0_VL#N")).toHaveFocus());
  });

  it("reads a deep link with a real key (it holds #) and a focus: the row is found by its data-shape value", async () => {
    const link = `/sources/5/shapes?${new URLSearchParams({ q: "pdua#_pm#_penrg", focus: B_KEY })}`;
    const { reads } = setup({ route: link });
    await ready();
    expect(reads).toEqual(["pdua#_pm#_penrg"]);
    await waitFor(() => expect(rowOf("PDUB#_PM0_PENRG")).toHaveFocus());
    expect(rowOf("PDUB#_PM0_PENRG")).toHaveAttribute("data-focus", "true");
    expect(rowOf("PDUB#_PM0_PENRG").dataset.shape).toBe(B_KEY);
  });

  it("opens the closed section for a deep link to a row in it", async () => {
    setup({ route: `/sources/5/shapes?${new URLSearchParams({ focus: V_KEY })}` });
    await ready();
    await waitFor(() => expect(rowOf("PDUA#_PM0_VL#N")).toHaveFocus());
    expect(screen.getByRole("button", { name: /^Not needed for billing/ })).toHaveAttribute("aria-expanded", "true");
  });

  it("says when nothing matches", async () => {
    const { clock } = setup({ body: (q) => (q === "" ? answer() : answer({ shapes: [], matches: { count: 0, first: [] } })) });
    await ready();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search tags" }), "zzz");
    act(() => clock.advance(300));
    expect(await screen.findByText('No shape has a tag that matches "zzz".')).toBeInTheDocument();
  });
});

describe("SourceShapesPage: the decisions", () => {
  it("ticks Same decision for the similar shape: it copies the decision, keeps it in step while ticked and lets go when unticked", async () => {
    setup();
    await ready();
    await userEvent.selectOptions(decision("PDUA#_PM0_PENRG"), "Map as energy counter");
    const tickBox = screen.getByRole("checkbox", { name: "Same decision for PDUB#_PM0_PENRG" });
    expect(tickBox).not.toBeChecked();
    expect(decision("PDUB#_PM0_PENRG")).toHaveValue("");
    await userEvent.click(tickBox);
    expect(decision("PDUB#_PM0_PENRG")).toHaveValue("energy_kwh");
    await userEvent.selectOptions(decision("PDUA#_PM0_PENRG"), "Map as current");
    expect(decision("PDUB#_PM0_PENRG")).toHaveValue("current_a");
    await userEvent.click(tickBox);
    await userEvent.selectOptions(decision("PDUA#_PM0_PENRG"), "Ignore");
    expect(decision("PDUB#_PM0_PENRG")).toHaveValue("current_a");
    expect(reviewButton()).toHaveTextContent("Review 200 mappings..."); // B alone is left
  });

  it("counts the tags the chosen decisions cover on the button, aria-disabled while nothing is chosen", async () => {
    setup();
    await ready();
    expect(reviewButton()).toHaveTextContent("Review mappings...");
    expect(reviewButton()).toHaveAttribute("aria-disabled", "true");
    expect(reviewButton()).not.toBeDisabled();
    await userEvent.click(reviewButton());
    expect(screen.queryByRole("dialog")).toBeNull();
    await userEvent.selectOptions(decision("PDUA#_PM0_PENRG"), "Map as energy counter");
    expect(reviewButton()).toHaveTextContent("Review 200 mappings...");
    expect(reviewButton()).not.toHaveAttribute("aria-disabled");
    await userEvent.selectOptions(decision("PDUA#_PM0_P"), "Map as active power");
    expect(reviewButton()).toHaveTextContent("Review 400 mappings...");
  });

  it("offers the parent asset (from the answer's own asset list), Create missing assets ticked, and sends both to the review", async () => {
    const { lines } = setup();
    await ready();
    const parent = screen.getByLabelText("Put new assets under");
    expect(within(parent).getAllByRole("option").map((o) => o.textContent)).toEqual(["(top level)", "Hall 1", "  Row A"]);
    expect(screen.getByRole("checkbox", { name: "Create missing assets" })).toBeChecked();
    await userEvent.selectOptions(parent, "Hall 1");
    await userEvent.click(screen.getByRole("checkbox", { name: "Create missing assets" }));
    await userEvent.selectOptions(decision("PDUA#_PM0_PENRG"), "Map as energy counter");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Asset name for PDUA#_PM0_PENRG" }), "parts 1 and 2");
    await userEvent.click(reviewButton());
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("What the tag list planner says");
    expect(lines).toEqual([{ decisions: [{ shape: A_KEY, metric: "energy_kwh", name_from: "parts12" }], parent_id: 1, create_assets: false }]);
    expect(dialog).toHaveTextContent("New assets go under Hall 1");
  });

  it("refuses a review of more than 60 shapes, with a sentence, before it asks the server", async () => {
    const many: Shape[] = Array.from({ length: 61 }, (_, i) => shape({ key: `k${i}#`, label: `K${i}#`, similar: [], billing: "counter", count: 10, examples: [{ name: `K${i}A`, address: `a${i}` }] }));
    const { lines, container } = setup({ body: answer({ shapes: many, shapes_total: 61 }) });
    await accountKnown();
    await screen.findByRole("group", { name: "Shape K0#" });
    // 61 rows make role queries slow: the decision selects are taken from the DOM once.
    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>('select[aria-label^="Decision for"]'));
    expect(selects).toHaveLength(61);
    for (const select of selects) fireEvent.change(select, { target: { value: "energy_kwh" } });
    expect(reviewButton()).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/You chose 61 shapes; one review takes at most 60/)).toBeInTheDocument();
    await userEvent.click(reviewButton());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lines).toHaveLength(0);
    fireEvent.change(selects[60], { target: { value: "" } });
    expect(reviewButton()).not.toHaveAttribute("aria-disabled");
    expect(reviewButton()).toHaveTextContent("Review 600 mappings...");
  });

  it("keeps a decision when a search no longer lists its row, and still counts its tags", async () => {
    const { clock } = setup({ body: (q) => (q === "" ? answer() : answer({ shapes: [POWER()], matches: { count: 1, first: [] } })) });
    await ready();
    await userEvent.selectOptions(decision("PDUA#_PM0_PENRG"), "Map as energy counter");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search tags" }), "PL1");
    act(() => clock.advance(300));
    await waitFor(() => expect(screen.queryByRole("group", { name: "Shape PDUA#_PM0_PENRG" })).toBeNull());
    expect(reviewButton()).toHaveTextContent("Review 200 mappings...");
  });
});

describe("SourceShapesPage: the warning slot", () => {
  it("keeps a slot for warnings under every row; a warning arrives in it and the slot is the same box", async () => {
    setup({ body: answer({ shapes: [shape({ examples: [{ name: "Solo", address: "a" }] }), PENRG_B()] }) });
    await accountKnown();
    const row = await screen.findByRole("group", { name: "Shape PDUA#_PM0_PENRG" });
    const slot = row.querySelector(".shape-warn")!;
    expect(slot).toBeEmptyDOMElement();
    await userEvent.selectOptions(decision("PDUA#_PM0_PENRG"), "Map as energy counter");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Asset name for PDUA#_PM0_PENRG" }), "parts 1 and 2");
    expect(row.querySelector(".shape-warn")).toBe(slot);
    expect(slot).toHaveTextContent("has only one part");
  });
});

describe("SourceShapesPage: Review and Map", () => {
  async function choose() {
    await userEvent.selectOptions(decision("PDUA#_PM0_PENRG"), "Map as energy counter");
    await userEvent.click(screen.getByRole("checkbox", { name: "Same decision for PDUB#_PM0_PENRG" }));
  }

  it("opens the Review for the chosen shapes, returns the focus to the button on Cancel and on Escape, and Escape closes only the dialog", async () => {
    setup();
    await ready();
    await choose();
    const button = reviewButton();
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleName("Review mappings by shape: Plant SCADA");
    await within(dialog).findByText("What the tag list planner says");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(button).toHaveFocus();
    expect(decision("PDUA#_PM0_PENRG")).toHaveValue("energy_kwh"); // the decisions stay
    await userEvent.click(button);
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(button).toHaveFocus();
    expect(screen.getByRole("searchbox", { name: "Search tags" })).toBeInTheDocument();
  });

  it("sends both chosen shapes (the tick copied the decision) in the order of the rows", async () => {
    const { lines } = setup();
    await ready();
    await choose();
    await userEvent.click(reviewButton());
    await screen.findByRole("dialog");
    await waitFor(() => expect(lines).toHaveLength(1));
    expect(lines[0]).toEqual({
      decisions: [{ shape: A_KEY, metric: "energy_kwh", name_from: "part1" }, { shape: B_KEY, metric: "energy_kwh", name_from: "part1" }],
      parent_id: null, create_assets: true,
    });
  });

  it("maps: the Undo toast, the decisions go, the dialog closes, the focus is on Review again, and the shapes are read again (the tiles move)", async () => {
    const { toasts, reads, state } = setup();
    await ready();
    await choose();
    const button = reviewButton();
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("What the tag list planner says");
    await userEvent.click(within(dialog).getByRole("button", { name: "Map 400 points" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toasts.calls.map((c) => c.text)).toEqual(["Created 400 mappings."]);
    expect(toasts.calls[0].options?.action?.label).toBe("Undo");
    expect(reviewButton()).toBe(button); // the same button: it never left the page
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(decision("PDUA#_PM0_PENRG")).toHaveValue("");
    await waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(2));
    expect(state.mapped).toBe(412);
    const tile = screen.getByText("Mapped", { selector: ".tile-label span" }).closest(".tile") as HTMLElement;
    await waitFor(() => expect(tile).toHaveTextContent("412"));
  });

  it("after Undo from the toast the shapes are read again and the tiles move back", async () => {
    const { toasts, reads } = setup();
    await ready();
    await choose();
    await userEvent.click(reviewButton());
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("What the tag list planner says");
    await userEvent.click(within(dialog).getByRole("button", { name: "Map 400 points" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const tile = screen.getByText("Mapped", { selector: ".tile-label span" }).closest(".tile") as HTMLElement;
    await waitFor(() => expect(tile).toHaveTextContent("412"));
    const before = reads.length;
    act(() => toasts.calls[0].options!.action!.onAction());
    await waitFor(() => expect(reads.length).toBeGreaterThan(before));
    await waitFor(() => expect(tile).toHaveTextContent("12"));
    expect(tile).not.toHaveTextContent("412");
  });

  it("the focus that was on the toast's Undo button lands on the page's heading when the toast goes (the heading can take focus by script)", async () => {
    const { toasts } = setup();
    await ready();
    await choose();
    await userEvent.click(reviewButton());
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("What the tag list planner says");
    await userEvent.click(within(dialog).getByRole("button", { name: "Map 400 points" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const toast = document.createElement("div");
    toast.className = "toast";
    const undo = document.createElement("button");
    toast.append(undo);
    document.body.append(toast);
    undo.focus();
    act(() => toasts.calls[0].options!.action!.onAction());
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    toast.remove();
  });

  it("a blocking check leaves Map closed and nothing is written", async () => {
    const blocked = linesAnswer({ csv: "", lines: 0, blocking: true, checks: [{ kind: "collision", severity: "blocking", shape: A_KEY, text: "3 tags of this shape would land on each asset" }] });
    const { calls } = setup({ linesBody: blocked });
    await ready();
    await choose();
    await userEvent.click(reviewButton());
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText(/3 tags of this shape would land on each asset/);
    expect(within(dialog).getByRole("button", { name: "Map points" })).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(within(dialog).getByRole("button", { name: "Map points" }));
    expect(calls.filter((c) => c.path === "/api/sources/5/tag-list")).toHaveLength(0);
  });

  it("the whole flow from the keyboard: Tab to a row, choose Map as, tick, Review, Map", async () => {
    const { toasts, lines } = setup();
    await ready();
    const tabTo = async (target: HTMLElement) => {
      for (let i = 0; i < 40 && document.activeElement !== target; i++) await userEvent.tab();
      expect(target).toHaveFocus();
    };
    await tabTo(decision("PDUA#_PM0_PENRG"));
    await userEvent.selectOptions(decision("PDUA#_PM0_PENRG"), "Map as energy counter");
    expect(decision("PDUA#_PM0_PENRG")).toHaveFocus();
    await userEvent.tab(); // Asset name
    expect(screen.getByRole("combobox", { name: "Asset name for PDUA#_PM0_PENRG" })).toHaveFocus();
    await userEvent.tab(); // the tick
    expect(screen.getByRole("checkbox", { name: "Same decision for PDUB#_PM0_PENRG" })).toHaveFocus();
    await userEvent.keyboard(" ");
    expect(decision("PDUB#_PM0_PENRG")).toHaveValue("energy_kwh");
    await tabTo(reviewButton());
    expect(reviewButton()).toHaveTextContent("Review 400 mappings...");
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    await within(dialog).findByText("What the tag list planner says");
    const go = within(dialog).getByRole("button", { name: "Map 400 points" });
    for (let i = 0; i < 6 && document.activeElement !== go; i++) await userEvent.tab();
    expect(go).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(lines).toHaveLength(1);
    expect(toasts.calls[0].text).toBe("Created 400 mappings.");
    expect(reviewButton()).toHaveFocus();
  });
});
