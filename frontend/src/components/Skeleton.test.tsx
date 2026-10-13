import { render, screen } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { CHART_HEIGHT } from "../lib/chartBox";
import {
  ActionsSpace, AssetSkeleton, CanvasSkeleton, ChartBlock, DashboardSkeleton, FleetSkeleton, FormSkeleton, PageCardSkeleton, PageHeaderSkeleton, PageSkeleton,
  resetSkeletonClock, Skeleton, SkeletonRegion, TableSkeleton, TilesSkeleton, TreeSkeleton, TrendSkeleton,
} from "./Skeleton";

const FOCUSABLE = "button, a, input, select, textarea, [tabindex]";

// Every shape, as a body (no label) and with a label (wrapped in one region).
const shapes: Array<[string, (label?: string) => ReactElement]> = [
  ["TilesSkeleton", (label) => <TilesSkeleton count={3} label={label} />],
  ["TilesSkeleton (fleet, notes)", (label) => <TilesSkeleton count={4} fleet notes={[1]} label={label} />],
  ["TableSkeleton", (label) => <TableSkeleton columns={4} rows={3} label={label} />],
  ["FormSkeleton", (label) => <FormSkeleton rows={2} label={label} />],
  ["ChartBlock", (label) => <ChartBlock label={label} />],
  ["TrendSkeleton", (label) => <TrendSkeleton label={label} />],
  ["TreeSkeleton", (label) => <TreeSkeleton label={label} />],
  ["PageHeaderSkeleton", (label) => <PageHeaderSkeleton label={label} />],
  ["PageHeaderSkeleton (all parts)", (label) => <PageHeaderSkeleton crumbs icon sub actions label={label} />],
  ["PageCardSkeleton", (label) => <PageCardSkeleton purpose label={label}><FormSkeleton rows={2} bare /></PageCardSkeleton>],
];

describe("Skeleton", () => {
  it("a block is one aria-hidden span with the variant class and an inline size (numbers are px, strings pass through)", () => {
    const { container } = render(<Skeleton variant="block" width={200} height="2.5rem" />);
    const el = container.firstElementChild as HTMLElement;
    expect(container.children).toHaveLength(1);
    expect(el.tagName).toBe("SPAN");
    expect(el).toHaveClass("sk", "sk-block");
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el.style.width).toBe("200px");
    expect(el.style.height).toBe("2.5rem");
  });

  it("a circle is one aria-hidden span; with one size given it is as high as it is wide", () => {
    const { container } = render(<Skeleton variant="circle" width={16} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveClass("sk", "sk-circle");
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el.style.width).toBe("16px");
    expect(el.style.height).toBe("16px");
  });

  it("a line is the default variant: an inline-block span inside a plain aria-hidden span (a bare inline-block in a flex or grid parent would lose the text's line height)", () => {
    const { container } = render(<Skeleton width="12ch" />);
    const wrap = container.firstElementChild as HTMLElement;
    expect(container.children).toHaveLength(1);
    expect(wrap.tagName).toBe("SPAN");
    expect(wrap).not.toHaveAttribute("class");
    expect(wrap).toHaveAttribute("aria-hidden", "true");
    const line = wrap.firstElementChild as HTMLElement;
    expect(line).toHaveClass("sk", "sk-line");
    expect(line.style.width).toBe("12ch");
    expect(wrap.children).toHaveLength(1);
  });

  it("carries no text and is not focusable", () => {
    const { container } = render(<><Skeleton /><Skeleton variant="block" /><Skeleton variant="circle" /></>);
    expect(container.textContent).toBe("");
    expect(container.querySelector(FOCUSABLE)).toBeNull();
  });
});

describe("SkeletonRegion", () => {
  beforeEach(resetSkeletonClock); // setup.ts's cleanup unmounts the last test's regions, which stamps the clock

  it("is the one status: busy, with the label as its only text, visually hidden", () => {
    render(<SkeletonRegion label="Loading users"><Skeleton variant="block" /></SkeletonRegion>);
    const region = screen.getByRole("status");
    expect(region).toHaveAttribute("aria-busy", "true");
    expect(region).toHaveClass("sk-region");
    expect(region.textContent).toBe("Loading users");
    const hidden = region.querySelectorAll(".sr-only");
    expect(hidden).toHaveLength(1);
    expect(hidden[0]).toHaveTextContent("Loading users");
    expect(screen.getByText("Loading users")).toBe(hidden[0]);
  });

  it("takes a className, so it can be the real wrapper", () => {
    render(<SkeletonRegion label="Loading the asset" className="asset-page">x</SkeletonRegion>);
    expect(screen.getByRole("status")).toHaveClass("sk-region", "asset-page");
  });

  it("holds nothing focusable of its own", () => {
    const { container } = render(<SkeletonRegion label="Loading"><Skeleton /></SkeletonRegion>);
    expect(container.querySelector(FOCUSABLE)).toBeNull();
  });
});

