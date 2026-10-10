import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { verticalCompactor } from "react-grid-layout";
import { GRID_GAP, ROW_HEIGHT } from "../../lib/gridMetrics";
import { GRID_COLS, toDrafts } from "../../lib/layout";
import { widget } from "../../test/dashboardFixtures";
import { DashboardGrid } from "./DashboardGrid";

// jsdom cannot measure or drag. The grid is replaced by a plain box that exposes the props the component wires up,
// and `move-{key}` / `resize-{key}` play a finished drag or resize of that widget.
const grid = vi.hoisted(() => ({ props: null as Record<string, any> | null }));
vi.mock("react-grid-layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-grid-layout")>();
  return {
    ...actual,
    default: (props: Record<string, any>) => {
      grid.props = props;
      return (
        <div data-testid="rgl">
          {props.children}
          {props.layout.map((item: { i: string }) => (
            <span key={item.i}>
              <button data-testid={`move-${item.i}`} onClick={() => props.onDragStop(props.layout.map((l: any) => (l.i === item.i ? { ...l, x: 4, y: 7 } : l)))} />
              <button data-testid={`resize-${item.i}`} onClick={() => props.onResizeStop(props.layout.map((l: any) => (l.i === item.i ? { ...l, w: 9, h: 5 } : l)))} />
            </span>
          ))}
        </div>
      );
    },
    useContainerWidth: () => ({ width: 1000, mounted: true, containerRef: { current: null }, measureWidth: () => {} }),
  };
});

const drafts = () => toDrafts([
  widget(1, "stat", { title: "Now", x: 0, y: 0, w: 3, h: 2 }),
  widget(2, "table", { title: "All", x: 3, y: 0, w: 6, h: 3 }),
]);
const show = (onChange = vi.fn()) => {
  const d = drafts();
  render(<DashboardGrid drafts={d} onChange={onChange} renderWidget={(w) => <p>{w.title}</p>} />);
  return { d, onChange };
};

describe("DashboardGrid", () => {
  it("lays the drafts out on the shared 12-column grid, with the vertical compactor and drag and resize handles", () => {
    const { d } = show();
    expect(screen.getByText("Now")).toBeInTheDocument();
    expect(screen.getByText("All")).toBeInTheDocument();
    const props = grid.props!;
    expect(props.width).toBe(1000);
    expect(props.gridConfig).toMatchObject({ cols: GRID_COLS, rowHeight: ROW_HEIGHT, margin: [GRID_GAP, GRID_GAP], containerPadding: [0, 0] });
    expect(props.dragConfig).toMatchObject({ enabled: true, handle: ".widget-drag-handle", cancel: ".widget-actions" });
    expect(props.resizeConfig).toMatchObject({ enabled: true, handles: ["se", "e", "s"] });
    expect(props.compactor).toBe(verticalCompactor);
    expect(props.layout.map(({ i, x, y, w, h }: Record<string, unknown>) => ({ i, x, y, w, h }))).toEqual(d.map(({ key, x, y, w, h }) => ({ i: key, x, y, w, h })));
  });

  it("changes nothing on its own", () => {
    const { onChange } = show();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports a finished drag as the drafts with the new position closed up under what is above it, everything else untouched", async () => {
    const { d, onChange } = show();
    await userEvent.click(screen.getByTestId(`move-${d[0].key}`)); // dropped at (4, 7): over `All` (x 3-9, y 0-3), so it lands directly below it
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual([{ ...d[0], x: 4, y: 3 }, d[1]]);
    expect(onChange.mock.calls[0][0][1]).toBe(d[1]);
  });

  it("moves a widget that was dropped on an occupied place only as far down as needed", () => {
    const { d, onChange } = show();
    // `Now` is dropped onto `All`'s place: the library reports both at (3, 0).
    grid.props!.onDragStop(grid.props!.layout.map((l: any) => (l.i === d[0].key ? { ...l, x: 3, y: 0 } : l)));
    expect(onChange.mock.calls[0][0].map(({ key, x, y }: { key: string; x: number; y: number }) => ({ key, x, y }))).toEqual([
      { key: d[0].key, x: 3, y: 0 }, { key: d[1].key, x: 3, y: 2 },
    ]);
  });

  it("hands back the very same drafts when a drag ends where it started, so it is not an edit", () => {
    const { d, onChange } = show();
    grid.props!.onDragStop(grid.props!.layout);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toBe(d);
  });

  it("reports a finished resize the same way", async () => {
    const { d, onChange } = show();
    await userEvent.click(screen.getByTestId(`resize-${d[1].key}`));
    expect(onChange.mock.calls[0][0]).toEqual([d[0], { ...d[1], w: 9, h: 5 }]);
  });
});
