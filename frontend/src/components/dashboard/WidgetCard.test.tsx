import { screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { authed, config, widgetDataRoute } from "../../test/dashboardFixtures";
import { mockFetch } from "../../test/fetchMock";
import { renderWithProviders } from "../../test/render";
import { LiveValuesContext } from "./LiveValuesContext";
import { WidgetCard, type WidgetCardProps } from "./WidgetCard";

vi.mock("echarts-for-react", () => ({ default: (props: { option: unknown }) => <pre data-testid="chart">{JSON.stringify(props.option)}</pre> }));

const text = (style: "heading" | "paragraph" | "divider", words: string): WidgetCardProps["widget"] => ({ type: "text", title: "Notes", config: { style, text: words } });
const stat: WidgetCardProps["widget"] = { type: "stat", title: "Now", config: config({ aggregation: "last" }) };
const base = { widgetKey: "w1", dashboardRange: "24h", timezone: "Asia/Qatar" } as const;
const widgetData = (calls: { method: string; path: string }[]) => calls.filter((c) => c.path === "/api/widget-data" || c.path === "/api/widget-data/csv");

/** The live registry as a spy: every register(owner, ids) call lands in `register`. */
function inRegistry(register: ReturnType<typeof vi.fn>, card: ReactElement) {
  return renderWithProviders(<LiveValuesContext.Provider value={{ values: new Map(), connected: false, register }}>{card}</LiveValuesContext.Provider>);
}

describe("WidgetCard", () => {
  it("draws a text widget without a request and without registering for live values", async () => {
    const calls = mockFetch({ ...authed("viewer"), "POST /api/widget-data": widgetDataRoute });
    const register = vi.fn();
    for (const style of ["heading", "paragraph", "divider"] as const) {
      const { unmount } = inRegistry(register, <WidgetCard widget={text(style, style === "divider" ? "" : "Words")} {...base} />);
      unmount();
    }
    await new Promise((resolve) => setTimeout(resolve, 80)); // longer than anything the data path would take to start
    expect(widgetData(calls)).toEqual([]);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]); // the providers ask who is signed in; a widget would POST
    expect(register).not.toHaveBeenCalled();
  });

  it("gives a text widget its own views: an h2, a named region and a separator", () => {
    mockFetch({ ...authed("viewer") });
    const { unmount } = renderWithProviders(<WidgetCard widget={text("heading", "Plant")} {...base} />);
    expect(screen.getByRole("heading", { level: 2, name: "Plant" })).toBeInTheDocument();
    unmount();
    const paragraph = renderWithProviders(<WidgetCard widget={text("paragraph", "Words")} {...base} />);
    expect(screen.getByRole("region", { name: "Notes" })).toHaveTextContent("Words");
    paragraph.unmount();
    renderWithProviders(<WidgetCard widget={text("divider", "")} {...base} />);
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("ignores csv, live and details for a text widget: no button, no stream", () => {
    mockFetch({ ...authed("viewer") });
    const register = vi.fn();
    inRegistry(register, <WidgetCard widget={text("paragraph", "Words")} {...base} csv live details />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(register).not.toHaveBeenCalled();
  });

  it("passes the edit-mode header through to a text widget", () => {
    mockFetch({ ...authed("viewer") });
    renderWithProviders(
      <WidgetCard widget={text("heading", "Plant")} {...base} dragHandle actions={<span className="widget-actions"><button type="button">Edit Notes</button></span>} />,
    );
    const card = screen.getByRole("region", { name: "Notes" });
    expect(card.querySelector("header")).toHaveClass("widget-drag-handle");
    expect(within(card).getByRole("button", { name: "Edit Notes" })).toBeInTheDocument();
  });

  it("draws a data widget as before: the request, the figure, the Details and CSV buttons", async () => {
    const calls = mockFetch({ ...authed("viewer"), "POST /api/widget-data": widgetDataRoute });
    const register = vi.fn();
    inRegistry(register, <WidgetCard widget={stat} {...base} />);
    const card = await screen.findByRole("region", { name: "Now" });
    await within(card).findByText("10.50");
    await waitFor(() => expect(register).toHaveBeenCalledWith("w1", [7])); // the control for the text case above: a live data widget does register
    expect(widgetData(calls)).toHaveLength(1);
    expect(calls.find((c) => c.path === "/api/widget-data")?.body).toEqual({ type: "stat", range: "24h", config: stat.config });
    await waitFor(() => expect(within(card).getByRole("button", { name: "Details for Now" })).toBeInTheDocument());
    expect(within(card).getByRole("button", { name: "Download CSV for Now" })).toBeInTheDocument();
  });

  it("honours csv, live and details for a data widget", async () => {
    mockFetch({ ...authed("viewer"), "POST /api/widget-data": widgetDataRoute });
    const register = vi.fn();
    inRegistry(register, <WidgetCard widget={stat} {...base} csv={false} details={false} live={false} />);
    const card = await screen.findByRole("region", { name: "Now" });
    await within(card).findByText("10.50");
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
    expect(register).not.toHaveBeenCalledWith("w1", expect.arrayContaining([expect.any(Number)]));
  });
});
