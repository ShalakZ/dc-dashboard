import { mockFetch } from "../test/fetchMock";
import { api, ApiError } from "./client";

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

  it("returns undefined on 204", async () => {
    mockFetch({ "DELETE /api/assets/3": { status: 204 } });
    await expect(api.del("/api/assets/3")).resolves.toBeUndefined();
  });

  it("formats a pydantic validation list into one message", () => {
    const err = new ApiError(422, [{ loc: ["body", "config", "url"], msg: "Input should be a valid URL" }]);
    expect(err.message).toBe("config.url: Input should be a valid URL");
  });
});
