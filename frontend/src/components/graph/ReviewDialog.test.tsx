import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { useAssets, useGraph, usePoints, useSources } from "../../api/queries";
import type { GraphModel, Metric } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { dropPayload, type DropPayload } from "../../lib/drop";
import { nodeId } from "../../lib/graph";
import { mockFetch } from "../../test/fetchMock";
import { model, point, source } from "../../test/graphFixtures";
import { renderWithProviders } from "../../test/render";
import { userFor } from "../../test/users";
import type { MappedInfo } from "../../hooks/useMappingActions";
import { ReviewDialog } from "./ReviewDialog";

const suggest = (metric: Metric, over: { scale?: number; interval_seconds?: number; custom_unit?: string | null } = {}) =>
  ({ metric, scale: 1, interval_seconds: 5, custom_unit: null, ...over });

// Asset 10 ("Site") already has active_power_kw and voltage_v from source 2; asset 11 ("Panel 1", child of 10) has nothing.
const graph = (): GraphModel => model({
  sources: [
    source(1, {
      clusters: [{ key: "LVP01", points: [
        point(1, "LVP01 kW", { suggestion: suggest("active_power_kw") }),
        point(2, "LVP01 kWh", { unit_hint: "kWh", suggestion: suggest("energy_kwh", { scale: 0.001, interval_seconds: 60 }) }),
        point(3, "LVP01 V", { suggestion: suggest("voltage_v") }),
      ] }, { key: "TEMPS", points: [
        point(4, "T a", { suggestion: suggest("custom", { custom_unit: "degC" }) }),
        point(5, "T b", { suggestion: suggest("custom", { custom_unit: "degC" }) }),
      ] }],
    }),
    source(2, { origin: "manual", enabled: true, clusters: [{ key: "M", points: [
      point(8, "M kW", { asset_id: 10, mapping_id: 1, mapped_metric: "active_power_kw" }),
      point(9, "M V", { asset_id: 10, mapping_id: 2, mapped_metric: "voltage_v" }),
    ] }] }),
  ],
});

type Initial = React.ComponentProps<typeof ReviewDialog>["initialTarget"];
const created = { status: 201, body: { asset_id: 11, mapping_ids: [1, 2, 3] } };
const routes = (accept: object = created) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor("admin", { username: "admin" }) },
  "GET /api/discovery/graph": { body: graph() },
  "POST /api/discovery/accept": accept,
});
const posts = (calls: { method: string; path: string; body: unknown }[]) => calls.filter((c) => c.method === "POST");

/** Mounts a graph query next to the dialog, as the page does, so the refetch after a commit is observable. `onMapped` is the page's `maps.mappedToast`. */
function Harness({ cluster = "LVP01", initialTarget, onClose, onMapped = () => undefined, kinds, observe = false, createdAsset }: {
  cluster?: string; initialTarget: Initial; onClose: () => void; onMapped?: (info: MappedInfo) => void; kinds?: React.ComponentProps<typeof ReviewDialog>["kinds"]; observe?: boolean;
  createdAsset?: string;
}) {
  const { loading } = useAuth();
  const { data } = useGraph();
  const payload = useRef<DropPayload | null>(null);
  if (loading || !data) return null;
  payload.current ??= dropPayload(data, nodeId.cluster(1, cluster));
  return (
    <>
      {observe && <Observers />}
      <ReviewDialog model={data} payload={payload.current!} initialTarget={initialTarget} kinds={kinds} createdAsset={createdAsset} onClose={onClose} onMapped={onMapped} />
    </>
  );
}
/** Queries the dialog is expected to refresh: mounting them makes their refetch visible as requests. */
function Observers() {
  useAssets();
  useSources();
  usePoints(1);
  return null;
}
async function open(initialTarget: Initial, accept?: object, cluster?: string) {
  const calls = mockFetch(routes(accept));
  const onClose = vi.fn();
  const onMapped = vi.fn();
  renderWithProviders(<Harness initialTarget={initialTarget} onClose={onClose} onMapped={onMapped} cluster={cluster} />);
  const dialog = await screen.findByRole("dialog", { name: "Review mappings" });
  return { calls, onClose, onMapped, dialog };
}
const existing = (assetId: number | null): Initial => ({ kind: "existing", assetId });
const create = () => screen.getByRole("button", { name: "Create mappings" });
const box = (name: string) => screen.getByRole("checkbox", { name: `Map ${name}` });
const rowOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;

