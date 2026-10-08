import { ApiError, notifyUnauthorized } from "../api/client";

/** A filename must stay a plain name: path separators from either spelling of the header become underscores. */
const safeName = (name: string) => name.replace(/[\\/]/g, "_");

function filenameOf(disposition: string | null): string {
  if (disposition) {
    const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
    if (encoded) {
      try {
        return safeName(decodeURIComponent(encoded[1].trim()));
      } catch {
        // malformed percent-encoding: fall through to the plain filename
      }
    }
    const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(disposition);
    const name = (plain?.[1] ?? plain?.[2])?.trim();
    if (name) return safeName(name);
  }
  return "export.csv";
}

/** Fetch a CSV export (with the session cookie) and hand it to the browser as a file download. Throws ApiError on a non-2xx answer. */
export async function downloadCsv(path: string, init: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<void> {
  const headers: Record<string, string> = {};
  const request: RequestInit = { method: init.method ?? "GET", credentials: "same-origin", headers };
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    request.body = JSON.stringify(init.body);
  }
  const response = await fetch(path, request);
  if (!response.ok) {
    if (response.status === 401) notifyUnauthorized(path);
    const text = await response.text();
    let detail: unknown = text || null;
    try {
      const data: unknown = text ? JSON.parse(text) : null;
      detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : data;
    } catch {
      // not JSON: the plain text is the detail
    }
    throw new ApiError(response.status, detail);
  }
  // blob(), not text(): text() would drop the byte-order mark that makes Excel read the file as UTF-8.
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filenameOf(response.headers.get("content-disposition"));
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
