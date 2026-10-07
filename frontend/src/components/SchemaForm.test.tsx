import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

describe("SourceForm", () => {
  it("submits typed config and secret separately", async () => {
    const calls = mockFetch({ ...auth, "POST /api/sources": { status: 201, body: { id: 3 } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm onDone={onDone} />);
    await userEvent.type(await screen.findByLabelText("Name"), "sim");
    expect(screen.getByLabelText("Url")).toHaveValue("http://simulator:9000");
    await userEvent.clear(screen.getByLabelText("Timeout Seconds"));
    await userEvent.type(screen.getByLabelText("Timeout Seconds"), "2.5");
    await userEvent.type(screen.getByLabelText("Secret"), "sim-key");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "sim", connector_type: "simulator", config: { url: "http://simulator:9000", timeout_seconds: 2.5 }, secret: "sim-key", enabled: true,
    });
    expect(onDone).toHaveBeenCalled();
  });

  it("switches fields with the connector type and renders checkbox and integer inputs", async () => {
    mockFetch(auth);
    renderWithProviders(<SourceForm onDone={() => {}} />);
    await userEvent.selectOptions(await screen.findByLabelText("Connector"), "other");
    expect(screen.getByLabelText("Host")).toBeRequired();
    expect(screen.getByLabelText("Port")).toHaveAttribute("step", "1");
    expect(screen.getByLabelText("Tls")).not.toBeChecked();
  });

  it("shows a pydantic validation error from the API", async () => {
    mockFetch({ ...auth, "POST /api/sources": { status: 422, body: { detail: [{ loc: ["config", "url"], msg: "Input should be a valid URL", type: "url_parsing" }] } } });
    renderWithProviders(<SourceForm onDone={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Name"), "sim");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("config.url: Input should be a valid URL");
  });
});
