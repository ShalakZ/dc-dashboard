import { URI_MATCH } from "../test/moveFixtures";
import { formatOfflineSince, longOffline, OFFLINE_BANNER_SECONDS, offlineBannerParts, offlineBannerText, sourceStatusText } from "./sourceStatus";

describe("sourceStatusText", () => {
  it("says a disabled source is not polled", () => {
    expect(sourceStatusText({ enabled: false, status: "unknown", mapped_points: 3 })).toEqual({ text: "not polled (disabled)", polled: false });
  });

  it("says an enabled source with no mapped points is not polled", () => {
    expect(sourceStatusText({ enabled: true, status: "unknown", mapped_points: 0 })).toEqual({ text: "not polled (no mapped points)", polled: false });
  });

  it("keeps the last check visible: a Test or Browse job writes the status of a source that is not polled", () => {
    expect(sourceStatusText({ enabled: true, status: "offline", mapped_points: 0 })).toEqual({
      text: "not polled (no mapped points); last check: offline", polled: false,
    });
    expect(sourceStatusText({ enabled: false, status: "online", mapped_points: 2 })).toEqual({
      text: "not polled (disabled); last check: online", polled: false,
    });
  });

  it("disabled wins over no mapped points", () => {
    expect(sourceStatusText({ enabled: false, status: "unknown", mapped_points: 0 }).text).toBe("not polled (disabled)");
  });

  it("shows the stored status of a polled source", () => {
    expect(sourceStatusText({ enabled: true, status: "online", mapped_points: 4 })).toEqual({ text: "online", polled: true });
    expect(sourceStatusText({ enabled: true, status: "unknown", mapped_points: 1 })).toEqual({ text: "unknown", polled: true });
  });

  it("treats a missing mapped_points as polled (an older API, or a reply that does not carry it)", () => {
    expect(sourceStatusText({ enabled: true, status: "offline" })).toEqual({ text: "offline", polled: true });
  });

  it("says a source that is filled by importing files is filled by file import, whatever else it is (not 'not polled')", () => {
    expect(sourceStatusText({ enabled: true, status: "unknown", mapped_points: 0, polls: false })).toEqual({ text: "filled by file import", polled: false });
    expect(sourceStatusText({ enabled: false, status: "unknown", mapped_points: 3, polls: false })).toEqual({ text: "filled by file import", polled: false });
    expect(sourceStatusText({ enabled: true, status: "offline", mapped_points: 2, polls: false }).text).toBe("filled by file import");
  });

  it("counts a missing or true polls as polling", () => {
    expect(sourceStatusText({ enabled: true, status: "online", mapped_points: 4, polls: true })).toEqual({ text: "online", polled: true });
  });
});

describe("longOffline (w32, the Sources banner)", () => {
  const NOW = Date.parse("2026-10-22T07:00:00Z");
  const secondsAgo = (n: number) => new Date(NOW - n * 1000).toISOString();
  const base = { id: 1, name: "opc", connector_type: "opcua", config: {}, origin: "manual" as const, enabled: true, status: "offline", last_seen: "2026-10-18T04:52:51Z", last_error: null, has_secret: false, mapped_points: 3, polls: true };

  it("takes a polled source that is offline and has been for more than 120 seconds, and says how long", () => {
    const [one] = longOffline([{ ...base, offline_since: secondsAgo(121) }], NOW);
    expect(one).toMatchObject({ since: secondsAgo(121), seconds: 121, neverAnswered: false });
    expect(one.source.id).toBe(1);
  });

  it("is a strict 120: a source offline for 120 seconds or less is left out, and so is one with a future time", () => {
    expect(OFFLINE_BANNER_SECONDS).toBe(120);
    expect(longOffline([{ ...base, offline_since: secondsAgo(120) }], NOW)).toEqual([]);
    expect(longOffline([{ ...base, offline_since: secondsAgo(90) }], NOW)).toEqual([]);
    expect(longOffline([{ ...base, offline_since: secondsAgo(-30) }], NOW)).toEqual([]);
  });

  it.each([
    ["disabled", { enabled: false }],
    ["filled by file import (polls false)", { polls: false }],
    ["no mapped points", { mapped_points: 0 }],
    ["online", { status: "online" }],
    ["unknown", { status: "unknown" }],
    ["no offline_since (null)", { offline_since: null }],
    ["no offline_since (an older API)", { offline_since: undefined }],
    ["an offline_since that is not a time", { offline_since: "not a time" }],
  ])("leaves out a source that is %s", (_name, over) => {
    expect(longOffline([{ ...base, offline_since: secondsAgo(500), ...over }], NOW)).toEqual([]);
  });

  it("counts a missing mapped_points or polls as polled (an older API), the way the Status column does", () => {
    const { mapped_points: _m, polls: _p, ...older } = base;
    expect(longOffline([{ ...older, offline_since: secondsAgo(500) }], NOW)).toHaveLength(1);
  });

  it("marks a source that never answered (no last_seen), and lists the longest outage first, ties by name", () => {
    const list = longOffline([
      { ...base, id: 1, name: "short", offline_since: secondsAgo(300) },
      { ...base, id: 2, name: "b-long", offline_since: secondsAgo(9000) },
      { ...base, id: 3, name: "a-long", offline_since: secondsAgo(9000) },
      { ...base, id: 4, name: "never", offline_since: secondsAgo(600), last_seen: null },
    ], NOW);
    expect(list.map((x) => x.source.name)).toEqual(["a-long", "b-long", "never", "short"]);
    expect(list.map((x) => x.neverAnswered)).toEqual([false, false, true, false]);
  });
});

