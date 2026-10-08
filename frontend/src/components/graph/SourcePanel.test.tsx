import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useGraph } from "../../api/queries";
import type { GraphSource } from "../../api/types";
import { mockFetch } from "../../test/fetchMock";
import { renderWithProviders } from "../../test/render";
import { SourcePanel } from "./SourcePanel";

const source = (over: Partial<GraphSource> = {}): GraphSource => ({
  id: 5, name: "Plant OPC", connector_type: "opcua", config: { endpoint: "opc.tcp://plc:4840", username: "svc" },
  origin: "discovered", enabled: false, status: "unknown", last_error: null, has_secret: false, needs_credentials: false,
  point_count: 0, clusters: [], ungrouped: [], ...over,
});
const base = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role: "admin" } },
};
const job = { id: 9, kind: "browse_source", status: "done", result: { count: 60 }, created_at: "t", finished_at: "t" };
const graph = { sources: [], unidentified: [], assets: [], layout: {} };

/** Mounts a graph consumer next to the panel so a refetch of the graph shows up as a second GET. */
function GraphProbe() {
  useGraph();
  return null;
}
const open = (s: GraphSource, canEdit: boolean, onClose = () => {}) =>
  renderWithProviders(<><GraphProbe /><SourcePanel source={s} canEdit={canEdit} onClose={onClose} /></>, { route: "/discovery", path: "/discovery" });