describe("ReviewDialog", () => {
  it("lists one row per point with a checkbox, metric and the suggested numbers", async () => {
    const { dialog } = await open(existing(11));
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(3);
    for (const name of ["LVP01 kW", "LVP01 kWh", "LVP01 V"]) expect(box(name)).toBeChecked();
    expect(screen.getByLabelText("Metric for LVP01 kWh")).toHaveValue("energy_kwh");
    expect(screen.getByLabelText("Scale for LVP01 kWh")).toHaveValue(0.001);
    expect(screen.getByLabelText("Interval for LVP01 kWh")).toHaveValue(60);
    expect(screen.getByRole("radio", { name: "Existing asset" })).toBeChecked();
    expect(screen.getByLabelText("Asset")).toHaveValue("11");
    expect(create()).toBeEnabled();
  });

  it("the asset choices are the model's assets, indented by depth, after a (choose) option", async () => {
    await open(existing(null));
    const options = within(screen.getByLabelText("Asset")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["(choose)", "Site", "  Panel 1"]);
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual(["", "10", "11"]);
  });

  it("tells two assets with one name apart by their parent, in the asset list and in the parent list", async () => {
    mockFetch({
      ...routes(),
      "GET /api/discovery/graph": { body: { ...graph(), assets: [
        { id: 20, parent_id: null, name: "Room 1", kind: "generic" },
        { id: 21, parent_id: null, name: "Room 2", kind: "generic" },
        { id: 22, parent_id: 20, name: "LV Panel", kind: "generic" },
        { id: 23, parent_id: 21, name: "LV Panel", kind: "generic" },
      ] } },
    });
    renderWithProviders(<Harness initialTarget={existing(null)} onClose={vi.fn()} />);
    await screen.findByRole("dialog", { name: "Review mappings" });
    const texts = (select: HTMLElement) => within(select).getAllByRole("option").map((o) => o.textContent!.replace(/\u00a0/g, "_"));
    expect(texts(screen.getByLabelText("Asset"))).toEqual(["(choose)", "Room 1", "__LV Panel (Room 1)", "Room 2", "__LV Panel (Room 2)"]);
    await userEvent.click(screen.getByRole("radio", { name: "New asset" }));
    expect(texts(screen.getByLabelText("Parent asset"))).toEqual(["(root)", "Room 1", "__LV Panel (Room 1)", "Room 2", "__LV Panel (Room 2)"]);
  });

  it("rows whose metric the asset already has start unchecked and show their note", async () => {
    await open(existing(10));
    expect(box("LVP01 kW")).not.toBeChecked();
    expect(box("LVP01 V")).not.toBeChecked();
    expect(box("LVP01 kWh")).toBeChecked();
    expect(within(rowOf("LVP01 kW")).getByText(/already/)).toHaveTextContent("active_power_kw");
    expect(within(rowOf("LVP01 kWh")).queryByText(/already/)).not.toBeInTheDocument();
    expect(create()).toBeEnabled();
  });

  it("choosing New asset offers a name prefilled with the cluster label and a parent, and posts new_asset", async () => {
    const { calls, onClose } = await open(existing(10));
    await userEvent.click(screen.getByRole("radio", { name: "New asset" }));
    expect(screen.getByLabelText("New asset name")).toHaveValue("LVP01");
    expect(screen.queryByLabelText("Asset")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("Parent asset")).getAllByRole("option").map((o) => o.textContent)).toEqual(["(root)", "Site", "  Panel 1"]);
    for (const name of ["LVP01 kW", "LVP01 kWh", "LVP01 V"]) expect(box(name)).toBeChecked(); // a new asset has nothing yet
    await userEvent.selectOptions(screen.getByLabelText("Parent asset"), "10");
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const [post] = posts(calls);
    expect(post.path).toBe("/api/discovery/accept");
    expect(post.body).toEqual({
      source_id: 1, new_asset: { name: "LVP01", parent_id: 10 },
      points: [
        { point_id: 1, metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null },
        { point_id: 2, metric: "energy_kwh", scale: 0.001, interval_seconds: 60, custom_unit: null },
        { point_id: 3, metric: "voltage_v", scale: 1, interval_seconds: 5, custom_unit: null },
      ],
    });
    expect(post.body).not.toHaveProperty("asset_id");
  });

  it("opens straight on a new asset when asked to, with the given name and parent", async () => {
    await open({ kind: "new", name: "Feeder", parentId: 10 });
    expect(screen.getByRole("radio", { name: "New asset" })).toBeChecked();
    expect(screen.getByLabelText("New asset name")).toHaveValue("Feeder");
    expect(screen.getByLabelText("Parent asset")).toHaveValue("10");
  });

  it("a blank asset name keeps the button disabled and says why; the name is trimmed when posted", async () => {
    const { calls } = await open({ kind: "new", name: "Feeder", parentId: null });
    await userEvent.clear(screen.getByLabelText("New asset name"));
    expect(create()).toBeDisabled();
    expect(screen.getByText(/Enter a name/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("New asset name"), "  MV3 ");
    await userEvent.click(create());
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0].body).toMatchObject({ new_asset: { name: "MV3", parent_id: null } });
  });

  it("editing the metric and the numbers changes the posted row", async () => {
    const { calls, onClose } = await open(existing(11));
    await userEvent.selectOptions(screen.getByLabelText("Metric for LVP01 kWh"), "frequency_hz");
    const scale = screen.getByLabelText("Scale for LVP01 kWh");
    await userEvent.clear(scale);
    await userEvent.type(scale, "0.5");
    const interval = screen.getByLabelText("Interval for LVP01 kWh");
    await userEvent.clear(interval);
    await userEvent.type(interval, "30");
    const other = screen.getByLabelText("Interval for LVP01 V"); // blank means "use the server default"
    await userEvent.clear(other);
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts(calls)[0].body).toMatchObject({
      asset_id: 11,
      points: [
        { point_id: 1, metric: "active_power_kw", scale: 1, interval_seconds: 5 },
        { point_id: 2, metric: "frequency_hz", scale: 0.5, interval_seconds: 30 },
        { point_id: 3, metric: "voltage_v", scale: 1, interval_seconds: null },
      ],
    });
  });

  it("sends only the checked rows", async () => {
    const { calls, onClose } = await open(existing(11));
    await userEvent.click(box("LVP01 kWh"));
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect((posts(calls)[0].body as { points: { point_id: number }[] }).points.map((p) => p.point_id)).toEqual([1, 3]);
  });

  it("checking a conflicting row disables the button and names the conflict", async () => {
    await open(existing(10));
    await userEvent.click(box("LVP01 kW")); // asset 10 already has active_power_kw
    expect(create()).toBeDisabled();
    expect(screen.getByText(/Each metric can be mapped to an asset only once/)).toHaveTextContent("LVP01 kW (active_power_kw)");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await userEvent.click(box("LVP01 kW"));
    expect(create()).toBeEnabled();
  });

  it("two checked rows with the same metric conflict, and changing one metric resolves it", async () => {
    await open(existing(11));
    await userEvent.selectOptions(screen.getByLabelText("Metric for LVP01 kWh"), "active_power_kw");
    expect(create()).toBeDisabled();
    expect(screen.getByText(/Each metric can be mapped to an asset only once/)).toHaveTextContent(/LVP01 kW \(active_power_kw\).*LVP01 kWh \(active_power_kw\)/);
    await userEvent.selectOptions(screen.getByLabelText("Metric for LVP01 kWh"), "frequency_hz");
    expect(create()).toBeEnabled();
  });

  it("Create mappings posts the body, closes, and the graph is read again", async () => {
    const { calls, onClose } = await open(existing(11));
    const reads = () => calls.filter((c) => c.method === "GET" && c.path === "/api/discovery/graph").length;
    expect(reads()).toBe(1);
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0].body).toEqual({
      source_id: 1, asset_id: 11,
      points: [
        { point_id: 1, metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null },
        { point_id: 2, metric: "energy_kwh", scale: 0.001, interval_seconds: 60, custom_unit: null },
        { point_id: 3, metric: "voltage_v", scale: 1, interval_seconds: 5, custom_unit: null },
      ],
    });
    expect(reads()).toBeGreaterThan(1);
  });

  it("refreshes the assets, sources and the source's points as well as the graph", async () => {
    const calls = mockFetch({
      ...routes(),
      "GET /api/assets": { body: [] }, "GET /api/sources": { body: [] }, "GET /api/sources/1/points": { body: [] },
    });
    const onClose = vi.fn();
    renderWithProviders(<Harness initialTarget={existing(11)} onClose={onClose} observe />);
    await userEvent.click(await screen.findByRole("button", { name: "Create mappings" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const reads = (path: string) => calls.filter((c) => c.method === "GET" && c.path === path).length;
    for (const path of ["/api/discovery/graph", "/api/assets", "/api/sources", "/api/sources/1/points"]) {
      await waitFor(() => expect(reads(path)).toBe(2));
    }
  });

  it("a 409 keeps the dialog open and shows the server's message", async () => {
    const message = "this point is already mapped, or the asset already has this metric";
    const { onClose } = await open(existing(11), { status: 409, body: { detail: message } });
    await userEvent.click(create());
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("dialog", { name: "Review mappings" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(create()).toBeEnabled(); // the user can fix the rows and try again
  });

  it("a validation error list is shown as text too", async () => {
    await open(existing(11), { status: 422, body: { detail: [{ loc: ["body", "points", 0, "scale"], msg: "Input should be greater than 0" }] } });
    await userEvent.click(create());
    expect(await screen.findByRole("alert")).toHaveTextContent("points.0.scale: Input should be greater than 0");
  });

  it("Cancel closes without posting", async () => {
    const { calls, onClose } = await open(existing(11));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(posts(calls)).toHaveLength(0);
  });

  it("with no asset chosen the button stays disabled, with the reason, until one is picked", async () => {
    const { calls, onClose } = await open(existing(null));
    expect(screen.getByLabelText("Asset")).toHaveValue("");
    expect(create()).toBeDisabled();
    expect(screen.getByText(/Choose an asset/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "11");
    expect(create()).toBeEnabled();
    expect(screen.queryByText(/Choose an asset/)).not.toBeInTheDocument();
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts(calls)[0].body).toMatchObject({ asset_id: 11 });
  });

  it("with every row unchecked the button is disabled and says to check one", async () => {
    await open(existing(11));
    for (const name of ["LVP01 kW", "LVP01 kWh", "LVP01 V"]) await userEvent.click(box(name));
    expect(create()).toBeDisabled();
    expect(screen.getByText(/Check at least one point/)).toBeInTheDocument();
  });

  it("switching the asset recomputes the rows for the metrics that asset already has", async () => {
    await open(existing(11));
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "10");
    expect(box("LVP01 kW")).not.toBeChecked();
    expect(box("LVP01 kWh")).toBeChecked();
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "11");
    expect(box("LVP01 kW")).toBeChecked();
    expect(within(rowOf("LVP01 kW")).queryByText(/already/)).not.toBeInTheDocument();
  });

  it("a scale that is not above zero, or a fractional interval, disables the button until fixed", async () => {
    await open(existing(11));
    const scale = screen.getByLabelText("Scale for LVP01 kW");
    await userEvent.clear(scale);
    expect(create()).toBeDisabled();
    expect(screen.getByText(/scale above 0/i)).toBeInTheDocument();
    await userEvent.type(scale, "0");
    expect(create()).toBeDisabled();
    await userEvent.clear(scale);
    await userEvent.type(scale, "2");
    expect(create()).toBeEnabled();
    const interval = screen.getByLabelText("Interval for LVP01 kW");
    await userEvent.clear(interval);
    await userEvent.type(interval, "2.5");
    expect(create()).toBeDisabled();
    await userEvent.click(box("LVP01 kW")); // an unchecked row's numbers do not matter
    expect(create()).toBeEnabled();
  });

  it("several custom rows are fine together; the unit is kept, and dropped when the metric is changed away from custom", async () => {
    const { calls, onClose } = await open(existing(11), undefined, "TEMPS");
    expect(box("T a")).toBeChecked();
    expect(box("T b")).toBeChecked();
    await userEvent.selectOptions(screen.getByLabelText("Metric for T b"), "voltage_v");
    expect(screen.queryByLabelText("Unit for T b")).not.toBeInTheDocument(); // only custom rows have a unit field
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts(calls)[0].body).toMatchObject({
      points: [
        { point_id: 4, metric: "custom", custom_unit: "degC" },
        { point_id: 5, metric: "voltage_v", custom_unit: null },
      ],
    });
  });

  it("a custom row has a unit field prefilled from its suggestion; other rows have none", async () => {
    await open(existing(11), undefined, "TEMPS");
    expect(screen.getByLabelText("Unit for T a")).toHaveValue("degC");
    expect(screen.getByLabelText("Unit for T b")).toHaveValue("degC");
    cleanup();
    await open(existing(11));
    expect(screen.queryByLabelText(/^Unit for/)).not.toBeInTheDocument();
  });

  it("switching a row to custom prefills the unit from the point's hint; the edited unit is posted trimmed", async () => {
    const { calls, onClose } = await open(existing(11));
    await userEvent.selectOptions(screen.getByLabelText("Metric for LVP01 kWh"), "custom");
    const unit = screen.getByLabelText("Unit for LVP01 kWh");
    expect(unit).toHaveValue("kWh");
    await userEvent.clear(unit);
    await userEvent.type(unit, "  MWh ");
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts(calls)[0].body).toMatchObject({
      points: [
        { point_id: 1, metric: "active_power_kw", custom_unit: null },
        { point_id: 2, metric: "custom", custom_unit: "MWh" },
        { point_id: 3, metric: "voltage_v", custom_unit: null },
      ],
    });
  });

  it("a checked custom row without a unit keeps the button disabled and names the row; a unit or unchecking clears it", async () => {
    await open(existing(11));
    await userEvent.selectOptions(screen.getByLabelText("Metric for LVP01 kW"), "custom"); // this point has no unit hint
    const unit = screen.getByLabelText("Unit for LVP01 kW");
    expect(unit).toHaveValue("");
    expect(create()).toBeDisabled();
    expect(screen.getByText(/Enter a unit for each custom metric/)).toHaveTextContent("LVP01 kW");
    await userEvent.type(unit, "   ");
    expect(create()).toBeDisabled(); // spaces are not a unit
    await userEvent.type(unit, "bar");
    expect(create()).toBeEnabled();
    await userEvent.clear(unit);
    expect(create()).toBeDisabled();
    await userEvent.click(box("LVP01 kW")); // an unchecked row needs no unit
    expect(create()).toBeEnabled();
    expect(screen.queryByText(/Enter a unit/)).not.toBeInTheDocument();
  });

  it("moves focus into the dialog, closes on Escape without posting, and gives focus back", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    try {
      const { calls, onClose } = await open(existing(11));
      expect(screen.getByLabelText("Asset")).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(posts(calls)).toHaveLength(0);
    } finally {
      opener.remove();
    }
  });

  it("opened to choose an existing asset, focus starts on the Asset select", async () => {
    await open(existing(null));
    expect(screen.getByLabelText("Asset")).toHaveFocus();
  });

  it("opened to create a new asset, focus starts on the name input", async () => {
    await open({ kind: "new", name: "LVP01", parentId: null });
    expect(screen.getByLabelText("New asset name")).toHaveFocus();
  });

  it("restores focus to where it was when the dialog goes away", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    try {
      await open(existing(11));
      expect(opener).not.toHaveFocus();
      cleanup();
      expect(opener).toHaveFocus();
    } finally {
      opener.remove();
    }
  });

  it("keeps focus inside the dialog", async () => {
    const outside = document.createElement("button");
    document.body.append(outside);
    try {
      await open(existing(11));
      outside.focus();
      expect(screen.getByRole("dialog", { name: "Review mappings" })).toContainElement(document.activeElement as HTMLElement);
    } finally {
      outside.remove();
    }
  });

  it("is labelled as a modal dialog", async () => {
    const { dialog } = await open(existing(11));
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });
});

