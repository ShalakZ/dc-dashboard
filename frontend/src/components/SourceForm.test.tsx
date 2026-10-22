import { useQuery } from "@tanstack/react-query";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { api } from "../api/client";
import { keys } from "../api/queries";
import type { Source } from "../api/types";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { SourceForm } from "./SourceForm";

const connectors = [
  { type: "simulator", config_schema: { type: "object", title: "SimulatorConfig", properties: {
    url: { type: "string", format: "uri", title: "Url", default: "http://simulator:9000" },
    timeout_seconds: { type: "number", title: "Timeout Seconds", default: 5.0 } } } },
  { type: "other", config_schema: { type: "object", required: ["host"], properties: {
    host: { type: "string", title: "Host" }, port: { type: "integer", title: "Port", default: 502 }, tls: { type: "boolean", title: "Tls", default: false } } } },
];
const auth = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: userFor("admin", { username: "a" }) }, "GET /api/connectors": { body: connectors } };
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

describe("SourceForm, adding a source", () => {
  it("raises one toast after the POST succeeded, then closes", async () => {
    const calls = mockFetch({ ...auth, "POST /api/sources": { status: 201, body: { id: 3 } } });
    const onDone = vi.fn();
    const toasts = spyToasts();
    renderWithProviders(<SourceForm onDone={onDone} />, { toasts: toasts.api });
    await userEvent.type(await screen.findByLabelText("Name"), "new one");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/sources"]);
    expect(toasts.calls).toEqual([{ kind: "success", text: "Source added" }]);
  });

  it("raises none when the POST is refused: the error line is the feedback and the form stays open", async () => {
    mockFetch({ ...auth, "POST /api/sources": { status: 422, body: { detail: "name already in use" } } });
    const onDone = vi.fn();
    const toasts = spyToasts();
    renderWithProviders(<SourceForm onDone={onDone} />, { toasts: toasts.api });
    await userEvent.type(await screen.findByLabelText("Name"), "sim");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(toasts.calls).toEqual([]);
  });
});