describe.each(shapes)("%s", (_name, make) => {
  beforeEach(resetSkeletonClock);

  it("renders one aria-hidden body, no status of its own, nothing focusable and no text", () => {
    const { container } = render(make());
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector(FOCUSABLE)).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("given a label, wraps itself in exactly one region whose only text is the label", () => {
    const { container } = render(make("Loading things"));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild).toBe(screen.getByRole("status"));
    expect(container.textContent).toBe("Loading things");
    expect(container.querySelectorAll(".sr-only")).toHaveLength(1);
    expect(container.querySelector(FOCUSABLE)).toBeNull();
    // the body inside the region is the aria-hidden one
    const body = container.querySelector(".sr-only")!.nextElementSibling!;
    expect(body).toHaveAttribute("aria-hidden", "true");
  });

  it("wraps every line placeholder in a plain aria-hidden span, and is the same markup every time", () => {
    const first = render(make());
    for (const line of first.container.querySelectorAll(".sk-line")) {
      const wrap = line.parentElement!;
      expect(wrap.tagName).toBe("SPAN");
      expect(wrap).not.toHaveAttribute("class");
      expect(wrap).toHaveAttribute("aria-hidden", "true");
    }
    const html = first.container.innerHTML;
    first.unmount();
    expect(render(make()).container.innerHTML).toBe(html);
  });
});

describe("TilesSkeleton", () => {
  it("is a .tiles grid of .tile: a muted label row first (a circle and a line), then the figure line", () => {
    const { container } = render(<TilesSkeleton count={3} />);
    const grid = container.firstElementChild!;
    expect(grid).toHaveClass("tiles");
    expect(grid).not.toHaveClass("fleet-tiles");
    const tiles = grid.querySelectorAll(":scope > .tile");
    expect(tiles).toHaveLength(3);
    for (const tile of tiles) {
      const label = tile.firstElementChild!;
      expect(label).toHaveClass("muted", "tile-label"); // .tile > .muted:first-child is what sets the 13px size
      expect(label.querySelector(".sk-circle")).not.toBeNull();
      expect(label.querySelector(".sk-line")).not.toBeNull();
      const big = tile.querySelector(":scope > .big")!;
      expect(big).not.toHaveClass("none");
      expect(big.querySelector(".sk-line")).not.toBeNull();
      expect(tile.querySelector(":scope > small")).toBeNull();
    }
  });

  it("with fleet keeps .fleet-tiles (the 22px figure)", () => {
    const { container } = render(<TilesSkeleton count={4} fleet />);
    expect(container.firstElementChild).toHaveClass("tiles", "fleet-tiles");
  });

  it("with plain the label is a muted line alone (Storage's caption, no circle) and className reaches the grid", () => {
    const { container } = render(<TilesSkeleton count={5} plain className="storage-tiles" notes={[1, 2, 4]} />);
    const grid = container.firstElementChild!;
    expect(grid).toHaveClass("tiles", "storage-tiles");
    const tiles = [...grid.querySelectorAll(":scope > .tile")];
    expect(tiles).toHaveLength(5);
    for (const tile of tiles) {
      const label = tile.firstElementChild!;
      expect(label).toHaveClass("muted");
      expect(label).not.toHaveClass("tile-label");
      expect(label.querySelector(".sk-circle")).toBeNull();
      expect(label.querySelector(".sk-line")).not.toBeNull();
    }
    expect(tiles.map((t) => t.querySelector(":scope > small") !== null)).toEqual([false, true, true, false, true]);
  });

  it("gives a <small> note line, as a direct child of the tile, to the tiles listed in notes only", () => {
    const { container } = render(<TilesSkeleton count={4} fleet notes={[1]} />);
    const tiles = [...container.querySelectorAll(".tiles > .tile")];
    expect(tiles.map((t) => t.querySelector(":scope > small") !== null)).toEqual([false, true, false, false]);
    expect(tiles[1].querySelector(":scope > small .sk-line")).not.toBeNull();
  });
});

