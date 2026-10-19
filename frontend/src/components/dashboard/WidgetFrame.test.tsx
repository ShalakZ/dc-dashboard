import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { downloadCsv } from "../../lib/download";
import { config } from "../../test/dashboardFixtures";
import { WidgetFrame } from "./WidgetFrame";

vi.mock("../../lib/download", () => ({ downloadCsv: vi.fn() }));

const csv = { type: "stat" as const, config: config({ aggregation: "last" }), range: "7d" as const };
const frame = (props: Partial<React.ComponentProps<typeof WidgetFrame>> = {}) =>
  render(<WidgetFrame title="Hall power" loading={false} error={null} missing={0} {...props}><p>body</p></WidgetFrame>);

beforeEach(() => {
  vi.mocked(downloadCsv).mockReset();
  vi.mocked(downloadCsv).mockResolvedValue(undefined);
});

describe("WidgetFrame", () => {
  it("shows the title and the body", () => {
    frame();
    expect(screen.getByRole("region", { name: "Hall power" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hall power", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.queryByText(/removed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/without this metric/)).not.toBeInTheDocument();
  });

  it("gives the heading a title of the full widget title, so a name cut by the ellipsis can still be read (S7-3)", () => {
    frame({ title: "Energy per transformer feeder, main switchboard, east hall" });
    expect(screen.getByRole("heading")).toHaveAttribute("title", "Energy per transformer feeder, main switchboard, east hall");
  });

  it("draws the title at once and a skeleton in one labelled region instead of the body while loading", () => {
    frame({ loading: true, type: "gauge" });
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent(/^Loading Hall power$/); // the label is its only text: a placeholder holds no words
    expect(region).toHaveClass("sk-region", "widget-sk");
    expect(region).toHaveAttribute("data-type", "gauge");
    expect(region.parentElement).toBe(screen.getByRole("region", { name: "Hall power" })); // it stands where the body will be
    expect(screen.getByRole("heading", { name: "Hall power" })).toBeInTheDocument();
    expect(screen.queryByText("body")).not.toBeInTheDocument();
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
  });

  it.each([["stat", 2], ["gauge", 3], ["table", 5], ["timeseries", 1], ["bar", 1]] as const)("a %s skeleton has %i placeholder shapes, no words and nothing to focus", (type, shapes) => {
    frame({ loading: true, type });
    const region = screen.getByRole("status");
    expect(region.querySelectorAll(".sk")).toHaveLength(shapes);
    expect(region.textContent).toBe("Loading Hall power");
    expect(region.querySelector("button, a, input, [tabindex]")).toBeNull();
  });

  it("draws the skeleton variant it is given (a comparing stat, a breakdown by kind), in the same one region", () => {
    const { unmount } = frame({ loading: true, type: "stat", shape: "compare-stat" });
    expect(screen.getByRole("status")).toHaveClass("widget-sk", "widget-sk-compare");
    expect(screen.getByRole("status")).toHaveAttribute("data-type", "stat");
    unmount();
    frame({ loading: true, type: "bar", shape: "kind-bars" });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveClass("widget-sk-kind");
  });

  it("reserves the footer line while loading only when asked, so the body does not shrink when a since line arrives (energy and cost)", () => {
    const { container, unmount } = frame({ loading: true, type: "stat" });
    expect(container.querySelector(".widget-foot")).toBeNull();
    unmount();
    const held = frame({ loading: true, type: "stat", footSpace: true });
    const foot = held.container.querySelector(".widget-foot");
    expect(foot).toHaveAttribute("aria-hidden", "true");
    expect(foot?.textContent).toBe("");
  });

  it("shows an error as an alert with the alert icon, and keeps the title and the CSV button", () => {
    frame({ error: new Error("query failed"), csv });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("query failed");
    expect(alert).toHaveClass("widget-error");
    expect(alert.querySelector("svg.i")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Hall power" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download CSV for Hall power" })).toBeInTheDocument();
  });

  it("warns when assets were removed, and still shows the body (Review Focus 5, UI side)", () => {
    const { unmount } = frame({ missing: 1 });
    expect(screen.getByText("1 asset removed")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    unmount();
    frame({ missing: 3 });
    expect(screen.getByText("3 assets removed")).toBeInTheDocument();
  });

  it("a chip carries its words and, for a narrow card, its count: the words stay for a screen reader and the count is hidden from it", () => {
    frame({ missing: 3, noMetric: 2 });
    const chips = document.querySelectorAll(".widget-chips > .chip.chip-warn");
    expect(chips).toHaveLength(2);
    expect(chips[0].querySelector(".chip-long")).toHaveTextContent("3 assets removed");
    expect(chips[0].querySelector(".chip-short")).toHaveTextContent("3");
    expect(chips[0].querySelector(".chip-short")).toHaveAttribute("aria-hidden", "true");
    expect(chips[0]).toHaveAttribute("title", "Assets this widget used were deleted; it shows the rest.");
    expect(chips[1].querySelector(".chip-long")).toHaveTextContent("2 assets without this metric");
    expect(chips[1].querySelector(".chip-short")).toHaveTextContent("2");
    expect(chips[1]).toHaveAttribute("title", "These assets have no reading of this metric; they are left out.");
  });

  it("warns about assets that have no reading of the chosen metric, apart from the removed ones", () => {
    const { unmount } = frame({ noMetric: 1 });
    expect(screen.getByText("1 asset without this metric")).toBeInTheDocument();
    unmount();
    frame({ noMetric: 2, missing: 1 });
    expect(screen.getByText("2 assets without this metric")).toBeInTheDocument();
    expect(screen.getByText("1 asset removed")).toBeInTheDocument();
  });

  it("explains the markers and the window it shows in one footer line under the body, whatever the body draws", () => {
    frame({ hint: "~ estimated, * partial, some hours have no rate", since: "since 10:00" });
    const hint = screen.getByText("~ estimated, * partial, some hours have no rate");
    const since = screen.getByText("since 10:00");
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(since).toHaveClass("widget-since");
    expect(hint).toHaveClass("widget-hint");
    expect(since.parentElement).toBe(hint.parentElement);
    const foot = hint.parentElement as HTMLElement;
    expect(foot).toHaveClass("widget-foot");
    expect(foot.textContent).toBe("since 10:00 · ~ estimated, * partial, some hours have no rate"); // a dot between, each text in its own small
    // The dot is an element of its own, so a narrow card can hide it with the "since" (widgets.css): it sits between the two.
    const dot = foot.querySelector(".widget-dot");
    expect(dot?.textContent?.trim()).toBe("·");
    expect(since.nextElementSibling).toBe(dot);
    expect(dot?.nextElementSibling).toBe(hint);
    expect(foot.previousElementSibling).toHaveClass("widget-body"); // under the body
    expect(document.querySelector(".widget-notes")).toBeNull();
  });

  it("draws the footer for one of the two lines alone without a dot, and not at all for neither", () => {
    const { unmount } = frame({ since: "since 10:00" });
    expect(document.querySelector(".widget-foot")?.textContent).toBe("since 10:00");
    expect(document.querySelector(".widget-dot"), "no dot beside a lone line").toBeNull();
    unmount();
    const hint = frame({ hint: "~ estimated" });
    expect(document.querySelector(".widget-foot")?.textContent).toBe("~ estimated");
    hint.unmount();
    frame();
    expect(document.querySelector(".widget-foot")).toBeNull();
  });

  it("downloads the widget's CSV with the exact request body, from an icon button that stays a real button", async () => {
    frame({ csv });
    const button = screen.getByRole("button", { name: "Download CSV for Hall power" });
    expect(button).toHaveClass("icon-btn", "widget-csv-btn");
    expect(button).toHaveAttribute("type", "button");
    expect(button.querySelector("svg.i")).not.toBeNull();
    expect(button).toHaveTextContent(/^$/); // the icon is the face, the label is the name
    await userEvent.click(button);
    expect(downloadCsv).toHaveBeenCalledWith("/api/widget-data/csv", { method: "POST", body: { type: "stat", config: csv.config, range: "7d" } });
  });

  it("keeps the CSV button focusable while an export runs (aria-disabled, never disabled) and ignores a second click", async () => {
    let finish: () => void = () => {};
    vi.mocked(downloadCsv).mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    frame({ csv });
    const button = screen.getByRole("button", { name: "Download CSV for Hall power" });
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    expect(button).toHaveFocus();
    await userEvent.click(button);
    expect(downloadCsv).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(button).not.toHaveAttribute("aria-disabled", "true"));
  });

  it("reports a failed export without hiding the widget", async () => {
    vi.mocked(downloadCsv).mockRejectedValue(new Error("server said no"));
    frame({ csv });
    await userEvent.click(screen.getByRole("button", { name: "Download CSV for Hall power" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("CSV export failed: server said no");
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("offers no CSV button without a csv source, shows extra actions in the tools, and can mark the header as the drag handle with a grip", () => {
    frame({ actions: <button type="button">Edit</button>, dragHandle: true });
    expect(screen.queryByRole("button", { name: /CSV/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" }).closest(".widget-tools")).not.toBeNull();
    const head = screen.getByRole("heading", { name: "Hall power" }).parentElement as HTMLElement;
    expect(head).toHaveClass("widget-head", "widget-drag-handle");
    const grip = head.querySelector(".widget-grip");
    expect(grip).toHaveAttribute("aria-hidden", "true");
    expect(grip?.querySelector("svg.i")).not.toBeNull();
  });

  it("has no grip outside edit mode", () => {
    frame();
    expect(document.querySelector(".widget-grip")).toBeNull();
    expect(screen.getByRole("heading", { name: "Hall power" }).parentElement).not.toHaveClass("widget-drag-handle");
  });

  it("draws the Details button only when it is given a handler, as a real button named for the widget that says it opens a dialog", async () => {
    const { unmount } = frame();
    expect(screen.queryByRole("button", { name: /Details/ })).not.toBeInTheDocument();
    unmount();
    const details = vi.fn();
    frame({ details });
    const button = screen.getByRole("button", { name: "Details for Hall power" });
    expect(button).toHaveClass("icon-btn", "widget-details-btn");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveAttribute("aria-haspopup", "dialog");
    expect(button.querySelector("svg.i")).not.toBeNull();
    expect(button).not.toHaveAttribute("aria-disabled");
    await userEvent.click(button);
    expect(details).toHaveBeenCalledTimes(1);
  });

  it("holds the Details button back while the data loads: aria-disabled with a click guard, never disabled", async () => {
    const details = vi.fn();
    frame({ details, loading: true });
    const button = screen.getByRole("button", { name: "Details for Hall power" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(button).toHaveFocus();
    expect(details).not.toHaveBeenCalled();
  });
});
