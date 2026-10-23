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

  // w35: the data watchdog. The word alone is the live region (no second announcer); the oldest silence is the caption.
  describe("with the meter fields", () => {
    const watched = (over: Partial<LiveStatus>) => status({ meters: 48, meters_stale: 3, oldest_stale_age_seconds: 7260, ...over });

    it("says how many meters are stale in the live region, with data-state stale, and the oldest silence as the caption", async () => {
      mockFetch({ "GET /api/status": { body: watched({}) } });
      const { container } = mount();
      const live = await screen.findByRole("status");
      expect(live).toHaveTextContent(/^3 of 48 meters stale$/);
      expect(screen.getAllByRole("status")).toHaveLength(1);
      const chip = container.querySelector("span.live");
      expect(chip).toHaveAttribute("data-state", "stale");
      expect(chip).toContainElement(live);
      expect(chip?.querySelector(".detail")).toHaveTextContent("· oldest 2 h ago");
      expect(chip?.querySelector(".detail")).not.toContainElement(live);
    });

    it("has no caption when the server sent no age", async () => {
      mockFetch({ "GET /api/status": { body: watched({ oldest_stale_age_seconds: null }) } });
      const { container } = mount();
      expect(await screen.findByRole("status")).toHaveTextContent(/^3 of 48 meters stale$/);
      expect(container.querySelector(".live .detail")).toBeNull();
    });

    it("puts the parts a narrow window drops in spans of their own: ' of 48', and the plural s of '1 of 12 meters'", async () => {
      mockFetch({ "GET /api/status": { body: watched({ meters: 12, meters_stale: 1 }) } });
      const { container } = mount();
      expect(await screen.findByRole("status")).toHaveTextContent(/^1 of 12 meters stale$/);
      expect([...container.querySelectorAll(".live .wide")].map((n) => n.textContent)).toEqual([" of 12", "s"]);
    });

    it("keeps the plural s when more than one meter is stale, so the narrow word reads '3 meters stale'", async () => {
      mockFetch({ "GET /api/status": { body: watched({}) } });
      const { container } = mount();
      await screen.findByRole("status");
      expect([...container.querySelectorAll(".live .wide")].map((n) => n.textContent)).toEqual([" of 48"]);
    });

    it("says '1 of 1 meter stale' for a site with one meter, and '3 meters stale' without a total", async () => {
      mockFetch({ "GET /api/status": { body: watched({ meters: 1, meters_stale: 1 }) } });
      const first = mount();
      expect(await screen.findByRole("status")).toHaveTextContent(/^1 of 1 meter stale$/);
      first.unmount();
      mockFetch({ "GET /api/status": { body: watched({ meters: undefined }) } });
      mount();
      expect(await screen.findByRole("status")).toHaveTextContent(/^3 meters stale$/);
      expect(document.querySelector(".live .wide")).toBeNull();
    });

    it("stays Live with the counters that do not rise as the caption", async () => {
      mockFetch({ "GET /api/status": { body: status({ meters: 48, meters_stale: 0, meters_not_advancing: 2 }) } });
      const { container } = mount();
      expect(await screen.findByRole("status")).toHaveTextContent(/^Live$/);
      const chip = container.querySelector("span.live");
      expect(chip).toHaveAttribute("data-state", "live");
      expect(chip?.querySelector(".detail")).toHaveTextContent("· 2 meters not rising");
    });

    it("says Collector offline first", async () => {
      mockFetch({ "GET /api/status": { body: watched({ collector_alive: false }) } });
      const { container } = mount();
      expect(await screen.findByRole("status")).toHaveTextContent(/^Collector offline$/);
      expect(container.querySelector("span.live")).toHaveAttribute("data-state", "offline");
    });
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
