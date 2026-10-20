import type { DisplayRow, PlaylistItemRow } from "../../api/types";
import { countText, dashboardLabel, focusLabel, lastConnectedText, skipSentence, skippedText } from "./displayText";

const item = (over: Partial<PlaylistItemRow> = {}): PlaylistItemRow => ({
  id: 1, position: 0, seconds: 60, dashboard_id: 3, dashboard_name: "Ops", focus_asset_id: null, focus_name: null, skipped: null, ...over,
});
const screen = (over: Partial<DisplayRow> = {}): DisplayRow => ({
  id: 1, name: "Hall TV", playlist_id: 2, playlist_name: "Wall A", status: "active", created_at: "2026-10-20T08:00:00+00:00",
  last_seen_at: null, last_client: null, revoked_at: null, ...over,
});

describe("skipSentence", () => {
  it("says why an item is skipped, with the stored name", () => {
    expect(skipSentence(item({ dashboard_id: null, dashboard_name: "Ops", skipped: "dashboard_deleted" }))).toBe("The dashboard Ops was deleted");
    expect(skipSentence(item({ focus_asset_id: 9, focus_name: "Hall 1", skipped: "focus_gone" }))).toBe("The asset Hall 1 no longer exists");
    expect(skipSentence(item({ skipped: "no_widgets" }))).toBe("This dashboard has no widgets");
  });

  it("leaves the name out when none is kept, and says nothing for an item that plays", () => {
    expect(skipSentence(item({ dashboard_id: null, dashboard_name: null, skipped: "dashboard_deleted" }))).toBe("The dashboard was deleted");
    expect(skipSentence(item({ focus_asset_id: 9, focus_name: null, skipped: "focus_gone" }))).toBe("The asset no longer exists");
    expect(skipSentence(item())).toBeNull();
  });
});

describe("names the caller may not read", () => {
  it("shows (hidden) only for a thing that exists and has no name in the answer", () => {
    expect(dashboardLabel(item())).toBe("Ops");
    expect(dashboardLabel(item({ dashboard_name: null }))).toBe("(hidden)");
    expect(dashboardLabel(item({ dashboard_id: null, dashboard_name: null }))).toBeNull(); // no dashboard at all
    expect(focusLabel(item())).toBeNull(); // no focus: the whole site
    expect(focusLabel(item({ focus_asset_id: 9, focus_name: "Hall 1" }))).toBe("Hall 1");
    expect(focusLabel(item({ focus_asset_id: 9, focus_name: null }))).toBe("(hidden)");
  });
});

describe("counts", () => {
  it("writes the singular for one", () => {
    expect(countText(0, "dashboard")).toBe("0 dashboards");
    expect(countText(1, "dashboard")).toBe("1 dashboard");
    expect(countText(2, "dashboard")).toBe("2 dashboards");
    expect(skippedText(1)).toBe("1 item is skipped");
    expect(skippedText(2)).toBe("2 items are skipped");
  });
});

describe("lastConnectedText", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  it("says never connected for a link nobody opened", () => {
    expect(lastConnectedText(screen(), now, "UTC")).toBe("Never connected");
  });

  it("names the time ago and the address", () => {
    expect(lastConnectedText(screen({ last_seen_at: "2026-10-20T11:57:00+00:00", last_client: "10.0.0.12" }), now, "UTC")).toBe("Last connected 3 min ago from 10.0.0.12");
  });

  it("leaves the address out when none was kept, and says just now under a minute", () => {
    expect(lastConnectedText(screen({ last_seen_at: "2026-10-20T11:59:40+00:00" }), now, "UTC")).toBe("Last connected just now");
  });

  it("falls back to the date once the age is no longer written (after two weeks)", () => {
    expect(lastConnectedText(screen({ last_seen_at: "2026-09-01T10:00:00+00:00", last_client: "10.0.0.12" }), now, "UTC")).toBe("Last connected 2026-09-01 10:00:00 from 10.0.0.12");
  });
});
