import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { MemoryRouter } from "react-router";
import { keys } from "../../api/queries";
import type { Asset, WidgetData } from "../../api/types";
import { breakdownBlock, breakdownData, config, valueRow, valuesData } from "../../test/dashboardFixtures";
import { FocusContext, type FocusState } from "./FocusContext";
import { WidgetDetails } from "./WidgetDetails";

// w25 T5 (R10): the keyboard way to the drill-through. Each bar of a breakdown by kind whose asset has children gets a "Narrow to <name>" button in the Details panel.
vi.mock("../../auth/AuthProvider", () => ({ useAuth: () => ({ can: () => true }) }));

const asset = (id: number, parent_id: number | null, name: string): Asset => ({ id, parent_id, name, kind: "rack", sort_order: id });
/** Rack 05 (id 10) holds a feed; Rack 06 (id 11) holds nothing. */
const ASSETS: Asset[] = [asset(1, null, "Site"), asset(2, 1, "Hall 1"), asset(10, 2, "Rack 05"), asset(11, 2, "Rack 06"), asset(100, 10, "Feed A")];
const BARS: WidgetData = breakdownData(2, {
  values: [valueRow({ asset_id: 10, name: "Rack 05", value: 100, point_id: null }), valueRow({ asset_id: 11, name: "Rack 06", value: 90, point_id: null })],
  breakdown: breakdownBlock({ count: 2, shown: 2, more: { count: 0, with_value: 0, value: null, estimated: false, partial: false } }),
});
const CONFIG = config({ assets: [], bars: "kind" });

const setFocus = vi.fn();
/** A dashboard on which a card follows the focus (`anyFollowing`), so that a Narrow button means something; the all-fixed case says `anyFollowing: false`. */
const state = (over: Partial<FocusState> = {}): FocusState => ({ focus: null, allowed: true, assets: ASSETS, name: null, notice: null, anyFollowing: true, setFocus, reportGone: () => {}, ...over });

/** A card with its Details button, as WidgetView holds the drawer: the button that opened it is where focus goes back. */
function Card({ data }: { data: WidgetData }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={opener} type="button" onClick={() => setOpen(true)}>Open details</button>
      {open && <WidgetDetails title="Hall" type="bar" data={data} config={CONFIG} timezone="Asia/Qatar" following={false} onClose={() => setOpen(false)} returnFocus={() => opener.current} />}
    </>
  );
}

async function openDetails(data: WidgetData, { focus = state(), cached = ASSETS }: { focus?: FocusState; cached?: Asset[] | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (cached) client.setQueryData(keys.assets, cached);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FocusContext.Provider value={focus}>
          <Card data={data} />
        </FocusContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const opener = screen.getByRole("button", { name: "Open details" });
  await userEvent.click(opener);
  return { opener, dialog: screen.getByRole("dialog", { name: "Details: Hall" }) };
}
const perAsset = (dialog: HTMLElement) => within(within(dialog).getByRole("table")).getAllByRole("row");
const cellsOf = (row: HTMLElement) => within(row).getAllByRole("cell").map((cell) => cell.textContent);

beforeEach(() => setFocus.mockReset());

describe("the Details panel of a breakdown: Narrow to", () => {
  it("offers a button to each bar whose asset has children, in a cell of its own, and none to a leaf", async () => {
    const { dialog } = await openDetails(BARS);
    const buttons = within(dialog).getAllByRole("button", { name: /^Narrow to / });
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["Narrow to Rack 05"]);
    expect(buttons[0]).toHaveAttribute("type", "button");
    expect(buttons[0]).not.toHaveAttribute("disabled");
    const [head, ...rows] = perAsset(dialog);
    expect(within(head).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Asset", "Value (kWh)", "Actions"]);
    expect(cellsOf(rows[0])).toEqual(["Rack 05", "100.00", "Narrow"]);
    expect(cellsOf(rows[1]), "a leaf has an empty cell").toEqual(["Rack 06", "90.00", ""]);
  });

  it("keeps a leaf's name link to its page, as the Assets list had it", async () => {
    const { dialog } = await openDetails(BARS);
    expect(within(dialog).getByRole("link", { name: "Rack 06" })).toHaveAttribute("href", "/assets/11");
  });

  it("narrows the dashboard, closes the drawer and gives focus back to the card's Details button, by keyboard", async () => {
    const { dialog, opener } = await openDetails(BARS);
    const narrow = within(dialog).getByRole("button", { name: "Narrow to Rack 05" });
    narrow.focus();
    await userEvent.keyboard("{Enter}");
    expect(setFocus).toHaveBeenCalledTimes(1);
    expect(setFocus).toHaveBeenCalledWith(10);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("does the same on a click", async () => {
    const { dialog, opener } = await openDetails(BARS);
    await userEvent.click(within(dialog).getByRole("button", { name: "Narrow to Rack 05" }));
    expect(setFocus).toHaveBeenCalledWith(10);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("sits in the Tab order after the panel's close button and the links before the table", async () => {
    const { dialog } = await openDetails(BARS);
    const stops = Array.from(dialog.querySelectorAll<HTMLElement>("a[href], button")).map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(stops).toEqual(["Close", "Rack 05", "Rack 06", "Narrow to Rack 05"]);
  });
});

describe("the Details panel of a breakdown where there is no drill-through", () => {
  /** Exactly what the panel had before w25: no extra column, no button, the same stops. */
  const expectUnchanged = (dialog: HTMLElement) => {
    expect(within(dialog).queryByRole("button", { name: /Narrow/ })).not.toBeInTheDocument();
    const [head, ...rows] = perAsset(dialog);
    expect(within(head).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Asset", "Value (kWh)"]);
    expect(cellsOf(rows[0])).toEqual(["Rack 05", "100.00"]);
    expect(Array.from(dialog.querySelectorAll("button")).map((button) => button.getAttribute("aria-label"))).toEqual(["Close"]);
  };

  it("has none in the default context (a lone panel is allowed nothing)", async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter><Card data={BARS} /></MemoryRouter>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open details" }));
    expectUnchanged(screen.getByRole("dialog", { name: "Details: Hall" }));
  });

  it("has none for a role that cannot open assets", async () => {
    const { dialog } = await openDetails(BARS, { focus: state({ allowed: false, assets: undefined }) });
    expectUnchanged(dialog);
  });

  it("has none on a dashboard where no card follows the focus (W2), and then does not ask for the asset list", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}));
    const { dialog } = await openDetails(BARS, { focus: state({ anyFollowing: false }), cached: null });
    expectUnchanged(dialog);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("has none until the asset list is loaded", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {})); // the list is asked for and never answers
    const { dialog } = await openDetails(BARS, { cached: null });
    expectUnchanged(dialog);
  });

  it("has none for a bar chart that is not a breakdown", async () => {
    const plain = valuesData({ type: "bar", unit: "kWh", breakdown: null, values: [valueRow({ asset_id: 10, name: "Rack 05", value: 100, point_id: null })] });
    const { dialog } = await openDetails(plain);
    expectUnchanged(dialog);
  });
});
