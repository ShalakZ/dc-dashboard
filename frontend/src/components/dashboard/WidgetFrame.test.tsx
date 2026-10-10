import { render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("heading", { name: "Hall power" })).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    expect(screen.queryByText(/removed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/without this metric/)).not.toBeInTheDocument();
  });

  it("gives the heading a title of the full widget title, so a name cut by the ellipsis can still be read (S7-3)", () => {
    frame({ title: "Energy per transformer feeder, main switchboard, east hall" });
    expect(screen.getByRole("heading")).toHaveAttribute("title", "Energy per transformer feeder, main switchboard, east hall");
  });

  it("shows a loading note instead of the body while loading", () => {
    frame({ loading: true });
    expect(screen.getByText("loading…")).toBeInTheDocument();
    expect(screen.queryByText("body")).not.toBeInTheDocument();
  });

  it("shows an error as an alert", () => {
    frame({ error: new Error("query failed") });
    expect(screen.getByRole("alert")).toHaveTextContent("query failed");
  });

  it("warns when assets were removed, and still shows the body (Review Focus 5, UI side)", () => {
    const { unmount } = frame({ missing: 1 });
    expect(screen.getByText("1 asset removed")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
    unmount();
    frame({ missing: 3 });
    expect(screen.getByText("3 assets removed")).toBeInTheDocument();
  });

  it("warns about assets that have no reading of the chosen metric, apart from the removed ones", () => {
    const { unmount } = frame({ noMetric: 1 });
    expect(screen.getByText("1 asset without this metric")).toBeInTheDocument();
    unmount();
    frame({ noMetric: 2, missing: 1 });
    expect(screen.getByText("2 assets without this metric")).toBeInTheDocument();
    expect(screen.getByText("1 asset removed")).toBeInTheDocument();
  });

  it("explains the markers and the window it shows, whatever the body draws", () => {
    frame({ hint: "~ estimated, * partial, some hours have no rate", since: "since 10:00" });
    expect(screen.getByText("~ estimated, * partial, some hours have no rate")).toBeInTheDocument();
    expect(screen.getByText("since 10:00")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("downloads the widget's CSV with the exact request body", async () => {
    frame({ csv });
    await userEvent.click(screen.getByRole("button", { name: "Download CSV for Hall power" }));
    expect(downloadCsv).toHaveBeenCalledWith("/api/widget-data/csv", { method: "POST", body: { type: "stat", config: csv.config, range: "7d" } });
  });

  it("reports a failed export without hiding the widget", async () => {
    vi.mocked(downloadCsv).mockRejectedValue(new Error("server said no"));
    frame({ csv });
    await userEvent.click(screen.getByRole("button", { name: "Download CSV for Hall power" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("CSV export failed: server said no");
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("offers no CSV button without a csv source, shows extra actions, and can mark the header as the drag handle", () => {
    frame({ actions: <button>Edit</button>, dragHandle: true });
    expect(screen.queryByRole("button", { name: /CSV/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hall power" }).parentElement).toHaveClass("widget-drag-handle");
  });
});
