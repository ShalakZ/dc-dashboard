import { useQuery } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import { keys } from "../api/queries";
import type { Source } from "../api/types";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { SourceForm } from "./SourceForm";

const connectors = [
  { type: "simulator", config_schema: { type: "object", title: "SimulatorConfig", properties: {
    url: { type: "string", format: "uri", title: "Url", default: "http://simulator:9000" },
    timeout_seconds: { type: "number", title: "Timeout Seconds", default: 5.0 } } } },
  { type: "other", config_schema: { type: "object", required: ["host"], properties: {
    host: { type: "string", title: "Host" }, port: { type: "integer", title: "Port", default: 502 }, tls: { type: "boolean", title: "Tls", default: false } } } },
];
const auth = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "a", role: "admin" } }, "GET /api/connectors": { body: connectors } };
const sim: Source = {
  id: 2, name: "sim", connector_type: "simulator", config: { url: "http://sim:9000", timeout_seconds: 2.5 }, origin: "manual",
  enabled: true, status: "online", last_seen: null, last_error: null, has_secret: true,
};

/** One query per cache key an edit must refresh; it is fetched again only when the form invalidates its key. */
const PROBED = { sources: keys.sources, secretKey: keys.secretKey, graph: keys.graph } as const;
function Probe({ name }: { name: keyof typeof PROBED }) {
  useQuery({ queryKey: PROBED[name], queryFn: () => api.get(`/api/probe/${name}`), staleTime: Infinity });
  return null;
}
// The sources key holds the list of sources, which a save now updates in place before it invalidates: its probe answers a list.
const probeRoutes = Object.fromEntries(Object.keys(PROBED).map((name) => [`GET /api/probe/${name}`, { body: name === "sources" ? [] : {} }]));
const probeFetches = (calls: { path: string }[]) =>
  Object.fromEntries(Object.keys(PROBED).map((name) => [name, calls.filter((c) => c.path === `/api/probe/${name}`).length]));

const patchOf = (calls: { method: string; path: string; body: unknown }[]) => calls.find((c) => c.method === "PATCH");

