import { mockFetch } from "../test/fetchMock";
import { api, ApiError, isUnreachable, notifyForbidden, setForbiddenHandler, setUnauthorizedHandler } from "./client";

describe("api client", () => {
  it("sends JSON with same-origin credentials and parses the reply", async () => {
    const calls = mockFetch({ "POST /api/login": { body: { id: 1, username: "a", role: "admin" } } });
    const user = await api.post<{ id: number }>("/api/login", { username: "a", password: "p" });
    expect(user.id).toBe(1);
    expect(calls[0]).toEqual({ method: "POST", path: "/api/login", body: { username: "a", password: "p" } });
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("throws ApiError with status on non-2xx", async () => {
    mockFetch({ "GET /api/me": { status: 401, body: { detail: "not authenticated" } } });
    await expect(api.get("/api/me")).rejects.toMatchObject({ status: 401, detail: "not authenticated" });
    await expect(api.get("/api/me")).rejects.toBeInstanceOf(ApiError);
  });

  it("reads the server's one refusal text (403 insufficient permission) as a sentence for a person, and keeps the detail", async () => {
    mockFetch({
      "GET /api/users": { status: 403, body: { detail: "insufficient permission" } },
      "GET /api/roles": { status: 403, body: { detail: "cannot give an account a role with more access than yours" } },
      "GET /api/sources": { status: 409, body: { detail: "insufficient permission" } },
    });
    await expect(api.get("/api/users")).rejects.toMatchObject({ status: 403, detail: "insufficient permission", message: "Your role does not allow this." });
    await expect(api.get("/api/roles")).rejects.toMatchObject({ message: "cannot give an account a role with more access than yours" }); // another 403 keeps its own words
    await expect(api.get("/api/sources")).rejects.toMatchObject({ message: "insufficient permission" }); // only a 403 is rewritten
  });

  it("reads Caddy's plain-text 502 (the api is restarting) as an ApiError that says so, whatever the body, and keeps the body", async () => {
    const text = "The server is not answering (status 502). It may be restarting; try again in a moment.";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("502 Bad Gateway", { status: 502, headers: { "content-type": "text/plain" } })));
    await expect(api.get("/api/sources")).rejects.toMatchObject({ status: 502, detail: "502 Bad Gateway", body: "502 Bad Gateway", message: text });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    await expect(api.get("/api/sources")).rejects.toMatchObject({ status: 502, message: text });
  });

  it("describes 503 and 504 the same way, even when the api sent a reason of its own, and leaves other 5xx alone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "database unavailable" }), { status: 503, headers: { "content-type": "application/json" } })));
    await expect(api.get("/api/status")).rejects.toMatchObject({
      status: 503, detail: "database unavailable", message: "The server is not answering (status 503). It may be restarting; try again in a moment.",
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 504 })));
    await expect(api.get("/api/status")).rejects.toMatchObject({ message: "The server is not answering (status 504). It may be restarting; try again in a moment." });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "internal error" }), { status: 500, headers: { "content-type": "application/json" } })));
    await expect(api.get("/api/status")).rejects.toMatchObject({ status: 500, message: "internal error" });
  });

  it("turns a fetch that rejects (no network, the connection refused) into an ApiError with status 0 and a plain message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const error = await api.get("/api/sources").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 0, message: "Can't reach the server. Check the network and try again." });
    await expect(api.post("/api/login", {})).rejects.toBeInstanceOf(ApiError);
  });

  it("isUnreachable is true for status 0, 502, 503 and 504 and for nothing else", () => {
    for (const status of [0, 502, 503, 504]) expect(isUnreachable(new ApiError(status, "x")), String(status)).toBe(true);
    for (const status of [200, 400, 401, 403, 404, 409, 422, 500, 501]) expect(isUnreachable(new ApiError(status, "x")), String(status)).toBe(false);
    expect(isUnreachable(new TypeError("Failed to fetch"))).toBe(false);
    expect(isUnreachable(null)).toBe(false);
    expect(isUnreachable(undefined)).toBe(false);
  });

  it("calls the unauthorized handler on 401, except for auth endpoints", async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    try {
      mockFetch({
        "GET /api/assets": { status: 401, body: { detail: "not authenticated" } },
        "GET /api/me": { status: 401, body: { detail: "not authenticated" } },
        "POST /api/login": { status: 401, body: { detail: "bad credentials" } },
        "POST /api/me/password": { status: 401, body: { detail: "current password is incorrect" } },
        "GET /api/sources": { status: 403, body: { detail: "forbidden" } },
      });
      await expect(api.get("/api/assets")).rejects.toBeInstanceOf(ApiError);
      expect(handler).toHaveBeenCalledTimes(1);
      await expect(api.get("/api/me")).rejects.toBeInstanceOf(ApiError);
      await expect(api.post("/api/login", {})).rejects.toBeInstanceOf(ApiError);
      await expect(api.post("/api/me/password", {})).rejects.toBeInstanceOf(ApiError);
      await expect(api.get("/api/sources")).rejects.toBeInstanceOf(ApiError);
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      setUnauthorizedHandler(null);
    }
  });

  it("calls the forbidden handler on 403, except for auth endpoints, and not once it is set to null", async () => {
    const handler = vi.fn();
    setForbiddenHandler(handler);
    try {
      mockFetch({
        "GET /api/sources": { status: 403, body: { detail: "insufficient role" } },
        "GET /api/me": { status: 403, body: { detail: "forbidden" } },
        "POST /api/login": { status: 403, body: { detail: "account disabled" } },
        "POST /api/me/password": { status: 403, body: { detail: "forbidden" } },
        "GET /api/assets": { status: 401, body: { detail: "not authenticated" } },
      });
      await expect(api.get("/api/sources")).rejects.toMatchObject({ status: 403 });
      expect(handler).toHaveBeenCalledTimes(1);
      await expect(api.get("/api/me")).rejects.toBeInstanceOf(ApiError);
      await expect(api.post("/api/login", {})).rejects.toBeInstanceOf(ApiError);
      await expect(api.post("/api/me/password", {})).rejects.toBeInstanceOf(ApiError);
      await expect(api.get("/api/assets")).rejects.toMatchObject({ status: 401 }); // not a 403
      expect(handler).toHaveBeenCalledTimes(1);
      setForbiddenHandler(null);
      await expect(api.get("/api/sources")).rejects.toMatchObject({ status: 403 });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      setForbiddenHandler(null);
    }
  });

  it("notifyForbidden follows the same rules for raw fetches: a handler call, except for auth endpoints and query strings of them", () => {
    const handler = vi.fn();
    setForbiddenHandler(handler);
    try {
      notifyForbidden("/api/billing/costs.csv?month=2026-10");
      expect(handler).toHaveBeenCalledTimes(1);
      notifyForbidden("/api/login");
      notifyForbidden("/api/me?x=1");
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      setForbiddenHandler(null);
    }
    expect(() => notifyForbidden("/api/sources")).not.toThrow(); // no handler registered
  });

  it("put sends JSON body with PUT", async () => {
    const calls = mockFetch({ "PUT /api/settings/general": { body: { timezone: "UTC" } } });
    await expect(api.put("/api/settings/general", { timezone: "UTC" })).resolves.toEqual({ timezone: "UTC" });
    expect(calls[0]).toEqual({ method: "PUT", path: "/api/settings/general", body: { timezone: "UTC" } });
  });

  it("returns undefined on 204", async () => {
    mockFetch({ "DELETE /api/assets/3": { status: 204 } });
    await expect(api.del("/api/assets/3")).resolves.toBeUndefined();
  });

  it("keeps the whole reply body on the ApiError, not only its detail", async () => {
    mockFetch({ "DELETE /api/assets/3": { status: 409, body: { detail: "needs confirm", assets: 2, mappings: 1, tariffs: 0 } } });
    await expect(api.del("/api/assets/3")).rejects.toMatchObject({
      status: 409, detail: "needs confirm", body: { detail: "needs confirm", assets: 2, mappings: 1, tariffs: 0 },
    });
  });

  it("formats a pydantic validation list into one message", () => {
    const err = new ApiError(422, [{ loc: ["body", "config", "url"], msg: "Input should be a valid URL" }]);
    expect(err.message).toBe("config.url: Input should be a valid URL");
  });
});

