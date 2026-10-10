import { ApiError, setForbiddenHandler, setUnauthorizedHandler } from "../api/client";
import { downloadCsv } from "./download";

let clicks: { href: string; download: string }[];

/** jsdom's Blob has no arrayBuffer(), so read the raw bytes with FileReader. */
const bytesOf = (blob: Blob) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

beforeEach(() => {
  clicks = [];
  // jsdom implements neither object URLs nor anchor navigation.
  URL.createObjectURL = vi.fn(() => "blob:csv-1");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.download });
  });
});

const csvResponse = (disposition: string | null) =>
  new Response("﻿asset,date\r\n", {
    status: 200,
    headers: { "content-type": "text/csv; charset=utf-8", ...(disposition ? { "content-disposition": disposition } : {}) },
  });
const stubFetch = (response: Response) => {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("downloadCsv", () => {
  it("saves the response under the server's filename and keeps the byte-order mark", async () => {
    const fetchMock = stubFetch(csvResponse('attachment; filename="costs-2026-10.csv"'));
    await downloadCsv("/api/billing/costs.csv?month=2026-10");
    expect(fetchMock).toHaveBeenCalledWith("/api/billing/costs.csv?month=2026-10", { method: "GET", credentials: "same-origin", headers: {} });
    expect(clicks).toEqual([{ href: "blob:csv-1", download: "costs-2026-10.csv" }]);
    // Response.text() would strip the BOM Excel needs, so the file must be built from the raw bytes.
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect([...(await bytesOf(blob)).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(document.querySelector("a[download]")).toBeNull(); // the temporary anchor is removed again
  });

  it.each([
    [null, "export.csv"],
    ["attachment", "export.csv"],
    ["attachment; filename=plain.csv", "plain.csv"],
    ["attachment; filename*=UTF-8''kosten%20okt.csv", "kosten okt.csv"],
    ['attachment; filename="../evil.csv"', ".._evil.csv"],
    ["attachment; filename*=UTF-8''..%2Fevil.csv", ".._evil.csv"],
    ["attachment; filename*=UTF-8''..%5Cevil.csv", ".._evil.csv"],
  ])("reads %j as %j", async (disposition, expected) => {
    stubFetch(csvResponse(disposition));
    await downloadCsv("/x.csv");
    expect(clicks[0].download).toBe(expected);
  });

  it("posts a JSON body when asked to", async () => {
    const fetchMock = stubFetch(csvResponse('attachment; filename="w.csv"'));
    await downloadCsv("/api/widget-data/csv", { method: "POST", body: { type: "stat", range: "24h" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/widget-data/csv", {
      method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "stat", range: "24h" }),
    });
  });

  it("throws an ApiError carrying the server's detail and saves nothing", async () => {
    stubFetch(new Response(JSON.stringify({ detail: "site timezone must have whole-hour UTC offsets" }), {
      status: 409, headers: { "content-type": "application/json" },
    }));
    const failure = await downloadCsv("/api/billing/costs.csv?month=2026-10").catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).message).toBe("site timezone must have whole-hour UTC offsets");
    expect(clicks).toEqual([]);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("tells the app the session is gone on a 401, so it goes to the login page, and still throws", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    try {
      stubFetch(new Response(JSON.stringify({ detail: "not authenticated" }), {
        status: 401, headers: { "content-type": "application/json" },
      }));
      await expect(downloadCsv("/api/billing/costs.csv?month=2026-10")).rejects.toMatchObject({ status: 401 });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(clicks).toEqual([]);
    } finally {
      setUnauthorizedHandler(null);
    }
  });

  it("does not treat other failures as a lost session", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    try {
      stubFetch(new Response(JSON.stringify({ detail: "insufficient role" }), {
        status: 403, headers: { "content-type": "application/json" },
      }));
      await expect(downloadCsv("/api/billing/costs.csv?month=2026-10")).rejects.toMatchObject({ status: 403 });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      setUnauthorizedHandler(null);
    }
  });

  it("tells the app on a 403 so it can check the role, and still throws and saves nothing", async () => {
    const forbidden = vi.fn();
    const unauthorized = vi.fn();
    setForbiddenHandler(forbidden);
    setUnauthorizedHandler(unauthorized);
    try {
      stubFetch(new Response(JSON.stringify({ detail: "insufficient role" }), {
        status: 403, headers: { "content-type": "application/json" },
      }));
      await expect(downloadCsv("/api/billing/costs.csv?month=2026-10")).rejects.toMatchObject({ status: 403, message: "insufficient role" });
      expect(forbidden).toHaveBeenCalledTimes(1);
      expect(unauthorized).not.toHaveBeenCalled();
      expect(clicks).toEqual([]);
    } finally {
      setForbiddenHandler(null);
      setUnauthorizedHandler(null);
    }
  });

  it("does not tell the app about a 403 for other failures or a successful download", async () => {
    const forbidden = vi.fn();
    setForbiddenHandler(forbidden);
    try {
      stubFetch(new Response(JSON.stringify({ detail: "no such month" }), { status: 404, headers: { "content-type": "application/json" } }));
      await expect(downloadCsv("/x.csv")).rejects.toMatchObject({ status: 404 });
      stubFetch(csvResponse('attachment; filename="ok.csv"'));
      await downloadCsv("/x.csv");
      expect(forbidden).not.toHaveBeenCalled();
    } finally {
      setForbiddenHandler(null);
    }
  });

  it("reports a plain-text error body as its message", async () => {
    stubFetch(new Response("Bad gateway", { status: 502 }));
    await expect(downloadCsv("/x.csv")).rejects.toThrow("Bad gateway");
  });
});
