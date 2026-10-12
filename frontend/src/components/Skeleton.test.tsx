import { render, screen } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { CHART_HEIGHT } from "../lib/chartBox";
import {
  ChartBlock, FormSkeleton, PageHeaderSkeleton, PageSkeleton, resetSkeletonClock, Skeleton, SkeletonRegion, TableSkeleton, TilesSkeleton,
  TreeSkeleton, TrendSkeleton,
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

  it("with wide takes the full-width card", () => {
    const { container } = render(<FormSkeleton rows={1} wide />);
    expect(container.firstElementChild).toHaveClass("form-card", "wide");
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

describe("the instant rule (a region that follows another does not wait out the fade-in delay)", () => {
  const now = (ms: number) => vi.setSystemTime(ms);
  beforeEach(() => {
    resetSkeletonClock();
    vi.useFakeTimers({ toFake: ["Date"] });
    now(10_000);
  });
  afterEach(() => vi.useRealTimers());

  // always one fragment of keyed regions, so a rerender keeps the ones that stay and a changed key is a swap
  const regions = (labels: string[], className?: string) => (
    <>{labels.map((label) => <SkeletonRegion key={label} label={label} className={className}><Skeleton /></SkeletonRegion>)}</>
  );
  const status = (label: string) => screen.getByText(label).parentElement!;

  it("a lone region is delayed (no data-instant)", () => {
    render(regions(["One"]));
    expect(status("One")).not.toHaveAttribute("data-instant");
  });

  it("a region that mounts while another is mounted is instant", () => {
    const { rerender } = render(regions(["One"]));
    rerender(regions(["One", "Two"]));
    expect(status("Two")).toHaveAttribute("data-instant");
    expect(status("One")).not.toHaveAttribute("data-instant"); // it was first
  });

  it("two regions that mount in the same commit are both delayed (the tree and the pane)", () => {
    render(regions(["Tree", "Pane"]));
    expect(status("Tree")).not.toHaveAttribute("data-instant");
    expect(status("Pane")).not.toHaveAttribute("data-instant");
  });

  it("a region swapped for another in one commit is instant (the old one has not cleaned up when the new one renders)", () => {
    const { rerender } = render(regions(["Old"]));
    rerender(regions(["New"]));
    expect(status("New")).toHaveAttribute("data-instant");
  });

  it("a region that mounts less than 250 ms after another unmounted is instant", () => {
    render(regions(["One"])).unmount(); // at 10_000
    now(10_249);
    render(regions(["Quick"]));
    expect(status("Quick")).toHaveAttribute("data-instant");
  });

  it("a region that mounts 250 ms or more after the last unmount is delayed again", () => {
    render(regions(["One"])).unmount(); // at 10_000
    now(10_250);
    render(regions(["Late"]));
    expect(status("Late")).not.toHaveAttribute("data-instant");
  });

  it("a re-render of a delayed region does not make it instant (its own mount must not count against it)", () => {
    const { rerender } = render(regions(["One"]));
    rerender(regions(["One"], "again"));
    expect(status("One")).toHaveClass("again");
    expect(status("One")).not.toHaveAttribute("data-instant");
  });

  it("under StrictMode a lone region is delayed, and the counter balances: a later region, after the grace, is delayed too", () => {
    const first = render(<StrictMode>{regions(["One"])}</StrictMode>);
    expect(status("One")).not.toHaveAttribute("data-instant");
    first.unmount();
    now(10_300);
    render(<StrictMode>{regions(["Two"])}</StrictMode>);
    expect(status("Two")).not.toHaveAttribute("data-instant"); // a leaked count would leave every later region instant for good
  });
});
