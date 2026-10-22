import { NO_EVENT_FILTERS } from "../api/queries";
import type { EventFilters } from "../api/types";
import { FIRST_DAY, isFiltered, LAST_DAY, LEVELS, NO_FILTERS, readUrl, writeUrl, type EventsUrlState } from "./eventFilters";

const read = (query: string) => readUrl(new URLSearchParams(query));
const state = (filters: Partial<EventFilters> = {}, view: EventsUrlState["view"] = "friendly"): EventsUrlState => ({ filters: { ...NO_FILTERS, ...filters }, view });

describe("eventFilters (w32): the address of the System events page", () => {
  it("is the same 'nothing set' as the query hooks use", () => {
    expect(NO_FILTERS).toEqual(NO_EVENT_FILTERS);
    expect(LEVELS).toEqual(["info", "warning", "error"]);
  });

  it("reads an empty address as no filters in the friendly view, and writes it back as an empty address", () => {
    expect(read("")).toEqual(state());
    expect(writeUrl(state()).toString()).toBe("");
  });

  it("round-trips every filter and the raw view", () => {
    const full = state({ source: "4", levels: ["warning", "error"], kinds: ["source.offline", "points.bad"], from: "2026-10-01", to: "2026-10-22", open: true }, "raw");
    const query = writeUrl(full).toString();
    expect(query).toBe("source=4&level=warning&level=error&kind=source.offline&kind=points.bad&from=2026-10-01&to=2026-10-22&open=1&view=raw");
    expect(read(query)).toEqual(full);
  });

  it("keeps levels in the order info, warning, error whatever the address says, and each once", () => {
    expect(read("level=error&level=info&level=error").filters.levels).toEqual(["info", "error"]);
  });

  it("drops what the API would refuse instead of failing: a bad source, level, kind, day or open value", () => {
    const filters = read("source=abc&level=fatal&level=info&kind=Bad%20Kind&kind=ok.kind&from=2026-02-30&to=nope&open=yes").filters;
    expect(filters).toEqual({ ...NO_FILTERS, levels: ["info"], kinds: ["ok.kind"] });
    expect(read("source=1234567890").filters.source).toBe(""); // more digits than an id holds
    expect(read(`from=1969-12-31&to=2101-01-01`).filters).toMatchObject({ from: "", to: "" });
    expect(read(`from=${FIRST_DAY}&to=${LAST_DAY}`).filters).toMatchObject({ from: FIRST_DAY, to: LAST_DAY });
  });

  it("holds at most 20 kinds, each at most 60 characters, and each kind once", () => {
    const many = Array.from({ length: 30 }, (_, i) => `kind=k${i}.x`).join("&");
    expect(read(many).filters.kinds).toHaveLength(20);
    expect(read(`kind=${"a".repeat(61)}`).filters.kinds).toEqual([]);
    expect(read("kind=a.b&kind=a.b").filters.kinds).toEqual(["a.b"]);
  });

  it("treats any view but raw as friendly", () => {
    expect(read("view=raw").view).toBe("raw");
    expect(read("view=other").view).toBe("friendly");
  });

  it("says whether any filter is set", () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    for (const set of [{ source: "2" }, { levels: ["error"] }, { kinds: ["a.b"] }, { from: "2026-10-01" }, { to: "2026-10-02" }, { open: true }] as Partial<EventFilters>[]) {
      expect(isFiltered({ ...NO_FILTERS, ...set })).toBe(true);
    }
  });
});
