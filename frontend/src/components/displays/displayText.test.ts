import { ApiError } from "../../api/client";
import type { DisplayRow, PlaylistItemRow } from "../../api/types";
import { countText, dashboardLabel, focusLabel, focusRefusal, FOCUS_NEEDS_ASSETS, lastConnectedParts, lastConnectedText, namesFocus, playlistDeleteRefusal, skipSentence, skippedText } from "./displayText";

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

describe("lastConnectedParts: the two lines of the Last connected cell (the column header already says Last connected)", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  it("is one line for a link nobody opened", () => {
    expect(lastConnectedParts(screen(), now, "UTC")).toEqual({ when: "Never connected", from: null });
  });

  it("splits the time ago from the address, which is written 'from ...'", () => {
    expect(lastConnectedParts(screen({ last_seen_at: "2026-10-20T11:57:00+00:00", last_client: "10.0.0.12" }), now, "UTC")).toEqual({ when: "3 min ago", from: "from 10.0.0.12" });
  });

  it("starts the first line with a capital when it is a word, and leaves the address out when none was kept", () => {
    expect(lastConnectedParts(screen({ last_seen_at: "2026-10-20T11:59:40+00:00" }), now, "UTC")).toEqual({ when: "Just now", from: null });
    expect(lastConnectedParts(screen({ last_seen_at: "2026-10-19T08:00:00+00:00" }), now, "UTC")).toEqual({ when: "Yesterday", from: null });
  });

  it("keeps an IPv6 address whole (the cell may break it anywhere)", () => {
    expect(lastConnectedParts(screen({ last_seen_at: "2026-10-20T11:30:00+00:00", last_client: "2001:db8:85a3::8a2e:370:7334" }), now, "UTC"))
      .toEqual({ when: "30 min ago", from: "from 2001:db8:85a3::8a2e:370:7334" });
  });

  it("falls back to the date once the age is no longer written", () => {
    expect(lastConnectedParts(screen({ last_seen_at: "2026-09-01T10:00:00+00:00", last_client: "10.0.0.12" }), now, "UTC")).toEqual({ when: "2026-09-01 10:00:00", from: "from 10.0.0.12" });
  });
});

describe("namesFocus and focusRefusal: the 403 of a playlist that names a focus asset", () => {
  it("says whether any item names a focus asset", () => {
    expect(namesFocus([])).toBe(false);
    expect(namesFocus([null, null])).toBe(false);
    expect(namesFocus([null, 11])).toBe(true);
  });

  it("turns a 403 into the sentence that says what is missing, only when a focus is named", () => {
    const forbidden = new ApiError(403, "insufficient permission");
    expect(focusRefusal(forbidden, true)).toEqual(new Error(FOCUS_NEEDS_ASSETS));
    expect(FOCUS_NEEDS_ASSETS).toBe("This playlist names a focus asset. Saving it or showing it on a screen also needs See the Assets Tree.");
    expect(focusRefusal(forbidden, false)).toBe(forbidden); // no focus named: the 403 is about something else
    const taken = new ApiError(409, "a display with this name already exists");
    expect(focusRefusal(taken, true)).toBe(taken); // another status is left alone
    const plain = new Error("boom");
    expect(focusRefusal(plain, true)).toBe(plain);
  });
});

describe("playlistDeleteRefusal: the sentence a refused playlist delete shows", () => {
  it("starts with a capital, ends with a full stop and says what to do, for the old text of the server", () => {
    expect(playlistDeleteRefusal(new ApiError(409, "this playlist is shown by: Hall TV, Old (revoked)")))
      .toBe("This playlist is shown by: Hall TV, Old (revoked). Change their playlist or delete them first.");
  });

  it("does not say it twice when the server already did (the bounded text)", () => {
    const text = "this playlist is shown by 10 screens: A, B, C and 7 more. Change their playlist or delete them first.";
    expect(playlistDeleteRefusal(new ApiError(409, text))).toBe("This playlist is shown by 10 screens: A, B, C and 7 more. Change their playlist or delete them first.");
  });

  it("does not say it twice for one screen either (the server's singular advice), nor for a screen it does not name", () => {
    expect(playlistDeleteRefusal(new ApiError(409, "this playlist is shown by 1 screen: Hall TV. Change its playlist or delete it first.")))
      .toBe("This playlist is shown by 1 screen: Hall TV. Change its playlist or delete it first.");
    expect(playlistDeleteRefusal(new ApiError(409, "this playlist is shown by a screen. Change its playlist or delete it first.")))
      .toBe("This playlist is shown by a screen. Change its playlist or delete it first.");
  });

  it("adds no advice to another refusal, only the capital and the full stop", () => {
    expect(playlistDeleteRefusal(new ApiError(404, "playlist not found"))).toBe("Playlist not found.");
    expect(playlistDeleteRefusal(new ApiError(403, "insufficient permission"))).toBe("Your role does not allow this.");
    expect(playlistDeleteRefusal(new Error("Failed to fetch"))).toBe("Failed to fetch.");
  });
});