describe("TableSkeleton", () => {
  it("is a real table in .table-wrap: one header cell per column, one body row per row, a placeholder in every cell", () => {
    const { container } = render(<TableSkeleton columns={5} rows={3} />);
    expect(container.firstElementChild).toHaveClass("table-wrap");
    expect(container.querySelectorAll("table")).toHaveLength(1);
    expect(container.querySelectorAll("thead th")).toHaveLength(5);
    const rows = container.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.querySelectorAll("td")).toHaveLength(5);
    for (const cell of container.querySelectorAll("th, td")) expect(cell.querySelector(".sk-line")).not.toBeNull();
  });

  it("leaves no table, row or cell in the accessibility tree (a spec waiting for the first row must not count these)", () => {
    render(<TableSkeleton columns={3} rows={4} label="Loading users" />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryAllByRole("row")).toHaveLength(0);
    expect(screen.queryAllByRole("columnheader")).toHaveLength(0);
    expect(screen.queryAllByRole("cell")).toHaveLength(0);
  });

  it("with caption has a muted <caption> holding one line placeholder, first in the table (as billing's how-to-read row)", () => {
    const { container } = render(<TableSkeleton columns={3} rows={2} caption />);
    const table = container.querySelector("table")!;
    const caption = table.firstElementChild!;
    expect(caption.tagName).toBe("CAPTION");
    expect(caption).toHaveClass("muted");
    expect(caption.querySelectorAll(".sk-line")).toHaveLength(1);
    expect(caption.textContent).toBe("");
    expect(table.querySelector("thead")).not.toBeNull();
    expect(render(<TableSkeleton columns={3} rows={2} />).container.querySelector("caption")).toBeNull();
  });

  it("with headless has body rows only, as a table with no <thead> (Storage's rows per day)", () => {
    const { container } = render(<TableSkeleton columns={2} rows={7} headless />);
    expect(container.querySelector("thead")).toBeNull();
    expect(container.querySelectorAll("tbody tr")).toHaveLength(7);
    expect(container.querySelectorAll("tbody tr:first-child td")).toHaveLength(2);
  });

  it("varies the widths but not from one render to the next", () => {
    const { container } = render(<TableSkeleton columns={4} rows={4} />);
    const widths = [...container.querySelectorAll<HTMLElement>("tbody .sk-line")].map((l) => l.style.width);
    expect(new Set(widths).size).toBeGreaterThan(2);
  });
});

describe("FormSkeleton", () => {
  it("is a .form-card holding one field per row: a label line, then a 38px block", () => {
    const { container } = render(<FormSkeleton rows={3} />);
    const card = container.firstElementChild!;
    expect(card).toHaveClass("form-card");
    expect(card).not.toHaveClass("wide");
    const fields = card.querySelectorAll(".sk-field");
    expect(fields).toHaveLength(3);
    for (const field of fields) {
      expect(field.querySelector(".sk-line")).not.toBeNull();
      expect((field.querySelector(".sk-block") as HTMLElement).style.height).toBe("38px");
    }
  });

  it("with bare is the rows alone, with no card of its own (a card the page already draws keeps its heading)", () => {
    const { container } = render(<FormSkeleton rows={2} bare />);
    const stack = container.firstElementChild!;
    expect(stack).toHaveClass("sk-stack");
    expect(stack).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".form-card")).toBeNull();
    expect(stack.querySelectorAll(".sk-field")).toHaveLength(2);
  });

  it("with inline is the Tariffs bar: the fields side by side in a .inline-form and a 38px button block, no card", () => {
    const { container } = render(<FormSkeleton rows={1} inline />);
    const bar = container.firstElementChild!;
    expect(bar).toHaveClass("inline-form");
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".form-card")).toBeNull();
    expect(bar.querySelectorAll(":scope > .sk-field")).toHaveLength(1);
    const button = bar.querySelector<HTMLElement>(":scope > .sk-block")!;
    expect(button.style.height).toBe("38px");
  });

  it("with wide takes the full-width card", () => {
    const { container } = render(<FormSkeleton rows={1} wide />);
    expect(container.firstElementChild).toHaveClass("form-card", "wide");
  });
});