describe("SourcePanel", () => {
  it("shows the source facts including the last error", async () => {
    mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
    open(source({ status: "error", point_count: 12, last_error: "connection refused" }), true);
    const panel = screen.getByRole("complementary", { name: "Source details" });
    expect(within(panel).getByRole("heading", { name: "Plant OPC" })).toBeInTheDocument();
    expect(within(panel).getByText(/opcua/)).toBeInTheDocument();
    expect(within(panel).getByText(/12 points/)).toBeInTheDocument();
    expect(within(panel).getByText(/connection refused/)).toBeInTheDocument();
  });

  it("moves focus to its heading when it opens", () => {
    mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
    open(source(), false);
    const heading = screen.getByRole("heading", { name: "Plant OPC" });
    expect(heading).toHaveAttribute("tabindex", "-1");
    expect(heading).toHaveFocus();
  });

  it("Escape closes the panel, and so does Close", async () => {
    mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
    const onClose = vi.fn();
    open(source(), false, onClose);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("a source that needs credentials takes a secret and username, saves them, browses and shows the result", async () => {
    const calls = mockFetch({
      ...base,
      "GET /api/discovery/graph": { body: graph },
      "GET /api/sources": { body: [] },
      "PATCH /api/sources/5": { body: {} },
      "POST /api/sources/5/browse": { status: 202, body: { job_id: 9 } },
      "GET /api/jobs/9": { body: job },
    });
    open(source({ needs_credentials: true, has_secret: true, last_error: "credentials rejected" }), true);
    expect(screen.getByText(/needs credentials/i)).toBeInTheDocument();
    const secret = screen.getByLabelText("Secret");
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveValue(""); // a stored secret is never shown or prefilled
    expect(screen.getByLabelText("Username")).toHaveValue("svc");
    await userEvent.type(secret, "s3cret");
    await userEvent.clear(screen.getByLabelText("Username"));
    await userEvent.type(screen.getByLabelText("Username"), "operator");
    await userEvent.click(screen.getByRole("button", { name: "Save and browse" }));
    expect(await screen.findByText("found 60 points")).toBeInTheDocument();
    const order = calls.filter((c) => c.path.startsWith("/api/sources/5")).map((c) => `${c.method} ${c.path}`);
    expect(order).toEqual(["PATCH /api/sources/5", "POST /api/sources/5/browse"]);
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({
      secret: "s3cret", config: { endpoint: "opc.tcp://plc:4840", username: "operator" },
    });
    expect(screen.getByLabelText("Secret")).toHaveValue(""); // cleared once sent
  });

  it("leaves config untouched when the username is not changed", async () => {
    const calls = mockFetch({
      ...base,
      "GET /api/discovery/graph": { body: graph },
      "PATCH /api/sources/5": { body: {} },
      "POST /api/sources/5/browse": { status: 202, body: { job_id: 9 } },
      "GET /api/jobs/9": { body: job },
    });
    const s = source({ needs_credentials: true });
    open(s, true);
    await userEvent.type(screen.getByLabelText("Secret"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Save and browse" }));
    await screen.findByText("found 60 points");
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ secret: "pw", config: s.config });
  });

  it("only opcua sources ask for a username", async () => {
    const calls = mockFetch({
      ...base,
      "GET /api/discovery/graph": { body: graph },
      "PATCH /api/sources/6": { body: {} },
      "POST /api/sources/6/browse": { status: 202, body: { job_id: 9 } },
      "GET /api/jobs/9": { body: job },
    });
    open(source({ id: 6, connector_type: "simulator", config: { host: "sim" }, needs_credentials: true }), true);
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Secret"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Save and browse" }));
    await screen.findByText("found 60 points");
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ secret: "pw", config: { host: "sim" } });
  });

  it("refreshes the graph and the sources once the browse job has finished", async () => {
    const calls = mockFetch({
      ...base,
      "GET /api/discovery/graph": { body: graph },
      "GET /api/sources": { body: [] },
      "PATCH /api/sources/5": { body: {} },
      "POST /api/sources/5/browse": { status: 202, body: { job_id: 9 } },
      "GET /api/jobs/9": { body: job },
    });
    const view = open(source({ needs_credentials: true }), true);
    const graphReads = () => calls.filter((c) => c.method === "GET" && c.path === "/api/discovery/graph").length;
    await waitFor(() => expect(graphReads()).toBe(1));
    await userEvent.type(screen.getByLabelText("Secret"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Save and browse" }));
    await screen.findByText("found 60 points");
    await waitFor(() => expect(graphReads()).toBe(2));
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/jobs/9").length).toBeGreaterThan(0);
    view.unmount();
  });

  it("shows a failed save instead of browsing", async () => {
    const calls = mockFetch({
      ...base,
      "GET /api/discovery/graph": { body: graph },
      "PATCH /api/sources/5": { status: 403, body: { detail: "admin only" } },
    });
    open(source({ needs_credentials: true }), true);
    await userEvent.type(screen.getByLabelText("Secret"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Save and browse" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("admin only");
    expect(calls.some((c) => c.path.endsWith("/browse"))).toBe(false);
  });

  it("a source that failed for another reason shows the error and no credentials hint", () => {
    mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
    open(source({ last_error: "connection refused", needs_credentials: false }), true);
    expect(screen.getByText(/connection refused/)).toBeInTheDocument();
    expect(screen.queryByText(/needs credentials/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Secret")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save and browse" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Browse again" })).toBeInTheDocument();
  });

  it("Browse again posts the browse without touching the source", async () => {
    const calls = mockFetch({
      ...base,
      "GET /api/discovery/graph": { body: graph },
      "POST /api/sources/5/browse": { status: 202, body: { job_id: 9 } },
      "GET /api/jobs/9": { body: job },
    });
    open(source(), true);
    await userEvent.click(screen.getByRole("button", { name: "Browse again" }));
    expect(await screen.findByText("found 60 points")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("without edit rights it shows facts but no way to change or browse the source", () => {
    const onClose = vi.fn();
    mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
    open(source({ needs_credentials: true, last_error: "credentials rejected" }), false, onClose);
    expect(screen.getByText(/needs credentials/i)).toBeInTheDocument();
    expect(screen.getByText(/credentials rejected/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Secret")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save and browse" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Browse again" })).not.toBeInTheDocument();
    // The only button left is the one that closes the panel.
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
  });

  it("Close calls onClose", async () => {
    const onClose = vi.fn();
    mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
    open(source(), false, onClose);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