describe("ReviewDialog look (W6)", () => {
  it("puts Cancel before Create mappings, and Create mappings is the primary button", async () => {
    await open(existing(11));
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(create()).toHaveClass("primary");
    expect(cancel).not.toHaveClass("primary");
    expect(cancel.compareDocumentPosition(create()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(create().closest(".row")).toBe(cancel.closest(".row")); // the last row of the dialog (right-aligned by the CSS)
  });
});

describe("ReviewDialog tells the page what it made (W12a)", () => {
  it("after the accept it hands the page the sentence, each new mapping with the asset it is on and the point's name, and no new asset for an existing one", async () => {
    const { onMapped, onClose } = await open(existing(11));
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onMapped).toHaveBeenCalledTimes(1);
    expect(onMapped).toHaveBeenCalledWith({
      text: "Mapped 3 points to Panel 1.",
      mappings: [{ id: 1, assetId: 11, name: "LVP01 kW" }, { id: 2, assetId: 11, name: "LVP01 kWh" }, { id: 3, assetId: 11, name: "LVP01 V" }],
      newAssets: [],
    });
  });

  it("says 1 point, not 1 points, and names only the rows that were checked (the ids come back in that order)", async () => {
    const { onMapped, onClose } = await open(existing(11), { status: 201, body: { asset_id: 11, mapping_ids: [9] } });
    await userEvent.click(box("LVP01 kW"));
    await userEvent.click(box("LVP01 V"));
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onMapped).toHaveBeenCalledWith({ text: "Mapped 1 point to Panel 1.", mappings: [{ id: 9, assetId: 11, name: "LVP01 kWh" }], newAssets: [] });
  });

  it("a new asset is named in the sentence and in newAssets (the Undo then says it stays), under the id the server made", async () => {
    const { onMapped, onClose } = await open({ kind: "new", name: "  Room 7 ", parentId: null }, { status: 201, body: { asset_id: 31, mapping_ids: [4, 5, 6] } });
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onMapped).toHaveBeenCalledWith({
      text: "Mapped 3 points to Room 7.",
      mappings: [{ id: 4, assetId: 31, name: "LVP01 kW" }, { id: 5, assetId: 31, name: "LVP01 kWh" }, { id: 6, assetId: 31, name: "LVP01 V" }],
      newAssets: ["Room 7"],
    });
  });

  it("the toast comes after the accept and before the dialog closes, once; the dialog still reads the lists again", async () => {
    const order: string[] = [];
    const calls = mockFetch(routes());
    const onClose = vi.fn(() => { order.push("close"); });
    const onMapped = vi.fn(() => { order.push("mapped"); });
    renderWithProviders(<Harness initialTarget={existing(11)} onClose={onClose} onMapped={onMapped} />);
    await userEvent.click(await screen.findByRole("button", { name: "Create mappings" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(order).toEqual(["mapped", "close"]);
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && c.path === "/api/discovery/graph")).toHaveLength(2));
  });

  it("a refused accept tells the page nothing", async () => {
    const { onMapped } = await open(existing(11), { status: 409, body: { detail: "clash" } });
    await userEvent.click(create());
    expect(await screen.findByRole("alert")).toHaveTextContent("clash");
    expect(onMapped).not.toHaveBeenCalled();
  });
});

