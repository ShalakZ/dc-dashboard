import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import ReactGridLayout, { useContainerWidth } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

// jsdom has no layout: the real hook would measure 0 and the ResizeObserver stub in setup.ts never fires.
// Pin the measured width instead.
vi.mock("react-grid-layout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-grid-layout")>()),
  useContainerWidth: () => ({ width: 1200, mounted: true, containerRef: { current: null }, measureWidth: () => undefined }),
}));

type Item = { i: string; x: number; y: number; w: number; h: number };
const layout: Item[] = [{ i: "a", x: 0, y: 0, w: 6, h: 2 }, { i: "b", x: 6, y: 0, w: 6, h: 2 }];

function Grid({ items, onLayoutChange }: { items: Item[]; onLayoutChange?: (l: readonly Item[]) => void }) {
  const { width, containerRef, mounted } = useContainerWidth();
  return (
    <div ref={containerRef}>
      {mounted && (
        <ReactGridLayout
          width={width}
          layout={items}
          gridConfig={{ cols: 12, rowHeight: 30, margin: [10, 10], containerPadding: [10, 10] }}
          onLayoutChange={onLayoutChange}
        >
          <div key="a" data-testid="item-a">A</div>
          <div key="b" data-testid="item-b">B</div>
        </ReactGridLayout>
      )}
    </div>
  );
}

describe("react-grid-layout 2 under React 19 in jsdom", () => {
  it("renders two items at the pixel positions of a 12-column, 1200px grid, with resize handles", () => {
    render(<StrictMode><Grid items={layout} /></StrictMode>);
    const a = screen.getByTestId("item-a");
    const b = screen.getByTestId("item-b");
    expect(a).toHaveClass("react-grid-item");
    // column width = (1200 - 10 * 11 - 2 * 10) / 12 = 89.17px; w = 6 spans 6 * 89.17 + 5 * 10 = 585px;
    // x = 6 starts at 6 * (89.17 + 10) + 10 = 605px; h = 2 spans 2 * 30 + 10 = 70px.
    expect(a.style.width).toBe("585px");
    expect(a.style.height).toBe("70px");
    expect(a.style.transform).toBe("translate(10px,10px)");
    expect(b.style.transform).toBe("translate(605px,10px)");
    expect(document.querySelectorAll(".react-resizable-handle")).toHaveLength(2); // resizing is on by default
  });

  it("only ever reports the layout it was given, so mounting cannot look like an edit", () => {
    const seen: Item[][] = [];
    render(<StrictMode><Grid items={layout} onLayoutChange={(l) => seen.push(l.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })))} /></StrictMode>);
    for (const reported of seen) expect(reported).toEqual(layout);
  });

  it("moves an item when the layout prop changes", async () => {
    const { rerender } = render(<StrictMode><Grid items={layout} /></StrictMode>);
    rerender(<StrictMode><Grid items={[layout[0], { i: "b", x: 0, y: 2, w: 6, h: 2 }]} /></StrictMode>);
    // y = 2 starts at (30 + 10) * 2 + 10 = 90px
    await waitFor(() => expect(screen.getByTestId("item-b").style.transform).toBe("translate(10px,90px)"));
  });
});
