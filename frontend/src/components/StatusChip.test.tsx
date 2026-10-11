import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { keys } from "../api/queries";
import type { LiveStatus } from "../api/types";
import { mockFetch } from "../test/fetchMock";
import { StatusChip } from "./StatusChip";

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}><StatusChip /></QueryClientProvider>) };
}
const status = (over: Partial<LiveStatus>): LiveStatus => ({ collector_alive: true, readings_fresh: true, last_reading_age_seconds: 4, ...over });

describe("StatusChip", () => {
  it.each<[string, Partial<LiveStatus>, string, string, string | null]>([
    ["live", {}, "Live", "live", "last reading 4 s ago"],
    ["stale", { readings_fresh: false, last_reading_age_seconds: 300 }, "Stale", "stale", "last reading 5 min ago"],
    ["no readings", { readings_fresh: null, last_reading_age_seconds: null }, "No readings yet", "waiting", null],
    ["collector down with fresh readings", { collector_alive: false }, "Collector offline", "offline", null],
  ])("%s: says %s", async (_name, over, word, state, detail) => {
    mockFetch({ "GET /api/status": { body: status(over) } });
    const { container } = mount();
    const live = await screen.findByRole("status");
    // the live region holds the word alone, so a refresh of the age is never announced
    expect(live).toHaveTextContent(new RegExp(`^${word}$`));
    const chip = container.querySelector("span.live");
    expect(chip).toHaveAttribute("data-state", state);
    expect(chip).toContainElement(live);
    if (detail) expect(chip?.querySelector(".detail")).toHaveTextContent(`· ${detail}`);
    else expect(chip?.querySelector(".detail")).toBeNull();
  });

  it("has exactly one live region", async () => {
    mockFetch({ "GET /api/status": { body: status({}) } });
    mount();
    await screen.findByRole("status");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("shows nothing while the first answer is on its way", () => {
    mockFetch({ "GET /api/status": { body: status({}) } });
    const { container } = mount();
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing, and raises no alert, when the request fails", async () => {
    const calls = mockFetch({ "GET /api/status": { status: 500, body: { detail: "boom" } } });
    const { container } = mount();
    await waitFor(() => expect(calls.filter((c) => c.path === "/api/status")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50)); // the rejection reaches the query
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("goes away when a later poll fails, instead of keeping the last answer on show", async () => {
    let answer = 0;
    const calls = mockFetch({ "GET /api/status": () => (answer++ === 0 ? { body: status({}) } : { status: 500, body: { detail: "boom" } }) });
    const { client, container } = mount();
    expect(await screen.findByRole("status")).toHaveTextContent("Live");
    await act(async () => { await client.refetchQueries({ queryKey: keys.status }); });
    expect(calls.filter((c) => c.path === "/api/status")).toHaveLength(2);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
