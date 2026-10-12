import { ApiError } from "../api/client";
import { asCheckResult, checkVerdict, copyText, describeStepError, formatMs, partSize, reportErrorText, reportFileName, reportText, saveTextFile, stepLabel, stepState } from "./diagnostics";

const result = (over: Record<string, unknown> = {}) => ({
  source_id: 3, connector_type: "opcua", started_at: "2026-10-12T10:00:00+00:00", finished: true, ok: true, first_failed: null,
  steps: [], clock: { server_time: null, local_time: "2026-10-12T10:00:00+00:00", skew_seconds: null }, names: { hosts: [], uris: [] }, ...over,
});
const step = (over: Record<string, unknown> = {}) => ({ id: "dns", name: "DNS resolution", ok: true, ms: 12, summary: "", error: null, hint: null, detail: {}, ...over });

describe("step helpers", () => {
  it("names a step by the collector's name, else by its id", () => {
    expect(stepLabel({ id: "dns", name: "DNS resolution" })).toBe("DNS resolution");
    expect(stepLabel({ id: "read_points", name: "" })).toBe("Reading the points");
    expect(stepLabel({ id: "odd_one", name: "" })).toBe("odd_one");
  });

  it("reads ok as passed, false as failed and null as skipped", () => {
    expect([true, false, null].map((ok) => stepState({ ok }))).toEqual(["ok", "failed", "skipped"]);
  });

  it("formats milliseconds up to a second and seconds above it", () => {
    expect([12.4, 999, 1000, 1234, null, undefined, -1, Number.NaN].map(formatMs)).toEqual(["12 ms", "999 ms", "1.0 s", "1.2 s", "", "", "", ""]);
  });

  it("writes the exact error once: the class when it adds something, the status name and hex, the message", () => {
    expect(describeStepError({ class: "BadUserAccessDenied", status_name: "BadUserAccessDenied", status_hex: "0x801F0000", message: "no access" }))
      .toBe("BadUserAccessDenied (0x801F0000): no access");
    expect(describeStepError({ class: "UaStatusCodeError", status_name: "BadTimeout", status_hex: "0x800A0000", message: "slow" }))
      .toBe("UaStatusCodeError / BadTimeout (0x800A0000): slow");
    expect(describeStepError({ class: "ConnectionRefusedError", status_name: null, status_hex: null, message: "[Errno 111] refused" }))
      .toBe("ConnectionRefusedError: [Errno 111] refused");
    expect(describeStepError({ class: "TimeoutError", status_name: null, status_hex: null, message: "" })).toBe("TimeoutError");
    expect(describeStepError(null)).toBe("");
  });
});

describe("asCheckResult and checkVerdict", () => {
  it("accepts a stored check and refuses anything else", () => {
    expect(asCheckResult(result({ steps: [step()] }))?.steps).toHaveLength(1);
    expect(asCheckResult(null)).toBeNull();
    expect(asCheckResult({ error: "collector restarted" })).toBeNull();
    expect(asCheckResult({ steps: "no" })).toBeNull();
  });

  it("drops a step entry that is not an object", () => {
    expect(asCheckResult({ ...result(), steps: [step(), null, 3] })?.steps).toHaveLength(1);
  });

  it("says what the check found", () => {
    const failed = asCheckResult(result({ ok: false, first_failed: "session", steps: [step(), step({ id: "session", name: "Session", ok: false })] }))!;
    expect(checkVerdict(failed)).toBe("The check failed at: Session.");
    expect(checkVerdict(asCheckResult(result())!)).toBe("Every step passed.");
    expect(checkVerdict(asCheckResult(result({ ok: null }))!)).toBe("The check finished without a verdict.");
    expect(checkVerdict(asCheckResult(result({ ok: false }))!)).toBe("The check failed.");
  });
});

describe("report helpers", () => {
  const parts = [
    { index: 1, of: 2, text: "A\nB", chars: 12034, lines: 210 },
    { index: 2, of: 2, text: "C", chars: 1, lines: 1 },
  ];

  it("shows the server's sizes with thousands separators and singular units", () => {
    expect(partSize(parts[0])).toBe("12,034 characters of content, 210 lines");
    expect(partSize(parts[1])).toBe("1 character of content, 1 line");
  });

  describe("reportErrorText", () => {
    const fallback = "Try again; if it keeps failing, run the offline script described in docs/field-debugging.md (scripts/collect-diagnostics.ps1) and paste its output.";

    it("wraps the server's detail in a sentence that says what to do next, capitalised", () => {
      expect(reportErrorText(new ApiError(500, "internal error"))).toBe(`The report could not be built (Internal error). ${fallback}`);
      expect(reportErrorText(new ApiError(500, "report failed."))).toBe(`The report could not be built (Report failed). ${fallback}`);
    });

    it("says plainly that only administrators can build a report", () => {
      expect(reportErrorText(new ApiError(403, "admin role required"))).toBe("Only administrators can build a report.");
    });

    it("says the server could not be reached when the request itself failed", () => {
      expect(reportErrorText(new TypeError("Failed to fetch"))).toBe("Could not reach the server.");
      expect(reportErrorText(new Error("NetworkError when attempting to fetch resource."))).toBe("Could not reach the server.");
    });
  });

  it("joins the parts with one blank line, as format=text does", () => {
    expect(reportText({ parts })).toBe("A\nB\n\nC");
  });

  it("names the download after the build, the detail and the mask, safe for a file name", () => {
    expect(reportFileName({ build_id: "227bd6a", detail: "summary", mask: false })).toBe("dcdash-report-227bd6a-summary.txt");
    expect(reportFileName({ build_id: "v1/2 dirty:x", detail: "full", mask: true })).toBe("dcdash-report-v1_2_dirty_x-full-masked.txt");
    expect(reportFileName({ build_id: "", detail: "full", mask: false })).toBe("dcdash-report-build-full.txt");
  });
});

describe("saveTextFile", () => {
  it("saves a Blob under the name with no request", () => {
    const clicks: { href: string; download: string }[] = [];
    URL.createObjectURL = vi.fn(() => "blob:report-1");
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.href, download: this.download });
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    saveTextFile("r.txt", "héllo");
    expect(clicks).toEqual([{ href: "blob:report-1", download: "r.txt" }]);
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/plain;charset=utf-8");
    expect(blob.size).toBe(6); // UTF-8: the é takes two bytes
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("copyText", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the clipboard API when there is one", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("abc", null)).toBe(true);
    expect(writeText).toHaveBeenCalledWith("abc");
  });

  it("falls back to copying the text area's selection when the API is missing or refuses", async () => {
    const area = document.createElement("textarea");
    document.body.appendChild(area);
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    vi.stubGlobal("navigator", {});
    expect(await copyText("abc", area)).toBe(true);
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    expect(await copyText("abc", area)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledWith("copy");
    area.remove();
  });

  it("is false when nothing could copy", async () => {
    vi.stubGlobal("navigator", {});
    expect(await copyText("abc", null)).toBe(false);
    const area = document.createElement("textarea");
    document.body.appendChild(area);
    (document as unknown as { execCommand: unknown }).execCommand = () => false;
    expect(await copyText("abc", area)).toBe(false);
    area.remove();
  });
});