describe("api.postRaw (a body that is not JSON)", () => {
  // Not mockFetch: it parses every body as JSON, and a file is not.
  const stub = (response: () => Response) => {
    const fetchStub = vi.fn(async (_path: string, _init?: RequestInit) => response());
    vi.stubGlobal("fetch", fetchStub);
    return fetchStub;
  };
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const sent = (fetchStub: ReturnType<typeof stub>) => fetchStub.mock.calls[0][1] as RequestInit;
  const headers = (fetchStub: ReturnType<typeof stub>) => sent(fetchStub).headers as Record<string, string>;

  it("sends the very same Blob, with credentials, text/csv and no JSON encoding, and reads the JSON reply", async () => {
    const fetchStub = stub(json(200, { new: 12 }));
    const file = new Blob(["tag,time,value\n"], { type: "" }); // a file of an unknown extension has no type of its own
    await expect(api.postRaw<{ new: number }>("/api/sources/3/import?dry_run=1", file)).resolves.toEqual({ new: 12 });
    expect(fetchStub.mock.calls[0][0]).toBe("/api/sources/3/import?dry_run=1");
    expect(sent(fetchStub).method).toBe("POST");
    expect(sent(fetchStub).body).toBe(file);
    expect(sent(fetchStub).credentials).toBe("same-origin");
    expect(headers(fetchStub)["content-type"]).toBe("text/csv");
  });

  it("sends a string as it is (not quoted by JSON) and takes another content type when asked", async () => {
    const fetchStub = stub(json(200, {}));
    await api.postRaw("/api/sources/3/tag-list", "tag;asset\nA;B\n");
    expect(sent(fetchStub).body).toBe("tag;asset\nA;B\n");
    expect(headers(fetchStub)["content-type"]).toBe("text/csv");
    const other = stub(json(200, {}));
    await api.postRaw("/api/x", "a", "text/plain");
    expect(headers(other)["content-type"]).toBe("text/plain");
  });

  it("does not change what post, put, get and del send", async () => {
    const fetchStub = stub(json(200, {}));
    await api.post("/api/a", { x: 1 });
    expect(sent(fetchStub).body).toBe('{"x":1}');
    expect(headers(fetchStub)["content-type"]).toBe("application/json");
    const bare = stub(json(200, {}));
    await api.get("/api/a");
    expect(sent(bare).body).toBeUndefined();
    expect(headers(bare)).toEqual({});
  });

  it("refuses like post: the server's sentence is the error's message and the whole body stays on it", async () => {
    stub(json(422, { detail: "the file is not UTF-8; save it as CSV UTF-8" }));
    await expect(api.postRaw("/api/sources/3/import", "x")).rejects.toMatchObject({ status: 422, message: "the file is not UTF-8; save it as CSV UTF-8" });
    stub(json(409, { detail: "an import is running", job_id: 7 }));
    await expect(api.postRaw("/api/sources/3/import", "x")).rejects.toMatchObject({ status: 409, body: { detail: "an import is running", job_id: 7 } });
  });

  it("tells the app about a lost session (401) and a refused role (403), and turns a failed fetch into an ApiError", async () => {
    const unauthorized = vi.fn();
    const forbidden = vi.fn();
    setUnauthorizedHandler(unauthorized);
    setForbiddenHandler(forbidden);
    try {
      stub(json(401, { detail: "not authenticated" }));
      await expect(api.postRaw("/api/sources/3/import", "x")).rejects.toMatchObject({ status: 401 });
      stub(json(403, { detail: "insufficient permission" }));
      await expect(api.postRaw("/api/sources/3/import", "x")).rejects.toMatchObject({ status: 403, message: "Your role does not allow this." });
      expect([unauthorized.mock.calls.length, forbidden.mock.calls.length]).toEqual([1, 1]);
    } finally {
      setUnauthorizedHandler(null);
      setForbiddenHandler(null);
    }
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(api.postRaw("/api/sources/3/import", "x")).rejects.toMatchObject({ status: 0 });
  });
});