describe("ReviewDialog container note (W12a, A4)", () => {
  const ROOM = { id: 12, parent_id: 10, name: "Room 1", kind: "room" };
  const KINDS = [{ id: 1, name: "room", icon: "room", asset_count: 1, starter: true }, { id: 2, name: "panel", icon: "panel", asset_count: 1, starter: true }];
  const NOTE = "Room 1 is a room; meters usually belong to a Panel or Rack. Map here anyway?";
  async function openWithRoom(initialTarget: Initial, kinds: typeof KINDS | undefined = KINDS, accept?: object) {
    const calls = mockFetch({ ...routes(accept), "GET /api/discovery/graph": { body: { ...graph(), assets: [...graph().assets, ROOM] } } });
    const onClose = vi.fn();
    const onMapped = vi.fn();
    renderWithProviders(<Harness initialTarget={initialTarget} onClose={onClose} onMapped={onMapped} kinds={kinds} />);
    const dialog = await screen.findByRole("dialog", { name: "Review mappings" });
    return { calls, onClose, onMapped, dialog };
  }
  const slot = (dialog: HTMLElement) => dialog.querySelector(".mapmove-slot") as HTMLElement;

  it("choosing a room shows the note in the slot under the select, the select is described by it, and Create mappings stays enabled", async () => {
    const { dialog } = await openWithRoom(existing(null));
    const select = screen.getByLabelText("Asset");
    expect(slot(dialog)).toBeEmptyDOMElement();
    expect(select).not.toHaveAccessibleDescription();
    await userEvent.selectOptions(select, "12");
    expect(slot(dialog)).toHaveTextContent(NOTE);
    expect(select).toHaveAccessibleDescription(NOTE);
    expect(slot(dialog).closest(".field")).toContainElement(select); // under the select, in its own field
    expect(create()).toBeEnabled();
    expect(create()).not.toHaveAttribute("aria-disabled");
  });

  it("is not an announcer: no role on the slot or the note (the select's description is read when it is reached)", async () => {
    const { dialog } = await openWithRoom(existing(12));
    expect(slot(dialog)).toHaveTextContent(NOTE);
    expect(slot(dialog).querySelector("[role]")).toBeNull();
    expect(slot(dialog)).not.toHaveAttribute("role");
    expect(dialog.querySelectorAll('[role="status"], [role="alert"]')).toHaveLength(0);
  });

  it("the slot is always there in existing mode, with the same reserved height rule, so the note arriving moves nothing", async () => {
    const { dialog } = await openWithRoom(existing(11));
    expect(slot(dialog)).toBeInTheDocument();
    expect(slot(dialog)).toBeEmptyDOMElement();
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "12");
    expect(slot(dialog)).toHaveTextContent(NOTE);
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "11"); // a panel: the note goes, the slot stays
    expect(slot(dialog)).toBeInTheDocument();
    expect(slot(dialog)).toBeEmptyDOMElement();
  });

  it("a panel, an unchosen asset and a registry that has not loaded give no note; a new asset has no slot", async () => {
    const first = await openWithRoom(existing(11));
    expect(slot(first.dialog)).toBeEmptyDOMElement();
    cleanup();
    const second = await openWithRoom(existing(null));
    expect(slot(second.dialog)).toBeEmptyDOMElement();
    cleanup();
    const third = await openWithRoom({ kind: "new", name: "X", parentId: null });
    expect(slot(third.dialog)).toBeNull();
  });

  it("with no kinds list the keyword guess still finds a room (the same rule that draws the node)", async () => {
    const { dialog } = await openWithRoom(existing(12), undefined);
    expect(slot(dialog)).toHaveTextContent(NOTE);
  });

  it("the room can still be mapped to: the accept goes out and the page is told", async () => {
    const { calls, onMapped, onClose } = await openWithRoom(existing(12), KINDS, { status: 201, body: { asset_id: 12, mapping_ids: [1, 2, 3] } });
    await userEvent.click(create());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === "POST")[0].body).toMatchObject({ source_id: 1, asset_id: 12 });
    expect(onMapped).toHaveBeenCalledWith(expect.objectContaining({ text: "Mapped 3 points to Room 1." }));
  });
});

