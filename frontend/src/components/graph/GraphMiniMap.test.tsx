import { render, screen } from "@testing-library/react";
import { GraphMiniMap, MINIMAP_MIN_WIDTH, miniMapColor } from "./GraphMiniMap";

const flow = vi.hoisted(() => ({ width: 1200 }));

// A MiniMap needs a mounted React Flow store: here it is a stub that shows the props it was given.
vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  useStore: (selector: (state: { width: number }) => unknown) => selector({ width: flow.width }),
  MiniMap: (props: { ariaLabel?: string; pannable?: boolean; zoomable?: boolean; className?: string; nodeColor?: unknown }) => (
    <div data-testid="minimap" role="img" aria-label={props.ariaLabel} data-pannable={String(props.pannable)} data-zoomable={String(props.zoomable)} className={props.className} data-has-colour={String(typeof props.nodeColor === "function")} />
  ),
}));

describe("GraphMiniMap", () => {
  it("is the overview of the whole graph: pannable, zoomable and named", () => {
    flow.width = 1200;
    render(<GraphMiniMap />);
    const map = screen.getByRole("img", { name: "Overview of the whole graph" });
    expect(map).toHaveAttribute("data-pannable", "true");
    expect(map).toHaveAttribute("data-zoomable", "true");
    expect(map).toHaveClass("graph-minimap");
    expect(map).toHaveAttribute("data-has-colour", "true");
  });

  it.each([
    [MINIMAP_MIN_WIDTH - 1, false],
    [MINIMAP_MIN_WIDTH, true],
    [1440, true],
    [0, false], // a canvas that has not been measured yet
    [320, false],
  ])("a canvas %ipx wide: minimap shown = %s", (width, shown) => {
    flow.width = width;
    render(<GraphMiniMap />);
    expect(screen.queryByTestId("minimap") !== null).toBe(shown);
  });

  it("the threshold is 700", () => expect(MINIMAP_MIN_WIDTH).toBe(700));

  it.each([
    ["source", "var(--accent)"],
    ["cluster", "var(--text-2)"],
    ["point", "var(--border-strong)"],
    ["asset", "var(--text)"],
    ["moreAssets", "var(--text)"], // (w37) the summary of a parent with many sub-assets stands in the assets column in the asset's colour
    ["unidentified", "var(--field-border)"],
    ["something-new", "var(--border-strong)"],
    [undefined, "var(--border-strong)"],
  ])("a %s node is drawn in %s (tokens, so every theme follows)", (type, colour) => {
    expect(miniMapColor({ type })).toBe(colour);
  });
});