describe("formatOfflineSince", () => {
  it("prints the day, the month and the hour and minute on the wall clock of the site zone", () => {
    expect(formatOfflineSince("2026-10-18T04:52:51Z", "Asia/Qatar")).toBe("18 Oct 07:52");
    expect(formatOfflineSince("2026-10-17T22:30:00Z", "Asia/Qatar")).toBe("18 Oct 01:30"); // the zone moves the day
    expect(formatOfflineSince("2026-01-05T09:05:00Z", "UTC")).toBe("5 Jan 09:05"); // no leading zero on the day, like formatShortTime of the System events page
  });

  it("is null for a time or a zone it cannot read (the caller then leaves the time out rather than show one in the browser's zone)", () => {
    expect(formatOfflineSince("2026-10-18T04:52:51Z", "Not/AZone")).toBeNull();
    expect(formatOfflineSince("nonsense", "UTC")).toBeNull();
  });
});

describe("offlineBannerText", () => {
  const NOW = Date.parse("2026-10-22T07:00:00Z");
  const entry = (name: string, secondsOffline: number, over: Record<string, unknown> = {}) => {
    const since = new Date(NOW - secondsOffline * 1000).toISOString();
    return {
      source: { id: 1, name, connector_type: "opcua", config: {}, origin: "manual" as const, enabled: true, status: "offline", last_seen: "2026-10-18T04:52:51Z", last_error: null, has_secret: false, offline_since: since, ...over },
      since, seconds: secondsOffline, neverAnswered: false,
    };
  };
  const FOUR_DAYS_TWO_HOURS = 4 * 86400 + 2 * 3600 + 8 * 60; // from 2026-10-18 04:52 UTC (07:52 in Qatar) to NOW

  it("names one source, how long, since when in the site zone, and its last error", () => {
    const e = entry("OPC UA server at 172.20.0.3:4840", FOUR_DAYS_TWO_HOURS, {
      last_error: "[Errno 111] Connect call failed ('172.20.0.3', 4840)",
    });
    expect(offlineBannerText([e], "Asia/Qatar")).toBe(
      "1 source is offline: OPC UA server at 172.20.0.3:4840, for 4 d 2 h (since 18 Oct 07:52): [Errno 111] Connect call failed ('172.20.0.3', 4840).",
    );
  });

  it("does not put a second full stop after an error that ends with one, and says nothing of an error there is none of", () => {
    expect(offlineBannerText([entry("a", 300, { last_error: "no answer." })], "UTC")).toMatch(/: no answer\.$/);
    expect(offlineBannerText([entry("a", 300)], "UTC")).toMatch(/^1 source is offline: a, for 5 min \(since [0-9]{2} \w{3} [0-9:]{5}\)\.$/);
  });

  it("leaves the time out, not the browser's, while the site zone is unknown", () => {
    expect(offlineBannerText([entry("a", 300, { last_error: "x" })], undefined)).toBe("1 source is offline: a, for 5 min: x.");
  });

  it("says a source that never answered has not answered since it was added", () => {
    const e = { ...entry("fresh", 600, { last_seen: null, last_error: "timeout" }), neverAnswered: true };
    expect(offlineBannerText([e], "UTC")).toBe("1 source is offline: fresh, which has not answered since it was added: timeout.");
  });

  it("names up to three, each with how long, then 'and N more'", () => {
    const two = [entry("a", 7200), entry("b", 300)];
    expect(offlineBannerText(two, "UTC")).toBe("2 sources are offline: a (for 2 h) and b (for 5 min).");
    const three = [entry("a", 7200), entry("b", 300), entry("c", 130)];
    expect(offlineBannerText(three, "UTC")).toBe("3 sources are offline: a (for 2 h), b (for 5 min) and c (for 2 min).");
    const four = [...three, entry("d", 200)];
    expect(offlineBannerText(four, "UTC")).toBe("4 sources are offline: a (for 2 h), b (for 5 min), c (for 2 min) and 1 more.");
    const five = [...four, entry("e", 200)];
    expect(offlineBannerText(five, "UTC")).toBe("5 sources are offline: a (for 2 h), b (for 5 min), c (for 2 min) and 2 more.");
  });

  it("says in the list of several that one never answered", () => {
    const never = { ...entry("fresh", 600, { last_seen: null }), neverAnswered: true };
    expect(offlineBannerText([entry("a", 7200), never], "UTC")).toBe("2 sources are offline: a (for 2 h) and fresh (has not answered since it was added).");
  });
});