describe("ReviewDialog after a New asset (W12a, the continuation)", () => {
  const ROOM = { id: 12, parent_id: 10, name: "Room 1", kind: "room" };
  const KINDS = [{ id: 1, name: "room", icon: "room", asset_count: 1, starter: true }];
  const CREATED = "Cancel keeps it without any mappings.";
  const NOTE = "Room 1 is a room; meters usually belong to a Panel or Rack. Map here anyway?";
  async function openCreated(initialTarget: Initial, createdAsset: string | null = "Panel 9", kinds: typeof KINDS | undefined = KINDS) {
    mockFetch({ ...routes(), "GET /api/discovery/graph": { body: { ...graph(), assets: [...graph().assets, ROOM] } } });
    const onClose = vi.fn();
    renderWithProviders(<Harness initialTarget={initialTarget} onClose={onClose} createdAsset={createdAsset ?? undefined} kinds={kinds} />);
    const dialog = await screen.findByRole("dialog", { name: "Review mappings" });
    return { dialog, onClose, slot: dialog.querySelector(".mapmove-slot") as HTMLElement };
  }

  it("says in the reserved slot that the asset was made and that Cancel keeps it", async () => {
    const { slot } = await openCreated(existing(11));
    expect(slot).toHaveTextContent(`Panel 9 was created. ${CREATED}`);
    expect(slot.querySelector("p")).toHaveClass("muted");
    expect(slot.querySelector("[role]")).toBeNull(); // not an announcer
  });

  it("the Asset select is described by it, so the person who starts on the select hears it", async () => {
    await openCreated(existing(11));
    expect(screen.getByLabelText("Asset")).toHaveAccessibleDescription(`Panel 9 was created. ${CREATED}`);
  });

  it("with the container note too, the slot shows both, the created line first", async () => {
    const { slot } = await openCreated(existing(12));
    const lines = [...slot.querySelectorAll("p")].map((p) => p.textContent);
    expect(lines).toEqual([`Panel 9 was created. ${CREATED}`, NOTE]);
    expect(screen.getByLabelText("Asset")).toHaveAccessibleDescription(`Panel 9 was created. ${CREATED} ${NOTE}`);
  });

  it("choosing another asset keeps the line (the asset was still made); it is one line, not repeated", async () => {
    const { slot } = await openCreated(existing(11));
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "10");
    expect(slot.querySelectorAll("p")).toHaveLength(1);
    expect(slot).toHaveTextContent(`Panel 9 was created. ${CREATED}`);
  });

  it("a Review that does not follow a New asset has no such line", async () => {
    const { slot } = await openCreated(existing(11), null);
    expect(slot).toBeEmptyDOMElement();
    expect(screen.getByLabelText("Asset")).not.toHaveAccessibleDescription();
  });

  it("it lives in the existing reserved slot under the select, not in a new element", async () => {
    const { slot } = await openCreated(existing(11));
    expect(slot).toHaveClass("mapmove-slot");
    expect(slot.closest(".field")).toContainElement(screen.getByLabelText("Asset"));
  });
});
