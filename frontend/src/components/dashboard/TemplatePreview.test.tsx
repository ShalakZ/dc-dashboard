import { render } from "@testing-library/react";
import { templateCards } from "../../test/dashboardFixtures";
import { TemplatePreview } from "./TemplatePreview";

const power = () => templateCards().find((t) => t.id === "power")!;

function draw(widgets: Parameters<typeof TemplatePreview>[0]["widgets"]) {
  const { container } = render(<TemplatePreview widgets={widgets} />);
  const svg = container.querySelector("svg")!;
  return { svg, rects: Array.from(svg.querySelectorAll("rect")) };
}
const num = (element: Element, name: string) => Number(element.getAttribute(name));

describe("TemplatePreview", () => {
  it("is decorative: hidden from screen readers, not focusable, no text and no raster", () => {
    const { svg } = draw(power().widgets);
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg.textContent).toBe("");
    expect(svg.querySelector("image, foreignObject")).toBeNull();
    expect(svg.getAttribute("viewBox")).toBe("0 0 120 60"); // a small fixed box: 12 columns of 10
  });

  it("draws one rectangle for each widget, in order, at its place on the 12-column grid", () => {
    const widgets = power().widgets;
    const { rects } = draw(widgets);
    expect(rects).toHaveLength(widgets.length);
    expect(rects.map((r) => r.getAttribute("data-type"))).toEqual(widgets.map((w) => w.type));
    widgets.forEach((widget, i) => {
      const r = rects[i];
      expect([r.getAttribute("data-x"), r.getAttribute("data-y"), r.getAttribute("data-w"), r.getAttribute("data-h")]).toEqual([widget.x, widget.y, widget.w, widget.h].map(String));
      // a column is 10 units wide and a row 5 (60 units for the 12 rows a template may use), each glyph shrunk by a 2-unit gap
      expect(num(r, "x")).toBe(widget.x * 10 + 1);
      expect(num(r, "width")).toBe(widget.w * 10 - 2);
      expect(num(r, "y")).toBe(widget.y * 5 + 1);
      if (widget.type !== "text") expect(num(r, "height")).toBe(widget.h * 5 - 2);
    });
  });

  it("draws the Power template's cards at the places the server gives them", () => {
    const { rects } = draw(power().widgets);
    expect(rects.map((r) => [num(r, "x"), num(r, "y"), num(r, "width")])).toEqual([[1, 1, 118], [1, 6, 28], [31, 6, 28], [61, 6, 58], [1, 21, 118]]);
  });

  it("draws a text widget as a thin bar, never as tall as its cell", () => {
    const { rects } = draw([{ type: "text", x: 0, y: 0, w: 12, h: 3, source: null, compare: "none", bars: "asset", scope: "fixed" }]);
    expect(rects[0]).toHaveClass("tpl-glyph-text");
    expect(num(rects[0], "height")).toBeLessThanOrEqual(3);
  });

  it("stays inside the box when a template is taller than twelve rows, and keeps every glyph", () => {
    const tall = Array.from({ length: 6 }, (_, i) => ({ type: "table" as const, x: 0, y: i * 4, w: 12, h: 4, source: "energy" as const, compare: "none" as const, bars: "asset" as const, scope: "focus" as const }));
    const { rects } = draw(tall);
    expect(rects).toHaveLength(6);
    for (const r of rects) expect(num(r, "y") + num(r, "height")).toBeLessThanOrEqual(60);
  });

  it("draws Blank (no widgets) as a dashed frame with a plus and no widget rectangle", () => {
    const { svg, rects } = draw([]);
    expect(rects).toHaveLength(0);
    expect(svg.querySelector(".tpl-blank")).not.toBeNull();
    expect(svg.querySelector(".tpl-mark")).not.toBeNull();
  });

  it("draws a mark for every data widget and none for a text widget", () => {
    const { svg } = draw(templateCards().find((t) => t.id === "cost")!.widgets); // heading, stat, bar, timeseries, table
    expect(svg.querySelectorAll("g")).toHaveLength(5);
    expect(svg.querySelectorAll(".tpl-mark")).toHaveLength(4);
  });

  it("uses no inline colour (the colours are tokens in styles/templates.css)", () => {
    const { svg } = draw(power().widgets);
    expect(svg.outerHTML).not.toMatch(/fill="|stroke="|style="|#[0-9a-fA-F]{3,8}\b|rgb/);
  });
});
