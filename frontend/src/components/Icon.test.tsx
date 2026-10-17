import { render } from "@testing-library/react";
import { Icon, ICONS, type IconName } from "./Icon";

// The interface icons W7j adds: the Audit toolbar and rows, the Storage tiles and cards. None starts with "kind" (assetIcons.test.ts compares every kind* key with the catalogue).
const INTERFACE: IconName[] = [
  "download", "calendar", "clock", "filter", "layers", "trend", "hourglass", "readings", "database", "chevron",
  "evSignIn", "evProblem", "evCreate", "evChange", "evDelete", "evSettings", "evOther",
];

describe("the interface icons (W7j)", () => {
  it("are all there, 17 of them, and none is named like an asset kind", () => {
    expect(INTERFACE).toHaveLength(17);
    expect(new Set(INTERFACE).size).toBe(17);
    for (const name of INTERFACE) {
      expect(Object.keys(ICONS), name).toContain(name);
      expect(name.startsWith("kind"), name).toBe(false);
    }
  });

  it.each(INTERFACE)("%s is one decorative svg of the 24-unit box with at least one shape", (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.firstElementChild!;
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg).toHaveClass("i");
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg.querySelectorAll("path, circle, rect, ellipse").length).toBeGreaterThan(0);
  });

  it("are drawn differently from each other and from the icons they sit next to", () => {
    const drawn = (name: IconName) => {
      const { container, unmount } = render(<Icon name={name} />);
      const html = container.querySelector("svg")!.innerHTML;
      unmount();
      return html;
    };
    const all = INTERFACE.map(drawn);
    expect(new Set(all).size).toBe(INTERFACE.length);
    for (const other of ["diagnostics", "storage", "assets", "settings", "signOut", "trash", "caret"] as const) {
      expect(all, `not the same as ${other}`).not.toContain(drawn(other));
    }
  });

  it("draws the chevron pointing right (CSS turns it when a row opens)", () => {
    const { container } = render(<Icon name="chevron" />);
    expect(container.querySelector("path")!.getAttribute("d")).toBe("m9 6 6 6-6 6");
  });
});

// The twelve icons of the Discovery polish (w12c): the toolbar's, the protocols' and the metrics'. None starts with "kind".
const DISCOVERY: IconName[] = [
  "keyboard", "refresh", "expandAll", "tidy", "grid", "link",
  "protoOpcua", "protoModbus", "protoSimulator",
  "metricVoltage", "metricCurrent", "metricOther",
];

describe("the Discovery icons (w12c)", () => {
  it("are all there, 12 of them, and none is named like an asset kind", () => {
    expect(DISCOVERY).toHaveLength(12);
    expect(new Set(DISCOVERY).size).toBe(12);
    for (const name of DISCOVERY) {
      expect(Object.keys(ICONS), name).toContain(name);
      expect(name.startsWith("kind"), name).toBe(false);
    }
  });

  it.each(DISCOVERY)("%s is one decorative svg of the 24-unit box with at least one shape and no colour of its own", (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.firstElementChild!;
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg).toHaveClass("i");
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg.querySelectorAll("path, circle, rect, ellipse").length).toBeGreaterThan(0);
    // The stroke, the fill and the colour come from `svg.i`; a shape that sets its own would not follow the theme.
    for (const attr of ["fill", "stroke", "stroke-width", "style", "color"]) expect(svg.querySelector(`[${attr}]`), attr).toBeNull();
  });

  it("are drawn differently from each other and from the icons they sit next to", () => {
    const drawn = (name: IconName) => {
      const { container, unmount } = render(<Icon name={name} />);
      const html = container.querySelector("svg")!.innerHTML;
      unmount();
      return html;
    };
    const all = DISCOVERY.map(drawn);
    expect(new Set(all).size).toBe(DISCOVERY.length);
    // Find, the Details button, the overflow, the sources icon and the metrics' neighbours in the Find list.
    for (const other of ["search", "more", "sources", "discovery", "layers", "rate", "energy", "readings", "settings", "trend", "filter", "collapse", "caret", "chevron", "kindServer"] as const) {
      expect(all, `not the same as ${other}`).not.toContain(drawn(other));
    }
  });
});

// The two icons of the widget overhaul (w13): the Edit button of a card in the dashboard editor and the grip that marks its header as the grab area.
// M9 of the plan review: the audit's "change" icon (evChange) is already a pencil; this one is drawn on its own, so the pair never looks like one drawing twice.
const WIDGET: IconName[] = ["pencil", "grip"];

describe("the widget icons (w13)", () => {
  it("are both there and none is named like an asset kind", () => {
    expect(WIDGET).toHaveLength(2);
    for (const name of WIDGET) {
      expect(Object.keys(ICONS), name).toContain(name);
      expect(name.startsWith("kind"), name).toBe(false);
    }
  });

  it.each(WIDGET)("%s is one decorative svg of the 24-unit box with at least one shape and no colour of its own", (name) => {
    const { container } = render(<Icon name={name} />);
    const svg = container.firstElementChild!;
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg).toHaveClass("i");
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg.querySelectorAll("path, circle, rect, ellipse").length).toBeGreaterThan(0);
    for (const attr of ["fill", "stroke", "stroke-width", "style", "color"]) expect(svg.querySelector(`[${attr}]`), attr).toBeNull();
  });

  it("are drawn differently from each other and from the icons they sit next to (the audit pencil, the dots of a row menu, the list and grid icons)", () => {
    const drawn = (name: IconName) => {
      const { container, unmount } = render(<Icon name={name} />);
      const html = container.querySelector("svg")!.innerHTML;
      unmount();
      return html;
    };
    const all = WIDGET.map(drawn);
    expect(new Set(all).size).toBe(WIDGET.length);
    for (const other of ["evChange", "more", "readings", "grid", "info", "download", "close", "trash", "settings", "collapse"] as const) {
      expect(all, `not the same as ${other}`).not.toContain(drawn(other));
    }
  });

  it("the grip is six dots (two columns of three), the pencil a body and a tip", () => {
    const { container } = render(<Icon name="grip" />);
    expect(container.querySelectorAll("circle")).toHaveLength(6);
    const pencil = render(<Icon name="pencil" />);
    expect(pencil.container.querySelectorAll("path").length).toBeGreaterThanOrEqual(2);
  });
});
