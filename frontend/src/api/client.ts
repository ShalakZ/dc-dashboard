import { noteReach } from "../lib/serverReach";

type ValidationItem = { loc?: (string | number)[]; msg: string };

/** Statuses a proxy answers with when the api behind it does not. */
const NOT_ANSWERING = [502, 503, 504];

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
    // The proxy's own page ("502 Bad Gateway") or whatever the api sent: either way the server is not answering, and that is what the person needs to read.
    if (NOT_ANSWERING.includes(status)) return `The server is not answering (status ${status}). It may be restarting; try again in a moment.`;
    // The one text the api gives for every missing permission (it names none): a sentence for a person, wherever the error is shown.
    if (status === 403 && detail === "insufficient permission") return "Your role does not allow this.";
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

/** No answer from the server: the request never completed (status 0) or the proxy says the api is not there (502, 503, 504). Never a sign-in problem. */
export const isUnreachable = (error: unknown): boolean => error instanceof ApiError && (error.status === 0 || NOT_ANSWERING.includes(error.status));

type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
/** Endpoints where a 401 is an expected answer rather than a lost session (wrong credentials or wrong current password). */
const AUTH_PATHS = new Set(["/api/login", "/api/setup", "/api/me", "/api/me/password"]);

/** Register the callback invoked when any non-auth request answers 401 (session expired). */
export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  onUnauthorized = handler;
}

type ForbiddenHandler = () => void;
let onForbidden: ForbiddenHandler | null = null;

/** Register the callback invoked after any non-auth request answers 403, so the app can check whether the user's role has changed. */
export function setForbiddenHandler(handler: ForbiddenHandler | null): void {
  onForbidden = handler;
}

const isAuthPath = (path: string) => AUTH_PATHS.has(path.split("?")[0]);

/** Tell the app the session is gone (a 401 from anything but the sign-in endpoints). Shared by `request` and raw fetches such as CSV downloads. */
export function notifyUnauthorized(path: string): void {
  if (!isAuthPath(path)) onUnauthorized?.();
}

/** Tell the app a request was refused (a 403 from anything but the sign-in endpoints), so it can check whether the user's role has changed. Shared by `request` and raw fetches such as CSV downloads. */
export function notifyForbidden(path: string): void {
  if (!isAuthPath(path)) onForbidden?.();
}

/** A body that is sent as it is (a file or a pasted list), not as JSON. */
interface RawBody { body: Blob | string; contentType: string }

async function request<T>(method: string, path: string, body?: unknown, raw?: RawBody): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (raw !== undefined) {
    // Always named here: a browser sends no content-type for a file whose extension it does not know, and the server answers 415 to a body it cannot place.
    (init.headers as Record<string, string>)["content-type"] = raw.contentType;
    init.body = raw.body;
  } else if (body !== undefined) {
    (init.headers as Record<string, string>)["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    noteReach(false);
    throw new ApiError(0, "Can't reach the server. Check the network and try again.");
  }
  noteReach(!NOT_ANSWERING.includes(response.status));
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized(path);
    if (response.status === 403) notifyForbidden(path);
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : data;
    throw new ApiError(response.status, detail, data);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  /** POST `body` (a File, a Blob or a string) unchanged, with `contentType` always set; the reply, the refusals and the 401/403 handling are `post`'s. */
  postRaw: <T>(path: string, body: Blob | string, contentType = "text/csv") => request<T>("POST", path, undefined, { body, contentType }),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: (path: string) => request<undefined>("DELETE", path),
};
