import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useGraph } from "../../api/queries";
import type { GraphSource } from "../../api/types";
import { mockFetch } from "../../test/fetchMock";
import { renderWithProviders } from "../../test/render";
import { userFor } from "../../test/users";
import { SourcePanel } from "./SourcePanel";

const source = (over: Partial<GraphSource> = {}): GraphSource => ({
  id: 5, name: "Plant OPC", connector_type: "opcua", config: { endpoint: "opc.tcp://plc:4840", username: "svc" },
  origin: "discovered", enabled: false, status: "unknown", last_error: null, has_secret: false, needs_credentials: false,
  point_count: 0, clusters: [], ungrouped: [], ...over,
});
const base = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor("admin") },
};
const job = { id: 9, kind: "browse_source", status: "done", result: { count: 60 }, created_at: "t", finished_at: "t" };
const graph = { sources: [], unidentified: [], assets: [], layout: {} };

/** Mounts a graph consumer next to the panel so a refetch of the graph shows up as a second GET. */
function GraphProbe() {
  useGraph();
  return null;
}
const open = (s: GraphSource, canEdit: boolean, onClose = () => {}, seen = "Not seen in a scan yet") =>
  renderWithProviders(<><GraphProbe /><SourcePanel source={s} canEdit={canEdit} seen={seen} onClose={onClose} /></>, { route: "/discovery", path: "/discovery" });

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

  it("says when a scan last found the source, in the words the page gives it (W7r)", () => {
    mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
    open(source(), false, () => {}, "Seen in scan #6, 10 min ago");
    const panel = screen.getByRole("complementary", { name: "Source details" });
    expect(within(panel).getByText("Seen in scan #6, 10 min ago")).toHaveClass("muted");
  });

  // (w33) A source the newest scan of its range did not find: the whole sentence, what to do when something is mapped, and what its server said about itself (read-only).
  describe("a source that is not seen, and what its server said (w33)", () => {
    const miss = { scan_id: 7, at: "2026-10-15T11:00:00Z", last_seen_scan_id: 5, last_seen_at: "2026-10-11T09:00:00Z" };
    const LINE = "Not seen in scan #7 (last seen in #5, 4 days ago)";
    const identity = {
      application_uri: "urn:dcdash:simulator:dev", application_name: "DCDash simulator", product_uri: null, instance: null,
      thumbprint: "3A:5F:C1:0D:22:98:7B:44:E0:AB:12:34:56:78:9A:BC:DE:F0:11:91", usable: true, different: false,
    };
    const panel = () => screen.getByRole("complementary", { name: "Source details" });

    it("says the whole sentence: the line, then that a later scan of the same range did not find it", () => {
      mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
      open(source({ not_seen: miss }), false, () => {}, LINE);
      expect(within(panel()).getByText(`${LINE}. A later scan of the same range did not find it.`)).toHaveClass("muted");
    });

    it("a source with something mapped also says what to do, in a line of its own", () => {
      mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
      const mapped = { id: 1, address: "a1", name: "kW", unit_hint: null, mapping_id: 3, asset_id: 10, mapped_metric: "active_power_kw" as const, suggestion: { metric: "custom" as const, scale: 1, interval_seconds: 5, custom_unit: null } };
      open(source({ not_seen: miss, ungrouped: [mapped], status: "offline" }), false, () => {}, LINE);
      expect(within(panel()).getByText("Mapped: move it or delete it on Sources")).toHaveClass("muted");
    });

    it("a mapped source that is not seen but still polls fine has no such line: there is nothing to move or delete", () => {
      mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
      const mapped = { id: 1, address: "a1", name: "kW", unit_hint: null, mapping_id: 3, asset_id: 10, mapped_metric: "active_power_kw" as const, suggestion: { metric: "custom" as const, scale: 1, interval_seconds: 5, custom_unit: null } };
      open(source({ not_seen: miss, ungrouped: [mapped], status: "online" }), false, () => {}, LINE);
      expect(within(panel()).queryByText(/Mapped: move it/)).not.toBeInTheDocument();
      expect(within(panel()).getByText(`${LINE}. A later scan of the same range did not find it.`)).toBeInTheDocument();
    });

    it("an unmapped one has no such line, and a seen one keeps its sentence as it is", () => {
      mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
      open(source({ not_seen: miss }), false, () => {}, LINE);
      expect(within(panel()).queryByText(/Mapped: move it/)).not.toBeInTheDocument();
      expect(within(panel()).queryByText("Seen in scan #6, 10 min ago")).not.toBeInTheDocument();
    });

    it("shows the server and the certificate when the source has an identity: the URI, and the thumbprint cut short with the whole value in its title", () => {
      mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
      open(source({ identity }), false);
      expect(within(panel()).getByText("Server: urn:dcdash:simulator:dev")).toHaveClass("muted", "gsrc-fact");
      const cert = within(panel()).getByText("certificate 3A:5F:...:91");
      expect(cert).toHaveClass("muted", "gsrc-fact");
      expect(cert).toHaveAttribute("title", identity.thumbprint);
    });

    it("falls back to the instance id, then the application name, and has no certificate line without a thumbprint", () => {
      mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
      open(source({ identity: { ...identity, application_uri: null, instance: "dev", thumbprint: null } }), false);
      expect(within(panel()).getByText("Simulator instance dev")).toHaveClass("muted", "gsrc-fact");
      expect(within(panel()).queryByText(/^Server:/)).not.toBeInTheDocument();
      expect(within(panel()).queryByText(/^certificate/)).not.toBeInTheDocument();
    });

    it("shows nothing about a server when identity is null or absent, and no edit control for it (read-only)", () => {
      mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
      open(source({ identity: null }), true);
      expect(within(panel()).queryByText(/^Server:/)).not.toBeInTheDocument();
      expect(within(panel()).queryByText(/^certificate/)).not.toBeInTheDocument();
    });
  });

  // (w33) A new source that looks like an old one that stopped answering, two such old ones, and another server answering at the address.
  describe("a move offer, two candidates and a different server (w33)", () => {
    const OLD = "OPC UA server at 172.20.0.3:4840";
    const offer = {
      kind: "offer" as const, from_source_id: 2, from_name: OLD, from_endpoint: "opc.tcp://172.20.0.3:4840/dcdash/", from_since: "2026-10-18T04:52:51Z", mappings: 12, assets: 3,
      match: { kind: "same_server" as const, evidence: "uri" as const, value: "urn:dcdash:simulator:dev", addresses: 12, missing_addresses: 0, needs_tick: false },
    };
    // the name holds the address, so without a time the sentence does not say it twice
    const SENTENCE = `This looks like ${OLD} (12 mappings on 3 assets)`;
    const different = { application_uri: null, application_name: null, product_uri: null, thumbprint: null, instance: null, usable: true, different: true };
    const panel = () => screen.getByRole("complementary", { name: "Source details" });
    const show = (s: GraphSource, canEdit: boolean, onMoveSource?: () => void, looks?: string) => {
      mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
      return renderWithProviders(
        <><GraphProbe /><SourcePanel source={s} canEdit={canEdit} seen="Seen in scan #8, 2 min ago" looks={looks} onMoveSource={onMoveSource} onClose={() => {}} /></>,
        { route: "/discovery", path: "/discovery" },
      );
    };

    it("says the whole sentence of an offer, with the old address and the mappings, and has a Move... button that calls the page", async () => {
      const onMoveSource = vi.fn();
      show(source({ move_candidate: offer }), true, onMoveSource);
      expect(within(panel()).getByText(SENTENCE)).toHaveClass("muted", "gsrc-fact");
      const button = within(panel()).getByRole("button", { name: `Move ${OLD} to this address...` });
      expect(button).toHaveTextContent("Move...");
      expect(button).toHaveAttribute("type", "button");
      await userEvent.click(button);
      expect(onMoveSource).toHaveBeenCalledTimes(1);
    });

    it("without sources.edit the sentence stays and there is no Move... button", () => {
      show(source({ move_candidate: offer }), false, vi.fn());
      expect(within(panel()).getByText(SENTENCE)).toBeInTheDocument();
      expect(within(panel()).queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
    });

    it("without the page's callback there is no button either, even for a person who may edit", () => {
      show(source({ move_candidate: offer }), true);
      expect(within(panel()).getByText(SENTENCE)).toBeInTheDocument();
      expect(within(panel()).queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
    });

    it("says the mapping and asset counts in the singular", () => {
      show(source({ move_candidate: { ...offer, mappings: 1, assets: 1 } }), true, vi.fn());
      expect(within(panel()).getByText(`This looks like ${OLD} (1 mapping on 1 asset)`)).toBeInTheDocument();
    });

    it("shows the page's sentence when it gives one (the time it stopped answering, written in the site's zone), and says nothing twice", () => {
      const looks = `${SENTENCE}, which has not answered since 18 Oct 07:52`;
      show(source({ move_candidate: offer }), true, vi.fn(), looks);
      expect(within(panel()).getByText(looks)).toHaveClass("muted", "gsrc-fact");
      expect(within(panel()).queryByText(SENTENCE)).not.toBeInTheDocument();
    });

    it("a name that is not the address (one somebody typed) says where it stopped answering when there is no time", () => {
      show(source({ move_candidate: { ...offer, from_name: "Meter room 2" } }), true, vi.fn());
      expect(within(panel()).getByText("This looks like Meter room 2 (12 mappings on 3 assets), which stopped answering at 172.20.0.3:4840")).toBeInTheDocument();
    });

    it("two candidates: the sentence, and no button for anyone; more than two say Several", () => {
      show(source({ move_candidate: { kind: "two", count: 3 } }), true, vi.fn());
      expect(within(panel()).getByText("Several servers could be this one; edit the address by hand")).toHaveClass("muted", "gsrc-fact");
      cleanup();
      show(source({ move_candidate: { kind: "two", count: 2 } }), true, vi.fn());
      expect(within(panel()).getByText("Two servers could be this one; edit the address by hand")).toHaveClass("muted", "gsrc-fact");
      expect(within(panel()).queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
      expect(within(panel()).queryByText(/This looks like/)).not.toBeInTheDocument();
    });

    it("a different server: the warning in the warning ink (not muted), for a source added by hand too", () => {
      show(source({ identity: different }), false);
      expect(within(panel()).getByText("A different server answers at this address")).toHaveClass("warning", "gsrc-fact");
      expect(within(panel()).getByText("A different server answers at this address")).not.toHaveClass("muted");
      cleanup();
      show(source({ origin: "manual", identity: different }), false);
      expect(within(panel()).getByText("A different server answers at this address")).toBeInTheDocument();
    });

    it("says none of it for a source with no candidate and an identity that is the same server", () => {
      show(source({ move_candidate: null, identity: { ...different, different: false } }), true, vi.fn());
      expect(within(panel()).queryByText(/This looks like|Two servers|different server/)).not.toBeInTheDocument();
      expect(within(panel()).queryByRole("button", { name: /^Move / })).not.toBeInTheDocument();
    });

    it("a name hint is left to the move dialog: the panel says nothing about it", () => {
      show(source({ name_hint: "simulator" }), true, vi.fn());
      expect(within(panel()).queryByText(/container|Docker|simulator/)).not.toBeInTheDocument();
    });
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
      expect_config: { endpoint: "opc.tcp://plc:4840", username: "svc" }, // the config the panel was opened with, not what was typed
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
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ secret: "pw", config: s.config, expect_config: s.config });
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
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ secret: "pw", config: { host: "sim" }, expect_config: { host: "sim" } });
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

  it("a panel opened before the source was moved shows the server's 409 sentence in its error line and browses nothing (w33)", async () => {
    const sentence = "This source was changed since you opened it (for example it was moved to a new address). Close the form and open it again.";
    const calls = mockFetch({
      ...base,
      "GET /api/discovery/graph": { body: graph },
      "PATCH /api/sources/5": { status: 409, body: { detail: sentence } },
    });
    open(source({ needs_credentials: true }), true);
    await userEvent.type(screen.getByLabelText("Secret"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Save and browse" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(sentence);
    expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({ expect_config: { endpoint: "opc.tcp://plc:4840", username: "svc" } });
    expect(calls.some((c) => c.path.endsWith("/browse"))).toBe(false);
    expect(screen.getByLabelText("Secret")).toHaveValue("pw"); // nothing was saved, so what was typed stays
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

describe("SourcePanel look (W6)", () => {
  it("Close is a quiet button and Save and browse the primary one", () => {
    mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
    open(source({ needs_credentials: true }), true);
    expect(screen.getByRole("button", { name: "Close" })).toHaveClass("quiet");
    expect(screen.getByRole("button", { name: "Save and browse" })).toHaveClass("primary");
  });
});

// (w36) A large source (the server sent `large`) is described by it: 15,000 points, 800 mapped. The panel links to Map by shape for a person who may open that page (the page decides, as with Move...),
// and to the Points page only for one who may open that one: a link takes its target page's whole need.
describe("SourcePanel for a large source (w36)", () => {
  const large = { points: 15000, mapped: 800, unmapped: 14000, rules_new: 0 };
  const big = (over: Partial<GraphSource> = {}) => source({ point_count: 15000, large, ...over });
  const panel = () => screen.getByRole("complementary", { name: "Source details" });
  const render = (s: GraphSource, props: { canShapes?: boolean; canPoints?: boolean } = {}) => {
    mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
    return renderWithProviders(<SourcePanel source={s} canEdit={false} seen="Seen" onClose={() => {}} {...props} />, { route: "/discovery", path: "/discovery" });
  };

  it("says `15,000 points, 800 mapped` in place of the bare count", () => {
    render(big());
    expect(within(panel()).getByText("opcua · discovered · unknown · 15,000 points, 800 mapped")).toHaveClass("muted");
  });

  it("a source without `large` keeps its line, whatever its point_count", () => {
    render(source({ point_count: 12 }), { canShapes: true, canPoints: true });
    expect(within(panel()).getByText("opcua · discovered · unknown · 12 points")).toBeInTheDocument();
    expect(within(panel()).queryByRole("link", { name: "Map by shape" })).not.toBeInTheDocument();
    expect(within(panel()).queryByRole("link", { name: "Open the Points page" })).not.toBeInTheDocument();
  });

  it("Map by shape is a link to the source's page for a person who meets PAGE_NEED.sourceShapes, and absent otherwise", () => {
    const view = render(big(), { canShapes: true });
    expect(within(panel()).getByRole("link", { name: "Map by shape" })).toHaveAttribute("href", "/sources/5/shapes");
    view.unmount();
    render(big());
    expect(within(panel()).queryByRole("link", { name: "Map by shape" })).not.toBeInTheDocument();
  });

  it("the Points page link needs its own permission (sources.edit), whatever the shapes link needs", () => {
    const view = render(big(), { canShapes: true, canPoints: true });
    expect(within(panel()).getByRole("link", { name: "Open the Points page" })).toHaveAttribute("href", "/sources/5/points");
    view.unmount();
    render(big(), { canShapes: true, canPoints: false });
    expect(within(panel()).getByRole("link", { name: "Map by shape" })).toBeInTheDocument();
    expect(within(panel()).queryByRole("link", { name: "Open the Points page" })).not.toBeInTheDocument();
  });

  it("the two links stand in one row, in this order, and Tab reaches them right after Close", async () => {
    render(big(), { canShapes: true, canPoints: true });
    const shapes = within(panel()).getByRole("link", { name: "Map by shape" });
    expect(shapes.parentElement).toHaveClass("row");
    expect(shapes.parentElement).toContainElement(within(panel()).getByRole("link", { name: "Open the Points page" }));
    expect(Array.from(shapes.parentElement!.querySelectorAll("a")).map((a) => a.textContent)).toEqual(["Map by shape", "Open the Points page"]);
    await userEvent.tab(); // the heading has the focus first (tabIndex -1): Close, then the links
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await userEvent.tab();
    expect(shapes).toHaveFocus();
    await userEvent.tab();
    expect(within(panel()).getByRole("link", { name: "Open the Points page" })).toHaveFocus();
  });
});

// (w36 T7b) New tags that match the owner's saved rules: the panel has room for the whole sentence, as a link to the shapes page opened to review them.
describe("SourcePanel for a large source with new tags that match saved rules (w36)", () => {
  const big = (rules_new: number) => source({ point_count: 15000, large: { points: 15000, mapped: 800, unmapped: 14000, rules_new } });
  const panel = () => screen.getByRole("complementary", { name: "Source details" });
  const render = (s: GraphSource, props: { canShapes?: boolean; canPoints?: boolean } = {}) => {
    mockFetch({ ...base, "GET /api/discovery/graph": { body: graph } });
    return renderWithProviders(<SourcePanel source={s} canEdit={false} seen="Seen" onClose={() => {}} {...props} />, { route: "/discovery", path: "/discovery" });
  };

  it("says `12 new tags match your rules: review` as one link to /sources/<id>/shapes?rules=1", () => {
    render(big(12), { canShapes: true });
    expect(within(panel()).getByRole("link", { name: "12 new tags match your rules: review" })).toHaveAttribute("href", "/sources/5/shapes?rules=1");
    expect(within(panel()).getByRole("link", { name: "Map by shape" })).toHaveAttribute("href", "/sources/5/shapes"); // the plain link stays
  });

  it("uses thousands separators and the singular", () => {
    const view = render(big(1234), { canShapes: true });
    expect(within(panel()).getByRole("link", { name: "1,234 new tags match your rules: review" })).toBeInTheDocument();
    view.unmount();
    render(big(1), { canShapes: true });
    expect(within(panel()).getByRole("link", { name: "1 new tag matches your rules: review" })).toBeInTheDocument();
  });

  it("is not there without new matches, and not for a person who may not open the shapes page (a link takes its target's whole need)", () => {
    const view = render(big(0), { canShapes: true });
    expect(within(panel()).queryByText(/match your rules/)).not.toBeInTheDocument();
    view.unmount();
    render(big(12), { canShapes: false, canPoints: true });
    expect(within(panel()).queryByText(/match your rules/)).not.toBeInTheDocument();
  });

  it("a source without `large` never says it", () => {
    render(source({ point_count: 12 }), { canShapes: true });
    expect(within(panel()).queryByText(/match your rules/)).not.toBeInTheDocument();
  });
});
