import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { config, textWidget, widget } from "../../test/dashboardFixtures";
import { DashboardGuide, guideApplies, guideFacts, guideLines } from "./DashboardGuide";

const fixed = widget(1, "stat");
const following = widget(2, "stat", { config: config({ assets: [], scope: "focus" }) });
const children = widget(3, "table", { config: config({ assets: [], scope: "children" }) });
const comparing = widget(4, "stat", { config: config({ source: "energy", metric: null, aggregation: "sum", range: "this_month", compare: "same_days_last_month" }) });
const notComparing = widget(5, "stat", { config: config({ compare: "none" }) });
const kinds = widget(6, "bar", { config: config({ assets: [], source: "energy", metric: null, aggregation: "sum", bars: "kind", kind: "Rack" }) });
const heading = textWidget(7, "heading", "Hall");

describe("what a dashboard has that the guide explains", () => {
  it("reads a comparison, a card that follows the focus (a focus or its children) and a breakdown by kind from the widgets", () => {
    expect(guideFacts([comparing])).toEqual({ compares: true, follows: false, breaksDown: false });
    expect(guideFacts([following])).toEqual({ compares: false, follows: true, breaksDown: false });
    expect(guideFacts([children])).toEqual({ compares: false, follows: true, breaksDown: false });
    expect(guideFacts([kinds])).toEqual({ compares: false, follows: false, breaksDown: true });
    expect(guideFacts([fixed, notComparing, heading])).toEqual({ compares: false, follows: false, breaksDown: false });
    expect(guideFacts([])).toEqual({ compares: false, follows: false, breaksDown: false });
  });

  it("is offered on a dashboard that has at least one of them, and not on one that has none", () => {
    expect(guideApplies(guideFacts([fixed, notComparing, heading]))).toBe(false);
    expect(guideApplies(guideFacts([]))).toBe(false);
    for (const one of [comparing, following, children, kinds]) expect(guideApplies(guideFacts([fixed, one]))).toBe(true);
  });
});

describe("the lines of the guide", () => {
  const all = { compares: true, follows: true, breaksDown: true };
  const text = (lines: string[]) => lines.join("\n");

  it("has five lines for a role that can open assets on a dashboard that compares, follows the focus and breaks down", () => {
    const lines = guideLines(all, true);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^Energy and Cost cards set this month so far against the same days of last month\.$/);
    expect(lines[1]).toMatch(/^Focus picks the asset this dashboard follows/);
    expect(lines[2]).toMatch(/^Click a bar of a breakdown: an asset with other assets inside it narrows the dashboard to it/);
    expect(lines[3]).toBe("~ means some of the figure is estimated. * means some hours have no rate, so a cost is incomplete.");
    expect(lines[4]).toBe("The (i) button on a card (Details) shows how its figures were worked out; the download button saves them as a CSV file.");
  });

  it("leaves out the two lines about assets for a role that cannot open them, so two lines are left", () => {
    const lines = guideLines({ compares: false, follows: true, breaksDown: true }, false);
    expect(lines).toHaveLength(2);
    expect(text(lines)).not.toMatch(/Focus|Click a bar/);
    expect(guideLines(all, false)).toHaveLength(3); // the comparison line is true for everybody
  });

  it("explains only what the dashboard has", () => {
    expect(text(guideLines({ compares: true, follows: false, breaksDown: false }, true))).not.toMatch(/Focus|Click a bar/);
    expect(text(guideLines({ compares: false, follows: true, breaksDown: false }, true))).not.toMatch(/same days of last month|Click a bar/);
  });

  it("says that a bar opens its page where no card follows the focus (nothing to narrow), and that it narrows where one does", () => {
    expect(guideLines({ compares: false, follows: false, breaksDown: true }, true)[0]).toBe("Click a bar of a breakdown to open that asset's page.");
    expect(guideLines({ compares: false, follows: true, breaksDown: true }, true)[1]).toMatch(/narrows the dashboard to it, and any other opens its page\.$/);
  });
});

describe("the panel", () => {
  it("is a heading that can take the focus (tabIndex -1), the lines as a list and Got it", async () => {
    const onGotIt = vi.fn();
    render(<DashboardGuide lines={["One.", "Two."]} headingRef={{ current: null }} onGotIt={onGotIt} />);
    const heading = screen.getByRole("heading", { name: "How to read this dashboard", level: 2 });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["One.", "Two."]);
    await userEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onGotIt).toHaveBeenCalledTimes(1);
  });
});