describe("offlineBannerText and offlineBannerParts with a move candidate (w33)", () => {
  const NOW = Date.parse("2026-10-22T07:00:00Z");
  const offer = { kind: "offer" as const, to_source_id: 7, to_name: "OPC UA server at 172.20.0.5:4840", to_endpoint: "opc.tcp://172.20.0.5:4840/dcdash/", match: URI_MATCH };
  const entry = (name: string, secondsOffline: number, over: Record<string, unknown> = {}, id = 1) => {
    const since = new Date(NOW - secondsOffline * 1000).toISOString();
    return {
      source: { id, name, connector_type: "opcua", config: {}, origin: "manual" as const, enabled: true, status: "offline", last_seen: "2026-10-18T04:52:51Z", last_error: null, has_secret: false, offline_since: since, ...over },
      since, seconds: secondsOffline, neverAnswered: false,
    };
  };
  const OLD = "OPC UA server at 172.20.0.3:4840";
  const BASE = `1 source is offline: ${OLD}, for 4 d 2 h (since 18 Oct 07:52): Connect call failed.`;
  const FOUR_DAYS = 4 * 86400 + 2 * 3600 + 8 * 60;
  const withOffer = () => entry(OLD, FOUR_DAYS, { last_error: "Connect call failed", move_candidate: offer });

  it("changes nothing for a source without a candidate, or whose candidate is null or missing", () => {
    for (const over of [{}, { move_candidate: null }]) {
      const list = [entry(OLD, FOUR_DAYS, { last_error: "Connect call failed", ...over })];
      expect(offlineBannerText(list, "Asia/Qatar")).toBe(BASE);
      expect(offlineBannerText(list, "Asia/Qatar", true)).toBe(BASE);
      expect(offlineBannerParts(list, "Asia/Qatar", true)).toEqual({ text: BASE, move: null });
    }
  });

  it("ends a single offline source's sentence with where a scan found it and the words of the link, for a person who can move it", () => {
    expect(offlineBannerText([withOffer()], "Asia/Qatar", true)).toBe(`${BASE} A scan found it at 172.20.0.5:4840: Move to new address...`);
  });

  it("gives the parts: the sentence up to the colon, and the source the link opens", () => {
    expect(offlineBannerParts([withOffer()], "Asia/Qatar", true)).toEqual({
      text: `${BASE} A scan found it at 172.20.0.5:4840:`,
      move: { sourceId: 1, name: OLD, hostPort: "172.20.0.5:4840" },
    });
  });

  it("still says where it was found, but offers no link, to a person who cannot edit sources", () => {
    expect(offlineBannerText([withOffer()], "Asia/Qatar")).toBe(`${BASE} A scan found it at 172.20.0.5:4840.`);
    expect(offlineBannerParts([withOffer()], "Asia/Qatar", false)).toEqual({ text: `${BASE} A scan found it at 172.20.0.5:4840.`, move: null });
  });

  it("says two servers could be this one, and edits by hand", () => {
    const list = [entry(OLD, FOUR_DAYS, { last_error: "Connect call failed", move_candidate: { kind: "two", count: 2 } })];
    const text = `${BASE} Two servers could be this one; edit the address by hand.`;
    expect(offlineBannerText(list, "Asia/Qatar", true)).toBe(text);
    expect(offlineBannerParts(list, "Asia/Qatar", true)).toEqual({ text, move: null });
  });

  it("with several sources offline counts the ones a scan found a new address for, and sends the person to the row menus", () => {
    const list = [entry("a", 7200, { move_candidate: offer }, 1), entry("b", 300, {}, 2), entry("c", 200, { move_candidate: offer }, 3)];
    expect(offlineBannerText(list, "UTC", true)).toBe(
      "3 sources are offline: a (for 2 h), b (for 5 min) and c (for 3 min). A scan found a new address for 2 of them: use Move to new address... in the row menu of each.",
    );
    expect(offlineBannerParts(list, "UTC", true).move).toBeNull();
    expect(offlineBannerText(list, "UTC")).toBe("3 sources are offline: a (for 2 h), b (for 5 min) and c (for 3 min). A scan found a new address for 2 of them.");
  });

  it("with several sources and one candidate says the same", () => {
    const list = [entry("a", 7200, { move_candidate: offer }, 1), entry("b", 300, {}, 2)];
    expect(offlineBannerText(list, "UTC", true)).toBe("2 sources are offline: a (for 2 h) and b (for 5 min). A scan found a new address for 1 of them: use Move to new address... in its row menu.");
  });
});
