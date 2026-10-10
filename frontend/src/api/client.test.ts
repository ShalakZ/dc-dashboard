import { mockFetch } from "../test/fetchMock";
import { api, ApiError, notifyForbidden, setForbiddenHandler, setUnauthorizedHandler } from "./client";

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

  it("reads Caddy's plain-text 502 (the api is restarting) as an ApiError, the way it read the empty body before", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("502 Bad Gateway", { status: 502, headers: { "content-type": "text/plain" } })));
    await expect(api.get("/api/sources")).rejects.toMatchObject({ status: 502, detail: "502 Bad Gateway", message: "502 Bad Gateway" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    await expect(api.get("/api/sources")).rejects.toMatchObject({ status: 502, message: "request failed with status 502" });
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
