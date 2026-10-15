import { act, render } from "@testing-library/react";
import type { Guides } from "../../lib/graphGuides";
import { AlignGuides } from "./AlignGuides";

// The viewport portal needs a mounted React Flow to find its container: here it just draws its children in place.
vi.mock("@xyflow/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@xyflow/react")>()),
  ViewportPortal: ({ children }: { children: React.ReactNode }) => <div data-testid="portal">{children}</div>,
}));

type Handle = { set(guides: Guides | null): void };
const mount = () => {
  const handleRef: { current: Handle | null } = { current: null };
  const view = render(<AlignGuides handleRef={handleRef} />);
  return { handleRef, ...view };
};
const GUIDES: Guides = { vertical: [{ at: 120, from: 10, to: 200 }], horizontal: [{ at: 64, from: -24, to: 300 }, { at: 80, from: 0, to: 50 }] };

describe("AlignGuides", () => {
  it("draws nothing until it is given guides, and hands the page a handle", () => {
    const { handleRef, container } = mount();
    expect(handleRef.current).not.toBeNull();
    expect(container.querySelector("svg")).toBeNull();
  });

  it("draws ONE svg with a line per guide: vertical at x, horizontal at y, spanning from to to", () => {
    const { handleRef, container } = mount();
    act(() => handleRef.current!.set(GUIDES));
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    const lines = [...container.querySelectorAll("line")];
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => [l.getAttribute("x1"), l.getAttribute("y1"), l.getAttribute("x2"), l.getAttribute("y2")])).toEqual([
      ["120", "10", "120", "200"],
      ["-24", "64", "300", "64"],
      ["0", "80", "50", "80"],
    ]);
  });

  it("the svg is decoration: aria-hidden, no pointer events, overflow visible from a 1x1 box at the origin, and every line keeps its width at any zoom", () => {
    const { handleRef, container } = mount();
    act(() => handleRef.current!.set(GUIDES));
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveClass("graph-guides");
    expect(svg.style.overflow).toBe("visible");
    // At the origin of the portal, not on a text baseline (an inline svg sits a line-height too low, and the error grows with the zoom).
    expect([svg.style.position, svg.style.left, svg.style.top]).toEqual(["absolute", "0px", "0px"]);
    expect(svg.style.pointerEvents).toBe("none");
    expect(svg).toHaveAttribute("width", "1"); // not 0: Chromium draws nothing at all inside an svg of zero width or height, whatever its overflow says (static look, whole-wave fix 2)
    expect(svg).toHaveAttribute("height", "1");
    for (const line of container.querySelectorAll("line")) expect(line).toHaveAttribute("vector-effect", "non-scaling-stroke");
  });

  it("set(null) and a pair of empty lists both take the guides away", () => {
    const { handleRef, container } = mount();
    act(() => handleRef.current!.set(GUIDES));
    act(() => handleRef.current!.set(null));
    expect(container.querySelector("svg")).toBeNull();
    act(() => handleRef.current!.set(GUIDES));
    act(() => handleRef.current!.set({ vertical: [], horizontal: [] }));
    expect(container.querySelector("svg")).toBeNull();
  });

  it("the handle is cleared when it unmounts (the page must not call a dead setter)", () => {
    const { handleRef, unmount } = mount();
    unmount();
    expect(handleRef.current).toBeNull();
  });
});
