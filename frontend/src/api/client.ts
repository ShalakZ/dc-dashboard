type ValidationItem = { loc?: (string | number)[]; msg: string };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: unknown,
    /** The whole reply body (parsed JSON, else the raw text), for replies that carry more than `detail`. */
    public readonly body?: unknown,
  ) {
    super(ApiError.describe(status, detail));
    this.name = "ApiError";
  }

  static describe(status: number, detail: unknown): string {
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
      return (detail as ValidationItem[])
        .map((item) => {
          const loc = (item.loc ?? []).filter((part) => part !== "body").join(".");
          return loc ? `${loc}: ${item.msg}` : item.msg;
        })
        .join("; ");
    }
    return `request failed with status ${status}`;
  }
}

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
/** Endpoints where a 401 is an expected answer rather than a lost session (wrong credentials or wrong current password). */
const AUTH_PATHS = new Set(["/api/login", "/api/setup", "/api/me", "/api/me/password"]);

/** Register the callback invoked when any non-auth request answers 401 (session expired). */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    if (response.status === 401 && !AUTH_PATHS.has(path.split("?")[0])) onUnauthorized?.();
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : data;
    throw new ApiError(response.status, detail, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: (path: string) => request<undefined>("DELETE", path),
};
