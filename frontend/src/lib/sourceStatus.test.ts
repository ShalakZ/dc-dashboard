import { sourceStatusText } from "./sourceStatus";

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