describe("SourceForm, editing a source", () => {
  it("shows the stored name and config, and the connector as plain text that cannot be changed", async () => {
    mockFetch(auth);
    renderWithProviders(<SourceForm source={sim} onDone={() => {}} />);
    expect(await screen.findByLabelText("Url")).toHaveValue("http://sim:9000");
    expect(screen.getByLabelText("Name")).toHaveValue("sim");
    expect(screen.getByLabelText("Timeout Seconds")).toHaveValue(2.5);
    expect(screen.getByLabelText("Enabled")).toBeChecked();
    expect(screen.queryByLabelText("Connector")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("Connector: simulator")).toBeInTheDocument();
  });

  it("says the connectors are loading before they arrive", () => {
    mockFetch(auth);
    renderWithProviders(<SourceForm source={sim} onDone={() => {}} />);
    expect(screen.getByText("loading connectors…")).toBeInTheDocument();
  });

  it("shows the fields of the source's own connector, not the first one's", async () => {
    mockFetch(auth);
    const other: Source = { ...sim, connector_type: "other", config: { host: "10.0.0.1", port: 503, tls: true } };
    renderWithProviders(<SourceForm source={other} onDone={() => {}} />);
    expect(await screen.findByLabelText("Host")).toHaveValue("10.0.0.1");
    expect(screen.getByLabelText("Port")).toHaveValue(503);
    expect(screen.getByLabelText("Tls")).toBeChecked();
    expect(screen.queryByLabelText("Url")).not.toBeInTheDocument();
  });

  it("offers no Save for a connector type that is not registered, and says so", async () => {
    mockFetch(auth);
    renderWithProviders(<SourceForm source={{ ...sim, connector_type: "retired" }} onDone={() => {}} />);
    expect(await screen.findByText("This connector type is not available.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Name")).not.toBeInTheDocument();
  });

  it("sends the changed values to PATCH and no secret key when the Secret box is left blank", async () => {
    const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm source={sim} onDone={onDone} />);
    const name = await screen.findByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "renamed");
    await userEvent.click(screen.getByLabelText("Enabled"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const patch = patchOf(calls)!;
    expect(patch.path).toBe("/api/sources/2");
    expect(patch.body).toEqual({ name: "renamed", config: { url: "http://sim:9000", timeout_seconds: 2.5 }, enabled: false });
    expect(patch.body).not.toHaveProperty("secret");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sends the secret when one is typed", async () => {
    const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm source={sim} onDone={onDone} />);
    await userEvent.type(await screen.findByLabelText("Secret"), "new-key");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(patchOf(calls)!.body).toEqual({ name: "sim", config: { url: "http://sim:9000", timeout_seconds: 2.5 }, enabled: true, secret: "new-key" });
  });

  it("removes the stored secret only through the explicit checkbox, which disables the Secret box", async () => {
    const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm source={sim} onDone={onDone} />);
    await userEvent.type(await screen.findByLabelText("Secret"), "typed-then-dropped");
    await userEvent.click(screen.getByLabelText("Remove the stored secret"));
    expect(screen.getByLabelText("Secret")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(patchOf(calls)!.body).toEqual({ name: "sim", config: { url: "http://sim:9000", timeout_seconds: 2.5 }, enabled: true, secret: null });
  });

  it("keeps the label of the Secret box exactly `Secret`, with the hint outside it, and the box empty", async () => {
    mockFetch(auth);
    renderWithProviders(<SourceForm source={sim} onDone={() => {}} />);
    const box = await screen.findByLabelText("Secret");
    expect(box).toHaveValue("");
    expect(box.closest("label")).toHaveTextContent(/^Secret$/);
    expect(screen.getByText("A secret is stored; leave blank to keep it.")).toBeInTheDocument();
    expect(screen.getByText("A secret is stored; leave blank to keep it.").closest("label")).toBeNull();
  });

  it("has no remove checkbox and no hint when no secret is stored", async () => {
    mockFetch(auth);
    renderWithProviders(<SourceForm source={{ ...sim, has_secret: false }} onDone={() => {}} />);
    await screen.findByLabelText("Secret");
    expect(screen.queryByLabelText("Remove the stored secret")).not.toBeInTheDocument();
    expect(screen.queryByText(/A secret is stored/)).not.toBeInTheDocument();
  });

  it("leaves a cleared optional config field out of the body", async () => {
    const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm source={sim} onDone={onDone} />);
    await userEvent.clear(await screen.findByLabelText("Timeout Seconds"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const body = patchOf(calls)!.body as { config: Record<string, unknown> };
    expect(body.config).toEqual({ url: "http://sim:9000" });
    expect(body.config).not.toHaveProperty("timeout_seconds");
  });

  it("shows the API's error and stays open", async () => {
    mockFetch({ ...auth, "PATCH /api/sources/2": { status: 422, body: { detail: [{ loc: ["config", "url"], msg: "Input should be a valid URL", type: "url_parsing" }] } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm source={sim} onDone={onDone} />);
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("config.url: Input should be a valid URL");
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name")).toHaveValue("sim");
  });

  it("refreshes the sources, the secret-key status and the graph after a save", async () => {
    const calls = mockFetch({ ...auth, ...probeRoutes, "PATCH /api/sources/2": { body: { id: 2 } } });
    const onDone = vi.fn();
    renderWithProviders(<><SourceForm source={sim} onDone={onDone} /><Probe name="sources" /><Probe name="secretKey" /><Probe name="graph" /></>);
    await waitFor(() => expect(probeFetches(calls)).toEqual({ sources: 1, secretKey: 1, graph: 1 }));
    await userEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(probeFetches(calls)).toEqual({ sources: 2, secretKey: 2, graph: 2 }));
    expect(onDone).toHaveBeenCalled();
  });

  it("Cancel calls onDone and sends nothing", async () => {
    const calls = mockFetch(auth);
    const onDone = vi.fn();
    renderWithProviders(<SourceForm source={sim} onDone={onDone} />);
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onDone).toHaveBeenCalled();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