describe("SourceForm, the connector that is filled by files (w31)", () => {
  const FILE_SENTENCE = "Readings are loaded from CSV files; nothing is polled.";
  // As GET /api/connectors answers: the types that poll first, the one that does not last, each with `polls` and `description`.
  const withFile = [
    { ...connectors[0], polls: true, description: "" },
    { ...connectors[1], polls: true, description: "" },
    { type: "file", config_schema: { type: "object", title: "FileConfig", properties: {} }, polls: false, description: FILE_SENTENCE },
  ];
  const authWithFile = { ...auth, "GET /api/connectors": { body: withFile } };

  it("starts on the first type the server lists (one that polls), lists the file type last, and shows no description for a type without one", async () => {
    mockFetch(authWithFile);
    renderWithProviders(<SourceForm onDone={() => {}} />);
    const select = await screen.findByLabelText("Connector");
    expect(select).toHaveValue("simulator");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["simulator", "other", "file"]);
    expect(screen.queryByText(FILE_SENTENCE)).not.toBeInTheDocument();
    expect(select).not.toHaveAttribute("aria-describedby");
  });

  it("shows the description under the select when the type has one, tied to the select, and takes it away for another type", async () => {
    mockFetch(authWithFile);
    renderWithProviders(<SourceForm onDone={() => {}} />);
    const select = await screen.findByLabelText("Connector");
    await userEvent.selectOptions(select, "file");
    const note = screen.getByText(FILE_SENTENCE);
    expect(select).toHaveAccessibleDescription(FILE_SENTENCE);
    expect(note.closest("label")).toBeNull(); // outside the label: the select's name stays exactly "Connector"
    await userEvent.selectOptions(select, "other");
    expect(screen.queryByText(FILE_SENTENCE)).not.toBeInTheDocument();
  });

  it("has no config field for a file source, and saves it with an empty config", async () => {
    const calls = mockFetch({ ...authWithFile, "POST /api/sources": { status: 201, body: { id: 5 } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm onDone={onDone} />, { toasts: spyToasts().api });
    await userEvent.selectOptions(await screen.findByLabelText("Connector"), "file");
    expect(screen.queryByLabelText("Url")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Host")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Name"), "from files");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/sources")?.body).toEqual({
      name: "from files", connector_type: "file", config: {}, secret: null, enabled: true,
    });
  });

  it("offers no Secret for a type that does not poll (a file has nothing to authenticate), and brings it back for the others", async () => {
    mockFetch(authWithFile);
    renderWithProviders(<SourceForm onDone={() => {}} />);
    const select = await screen.findByLabelText("Connector");
    expect(screen.getByLabelText("Secret")).toBeInTheDocument(); // the form starts on a type that polls
    await userEvent.selectOptions(select, "file");
    expect(screen.queryByLabelText("Secret")).not.toBeInTheDocument();
    expect(document.querySelector("input[type=password]")).toBeNull();
    expect(screen.getByLabelText("Enabled")).toBeInTheDocument(); // the rest of the form is still there
    await userEvent.selectOptions(select, "other");
    expect(screen.getByLabelText("Secret")).toBeInTheDocument();
  });

  it("does not carry a secret typed for the type chosen before into a file source", async () => {
    const calls = mockFetch({ ...authWithFile, "POST /api/sources": { status: 201, body: { id: 5 } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm onDone={onDone} />, { toasts: spyToasts().api });
    const select = await screen.findByLabelText("Connector");
    await userEvent.type(screen.getByLabelText("Secret"), "typed-before");
    await userEvent.selectOptions(select, "file");
    await userEvent.type(screen.getByLabelText("Name"), "from files");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(calls.find((c) => c.method === "POST" && c.path === "/api/sources")?.body).toMatchObject({ connector_type: "file", secret: null });
  });

  it("copes with an answer that has no description or polls at all (an older server): the Secret stays", async () => {
    mockFetch(auth); // `connectors` above carries neither field
    renderWithProviders(<SourceForm onDone={() => {}} />);
    expect(await screen.findByLabelText("Connector")).toHaveValue("simulator");
    expect(document.querySelector("small.muted")).toBeNull();
    expect(screen.getByLabelText("Secret")).toBeInTheDocument();
  });

  it("edits a file source without a Secret, and sends no secret key (the stored state is kept)", async () => {
    const calls = mockFetch({ ...authWithFile, "PATCH /api/sources/6": { body: { id: 6 } } });
    const onDone = vi.fn();
    const fileSource: Source = { ...sim, id: 6, name: "from files", connector_type: "file", config: {}, has_secret: false };
    renderWithProviders(<SourceForm source={fileSource} onDone={onDone} />);
    expect(await screen.findByText("Connector: file")).toBeInTheDocument();
    expect(screen.queryByLabelText("Secret")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(patchOf(calls)?.body).not.toHaveProperty("secret");
  });
});

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
    const toasts = spyToasts();
    renderWithProviders(<SourceForm source={sim} onDone={onDone} />, { toasts: toasts.api });
    const name = await screen.findByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "renamed");
    await userEvent.click(screen.getByLabelText("Enabled"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(toasts.calls).toEqual([]); // an edit closes its dialog: that is its confirmation
    const patch = patchOf(calls)!;
    expect(patch.path).toBe("/api/sources/2");
    expect(patch.body).toEqual({ name: "renamed", enabled: false }); // no config field was edited: the stored config is not sent back
    expect(patch.body).not.toHaveProperty("secret");
    expect(patch.body).not.toHaveProperty("config");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sends no config for a rename alone, so a form opened before a move cannot put the old address back", async () => {
    const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm source={sim} onDone={onDone} />);
    const name = await screen.findByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(patchOf(calls)!.body).toEqual({ name: "renamed", enabled: true });
    expect(patchOf(calls)!.body).not.toHaveProperty("config");
    expect(patchOf(calls)!.body).not.toHaveProperty("clear_config_credentials");
  });

  it("sends no config when the endpoint is edited and then typed back to what it was", async () => {
    const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm source={sim} onDone={onDone} />);
    const url = await screen.findByLabelText("Url");
    await userEvent.clear(url);
    await userEvent.type(url, "http://other:9000");
    await userEvent.clear(url);
    await userEvent.type(url, "http://sim:9000");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(patchOf(calls)!.body).not.toHaveProperty("config");
  });

  it("sends the whole config when the endpoint is edited", async () => {
    const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm source={sim} onDone={onDone} />);
    const url = await screen.findByLabelText("Url");
    await userEvent.clear(url);
    await userEvent.type(url, "http://moved:9000");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(patchOf(calls)!.body).toEqual({ name: "sim", config: { url: "http://moved:9000", timeout_seconds: 2.5 }, enabled: true });
  });

  it("sends the secret when one is typed", async () => {
    const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm source={sim} onDone={onDone} />);
    await userEvent.type(await screen.findByLabelText("Secret"), "new-key");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(patchOf(calls)!.body).toEqual({ name: "sim", enabled: true, secret: "new-key" });
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
    expect(patchOf(calls)!.body).toEqual({ name: "sim", enabled: true, secret: null });
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

  describe("credentials hidden in the stored address", () => {
    const hiddenSim: Source = { ...sim, config: { url: "http://sim:9000", timeout_seconds: 2.5 }, hidden_config_keys: ["url"] };
    const note = "The user name and password stored in Url are hidden. They are kept while you leave the address as it is; "
      + "a different address replaces them, so type them into the address if it needs them.";

    it("says which field hides credentials, offers to remove them, and shows the masked value in the field", async () => {
      mockFetch(auth);
      renderWithProviders(<SourceForm source={hiddenSim} onDone={() => {}} />);
      expect(await screen.findByLabelText("Url")).toHaveValue("http://sim:9000");
      expect(screen.getByText(note)).toBeInTheDocument();
      expect(screen.getByLabelText("Remove the credentials stored in Url")).not.toBeChecked();
    });

    it("sends clear_config_credentials with the key once the checkbox is ticked", async () => {
      const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
      const onDone = vi.fn();
      renderWithProviders(<SourceForm source={hiddenSim} onDone={onDone} />);
      await userEvent.click(await screen.findByLabelText("Remove the credentials stored in Url"));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(patchOf(calls)!.body).toEqual({
        name: "sim", config: { url: "http://sim:9000", timeout_seconds: 2.5 }, enabled: true, clear_config_credentials: ["url"],
      });
    });

    it("sends no clear_config_credentials key when the checkbox is left alone, or ticked and unticked again", async () => {
      const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
      const onDone = vi.fn();
      renderWithProviders(<SourceForm source={hiddenSim} onDone={onDone} />);
      const box = await screen.findByLabelText("Remove the credentials stored in Url");
      await userEvent.click(box);
      await userEvent.click(box);
      expect(box).not.toBeChecked();
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(patchOf(calls)!.body).not.toHaveProperty("clear_config_credentials");
    });

    it("sends no config at all when the masked address and the other fields are left alone: the stored credentials stay where they are", async () => {
      const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
      const onDone = vi.fn();
      renderWithProviders(<SourceForm source={hiddenSim} onDone={onDone} />);
      await userEvent.click(await screen.findByRole("button", { name: "Save" }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(patchOf(calls)!.body).toEqual({ name: "sim", enabled: true });
    });

    it("sends the masked address back as it is, so the API can tell it is unchanged, when another field is edited", async () => {
      const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
      const onDone = vi.fn();
      renderWithProviders(<SourceForm source={hiddenSim} onDone={onDone} />);
      const timeout = await screen.findByLabelText("Timeout Seconds");
      await userEvent.clear(timeout);
      await userEvent.type(timeout, "7");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect((patchOf(calls)!.body as { config: unknown }).config).toEqual({ url: "http://sim:9000", timeout_seconds: 7 });
      expect(patchOf(calls)!.body).not.toHaveProperty("clear_config_credentials");
    });

    it("sends a changed credential-bearing address with the keys to clear, when both are chosen", async () => {
      const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
      const onDone = vi.fn();
      renderWithProviders(<SourceForm source={hiddenSim} onDone={onDone} />);
      const url = await screen.findByLabelText("Url");
      await userEvent.clear(url);
      await userEvent.type(url, "http://user:word@elsewhere:9000");
      await userEvent.click(screen.getByLabelText("Remove the credentials stored in Url"));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(patchOf(calls)!.body).toEqual({
        name: "sim", config: { url: "http://user:word@elsewhere:9000", timeout_seconds: 2.5 }, enabled: true, clear_config_credentials: ["url"],
      });
    });

    it("sends every schema key with the masked address byte-identical when another field is edited", async () => {
      // The API keeps the stored credentials only when the submitted value EQUALS the masked one it showed: a trimmed
      // value, a dropped trailing slash or a left-out key would silently replace them.
      const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
      const onDone = vi.fn();
      const slashed: Source = { ...sim, config: { url: "http://simulator:9000/", timeout_seconds: 5 }, hidden_config_keys: ["url"] };
      renderWithProviders(<SourceForm source={slashed} onDone={onDone} />);
      const timeout = await screen.findByLabelText("Timeout Seconds");
      await userEvent.clear(timeout);
      await userEvent.type(timeout, "8");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      const { config } = patchOf(calls)!.body as { config: Record<string, unknown> };
      expect(Object.keys(config).sort()).toEqual(["timeout_seconds", "url"]);
      expect(config.url).toBe("http://simulator:9000/");
      expect(config).toEqual({ url: "http://simulator:9000/", timeout_seconds: 8 });
    });

    it("sends a false flag and every other key of the stored config too, on a connector with three fields", async () => {
      const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
      const onDone = vi.fn();
      const plc: Source = { ...sim, connector_type: "other", config: { host: "opc.tcp://plc:4840/x", port: 502, tls: false }, hidden_config_keys: ["host"] };
      renderWithProviders(<SourceForm source={plc} onDone={onDone} />);
      const port = await screen.findByLabelText("Port");
      await userEvent.clear(port);
      await userEvent.type(port, "503");
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect((patchOf(calls)!.body as { config: unknown }).config).toEqual({ host: "opc.tcp://plc:4840/x", port: 503, tls: false });
    });

    it("sends no config when only a flag of a three-field connector is left as it was", async () => {
      const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
      const onDone = vi.fn();
      const plc: Source = { ...sim, connector_type: "other", config: { host: "opc.tcp://plc:4840/x", port: 502, tls: false }, hidden_config_keys: ["host"] };
      renderWithProviders(<SourceForm source={plc} onDone={onDone} />);
      const tls = await screen.findByLabelText("Tls");
      await userEvent.click(tls);
      await userEvent.click(tls);
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(patchOf(calls)!.body).not.toHaveProperty("config");
    });

    it("shows neither the note nor the checkbox for a source with no hidden keys, or an empty list", async () => {
      mockFetch(auth);
      const { unmount } = renderWithProviders(<SourceForm source={sim} onDone={() => {}} />);
      await screen.findByLabelText("Url");
      expect(screen.queryByText(/are hidden/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Remove the credentials/)).not.toBeInTheDocument();
      unmount();
      renderWithProviders(<SourceForm source={{ ...sim, hidden_config_keys: [] }} onDone={() => {}} />);
      await screen.findByLabelText("Url");
      expect(screen.queryByText(/are hidden/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Remove the credentials/)).not.toBeInTheDocument();
    });

    it("shows neither when adding a source", async () => {
      mockFetch(auth);
      renderWithProviders(<SourceForm onDone={() => {}} />);
      await screen.findByLabelText("Url");
      expect(screen.queryByText(/are hidden/)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Remove the credentials/)).not.toBeInTheDocument();
    });

    it("names a hidden key that is not in the connector's schema by the key itself, and sends every ticked key", async () => {
      const calls = mockFetch({ ...auth, "PATCH /api/sources/2": { body: { id: 2 } } });
      const onDone = vi.fn();
      renderWithProviders(<SourceForm source={{ ...sim, hidden_config_keys: ["url", "proxy"] }} onDone={onDone} />);
      expect(await screen.findByText(/stored in proxy are hidden/)).toBeInTheDocument();
      await userEvent.click(screen.getByLabelText("Remove the credentials stored in proxy"));
      await userEvent.click(screen.getByLabelText("Remove the credentials stored in Url"));
      await userEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect((patchOf(calls)!.body as { clear_config_credentials: string[] }).clear_config_credentials).toEqual(["url", "proxy"]);
    });
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