describe("PageCardSkeleton", () => {
  it("is the real card and head, with a 32px block for the icon tile and a grey line in the h2", () => {
    const { container } = render(<PageCardSkeleton />);
    const card = container.firstElementChild!;
    expect(card.tagName).toBe("SECTION");
    expect(card).toHaveClass("page-card");
    expect(card).toHaveAttribute("aria-hidden", "true");
    const head = card.firstElementChild!;
    expect(head).toHaveClass("page-card-head", "sect-head"); // the classes PageCard's head has
    const tile = head.querySelector<HTMLElement>(":scope > .sk-block")!;
    expect(tile.style.width).toBe("32px");
    expect(tile.style.height).toBe("32px");
    const title = head.querySelector("h2")!;
    expect(title.querySelector(".sk-line")).not.toBeNull();
    expect(title.textContent).toBe("");
    expect(head.querySelector(".sect-purpose")).toBeNull();
    expect(head.children).toHaveLength(2);
  });

  it("draws a purpose line only when asked, in the real purpose line's box", () => {
    const { container } = render(<PageCardSkeleton purpose />);
    const purpose = container.querySelector(".page-card-head > p")!;
    expect(purpose).toHaveClass("sect-purpose", "muted");
    expect(purpose.querySelector(".sk-line")).not.toBeNull();
    expect(purpose.textContent).toBe("");
  });

  it("puts its children after the head, as the body, and takes a className next to its own", () => {
    const { container } = render(<PageCardSkeleton className="rows-day"><TableSkeleton columns={2} rows={2} headless /></PageCardSkeleton>);
    const card = container.firstElementChild!;
    expect(card).toHaveClass("page-card", "rows-day");
    expect(card.children).toHaveLength(2);
    expect(card.children[1]).toHaveClass("table-wrap", "sk-table");
  });

  it("holds no words, no heading a reader can reach, and nothing focusable", () => {
    const { container } = render(<PageCardSkeleton purpose><FormSkeleton rows={1} bare /></PageCardSkeleton>);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.querySelector(FOCUSABLE)).toBeNull();
  });
});

describe("ChartBlock", () => {
  it("is as high as the real chart, from the one shared number", () => {
    expect(CHART_HEIGHT).toBe(320);
    const { container } = render(<ChartBlock />);
    const el = container.firstElementChild as HTMLElement;
    expect(el).toHaveClass("sk", "sk-block");
    expect(el.style.height).toBe(`${CHART_HEIGHT}px`);
  });
});

describe("TrendSkeleton", () => {
  it("is a .trend-frame: the real toolbar row (a label column of a line and a 38px block, then a 38px range block), then the chart block", () => {
    const { container } = render(<TrendSkeleton />);
    const frame = container.firstElementChild!;
    expect(frame).toHaveClass("trend-frame");
    expect(frame).not.toHaveAttribute("aria-label"); // the real frame is the "Trend" region; this one must not be found by name
    const bar = frame.querySelector(":scope > .row.trend-bar")!;
    expect(bar).not.toBeNull();
    const column = bar.querySelector(":scope > .sk-field")!;
    expect(column.querySelector(".sk-line")).not.toBeNull();
    expect((column.querySelector(".sk-block") as HTMLElement).style.height).toBe("38px");
    const range = bar.querySelector<HTMLElement>(":scope > .sk-block")!;
    expect(range.style.height).toBe("38px");
    const chart = frame.lastElementChild as HTMLElement;
    expect(chart).toHaveClass("sk-block");
    expect(chart.style.height).toBe(`${CHART_HEIGHT}px`);
    expect(bar.nextElementSibling).toBe(chart);
  });
});

describe("TreeSkeleton", () => {
  it("is rows of the real .node (a leading space, a circle, a name line) at three indent levels", () => {
    const { container } = render(<TreeSkeleton />);
    const nodes = [...container.querySelectorAll<HTMLElement>(".node")];
    expect(nodes.length).toBeGreaterThanOrEqual(6);
    for (const node of nodes) {
      expect(node.querySelector(".twisty-sp")).not.toBeNull();
      expect(node.querySelector(".sk-circle")).not.toBeNull();
      expect(node.querySelector(".sk-line")).not.toBeNull();
    }
    expect(new Set(nodes.map((n) => n.style.marginLeft || "0px")).size).toBe(3);
  });
});

describe("PageHeaderSkeleton", () => {
  it("is a .page-head with a sized title placeholder, and no heading, link or nav of its own", () => {
    const { container } = render(<PageHeaderSkeleton />);
    const head = container.firstElementChild!;
    expect(head.tagName).toBe("HEADER");
    expect(head).toHaveClass("page-head");
    expect(head.querySelector(".sk-line")).not.toBeNull();
    expect(head.querySelector("h1, h2, nav, .crumbs, .page-title, .sub, .actions")).toBeNull();
  });

  it("with crumbs draws the trail as a .crumbs list of lines with separators (a div, not a nav landmark)", () => {
    const { container } = render(<PageHeaderSkeleton crumbs />);
    const trail = container.querySelector(".crumbs")!;
    expect(trail.tagName).toBe("DIV");
    expect(trail.querySelectorAll("ol > li").length).toBeGreaterThanOrEqual(2);
    expect(trail.querySelectorAll("li .sep").length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toBe(""); // the separator is drawn by the stylesheet, not typed
  });

  it("with icon puts a 40px block beside the title in a .page-title (not the accent-tinted .page-tile)", () => {
    const { container } = render(<PageHeaderSkeleton icon />);
    const title = container.querySelector(".page-title")!;
    const tile = title.querySelector<HTMLElement>(".sk-block")!;
    expect(tile.style.width).toBe("40px");
    expect(tile.style.height).toBe("40px");
    expect(container.querySelector(".page-tile")).toBeNull();
  });

  it("with sub adds a .sub line; with actions a 34px block in the .actions slot", () => {
    const { container } = render(<PageHeaderSkeleton sub actions />);
    expect(container.querySelector("p.sub .sk-line")).not.toBeNull();
    const block = container.querySelector<HTMLElement>(".actions > .sk-block")!;
    expect(block.style.height).toBe("34px");
  });
});

describe("ActionsSpace", () => {
  it("is a 34px aria-hidden gap with no text and nothing grey (it stands outside any region, so a grey block would show before the fade-in delay)", () => {
    const { container } = render(<ActionsSpace />);
    const gap = container.firstElementChild as HTMLElement;
    expect(container.children).toHaveLength(1);
    expect(gap).toHaveAttribute("aria-hidden", "true");
    expect(gap.style.height).toBe("34px");
    expect(gap.className).toBe("");
    expect(gap.textContent).toBe("");
  });

  it("takes a height of its own (Billing's month bar is 38px)", () => {
    const { container } = render(<ActionsSpace height={38} />);
    expect((container.firstElementChild as HTMLElement).style.height).toBe("38px");
  });
});

describe("PageSkeleton", () => {
  beforeEach(resetSkeletonClock);

  it("is one region around a page head and two 240px blocks side by side", () => {
    const { container } = render(<PageSkeleton label="Loading the page" />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(container.firstElementChild).toBe(screen.getByRole("status"));
    expect(container.textContent).toBe("Loading the page");
    expect(container.querySelector("header.page-head")).not.toBeNull();
    const blocks = [...container.querySelectorAll<HTMLElement>(".sk-pair > .sk-block")];
    expect(blocks.map((b) => b.style.height)).toEqual(["240px", "240px"]);
    for (const child of container.querySelector(".sr-only")!.parentElement!.children) {
      if (!child.classList.contains("sr-only")) expect(child, "a shape inside the region").toHaveAttribute("aria-hidden", "true");
    }
    expect(container.querySelector(FOCUSABLE)).toBeNull();
  });
});

/** The children of a composite's region: the label, then bare bodies that are all out of the accessibility tree. */
function bodiesOf(region: Element) {
  const bodies = [...region.children].filter((child) => !child.classList.contains("sr-only"));
  for (const body of bodies) expect(body, "a shape inside the region").toHaveAttribute("aria-hidden", "true");
  return bodies;
}

describe("FleetSkeleton", () => {
  beforeEach(resetSkeletonClock);

  it("is one region around the four fleet tiles (the second with its note line), the kinds and the attention table", () => {
    const { container } = render(<FleetSkeleton label="Loading the fleet summary" />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(container.firstElementChild).toBe(screen.getByRole("status"));
    expect(container.textContent).toBe("Loading the fleet summary");
    bodiesOf(container.firstElementChild!);
    const tiles = [...container.querySelectorAll(".tiles.fleet-tiles > .tile")];
    expect(tiles.map((t) => t.querySelector(":scope > small") !== null)).toEqual([false, true, false, false]);
    expect(container.querySelector(FOCUSABLE)).toBeNull();
  });

  it("draws the section headings as real .section-title h2s that are out of the accessibility tree, and five kinds in a .kind-list", () => {
    const { container } = render(<FleetSkeleton label="Loading the fleet summary" />);
    const titles = [...container.querySelectorAll("h2")];
    expect(titles).toHaveLength(2); // By kind, Needs attention
    for (const title of titles) {
      expect(title).toHaveClass("section-title");
      expect(title).toHaveAttribute("aria-hidden", "true");
      expect(title.querySelector(".sk-line")).not.toBeNull();
    }
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    const kinds = container.querySelectorAll("ul.kind-list > li");
    expect(kinds).toHaveLength(5);
    for (const kind of kinds) {
      expect(kind.querySelector(".kind-name .sk-circle")).not.toBeNull();
      expect(kind.querySelector(".kind-name .sk-line")).not.toBeNull();
      expect(kind.querySelector(".kind-count .sk-line")).not.toBeNull();
    }
  });

  it("ends with the attention table as the real one is laid out: four columns (Asset, Where, Problem, Last reading), three rows", () => {
    const { container } = render(<FleetSkeleton label="Loading the fleet summary" />);
    const wrap = container.querySelector(".table-wrap")!;
    expect(wrap.querySelectorAll("thead th")).toHaveLength(4);
    expect(wrap.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(wrap).toBe(container.firstElementChild!.lastElementChild);
  });
});

describe("AssetSkeleton", () => {
  beforeEach(resetSkeletonClock);

  it("is one region that IS the asset page wrapper, with bare aria-hidden bodies inside", () => {
    const { container } = render(<AssetSkeleton label="Loading the asset" />);
    const region = screen.getByRole("status");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(container.firstElementChild).toBe(region);
    expect(region).toHaveClass("sk-region", "asset-page");
    expect(container.textContent).toBe("Loading the asset");
    bodiesOf(region);
    expect(container.querySelector(FOCUSABLE)).toBeNull();
  });

  it("holds the header with crumbs, an icon block and a sub line, then three tiles without notes", () => {
    const { container } = render(<AssetSkeleton label="Loading the asset" />);
    const head = container.querySelector("header.page-head")!;
    expect(head.querySelector(".crumbs")).not.toBeNull();
    expect(head.querySelector(".page-title > .sk-block")).not.toBeNull();
    expect(head.querySelector("p.sub .sk-line")).not.toBeNull();
    const tiles = container.querySelectorAll(".tiles > .tile");
    expect(tiles).toHaveLength(3);
    expect(container.querySelector(".tiles")).not.toHaveClass("fleet-tiles");
    for (const tile of tiles) expect(tile.querySelector(":scope > small")).toBeNull();
  });

  it("puts the Trend and Metrics headings in as aria-hidden h2s holding a line, direct children of the wrapper (so .asset-page > h2 styles them), around the trend frame and the metrics table", () => {
    const { container } = render(<AssetSkeleton label="Loading the asset" />);
    const region = container.firstElementChild!;
    const kids = [...region.children].filter((child) => !child.classList.contains("sr-only"));
    expect(kids.map((child) => child.tagName + (child.className ? `.${child.className.split(" ")[0]}` : ""))).toEqual([
      "HEADER.page-head", "DIV.tiles", "H2", "DIV.trend-frame", "H2", "DIV.table-wrap",
    ]);
    for (const h2 of region.querySelectorAll(":scope > h2")) {
      expect(h2).toHaveAttribute("aria-hidden", "true");
      expect(h2.querySelector(".sk-line")).not.toBeNull();
    }
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    const table = region.querySelector(".table-wrap")!;
    expect(table.querySelectorAll("thead th")).toHaveLength(4);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(3);
  });
});

describe("DashboardSkeleton", () => {
  beforeEach(resetSkeletonClock);

  it("is one region that is the sk-dash wrapper, around bare aria-hidden bodies: the trail, the head row and four blocks", () => {
    const { container } = render(<DashboardSkeleton label="Loading the dashboard" />);
    const region = screen.getByRole("status");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(container.firstElementChild).toBe(region);
    expect(region).toHaveClass("sk-region", "sk-dash");
    expect(container.textContent).toBe("Loading the dashboard");
    expect(bodiesOf(region).map((body) => body.tagName + "." + body.className.split(" ")[0])).toEqual(["DIV.crumbs", "DIV.row", "DIV.sk-quad"]);
    expect(container.querySelector(FOCUSABLE)).toBeNull();
  });

  it("has no page head, heading or navigation landmark, and none of the widget grid's classes (a spec's locator must not find the skeleton)", () => {
    const { container } = render(<DashboardSkeleton label="Loading the dashboard" />);
    expect(container.querySelector("header, h1, h2, nav, .page-head, .dash-grid, .dash-cell")).toBeNull();
    expect(screen.queryAllByRole("heading")).toHaveLength(0);
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("draws the trail of the real page, Dashboards and the dashboard's name, as a .crumbs div with one separator", () => {
    const { container } = render(<DashboardSkeleton label="Loading the dashboard" />);
    const trail = container.querySelector(".crumbs")!;
    expect(trail.tagName).toBe("DIV");
    expect(trail.querySelectorAll("ol > li")).toHaveLength(2);
    expect(trail.querySelectorAll("li .sep")).toHaveLength(1);
  });

  it("draws the head row as the real .row.dash-head: a title line, the spacer, the range label, the 142x38 select, and no Edit block unless canEdit", () => {
    const { container } = render(<DashboardSkeleton label="Loading the dashboard" />);
    const row = container.querySelector(".row.dash-head")!;
    expect(row.querySelector(":scope > .sk-h1 .sk-line")).not.toBeNull();
    expect(row.querySelector(":scope > .spacer")).not.toBeNull();
    const blocks = [...row.querySelectorAll<HTMLElement>(":scope > .sk-block")];
    expect(blocks.map((b) => [b.style.width, b.style.height])).toEqual([["142px", "38px"]]);
  });

  it("with canEdit adds the Edit button's block, 55x34, after the select", () => {
    const { container } = render(<DashboardSkeleton label="Loading the dashboard" canEdit />);
    const blocks = [...container.querySelectorAll<HTMLElement>(".dash-head > .sk-block")];
    expect(blocks.map((b) => [b.style.width, b.style.height])).toEqual([["142px", "38px"], ["55px", "34px"]]);
  });

  it("ends in four 240px blocks in a two-column grid", () => {
    const { container } = render(<DashboardSkeleton label="Loading the dashboard" />);
    const blocks = [...container.querySelectorAll<HTMLElement>(".sk-quad > .sk-block")];
    expect(blocks.map((b) => b.style.height)).toEqual(["240px", "240px", "240px", "240px"]);
  });
});

describe("CanvasSkeleton", () => {
  beforeEach(resetSkeletonClock);

  it("is one region that IS the .graph-layout row, around one aria-hidden block that takes the row's height (auto, not the 38px default)", () => {
    const { container } = render(<CanvasSkeleton label="Loading the graph" />);
    const region = screen.getByRole("status");
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(container.firstElementChild).toBe(region);
    expect(region).toHaveClass("sk-region", "graph-layout");
    expect(container.textContent).toBe("Loading the graph");
    const [block, ...rest] = bodiesOf(region);
    expect(rest).toHaveLength(0);
    expect(block).toHaveClass("sk-block");
    expect((block as HTMLElement).style.height).toBe("auto");
    expect(container.querySelector(FOCUSABLE)).toBeNull();
  });
});

describe("the instant rule (a region that follows a skeleton somebody saw does not wait out the fade-in delay)", () => {
  // The clock is performance.now, which the rule reads when a region mounts (a layout effect); React Query is not involved, but global fake timers are not used anyway.
  let clock = 0;
  const at = (ms: number) => { clock = ms; };
  let spy: { mockRestore: () => void };
  beforeEach(() => {
    resetSkeletonClock();
    at(10_000);
    spy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  });
  afterEach(() => spy.mockRestore());

  // always one fragment of keyed regions, so a rerender keeps the ones that stay and a changed key is a swap
  const regions = (labels: string[], className?: string) => (
    <>{labels.map((label) => <SkeletonRegion key={label} label={label} className={className}><Skeleton /></SkeletonRegion>)}</>
  );
  const status = (label: string) => screen.getByText(label).parentElement!;
  const instant = (label: string) => status(label).hasAttribute("data-instant");

  it("a lone region is delayed (no data-instant)", () => {
    render(regions(["One"]));
    expect(instant("One")).toBe(false);
  });

  it("a region that mounts beside one that has been up 270 ms is instant (that one was fully on screen)", () => {
    const { rerender } = render(regions(["One"]));
    at(10_270);
    rerender(regions(["One", "Two"]));
    expect(instant("Two")).toBe(true);
    expect(instant("One")).toBe(false); // it was first
  });

  it("a region that mounts beside one that is still fading in is delayed too (nobody saw that one fully)", () => {
    const { rerender } = render(regions(["One"]));
    at(10_269);
    rerender(regions(["One", "Two"]));
    expect(instant("Two")).toBe(false);
  });

  it("two regions that mount in the same commit are both delayed (the tree and the pane)", () => {
    render(regions(["Tree", "Pane"]));
    expect(instant("Tree")).toBe(false);
    expect(instant("Pane")).toBe(false);
  });

  it("a region swapped in for one that was up 300 ms is instant (the old one went in the same commit)", () => {
    const { rerender } = render(regions(["Old"]));
    at(10_300);
    rerender(regions(["New"]));
    expect(instant("New")).toBe(true);
  });

  it("a region swapped in for one that was up only 200 ms (half faded in) is delayed: the cold chart behind a 130 ms answer's skeletons would flash otherwise", () => {
    const { rerender } = render(regions(["Old"]));
    at(10_200);
    rerender(regions(["New"]));
    expect(instant("New")).toBe(false);
  });

  it("a region swapped in for one that was up only 40 ms is delayed: the data came back before the first was ever visible", () => {
    const { rerender } = render(regions(["Old"]));
    at(10_040);
    rerender(regions(["New"]));
    expect(instant("New")).toBe(false);
  });

  it("a region that unmounted after 40 ms leaves no grace: the next one, a moment later, is delayed (a tree click that is answered quickly)", () => {
    const first = render(regions(["Asset"]));
    at(10_040);
    first.unmount();
    at(10_050);
    render(regions(["Chart"]));
    expect(instant("Chart")).toBe(false);
  });

  it("a region that was up 300 ms leaves a grace of 250 ms: one that mounts 249 ms after it left is instant", () => {
    const first = render(regions(["One"]));
    at(10_300);
    first.unmount();
    at(10_549);
    render(regions(["Quick"]));
    expect(instant("Quick")).toBe(true);
  });

  it("and one that mounts 250 ms after it left is delayed again", () => {
    const first = render(regions(["One"]));
    at(10_300);
    first.unmount();
    at(10_550);
    render(regions(["Late"]));
    expect(instant("Late")).toBe(false);
  });

  it("a region that was instant counts as seen at once: a chain of short hops keeps the grace alive", () => {
    const { rerender, unmount } = render(regions(["A"]));
    at(10_300);
    rerender(regions(["B"])); // B follows A: instant, so on screen from this moment
    expect(instant("B")).toBe(true);
    at(10_340);
    unmount(); // B was up for 40 ms, A went 40 ms before B: C comes past the grace of A (10_550) but within B's own (10_590)
    at(10_570);
    render(regions(["C"]));
    expect(instant("C")).toBe(true);
  });

  it("a re-render of a delayed region does not make it instant (its own mount must not count against it)", () => {
    const { rerender } = render(regions(["One"]));
    at(10_500);
    rerender(regions(["One"], "again"));
    expect(status("One")).toHaveClass("again");
    expect(instant("One")).toBe(false);
  });

  it("under StrictMode a lone region is delayed, its simulated unmount leaves no grace, and nothing leaks into the regions after it", () => {
    const first = render(<StrictMode>{regions(["One"])}</StrictMode>);
    expect(instant("One")).toBe(false);
    at(10_010);
    first.unmount();
    at(10_020);
    const second = render(<StrictMode>{regions(["Two"])}</StrictMode>);
    expect(instant("Two")).toBe(false); // One lived 10 ms: nobody saw it, and the simulated unmount did not stamp the grace
    at(10_030);
    second.unmount();
    at(10_600);
    render(<StrictMode>{regions(["Three"])}</StrictMode>);
    expect(instant("Three")).toBe(false); // a leaked region would leave every later one instant for good
  });
});
