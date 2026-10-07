# Phase 1B — Web UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser UI, served by Caddy on port 80, through which an admin completes first-run setup, adds the simulator as a source, tests and browses it, maps points to assets, and sees live and historical values on an asset page.

**Architecture:** A React single-page app built by Vite into static files. A new `web` service (Caddy) serves those files and reverse-proxies `/api` to `api:8000`, so the browser, the cookie session and the SSE stream are all same-origin. The UI holds no business rules: it renders what the API returns, and the API keeps enforcing roles. A thin pure-TypeScript layer (`src/lib/`) holds the logic that is worth unit-testing without a DOM.

**Tech Stack:** Node 22 (Docker) / Node 25 (dev machine), npm, Vite 6, React 19, TypeScript 5, TanStack Query 5, react-router 7, ECharts 5 (`echarts-for-react`), Vitest 3 + React Testing Library + jsdom, Caddy 2.

**Spec:** `docs/superpowers/specs/2026-10-06-dc-dashboard-design.md` (section 9 screens, section 3 `web` service)

**Prerequisite:** branch `phase-1a-backend` merged or checked out; its API is the source of truth for every contract below (verified against `backend/dcdash/api/*.py` on 2026-10-07).

## Scope

| Plan | Contents |
|---|---|
| 1A (done) | Compose stack, schema, connectors, collector, auth, sources / assets / mappings / data / stream API |
| **1B (this plan)** | `frontend/` React app: Setup, Login, Assets, Asset page, Sources (add / test / browse / map); `web` Caddy service; dev proxy; README |
| 1C | Storage panel, Users screen, OPC UA and Modbus connectors, rollup tiers, backup / restore, Playwright end-to-end test |

Deliberate choices:

- No component library and no CSS framework: one `app.css`, black on white, tables and forms with browser defaults plus spacing.
- No new backend endpoints are needed. The asset page reads `GET /api/assets/{id}/summary` (which embeds the asset) and the points table reads mappings from `GET /api/sources/{id}/points` (which embeds each point's mapping). Both were checked against the code.
- `GET /api/connectors` is admin-only in the API, so the add-source form is shown to admins only; operators see the list, status and test buttons.
- Vitest tests mock `fetch` with a small helper instead of MSW: fewer dependencies, and every test states its own responses inline.
- `scripts/smoke.py` keeps its optional URL argument; its default becomes `http://localhost` because the API port is no longer published. Inside Compose the API stays reachable as `api:8000`.
- The Docker build uses Node 22 LTS; development on the machine's Node 25 is fine because nothing here depends on Node features beyond ES2022.

## Global Constraints

- All frontend commands run from `frontend/` with `npm` (never pnpm or yarn). `package-lock.json` is committed.
- TypeScript `strict: true`; `npm run typecheck` (`tsc --noEmit`) must pass before every commit.
- The UI never stores a token: authentication is the HTTP-only cookie set by the API; every `fetch` uses `credentials: "same-origin"`.
- The UI hides what a role cannot do; it never assumes the API will allow it. A 403 is rendered as an error, not swallowed.
- Values are never invented: a metric with `value: null` shows `—`; a chart bucket missing from the series is a gap (`connectNulls: false`).
- All timestamps from the API are ISO-8601 with offset; the UI formats them in the browser's locale and never does date arithmetic on strings.
- Secrets typed into forms are sent once in a request body and never written to state after submit, never logged, never echoed.
- `/api` is the only path the browser calls; in development Vite proxies it to `http://localhost:8000`, in production Caddy proxies it to `api:8000`.
- Work on branch `phase-1b-web-ui`. After each task's commit, `git push -u origin phase-1b-web-ui`.
- Commit messages end with the attribution trailer the executing session specifies.
- Nothing Windows-specific: LF line endings (already enforced by `.gitattributes`).

## Review Focus

Conditions most likely to hurt a real user. Each is pinned by a named test in the task that owns the code.

1. **The session expires while the user is on a page.** Expected: the next API call's 401 sends the user to Login and the page they were on is restored after signing in; no blank screens. Tests: Task 4 `test_login_redirects_back_after_401` (in `AuthProvider.test.tsx`), Task 1 `throws ApiError with status on non-2xx` (in `client.test.ts`).
2. **The SSE stream carries a value for a point that is not on the page, or a `null` value.** Expected: unknown points are ignored, `null` shows `—` and the previous value is not kept. Tests: Task 3 `ignores points not in the map` and `null value replaces previous value` (in `stream.test.ts`); Task 6 `renders live value from stream and dash for null` (in `AssetPage.test.tsx`).
3. **A connector's schema has a default or a non-string type.** Expected: the form pre-fills defaults, submits numbers as numbers and booleans as booleans, and never sends an empty string for an omitted optional field. Tests: Task 3 `coerces number, integer and boolean` and `drops empty optional strings but keeps empty required ones` (in `schemaForm.test.ts`); Task 9 `submits typed config and secret separately` (in `SchemaForm.test.tsx`).
4. **"Test connection" is slow or fails.** Expected: the button shows `running…`, polling stops on `done` or `failed`, and the result status and message are shown; a failed job shows its `error`. Tests: Task 8 `polls until done and shows status`, `shows error from failed job` (in `useJob.test.tsx`).
5. **Today's energy is estimated from power, or there is no energy at all.** Expected: the tile shows `estimated` when `estimated: true`, and `no energy data` when `energy_today` is `null`. Test: Task 6 `labels estimated energy and handles missing energy` (in `AssetPage.test.tsx`).

## File Structure

```
compose.yaml                       + web service, api port removed
deploy/Caddyfile                   serve dist, proxy /api
frontend/
  package.json  package-lock.json  tsconfig.json  vite.config.ts  index.html  Dockerfile  .dockerignore
  src/
    main.tsx                       React root, QueryClient, router
    app.css
    api/
      client.ts                    fetch wrapper, ApiError
      types.ts                     API shapes (mirrors Pydantic models)
      queries.ts                   TanStack Query hooks per endpoint
    lib/
      tree.ts                      flat assets -> tree
      timeRange.ts                 range picker -> start/end/buckets
      schemaForm.ts                JSON Schema -> form fields, coercion
      stream.ts                    SSE message parsing into point_id -> value
    auth/
      AuthProvider.tsx             /api/setup + /api/me, login/logout, role helpers
      RequireAuth.tsx              route guard
    pages/
      SetupPage.tsx  LoginPage.tsx
      AssetsPage.tsx  AssetPage.tsx
      SourcesPage.tsx  SourcePointsPage.tsx
    components/
      Layout.tsx                   nav (role-aware), outlet
      AssetTree.tsx  AssetForm.tsx
      TrendChart.tsx  RangePicker.tsx  MetricsTable.tsx  EnergyTile.tsx
      SchemaForm.tsx  SourceForm.tsx  JobStatus.tsx  MappingForm.tsx
    hooks/
      useStream.ts                 EventSource subscription
      useJob.ts                    poll GET /api/jobs/{id}
    test/
      setup.ts                     jest-dom matchers
      fetchMock.ts                 route-table fetch mock
      render.tsx                   renderWithProviders
    **/*.test.ts(x)
scripts/smoke.py                   default URL -> http://localhost
README.md                          Run it / Status / Develop updated
```

---

### Task 1: Frontend scaffold, API client and dev proxy

**Files:**
- Create: `frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.ts`, `frontend/index.html`, `frontend/.dockerignore`
- Create: `frontend/src/main.tsx`, `frontend/src/app.css`, `frontend/src/api/client.ts`, `frontend/src/api/types.ts`
- Create: `frontend/src/test/setup.ts`, `frontend/src/test/fetchMock.ts`
- Test: `frontend/src/api/client.test.ts`

**Interfaces:**
- Produces: `api.get<T>(path)`, `api.post<T>(path, body?)`, `api.patch<T>(path, body)`, `api.del(path)` in `src/api/client.ts`; all throw `ApiError { status: number; detail: unknown }` on non-2xx and return `undefined` on 204.
- Produces: `src/api/types.ts` with `User`, `Asset`, `Source`, `Connector`, `PointRow`, `Mapping`, `Summary`, `Series`, `Job`, `Metric` (mirroring the Pydantic models in `backend/dcdash/api/*.py`).
- Produces: `mockFetch(routes)` in `src/test/fetchMock.ts` where `routes` maps `"GET /api/me"` style keys to `{ status, body }` or a function of the request.

- [x] **Step 1: Create the branch and scaffold**

```bash
git checkout -b phase-1b-web-ui
mkdir -p frontend/src/{api,lib,auth,pages,components,hooks,test}
```

`frontend/package.json`:

```json
{
  "name": "dcdash-frontend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.59.0",
    "echarts": "^5.5.1",
    "echarts-for-react": "^3.0.2",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router": "^7.1.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "jsdom": "^26.0.0",
    "typescript": "~5.7.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

`frontend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`frontend/vite.config.ts`:

```ts
/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: false },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    css: false,
  },
});
```

`frontend/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>DC Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`frontend/.dockerignore`:

```
node_modules
dist
```

`frontend/src/app.css`:

```css
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.4 system-ui, sans-serif; color: #000; background: #fff; }
a { color: #000; }
nav { display: flex; gap: 16px; padding: 8px 16px; border-bottom: 1px solid #000; align-items: center; }
nav .spacer { flex: 1; }
main { padding: 16px; max-width: 1200px; }
table { border-collapse: collapse; width: 100%; margin: 8px 0; }
th, td { border: 1px solid #000; padding: 4px 8px; text-align: left; vertical-align: top; }
form { display: grid; gap: 8px; max-width: 480px; margin: 8px 0; }
label { display: grid; gap: 2px; }
button { padding: 4px 10px; cursor: pointer; }
.error { color: #b00; }
.muted { color: #555; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.tile { border: 1px solid #000; padding: 12px; min-width: 180px; display: inline-block; margin-right: 12px; }
.tile .big { font-size: 28px; }
ul.tree, ul.tree ul { list-style: none; padding-left: 20px; margin: 0; }
ul.tree li { margin: 2px 0; }
.selected { font-weight: bold; }
```

- [x] **Step 2: Write the failing API client test**

`frontend/src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
```

`frontend/src/test/fetchMock.ts`:

```ts
type Reply = { status?: number; body?: unknown };
type Handler = Reply | ((req: { url: string; body: unknown }) => Reply);
export type Routes = Record<string, Handler>;

/** Install a fetch mock keyed by "METHOD /path" (query string ignored). Returns the recorded calls. */
export function mockFetch(routes: Routes) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const handler = routes[`${method} ${path}`];
      if (handler === undefined) {
        return new Response(JSON.stringify({ detail: `no mock for ${method} ${path}` }), { status: 500 });
      }
      const reply = typeof handler === "function" ? handler({ url, body }) : handler;
      const status = reply.status ?? 200;
      if (status === 204) return new Response(null, { status });
      return new Response(JSON.stringify(reply.body ?? {}), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}
```

`frontend/src/api/client.test.ts`:

```ts
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
```

- [x] **Step 3: Install and run the test to see it fail**

```bash
cd frontend && npm install
npm test -- src/api/client.test.ts
```

Expected: `Error: Failed to resolve import "./client"`.

- [x] **Step 4: Implement the client and types**

`frontend/src/api/client.ts`:

```ts
type ValidationItem = { loc?: (string | number)[]; msg: string };

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: unknown,
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
    const detail = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : data;
    throw new ApiError(response.status, detail);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: (path: string) => request<undefined>("DELETE", path),
};
```

`frontend/src/api/types.ts` (every field verified against the backend response models):

```ts
export type Role = "viewer" | "operator" | "admin";
export const ROLE_LEVEL: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };

export interface User { id: number; username: string; role: Role }

export interface Asset { id: number; parent_id: number | null; name: string; kind: string; sort_order: number }
export interface AssetIn { name: string; parent_id: number | null; kind: string; sort_order: number }

export interface Source {
  id: number; name: string; connector_type: string; config: Record<string, unknown>;
  enabled: boolean; status: string; last_seen: string | null; last_error: string | null; has_secret: boolean;
}
export interface SourceIn {
  name: string; connector_type: string; config: Record<string, unknown>; secret?: string | null; enabled: boolean;
}

export interface JsonSchema {
  type?: string; title?: string; properties?: Record<string, JsonSchemaProperty>; required?: string[];
}
export interface JsonSchemaProperty {
  type?: string; title?: string; description?: string; default?: unknown; format?: string;
  anyOf?: { type?: string; format?: string }[]; minimum?: number; maximum?: number;
}
export interface Connector { type: string; config_schema: JsonSchema }

export const METRICS = [
  "active_power_kw", "energy_kwh", "voltage_v", "current_a", "power_factor",
  "frequency_hz", "reactive_power_kvar", "apparent_power_kva", "custom",
] as const;
export type Metric = (typeof METRICS)[number];

export interface Mapping {
  id: number; point_id: number; asset_id: number; metric: Metric; scale: number;
  interval_seconds: number; custom_unit: string | null;
}
export interface MappingIn {
  point_id: number; asset_id: number; metric: Metric; scale: number;
  interval_seconds: number | null; custom_unit: string | null;
}
/** Row of GET /api/sources/{id}/points: mapping is embedded (without point_id). */
export interface PointRow {
  id: number; address: string; name: string; data_type: string; unit_hint: string | null;
  mapping: Omit<Mapping, "point_id"> | null;
}

export interface SummaryMetric {
  mapping_id: number; point_id: number; metric: Metric; unit: string;
  value: number | null; ts: string | null; quality: number | null;
}
export interface Summary {
  asset: { id: number; name: string; parent_id: number | null; kind: string };
  metrics: SummaryMetric[];
  energy_today: { kwh: number; estimated: boolean } | null;
}
export interface SeriesPoint { ts: string; avg: number; min: number; max: number }
export interface Series { metric: Metric; unit: string; points: SeriesPoint[] }

export type JobStatus = "pending" | "running" | "done" | "failed";
export interface Job {
  id: number; kind: string; status: JobStatus; result: Record<string, unknown> | null;
  created_at: string; finished_at: string | null;
}
/** result of a done test_source job (dataclasses.asdict(ConnectionCheck)) */
export interface CheckResult { ok: boolean; status: string; latency_ms: number | null; message: string }
```

`frontend/src/main.tsx` (placeholder until Task 4 adds the router):

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <p>DC Dashboard</p>
  </StrictMode>,
);
```

- [x] **Step 5: Run the tests, typecheck and the dev server**

```bash
npm test -- src/api/client.test.ts
npm run typecheck
npm run dev -- --host 127.0.0.1 &
curl -s http://127.0.0.1:5173/ | grep -c "DC Dashboard"
kill %1
```

Expected: `Tests  4 passed (4)`; typecheck prints nothing; curl prints `1`.

- [x] **Step 6: Commit and push**

```bash
cd .. && git add frontend && git commit -m "Scaffold frontend with Vite, API client and fetch mock" && git push -u origin phase-1b-web-ui
```

---

### Task 2: Pure modules — asset tree and time ranges

**Files:**
- Create: `frontend/src/lib/tree.ts`, `frontend/src/lib/timeRange.ts`
- Test: `frontend/src/lib/tree.test.ts`, `frontend/src/lib/timeRange.test.ts`

**Interfaces:**
- Produces: `buildTree(assets: Asset[]): TreeNode[]` with `TreeNode = Asset & { children: TreeNode[] }`, siblings ordered by `sort_order` then `name`; an asset whose parent is absent becomes a root. `descendantIds(nodes, id): Set<number>` returns `id` and everything below it (used to block moving an asset under itself).
- Produces: `RANGES = ["1h", "6h", "24h", "7d"]`, `type Range`, `rangeToQuery(range, now = new Date()): { start: string; end: string; buckets: number }` with ISO strings and `buckets` of 300 for all ranges (the API caps at 2000; 300 keeps charts readable).

- [x] **Step 1: Write the failing tests**

`frontend/src/lib/tree.test.ts`:

```ts
import type { Asset } from "../api/types";
import { buildTree, descendantIds } from "./tree";

const a = (id: number, parent_id: number | null, name: string, sort_order = 0): Asset => ({
  id, parent_id, name, kind: "generic", sort_order,
});

describe("buildTree", () => {
  it("nests children under parents and sorts by sort_order then name", () => {
    const tree = buildTree([a(3, 1, "b"), a(1, null, "Site"), a(2, 1, "a"), a(4, 1, "z", -1)]);
    expect(tree.map((n) => n.id)).toEqual([1]);
    expect(tree[0].children.map((n) => n.name)).toEqual(["z", "a", "b"]);
  });

  it("treats an asset with a missing parent as a root", () => {
    const tree = buildTree([a(5, 99, "orphan"), a(1, null, "Site")]);
    expect(tree.map((n) => n.name)).toEqual(["Site", "orphan"]);
  });

  it("returns an empty list for no assets", () => {
    expect(buildTree([])).toEqual([]);
  });
});

describe("descendantIds", () => {
  it("includes the node itself and all descendants", () => {
    const tree = buildTree([a(1, null, "Site"), a(2, 1, "Room"), a(3, 2, "Rack"), a(4, 1, "Other")]);
    expect([...descendantIds(tree, 2)].sort()).toEqual([2, 3]);
    expect([...descendantIds(tree, 9)]).toEqual([]);
  });
});
```

`frontend/src/lib/timeRange.test.ts`:

```ts
import { RANGES, rangeToQuery } from "./timeRange";

describe("rangeToQuery", () => {
  const now = new Date("2026-10-07T12:00:00Z");

  it.each([
    ["1h", "2026-10-07T11:00:00.000Z"],
    ["6h", "2026-10-07T06:00:00.000Z"],
    ["24h", "2026-10-06T12:00:00.000Z"],
    ["7d", "2026-09-30T12:00:00.000Z"],
  ] as const)("%s starts at %s", (range, start) => {
    const q = rangeToQuery(range, now);
    expect(q.start).toBe(start);
    expect(q.end).toBe("2026-10-07T12:00:00.000Z");
    expect(q.buckets).toBe(300);
  });

  it("lists the four ranges in order", () => {
    expect(RANGES).toEqual(["1h", "6h", "24h", "7d"]);
  });
});
```

- [x] **Step 2: Run the tests to see them fail**

```bash
npm test -- src/lib
```

Expected: two `Failed to resolve import` errors.

- [x] **Step 3: Implement**

`frontend/src/lib/tree.ts`:

```ts
import type { Asset } from "../api/types";

export type TreeNode = Asset & { children: TreeNode[] };

function compare(x: Asset, y: Asset): number {
  return x.sort_order - y.sort_order || x.name.localeCompare(y.name);
}

export function buildTree(assets: Asset[]): TreeNode[] {
  const nodes = new Map<number, TreeNode>();
  for (const asset of assets) nodes.set(asset.id, { ...asset, children: [] });
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id === null ? undefined : nodes.get(node.parent_id);
    (parent ? parent.children : roots).push(node);
  }
  const sortAll = (list: TreeNode[]) => {
    list.sort(compare);
    list.forEach((node) => sortAll(node.children));
  };
  sortAll(roots);
  return roots;
}

export function descendantIds(nodes: TreeNode[], id: number): Set<number> {
  const out = new Set<number>();
  const collect = (node: TreeNode) => {
    out.add(node.id);
    node.children.forEach(collect);
  };
  const find = (list: TreeNode[]): TreeNode | undefined => {
    for (const node of list) {
      if (node.id === id) return node;
      const hit = find(node.children);
      if (hit) return hit;
    }
    return undefined;
  };
  const start = find(nodes);
  if (start) collect(start);
  return out;
}
```

`frontend/src/lib/timeRange.ts`:

```ts
export const RANGES = ["1h", "6h", "24h", "7d"] as const;
export type Range = (typeof RANGES)[number];

const HOURS: Record<Range, number> = { "1h": 1, "6h": 6, "24h": 24, "7d": 168 };

export function rangeToQuery(range: Range, now: Date = new Date()) {
  const end = now;
  const start = new Date(end.getTime() - HOURS[range] * 3600_000);
  return { start: start.toISOString(), end: end.toISOString(), buckets: 300 };
}
```

- [x] **Step 4: Run the tests**

```bash
npm test -- src/lib && npm run typecheck
```

Expected: `Tests  9 passed (9)`.

- [x] **Step 5: Commit and push**

```bash
git add frontend/src/lib && git commit -m "Add asset tree and time range helpers" && git push
```

---

### Task 3: Pure modules — JSON Schema form fields and SSE parsing

**Files:**
- Create: `frontend/src/lib/schemaForm.ts`, `frontend/src/lib/stream.ts`
- Test: `frontend/src/lib/schemaForm.test.ts`, `frontend/src/lib/stream.test.ts`

**Interfaces:**
- Produces: `FormField { name; label; kind: "string" | "number" | "integer" | "boolean"; required; default?: unknown; description? }`, `fieldsFromSchema(schema: JsonSchema): FormField[]` (property order preserved; `anyOf` with a `null` member means optional; unknown types fall back to `string`), `initialValues(fields): Record<string, string | boolean>`, `coerceValues(fields, raw): Record<string, unknown>` (numbers parsed, booleans passed through, empty optional strings dropped, empty required strings kept so the API reports them).
- Produces: `LiveValue { ts: string; value: number | null; quality: number }`, `parseStreamMessage(data: string): [number, LiveValue][]` (invalid JSON yields `[]`), `applyUpdates(current: Map<number, LiveValue>, updates, wanted: Set<number>): Map<number, LiveValue>` returning a new Map only when something in `wanted` changed.

- [x] **Step 1: Write the failing tests**

`frontend/src/lib/schemaForm.test.ts`:

```ts
import type { JsonSchema } from "../api/types";
import { coerceValues, fieldsFromSchema, initialValues } from "./schemaForm";

// Exactly what pydantic emits for SimulatorConfig (backend/dcdash/connectors/simulator.py).
const simulator: JsonSchema = {
  type: "object",
  title: "SimulatorConfig",
  properties: {
    url: { type: "string", format: "uri", minLength: 1, title: "Url", default: "http://simulator:9000" } as never,
    timeout_seconds: { type: "number", title: "Timeout Seconds", default: 5.0 },
  },
};

const mixed: JsonSchema = {
  type: "object",
  required: ["host", "port"],
  properties: {
    host: { type: "string", title: "Host" },
    port: { type: "integer", title: "Port", default: 502 },
    tls: { type: "boolean", title: "Tls", default: false },
    note: { anyOf: [{ type: "string" }, { type: "null" }], title: "Note", default: null },
  },
};

describe("fieldsFromSchema", () => {
  it("keeps property order, labels, kinds and defaults", () => {
    expect(fieldsFromSchema(simulator)).toEqual([
      { name: "url", label: "Url", kind: "string", required: false, default: "http://simulator:9000", description: undefined },
      { name: "timeout_seconds", label: "Timeout Seconds", kind: "number", required: false, default: 5.0, description: undefined },
    ]);
  });

  it("marks required fields and unwraps anyOf-with-null as optional", () => {
    const fields = fieldsFromSchema(mixed);
    expect(fields.map((f) => [f.name, f.kind, f.required])).toEqual([
      ["host", "string", true], ["port", "integer", true], ["tls", "boolean", false], ["note", "string", false],
    ]);
  });
});

describe("initialValues / coerceValues", () => {
  it("pre-fills defaults as strings and booleans", () => {
    expect(initialValues(fieldsFromSchema(mixed))).toEqual({ host: "", port: "502", tls: false, note: "" });
  });

  it("coerces number, integer and boolean", () => {
    const fields = fieldsFromSchema(mixed);
    expect(coerceValues(fields, { host: "10.0.0.1", port: "503", tls: true, note: "x" })).toEqual({
      host: "10.0.0.1", port: 503, tls: true, note: "x",
    });
  });

  it("drops empty optional strings but keeps empty required ones", () => {
    const fields = fieldsFromSchema(mixed);
    expect(coerceValues(fields, { host: "", port: "502", tls: false, note: "" })).toEqual({
      host: "", port: 502, tls: false,
    });
  });

  it("passes a non-numeric number field through as a string so the API rejects it", () => {
    expect(coerceValues(fieldsFromSchema(simulator), { url: "http://x", timeout_seconds: "abc" })).toEqual({
      url: "http://x", timeout_seconds: "abc",
    });
  });
});
```

`frontend/src/lib/stream.test.ts`:

```ts
import { applyUpdates, parseStreamMessage, type LiveValue } from "./stream";

// One dcdash_latest message after Broadcaster.publish_raw: [point_id, ts, scaled value | null, quality]
const message = JSON.stringify([
  [7, "2026-10-07T10:00:00+00:00", 12.5, 0],
  [8, "2026-10-07T10:00:00+00:00", null, 1],
]);

describe("parseStreamMessage", () => {
  it("parses rows into point_id / LiveValue pairs", () => {
    expect(parseStreamMessage(message)).toEqual([
      [7, { ts: "2026-10-07T10:00:00+00:00", value: 12.5, quality: 0 }],
      [8, { ts: "2026-10-07T10:00:00+00:00", value: null, quality: 1 }],
    ]);
  });

  it("returns an empty list for malformed data", () => {
    expect(parseStreamMessage("not json")).toEqual([]);
    expect(parseStreamMessage('{"a":1}')).toEqual([]);
  });
});

describe("applyUpdates", () => {
  const v = (value: number | null): LiveValue => ({ ts: "t", value, quality: 0 });

  it("ignores points not in the map", () => {
    const current = new Map([[7, v(1)]]);
    const next = applyUpdates(current, [[99, v(5)]], new Set([7]));
    expect(next).toBe(current);
  });

  it("null value replaces previous value", () => {
    const next = applyUpdates(new Map([[7, v(1)]]), [[7, v(null)]], new Set([7]));
    expect(next.get(7)?.value).toBeNull();
  });

  it("returns a new map when a wanted point changes", () => {
    const current = new Map<number, LiveValue>();
    const next = applyUpdates(current, [[7, v(3)], [8, v(4)]], new Set([7, 8]));
    expect(next).not.toBe(current);
    expect([...next.keys()]).toEqual([7, 8]);
  });
});
```

- [x] **Step 2: Run the tests to see them fail**

```bash
npm test -- src/lib/schemaForm.test.ts src/lib/stream.test.ts
```

Expected: `Failed to resolve import "./schemaForm"` and `"./stream"`.

- [x] **Step 3: Implement**

`frontend/src/lib/schemaForm.ts`:

```ts
import type { JsonSchema, JsonSchemaProperty } from "../api/types";

export type FieldKind = "string" | "number" | "integer" | "boolean";
export interface FormField {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  default?: unknown;
  description?: string;
}

const KINDS: FieldKind[] = ["string", "number", "integer", "boolean"];

function kindOf(property: JsonSchemaProperty): FieldKind {
  const candidates = property.anyOf
    ? property.anyOf.map((option) => option.type).filter((t) => t !== "null")
    : [property.type];
  const first = candidates[0];
  return KINDS.includes(first as FieldKind) ? (first as FieldKind) : "string";
}

export function fieldsFromSchema(schema: JsonSchema): FormField[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([name, property]) => ({
    name,
    label: property.title ?? name,
    kind: kindOf(property),
    required: required.has(name),
    default: property.default,
    description: property.description,
  }));
}

export type RawValues = Record<string, string | boolean>;

export function initialValues(fields: FormField[]): RawValues {
  const out: RawValues = {};
  for (const field of fields) {
    if (field.kind === "boolean") out[field.name] = field.default === true;
    else out[field.name] = field.default === undefined || field.default === null ? "" : String(field.default);
  }
  return out;
}

export function coerceValues(fields: FormField[], raw: RawValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = raw[field.name];
    if (field.kind === "boolean") {
      out[field.name] = value === true;
      continue;
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (text === "") {
      if (field.required) out[field.name] = "";
      continue;
    }
    if (field.kind === "number" || field.kind === "integer") {
      const parsed = field.kind === "integer" ? Number.parseInt(text, 10) : Number.parseFloat(text);
      out[field.name] = Number.isFinite(parsed) && String(parsed) === text ? parsed : text;
    } else {
      out[field.name] = text;
    }
  }
  return out;
}
```

`frontend/src/lib/stream.ts`:

```ts
export interface LiveValue {
  ts: string;
  value: number | null;
  quality: number;
}

/** Parse one SSE `data:` payload: a JSON list of [point_id, ts, value|null, quality]. */
export function parseStreamMessage(data: string): [number, LiveValue][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: [number, LiveValue][] = [];
  for (const row of parsed) {
    if (!Array.isArray(row) || row.length < 4 || typeof row[0] !== "number") continue;
    const [pointId, ts, value, quality] = row as [number, string, number | null, number];
    out.push([pointId, { ts, value: typeof value === "number" ? value : null, quality }]);
  }
  return out;
}

export function applyUpdates(
  current: Map<number, LiveValue>,
  updates: [number, LiveValue][],
  wanted: Set<number>,
): Map<number, LiveValue> {
  let next: Map<number, LiveValue> | null = null;
  for (const [pointId, live] of updates) {
    if (!wanted.has(pointId)) continue;
    next ??= new Map(current);
    next.set(pointId, live);
  }
  return next ?? current;
}
```

- [x] **Step 4: Run the tests**

```bash
npm test -- src/lib && npm run typecheck
```

Expected: `Tests  20 passed (20)`.

- [x] **Step 5: Commit and push**

```bash
git add frontend/src/lib && git commit -m "Add JSON Schema form and SSE parsing helpers" && git push
```

---

### Task 4: Auth provider, Setup, Login, layout and router

**Files:**
- Create: `frontend/src/api/queries.ts`, `frontend/src/auth/AuthProvider.tsx`, `frontend/src/auth/RequireAuth.tsx`
- Create: `frontend/src/components/Layout.tsx`, `frontend/src/pages/SetupPage.tsx`, `frontend/src/pages/LoginPage.tsx`
- Create: `frontend/src/test/render.tsx`
- Modify: `frontend/src/main.tsx`
- Test: `frontend/src/auth/AuthProvider.test.tsx`, `frontend/src/pages/LoginPage.test.tsx`

**Interfaces:**
- Produces: `useAuth(): { user: User | null; setupNeeded: boolean; loading: boolean; login(username, password): Promise<void>; setup(username, password): Promise<void>; logout(): Promise<void>; hasRole(min: Role): boolean }`.
- Produces: `routes` in `main.tsx`: `/setup`, `/login`, and under `RequireAuth` + `Layout`: `/` (redirects to `/assets`), `/assets`, `/assets/:id`, `/sources`, `/sources/:id/points`.
- Produces: `renderWithProviders(ui, { route })` in `src/test/render.tsx`: QueryClient (retry off) + MemoryRouter + AuthProvider.
- Produces: `queries.ts` hooks used by later tasks: `useAssets`, `useSummary(id)`, `useSeries(id, metric, range)`, `useSources`, `useConnectors`, `usePoints(sourceId)`; mutation helpers `useInvalidate(keys)`.

- [x] **Step 1: Write the failing tests**

`frontend/src/test/render.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { AuthProvider } from "../auth/AuthProvider";

export function renderWithProviders(ui: ReactElement, { route = "/", path = "*" } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <Routes>
            <Route path={path} element={ui} />
            <Route path="/login" element={<p>login page</p>} />
            <Route path="/setup" element={<p>setup page</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
```

`frontend/src/auth/AuthProvider.test.tsx`:

```tsx
import { screen, waitFor } from "@testing-library/react";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { RequireAuth } from "./RequireAuth";
import { useAuth } from "./AuthProvider";

function WhoAmI() {
  const { user, hasRole } = useAuth();
  return <p>{user?.username} admin:{String(hasRole("admin"))} operator:{String(hasRole("operator"))}</p>;
}

describe("AuthProvider", () => {
  it("redirects to /setup when no user exists yet", async () => {
    mockFetch({ "GET /api/setup": { body: { needed: true } }, "GET /api/me": { status: 401, body: { detail: "x" } } });
    renderWithProviders(<RequireAuth><WhoAmI /></RequireAuth>, { route: "/assets" });
    expect(await screen.findByText("setup page")).toBeInTheDocument();
  });

  it("test_login_redirects_back_after_401: unauthenticated users go to login with the return path", async () => {
    mockFetch({ "GET /api/setup": { body: { needed: false } }, "GET /api/me": { status: 401, body: { detail: "x" } } });
    renderWithProviders(<RequireAuth><WhoAmI /></RequireAuth>, { route: "/assets/4" });
    expect(await screen.findByText("login page")).toBeInTheDocument();
    expect(sessionStorage.getItem("dcdash.returnTo")).toBe("/assets/4");
  });

  it("exposes the user and role checks", async () => {
    mockFetch({
      "GET /api/setup": { body: { needed: false } },
      "GET /api/me": { body: { id: 1, username: "op", role: "operator" } },
    });
    renderWithProviders(<RequireAuth><WhoAmI /></RequireAuth>);
    await waitFor(() => expect(screen.getByText(/op admin:false operator:true/)).toBeInTheDocument());
  });
});
```

`frontend/src/pages/LoginPage.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { LoginPage } from "./LoginPage";

const base = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { status: 401, body: { detail: "x" } } };

describe("LoginPage", () => {
  it("posts credentials and navigates to the stored return path", async () => {
    sessionStorage.setItem("dcdash.returnTo", "/assets/4");
    const calls = mockFetch({ ...base, "POST /api/login": { body: { id: 1, username: "admin", role: "admin" } } });
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "secret-123");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ username: "admin", password: "secret-123" });
    expect(sessionStorage.getItem("dcdash.returnTo")).toBeNull();
  });

  it("shows the API's message on a failed login", async () => {
    mockFetch({ ...base, "POST /api/login": { status: 401, body: { detail: "invalid username or password" } } });
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("invalid username or password")).toBeInTheDocument();
  });

  it("shows the lockout message on 429", async () => {
    mockFetch({ ...base, "POST /api/login": { status: 429, body: { detail: "too many failed attempts, try again later" } } });
    renderWithProviders(<LoginPage />, { route: "/login", path: "/login" });
    await userEvent.type(await screen.findByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("too many failed attempts, try again later")).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run the tests to see them fail**

```bash
npm test -- src/auth src/pages/LoginPage.test.tsx
```

Expected: `Failed to resolve import "../auth/AuthProvider"`.

- [x] **Step 3: Implement queries, auth, pages, layout and router**

`frontend/src/api/queries.ts`:

```ts
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { rangeToQuery, type Range } from "../lib/timeRange";
import { api } from "./client";
import type { Asset, Connector, Metric, PointRow, Series, Source, Summary } from "./types";

export const keys = {
  assets: ["assets"] as const,
  summary: (id: number) => ["assets", id, "summary"] as const,
  series: (id: number, metric: Metric, range: Range) => ["assets", id, "series", metric, range] as const,
  sources: ["sources"] as const,
  connectors: ["connectors"] as const,
  points: (sourceId: number) => ["sources", sourceId, "points"] as const,
};

export const useAssets = () => useQuery({ queryKey: keys.assets, queryFn: () => api.get<Asset[]>("/api/assets") });

export const useSummary = (id: number) =>
  useQuery({ queryKey: keys.summary(id), queryFn: () => api.get<Summary>(`/api/assets/${id}/summary`), refetchInterval: 60_000 });

export const useSeries = (id: number, metric: Metric | null, range: Range) =>
  useQuery({
    queryKey: keys.series(id, metric ?? "custom", range),
    enabled: metric !== null,
    refetchInterval: 30_000,
    queryFn: () => {
      const q = rangeToQuery(range);
      const params = new URLSearchParams({ metric: metric!, start: q.start, end: q.end, buckets: String(q.buckets) });
      return api.get<Series>(`/api/assets/${id}/series?${params}`);
    },
  });

export const useSources = () =>
  useQuery({ queryKey: keys.sources, queryFn: () => api.get<Source[]>("/api/sources"), refetchInterval: 10_000 });

export const useConnectors = (enabled: boolean) =>
  useQuery({ queryKey: keys.connectors, queryFn: () => api.get<Connector[]>("/api/connectors"), enabled, staleTime: Infinity });

export const usePoints = (sourceId: number) =>
  useQuery({ queryKey: keys.points(sourceId), queryFn: () => api.get<PointRow[]>(`/api/sources/${sourceId}/points`) });

export function useInvalidate() {
  const client = useQueryClient();
  return (...queryKeys: readonly (readonly unknown[])[]) =>
    Promise.all(queryKeys.map((queryKey) => client.invalidateQueries({ queryKey })));
}
```

`frontend/src/auth/AuthProvider.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "../api/client";
import { ROLE_LEVEL, type Role, type User } from "../api/types";

export const RETURN_KEY = "dcdash.returnTo";

interface AuthState {
  user: User | null;
  setupNeeded: boolean;
  loading: boolean;
  login(username: string, password: string): Promise<void>;
  setup(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  hasRole(min: Role): boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [loading, setLoading] = useState(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await api.get<{ needed: boolean }>("/api/setup");
        if (cancelled) return;
        setSetupNeeded(status.needed);
        if (!status.needed) {
          try {
            setUser(await api.get<User>("/api/me"));
          } catch (error) {
            if (!(error instanceof ApiError && error.status === 401)) throw error;
          }
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    setUser(await api.post<User>("/api/login", { username, password }));
  }, []);

  const setup = useCallback(async (username: string, password: string) => {
    setUser(await api.post<User>("/api/setup", { username, password }));
    setSetupNeeded(false);
  }, []);

  const logout = useCallback(async () => {
    await api.post("/api/logout");
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  const value = useMemo<AuthState>(
    () => ({
      user, setupNeeded, loading, login, setup, logout,
      hasRole: (min) => user !== null && ROLE_LEVEL[user.role] >= ROLE_LEVEL[min],
    }),
    [user, setupNeeded, loading, login, setup, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
```

`frontend/src/auth/RequireAuth.tsx`:

```tsx
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { RETURN_KEY, useAuth } from "./AuthProvider";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, setupNeeded, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="muted">loading…</p>;
  if (setupNeeded) return <Navigate to="/setup" replace />;
  if (!user) {
    sessionStorage.setItem(RETURN_KEY, location.pathname + location.search);
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
```

`frontend/src/pages/LoginPage.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { RETURN_KEY, useAuth } from "../auth/AuthProvider";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      const returnTo = sessionStorage.getItem(RETURN_KEY) ?? "/assets";
      sessionStorage.removeItem(RETURN_KEY);
      navigate(returnTo, { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Sign in</h1>
      <form onSubmit={submit}>
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !username || !password}>Sign in</button>
      </form>
    </main>
  );
}
```

`frontend/src/pages/SetupPage.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";

export function SetupPage() {
  const { setup, setupNeeded, loading } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!loading && !setupNeeded) return <Navigate to="/login" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== confirm) return setError("passwords do not match");
    if (password.length < 8) return setError("password must be at least 8 characters");
    try {
      await setup(username, password);
      navigate("/assets", { replace: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <main>
      <h1>First-run setup</h1>
      <p>Create the first administrator account.</p>
      <form onSubmit={submit}>
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <label>Confirm password<input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={!username || !password}>Create admin</button>
      </form>
    </main>
  );
}
```

`frontend/src/components/Layout.tsx`:

```tsx
import { NavLink, Outlet, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";

export function Layout() {
  const { user, hasRole, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <>
      <nav>
        <strong>DC Dashboard</strong>
        <NavLink to="/assets">Assets</NavLink>
        {hasRole("operator") && <NavLink to="/sources">Sources</NavLink>}
        <span className="spacer" />
        <span className="muted">{user?.username} ({user?.role})</span>
        <button onClick={() => logout().then(() => navigate("/login"))}>Sign out</button>
      </nav>
      <main>
        <Outlet />
      </main>
    </>
  );
}
```

`frontend/src/main.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import "./app.css";
import { AuthProvider } from "./auth/AuthProvider";
import { RequireAuth } from "./auth/RequireAuth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/LoginPage";
import { SetupPage } from "./pages/SetupPage";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

// Pages added by later tasks are imported here as they land (Tasks 5, 6, 8, 10).
export function App() {
  return (
    <Routes>
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route path="/" element={<Navigate to="/assets" replace />} />
        <Route path="/assets" element={<p>assets (Task 5)</p>} />
        <Route path="/assets/:id" element={<p>asset (Task 6)</p>} />
        <Route path="/sources" element={<p>sources (Task 8)</p>} />
        <Route path="/sources/:id/points" element={<p>points (Task 10)</p>} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
```

- [x] **Step 4: Run the tests and try it against the real API**

```bash
npm test -- src/auth src/pages && npm run typecheck
```

Expected: `Tests  6 passed (6)`.

With the 1A stack running (`docker compose up -d`, API on :8000), `npm run dev`, open `http://localhost:5173/`: a fresh database shows the setup form; after creating the admin the nav shows `admin (admin)` and both links. Sign out, sign in again. The `dcdash_session` cookie is set by the API through the Vite proxy because both share the origin `localhost:5173`.

- [x] **Step 5: Commit and push**

```bash
git add frontend && git commit -m "Add auth provider, setup and login pages, router shell" && git push
```

---

### Task 5: Assets screen — tree with admin add / rename / move / delete

**Files:**
- Create: `frontend/src/components/AssetTree.tsx`, `frontend/src/components/AssetForm.tsx`, `frontend/src/pages/AssetsPage.tsx`
- Modify: `frontend/src/main.tsx` (route `/assets` → `<AssetsPage />`)
- Test: `frontend/src/pages/AssetsPage.test.tsx`

**Interfaces:**
- Produces: `AssetTree({ nodes, selectedId, onSelect })` renders nested `<ul class="tree">` with one `<a>` per asset linking to `/assets/{id}`.
- Produces: `AssetForm({ assets, initial?, excludeIds, onSubmit })` with fields name, parent (select of assets minus `excludeIds`, plus "(none)"), kind, sort order; submits `AssetIn`.
- Uses: `GET /api/assets` (viewer), `POST /api/assets` (admin, 201), `PATCH /api/assets/{id}` (admin; 422 when moving under own descendant), `DELETE /api/assets/{id}` (admin, 204).

- [x] **Step 1: Write the failing test**

`frontend/src/pages/AssetsPage.test.tsx`:

```tsx
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { AssetsPage } from "./AssetsPage";

const assets = [
  { id: 1, parent_id: null, name: "Site", kind: "site", sort_order: 0 },
  { id: 2, parent_id: 1, name: "Room A", kind: "room", sort_order: 0 },
];
const authed = (role: string) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/assets": { body: assets },
});

describe("AssetsPage", () => {
  it("renders the hierarchy as a nested tree", async () => {
    mockFetch(authed("viewer"));
    renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
    const site = await screen.findByRole("link", { name: "Site" });
    expect(within(site.closest("li")!).getByRole("link", { name: "Room A" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add asset" })).not.toBeInTheDocument();
  });

  it("lets an admin add a child asset", async () => {
    const calls = mockFetch({
      ...authed("admin"),
      "POST /api/assets": { status: 201, body: { id: 3, parent_id: 1, name: "Room B", kind: "generic", sort_order: 0 } },
    });
    renderWithProviders(<AssetsPage />, { route: "/assets", path: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "Add asset" }));
    await userEvent.type(screen.getByLabelText("Name"), "Room B");
    await userEvent.selectOptions(screen.getByLabelText("Parent"), "1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Room B", parent_id: 1, kind: "generic", sort_order: 0 });
  });

  it("shows the API error when a move is rejected", async () => {
    mockFetch({
      ...authed("admin"),
      "PATCH /api/assets/1": { status: 422, body: { detail: "an asset cannot be moved under itself or its own descendants" } },
    });
    renderWithProviders(<AssetsPage />, { route: "/assets?selected=1", path: "/assets" });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cannot be moved under itself");
  });
});
```

- [x] **Step 2: Run it to see it fail**: `npm test -- src/pages/AssetsPage.test.tsx` → `Failed to resolve import "./AssetsPage"`.

- [x] **Step 3: Implement**

`frontend/src/components/AssetTree.tsx`:

```tsx
import { Link } from "react-router";
import type { TreeNode } from "../lib/tree";

export function AssetTree({ nodes, selectedId, onSelect }: {
  nodes: TreeNode[]; selectedId: number | null; onSelect?: (id: number) => void;
}) {
  if (nodes.length === 0) return null;
  return (
    <ul className="tree">
      {nodes.map((node) => (
        <li key={node.id}>
          <Link to={`/assets/${node.id}`} className={node.id === selectedId ? "selected" : undefined}
            onClick={(e) => { if (onSelect) { e.preventDefault(); onSelect(node.id); } }}>
            {node.name}
          </Link>{" "}
          <span className="muted">{node.kind}</span>
          <AssetTree nodes={node.children} selectedId={selectedId} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}
```

`frontend/src/components/AssetForm.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import type { Asset, AssetIn } from "../api/types";

export function AssetForm({ assets, initial, excludeIds, onSubmit, onCancel }: {
  assets: Asset[]; initial?: Partial<AssetIn>; excludeIds: Set<number>;
  onSubmit: (body: AssetIn) => Promise<void>; onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [parent, setParent] = useState(initial?.parent_id == null ? "" : String(initial.parent_id));
  const [kind, setKind] = useState(initial?.kind ?? "generic");
  const [sortOrder, setSortOrder] = useState(String(initial?.sort_order ?? 0));
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await onSubmit({ name, parent_id: parent === "" ? null : Number(parent), kind, sort_order: Number(sortOrder) || 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <form onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Parent
        <select value={parent} onChange={(e) => setParent(e.target.value)}>
          <option value="">(none)</option>
          {assets.filter((a) => !excludeIds.has(a.id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <label>Kind<input value={kind} onChange={(e) => setKind(e.target.value)} /></label>
      <label>Sort order<input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button type="submit">Save</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
```

`frontend/src/pages/AssetsPage.tsx`:

```tsx
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api/client";
import { keys, useAssets, useInvalidate } from "../api/queries";
import type { AssetIn } from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { AssetForm } from "../components/AssetForm";
import { AssetTree } from "../components/AssetTree";
import { buildTree, descendantIds } from "../lib/tree";

export function AssetsPage() {
  const { hasRole } = useAuth();
  const { data: assets = [], error, isLoading } = useAssets();
  const invalidate = useInvalidate();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("selected") ? Number(params.get("selected")) : null;
  const [mode, setMode] = useState<"none" | "add" | "edit">("none");
  const tree = useMemo(() => buildTree(assets), [assets]);
  const selected = assets.find((a) => a.id === selectedId) ?? null;

  const finish = async () => { await invalidate(keys.assets); setMode("none"); };
  const create = async (body: AssetIn) => { await api.post("/api/assets", body); await finish(); };
  const update = async (body: AssetIn) => { await api.patch(`/api/assets/${selected!.id}`, body); await finish(); };
  const remove = async () => {
    if (!selected || !window.confirm(`Delete "${selected.name}" and its mappings?`)) return;
    await api.del(`/api/assets/${selected.id}`);
    setParams({});
    await finish();
  };

  if (isLoading) return <p className="muted">loading…</p>;
  if (error) return <p className="error" role="alert">{error.message}</p>;
  return (
    <>
      <h1>Assets</h1>
      {assets.length === 0 && <p className="muted">No assets yet.</p>}
      <AssetTree nodes={tree} selectedId={selectedId} onSelect={(id) => setParams({ selected: String(id) })} />
      {selected && <p>Selected: <Link to={`/assets/${selected.id}`}>{selected.name}</Link> (open page)</p>}
      {hasRole("admin") && mode === "none" && (
        <div className="row">
          <button onClick={() => setMode("add")}>Add asset</button>
          {selected && <button onClick={() => setMode("edit")}>Edit</button>}
          {selected && <button onClick={remove}>Delete</button>}
        </div>
      )}
      {mode === "add" && (
        <AssetForm assets={assets} initial={{ parent_id: selectedId }} excludeIds={new Set()} onSubmit={create} onCancel={() => setMode("none")} />
      )}
      {mode === "edit" && selected && (
        <AssetForm assets={assets} initial={selected} excludeIds={descendantIds(tree, selected.id)} onSubmit={update} onCancel={() => setMode("none")} />
      )}
    </>
  );
}
```

In `main.tsx`, import `AssetsPage` and replace the `/assets` placeholder with `<AssetsPage />`.

- [x] **Step 4: Run**: `npm test -- src/pages/AssetsPage.test.tsx && npm run typecheck` → `Tests  3 passed (3)`. Note the third test's `Save` sends `parent_id: null` for "Site"; the mock's 422 is what the test checks, not the body.

- [x] **Step 5: Commit and push**: `git add frontend && git commit -m "Add assets tree with admin add, rename, move and delete" && git push`

---

### Task 6: Asset page — summary, energy tile, metrics table, live values over SSE

**Files:**
- Create: `frontend/src/hooks/useStream.ts`, `frontend/src/components/EnergyTile.tsx`, `frontend/src/components/MetricsTable.tsx`, `frontend/src/pages/AssetPage.tsx`
- Modify: `frontend/src/main.tsx` (route `/assets/:id` → `<AssetPage />`)
- Test: `frontend/src/pages/AssetPage.test.tsx`

**Interfaces:**
- Produces: `useStream(wanted: Set<number>): Map<number, LiveValue>` — opens one `EventSource("/api/stream")` while mounted, applies `parseStreamMessage` + `applyUpdates`; reconnects are left to the browser's EventSource.
- Produces: `MetricsTable({ metrics, live })`: columns Metric, Value, Unit, Updated; value is `live.get(point_id)?.value ?? metric.value`, `—` when `null`; quality ≠ 0 shows `bad quality`.
- Produces: `EnergyTile({ energy })`: `n.nn kWh`, ` (estimated)` when flagged, `no energy data` when `null`.
- Uses: `GET /api/assets/{id}/summary` (viewer), `GET /api/stream` (SSE, any authenticated user).

- [x] **Step 1: Write the failing test**

`frontend/src/pages/AssetPage.test.tsx`:

```tsx
import { act, screen } from "@testing-library/react";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { AssetPage } from "./AssetPage";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeEventSource.last = this; }
  close() { this.closed = true; }
  emit(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
}

const summary = (energy: unknown) => ({
  asset: { id: 4, name: "Panel 1", parent_id: 1, kind: "panel" },
  metrics: [
    { mapping_id: 1, point_id: 7, metric: "active_power_kw", unit: "kW", value: 10.5, ts: "2026-10-07T10:00:00+00:00", quality: 0 },
    { mapping_id: 2, point_id: 8, metric: "voltage_v", unit: "V", value: null, ts: null, quality: null },
  ],
  energy_today: energy,
});
const routes = (energy: unknown) => ({
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
  "GET /api/assets/4/summary": { body: summary(energy) },
  "GET /api/assets/4/series": { body: { metric: "active_power_kw", unit: "kW", points: [] } },
});

beforeEach(() => vi.stubGlobal("EventSource", FakeEventSource));

describe("AssetPage", () => {
  it("renders live value from stream and dash for null", async () => {
    mockFetch(routes({ kwh: 3.25, estimated: false }));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByRole("heading", { name: "Panel 1" })).toBeInTheDocument();
    expect(screen.getByText("10.50")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(FakeEventSource.last?.url).toBe("/api/stream");
    act(() => FakeEventSource.last!.emit([[7, "2026-10-07T10:00:05+00:00", 11.25, 0], [99, "t", 1, 0]]));
    expect(screen.getByText("11.25")).toBeInTheDocument();
    act(() => FakeEventSource.last!.emit([[7, "2026-10-07T10:00:10+00:00", null, 1]]));
    expect(screen.queryByText("11.25")).not.toBeInTheDocument();
    expect(screen.getByText("bad quality")).toBeInTheDocument();
  });

  it("labels estimated energy and handles missing energy", async () => {
    mockFetch(routes({ kwh: 3.25, estimated: true }));
    const { unmount } = renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByText(/3\.25 kWh/)).toHaveTextContent("estimated");
    unmount();
    expect(FakeEventSource.last?.closed).toBe(true);
    mockFetch(routes(null));
    renderWithProviders(<AssetPage />, { route: "/assets/4", path: "/assets/:id" });
    expect(await screen.findByText("no energy data")).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run it to see it fail**: `npm test -- src/pages/AssetPage.test.tsx` → `Failed to resolve import "./AssetPage"`.

- [x] **Step 3: Implement**

`frontend/src/hooks/useStream.ts`:

```ts
import { useEffect, useState } from "react";
import { applyUpdates, parseStreamMessage, type LiveValue } from "../lib/stream";

export function useStream(wanted: Set<number>): Map<number, LiveValue> {
  const [live, setLive] = useState<Map<number, LiveValue>>(() => new Map());
  const key = [...wanted].sort((a, b) => a - b).join(",");
  useEffect(() => {
    if (key === "") return;
    const ids = new Set(key.split(",").map(Number));
    const source = new EventSource("/api/stream");
    source.onmessage = (event) => setLive((current) => applyUpdates(current, parseStreamMessage(event.data), ids));
    return () => source.close();
  }, [key]);
  return live;
}
```

`frontend/src/components/EnergyTile.tsx`:

```tsx
export function EnergyTile({ energy }: { energy: { kwh: number; estimated: boolean } | null }) {
  return (
    <div className="tile">
      <div className="muted">Energy today</div>
      {energy === null ? <div className="big">no energy data</div> : (
        <div className="big">{energy.kwh.toFixed(2)} kWh{energy.estimated && <small className="muted"> (estimated)</small>}</div>
      )}
    </div>
  );
}
```

`frontend/src/components/MetricsTable.tsx`:

```tsx
import type { SummaryMetric } from "../api/types";
import type { LiveValue } from "../lib/stream";

export const fmt = (value: number | null | undefined) => (value == null ? "—" : value.toFixed(2));
export const when = (ts: string | null | undefined) => (ts ? new Date(ts).toLocaleTimeString() : "—");

export function MetricsTable({ metrics, live }: { metrics: SummaryMetric[]; live: Map<number, LiveValue> }) {
  if (metrics.length === 0) return <p className="muted">No metrics are mapped to this asset.</p>;
  return (
    <table>
      <thead><tr><th>Metric</th><th>Value</th><th>Unit</th><th>Updated</th></tr></thead>
      <tbody>
        {metrics.map((m) => {
          const current = live.get(m.point_id);
          const value = current ? current.value : m.value;
          const quality = current ? current.quality : m.quality;
          return (
            <tr key={m.mapping_id}>
              <td>{m.metric}</td>
              <td>{quality !== null && quality !== 0 ? <span className="error">bad quality</span> : fmt(value)}</td>
              <td>{m.unit}</td>
              <td>{when(current ? current.ts : m.ts)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
```

`frontend/src/pages/AssetPage.tsx` (the chart slot is filled in Task 7):

```tsx
import { useMemo } from "react";
import { Link, useParams } from "react-router";
import { useSummary } from "../api/queries";
import { EnergyTile } from "../components/EnergyTile";
import { fmt, MetricsTable } from "../components/MetricsTable";
import { useStream } from "../hooks/useStream";

export function AssetPage() {
  const id = Number(useParams().id);
  const { data, error, isLoading } = useSummary(id);
  const wanted = useMemo(() => new Set((data?.metrics ?? []).map((m) => m.point_id)), [data]);
  const live = useStream(wanted);

  if (isLoading) return <p className="muted">loading…</p>;
  if (error || !data) return <p className="error" role="alert">{error?.message ?? "not found"}</p>;
  const power = data.metrics.find((m) => m.metric === "active_power_kw");
  const livePower = power ? (live.get(power.point_id)?.value ?? power.value) : null;
  return (
    <>
      <p><Link to="/assets">Assets</Link> / {data.asset.name}</p>
      <h1>{data.asset.name}</h1>
      <div className="tile"><div className="muted">Live power</div><div className="big">{power ? `${fmt(livePower)} kW` : "—"}</div></div>
      <EnergyTile energy={data.energy_today} />
      <h2>Metrics</h2>
      <MetricsTable metrics={data.metrics} live={live} />
    </>
  );
}
```

In `main.tsx`, import `AssetPage` and replace the `/assets/:id` placeholder with `<AssetPage />`.

- [x] **Step 4: Run**: `npm test -- src/pages/AssetPage.test.tsx && npm run typecheck` → `Tests  2 passed (2)`. Against the real stack with a mapped simulator panel, the value changes every polling interval without a reload.

- [x] **Step 5: Commit and push**: `git add frontend && git commit -m "Add asset page with live values over SSE" && git push`

---

### Task 7: Trend chart with range picker

**Files:**
- Create: `frontend/src/components/RangePicker.tsx`, `frontend/src/components/TrendChart.tsx`
- Modify: `frontend/src/pages/AssetPage.tsx`
- Test: `frontend/src/components/TrendChart.test.tsx`

**Interfaces:**
- Produces: `RangePicker({ value, onChange })`: four buttons from `RANGES`; the active one has `aria-pressed="true"`.
- Produces: `seriesToOption(series: Series, range: Range): EChartsOption` (pure, exported for the test) — a line of `avg` with `connectNulls: false`, a shaded `min`/`max` band, time x-axis, y-axis named with the unit.
- Produces: `TrendChart({ assetId, metrics })`: metric `<select>` (default `active_power_kw` when mapped, else the first metric) + `RangePicker` + `ReactECharts`.
- Uses: `GET /api/assets/{id}/series?metric=&start=&end=&buckets=` (viewer; 404 when the asset lacks the metric; 422 without timezone offsets — `toISOString()` always includes `Z`).

- [x] **Step 1: Write the failing test**

`frontend/src/components/TrendChart.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { seriesToOption, TrendChart } from "./TrendChart";

vi.mock("echarts-for-react", () => ({ default: (props: { option: unknown }) => <pre data-testid="chart">{JSON.stringify(props.option)}</pre> }));

const series = {
  metric: "active_power_kw", unit: "kW",
  points: [{ ts: "2026-10-07T10:00:00+00:00", avg: 1, min: 0.5, max: 1.5 }, { ts: "2026-10-07T10:01:00+00:00", avg: 2, min: 1, max: 3 }],
};
const metrics = [{ mapping_id: 1, point_id: 7, metric: "active_power_kw" as const, unit: "kW", value: 1, ts: null, quality: 0 }];

describe("seriesToOption", () => {
  it("draws avg with gaps and a min/max band in the unit", () => {
    const option = seriesToOption(series as never, "1h") as { series: { name: string; data: unknown[]; connectNulls?: boolean }[]; yAxis: { name: string } };
    expect(option.yAxis.name).toBe("kW");
    const avg = option.series.find((s) => s.name === "avg")!;
    expect(avg.connectNulls).toBe(false);
    expect(avg.data).toEqual([["2026-10-07T10:00:00+00:00", 1], ["2026-10-07T10:01:00+00:00", 2]]);
    expect(option.series.map((s) => s.name)).toEqual(["min", "max", "avg"]);
  });
});

describe("TrendChart", () => {
  it("requests the series for the chosen range", async () => {
    const calls = mockFetch({
      "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "v", role: "viewer" } },
      "GET /api/assets/4/series": { body: series },
    });
    renderWithProviders(<TrendChart assetId={4} metrics={metrics} />);
    await screen.findByTestId("chart");
    await userEvent.click(screen.getByRole("button", { name: "7d" }));
    expect(screen.getByRole("button", { name: "7d" })).toHaveAttribute("aria-pressed", "true");
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("metric=active_power_kw") && u.includes("buckets=300"))).toBe(true);
    expect(calls.filter((c) => c.path === "/api/assets/4/series").length).toBeGreaterThanOrEqual(2);
  });
});
```

- [x] **Step 2: Run it to see it fail**: `npm test -- src/components/TrendChart.test.tsx` → `Failed to resolve import "./TrendChart"`.

- [x] **Step 3: Implement**

`frontend/src/components/RangePicker.tsx`:

```tsx
import { RANGES, type Range } from "../lib/timeRange";

export function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div className="row" role="group" aria-label="Time range">
      {RANGES.map((r) => <button key={r} type="button" aria-pressed={r === value} onClick={() => onChange(r)}>{r}</button>)}
    </div>
  );
}
```

`frontend/src/components/TrendChart.tsx`:

```tsx
import type { EChartsOption } from "echarts";
import ReactECharts from "echarts-for-react";
import { useState } from "react";
import { useSeries } from "../api/queries";
import type { Metric, Series, SummaryMetric } from "../api/types";
import type { Range } from "../lib/timeRange";
import { RangePicker } from "./RangePicker";

export function seriesToOption(series: Series, range: Range): EChartsOption {
  const ts = (p: { ts: string }) => p.ts;
  return {
    animation: false,
    tooltip: { trigger: "axis" },
    grid: { left: 60, right: 20, top: 30, bottom: 40 },
    xAxis: { type: "time", name: range },
    yAxis: { type: "value", name: series.unit, scale: true },
    series: [
      { name: "min", type: "line", data: series.points.map((p) => [ts(p), p.min]), lineStyle: { opacity: 0 }, symbol: "none", stack: "band", connectNulls: false },
      { name: "max", type: "line", data: series.points.map((p) => [ts(p), p.max - p.min]), lineStyle: { opacity: 0 }, symbol: "none", stack: "band", areaStyle: { color: "#000", opacity: 0.1 }, connectNulls: false },
      { name: "avg", type: "line", data: series.points.map((p) => [ts(p), p.avg]), symbol: "none", color: "#000", connectNulls: false },
    ],
  };
}

export function TrendChart({ assetId, metrics }: { assetId: number; metrics: SummaryMetric[] }) {
  const available = metrics.map((m) => m.metric);
  const [metric, setMetric] = useState<Metric | null>(
    available.includes("active_power_kw") ? "active_power_kw" : (available[0] ?? null),
  );
  const [range, setRange] = useState<Range>("1h");
  const { data, error, isFetching } = useSeries(assetId, metric, range);
  if (metric === null) return <p className="muted">No metric to chart.</p>;
  return (
    <section>
      <div className="row">
        <label>Metric
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {available.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <RangePicker value={range} onChange={setRange} />
        {isFetching && <span className="muted">updating…</span>}
      </div>
      {error && <p className="error" role="alert">{error.message}</p>}
      {data && (data.points.length === 0 ? <p className="muted">No data in this range.</p> : <ReactECharts option={seriesToOption(data, range)} style={{ height: 320 }} notMerge />)}
    </section>
  );
}
```

In `AssetPage.tsx`, import `TrendChart` and add `<h2>Trend</h2><TrendChart assetId={id} metrics={data.metrics} />` between the tiles and the Metrics heading.

- [x] **Step 4: Run**: `npm test -- src/components/TrendChart.test.tsx src/pages/AssetPage.test.tsx && npm run typecheck` → `Tests  4 passed (4)`. (The AssetPage test already mocks `GET /api/assets/4/series`.)

- [x] **Step 5: Commit and push**: `git add frontend && git commit -m "Add trend chart with range picker" && git push`

---

### Task 8: Sources list, job polling, test one / test all

**Files:**
- Create: `frontend/src/hooks/useJob.ts`, `frontend/src/components/JobStatus.tsx`, `frontend/src/pages/SourcesPage.tsx`
- Modify: `frontend/src/main.tsx` (route `/sources` → `<SourcesPage />`)
- Test: `frontend/src/hooks/useJob.test.tsx`, `frontend/src/pages/SourcesPage.test.tsx`

**Interfaces:**
- Produces: `useJob(jobId: number | null): { job: Job | null; running: boolean; error: string | null }` — polls `GET /api/jobs/{id}` every 1 s (TanStack `refetchInterval` returning `false` once `status` is `done` or `failed`).
- Produces: `JobStatus({ jobId })`: `running…` while pending/running; on done shows `result.status` and `result.message` (test) or `result.count` points (browse); on failed shows `result.error`.
- Uses: `GET /api/sources` (operator), `POST /api/sources/{id}/test` → 202 `{job_id}` (operator), `POST /api/sources/test-all` → 202 `{job_ids}` (operator), `GET /api/jobs/{id}` (operator).

- [x] **Step 1: Write the failing tests**

`frontend/src/hooks/useJob.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { JobStatus } from "../components/JobStatus";

const auth = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "o", role: "operator" } } };
const job = (status: string, result: unknown) => ({ id: 5, kind: "test_source", status, result, created_at: "t", finished_at: null });

describe("JobStatus", () => {
  it("polls until done and shows status", async () => {
    let polls = 0;
    mockFetch({ ...auth, "GET /api/jobs/5": () => ({ body: ++polls < 3 ? job("running", null) : job("done", { ok: true, status: "ok", latency_ms: 12, message: "" }) }) });
    renderWithProviders(<JobStatus jobId={5} />);
    expect(await screen.findByText("running…")).toBeInTheDocument();
    expect(await screen.findByText(/ok/, {}, { timeout: 5000 })).toBeInTheDocument();
    const settled = polls;
    await new Promise((r) => setTimeout(r, 1500));
    expect(polls).toBe(settled);
  }, 10_000);

  it("shows error from failed job", async () => {
    mockFetch({ ...auth, "GET /api/jobs/5": { body: job("failed", { error: "collector restarted" }) } });
    renderWithProviders(<JobStatus jobId={5} />);
    expect(await screen.findByText(/collector restarted/)).toHaveClass("error");
  });
});
```

`frontend/src/pages/SourcesPage.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { SourcesPage } from "./SourcesPage";

const source = { id: 2, name: "sim", connector_type: "simulator", config: { url: "http://simulator:9000" }, enabled: true, status: "online", last_seen: "2026-10-07T10:00:00+00:00", last_error: null, has_secret: true };
const routes = (role: string) => ({
  "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "u", role } },
  "GET /api/sources": { body: [{ ...source, status: "offline", last_error: "timeout" }] },
  "POST /api/sources/2/test": { status: 202, body: { job_id: 9 } },
  "POST /api/sources/test-all": { status: 202, body: { job_ids: [9] } },
  "GET /api/jobs/9": { body: { id: 9, kind: "test_source", status: "done", result: { ok: false, status: "timeout", latency_ms: null, message: "no reply" }, created_at: "t", finished_at: "t" } },
});

describe("SourcesPage", () => {
  it("lists status and last error, and tests one source", async () => {
    const calls = mockFetch(routes("operator"));
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    expect(await screen.findByText("offline")).toBeInTheDocument();
    expect(screen.getByText("timeout")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add source" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText(/no reply/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/sources/2/test")).toBe(true);
  });

  it("tests all sources and shows add/browse for admins", async () => {
    const calls = mockFetch(routes("admin"));
    renderWithProviders(<SourcesPage />, { route: "/sources", path: "/sources" });
    await userEvent.click(await screen.findByRole("button", { name: "Test all" }));
    expect(calls.some((c) => c.path === "/api/sources/test-all")).toBe(true);
    expect(screen.getByRole("button", { name: "Add source" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Points" })).toHaveAttribute("href", "/sources/2/points");
  });
});
```

- [x] **Step 2: Run them to see them fail**: `npm test -- src/hooks src/pages/SourcesPage.test.tsx` → two `Failed to resolve import` errors.

- [x] **Step 3: Implement**

`frontend/src/hooks/useJob.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Job } from "../api/types";

const FINISHED = new Set(["done", "failed"]);

export function useJob(jobId: number | null) {
  const { data, error } = useQuery({
    queryKey: ["jobs", jobId],
    enabled: jobId !== null,
    queryFn: () => api.get<Job>(`/api/jobs/${jobId}`),
    refetchInterval: (query) => (query.state.data && FINISHED.has(query.state.data.status) ? false : 1000),
  });
  const job = data ?? null;
  return { job, running: jobId !== null && (job === null || !FINISHED.has(job.status)), error: error ? error.message : null };
}
```

`frontend/src/components/JobStatus.tsx`:

```tsx
import { useJob } from "../hooks/useJob";

export function JobStatus({ jobId }: { jobId: number | null }) {
  const { job, running, error } = useJob(jobId);
  if (jobId === null) return null;
  if (error) return <span className="error">{error}</span>;
  if (running) return <span className="muted">running…</span>;
  const result = job!.result ?? {};
  if (job!.status === "failed") return <span className="error">failed: {String(result.error ?? "unknown error")}</span>;
  if (job!.kind === "browse_source") return <span>found {String(result.count ?? 0)} points</span>;
  const latency = typeof result.latency_ms === "number" ? ` ${result.latency_ms.toFixed(0)} ms` : "";
  return <span className={result.ok ? undefined : "error"}>{String(result.status)}{latency}{result.message ? ` — ${String(result.message)}` : ""}</span>;
}
```

`frontend/src/pages/SourcesPage.tsx` (the add form arrives in Task 9; `showAdd` is wired then):

```tsx
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api/client";
import { keys, useInvalidate, useSources } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";
import { JobStatus } from "../components/JobStatus";

export function SourcesPage() {
  const { hasRole } = useAuth();
  const { data: sources = [], error, isLoading } = useSources();
  const invalidate = useInvalidate();
  const [jobs, setJobs] = useState<Record<number, number>>({});
  const [showAdd, setShowAdd] = useState(false);

  const testOne = async (id: number) => {
    const { job_id } = await api.post<{ job_id: number }>(`/api/sources/${id}/test`);
    setJobs((j) => ({ ...j, [id]: job_id }));
  };
  const testAll = async () => {
    const { job_ids } = await api.post<{ job_ids: number[] }>("/api/sources/test-all");
    const enabled = sources.filter((s) => s.enabled).map((s) => s.id);
    setJobs(Object.fromEntries(enabled.map((id, i) => [id, job_ids[i]])));
  };
  const remove = async (id: number, name: string) => {
    if (!window.confirm(`Delete source "${name}", its points and mappings?`)) return;
    await api.del(`/api/sources/${id}`);
    await invalidate(keys.sources);
  };

  if (isLoading) return <p className="muted">loading…</p>;
  if (error) return <p className="error" role="alert">{error.message}</p>;
  return (
    <>
      <h1>Sources</h1>
      <div className="row">
        <button onClick={testAll} disabled={sources.length === 0}>Test all</button>
        {hasRole("admin") && <button onClick={() => setShowAdd((v) => !v)}>Add source</button>}
      </div>
      {showAdd && <p className="muted">(form: Task 9)</p>}
      <table>
        <thead><tr><th>Name</th><th>Type</th><th>Enabled</th><th>Status</th><th>Last seen</th><th>Last error</th><th>Test result</th><th></th></tr></thead>
        <tbody>
          {sources.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td><td>{s.connector_type}</td><td>{s.enabled ? "yes" : "no"}</td>
              <td>{s.status}</td>
              <td>{s.last_seen ? new Date(s.last_seen).toLocaleString() : "—"}</td>
              <td className="error">{s.last_error ?? ""}</td>
              <td><JobStatus jobId={jobs[s.id] ?? null} /></td>
              <td className="row">
                <button onClick={() => testOne(s.id)}>Test</button>
                {hasRole("admin") && <Link to={`/sources/${s.id}/points`}>Points</Link>}
                {hasRole("admin") && <button onClick={() => remove(s.id, s.name)}>Delete</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

In `main.tsx`, import `SourcesPage` and replace the `/sources` placeholder.

- [x] **Step 4: Run**: `npm test -- src/hooks src/pages/SourcesPage.test.tsx && npm run typecheck` → `Tests  4 passed (4)`.

- [x] **Step 5: Commit and push**: `git add frontend && git commit -m "Add sources list with connection tests and job polling" && git push`

---

### Task 9: Schema-generated add-source form

**Files:**
- Create: `frontend/src/components/SchemaForm.tsx`, `frontend/src/components/SourceForm.tsx`
- Modify: `frontend/src/pages/SourcesPage.tsx` (replace the Task 9 placeholder with `<SourceForm onDone={...} />`)
- Test: `frontend/src/components/SchemaForm.test.tsx`

**Interfaces:**
- Produces: `SchemaForm({ fields, values, onChange })`: one labelled input per `FormField` (`type="checkbox"` for boolean, `type="number"` with `step="any"`/`step="1"` for number/integer, text otherwise; `required` attribute mirrors the field).
- Produces: `SourceForm({ onDone })`: name, connector type `<select>` from `GET /api/connectors`, generated config fields, a separate `Secret` password input (sent as `secret`, `null` when blank), `Enabled` checkbox; submits `POST /api/sources` (admin, 201; 409 on duplicate name; 422 with pydantic list on bad config).

- [x] **Step 1: Write the failing test**

`frontend/src/components/SchemaForm.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { SourceForm } from "./SourceForm";

const connectors = [
  { type: "simulator", config_schema: { type: "object", title: "SimulatorConfig", properties: {
    url: { type: "string", format: "uri", title: "Url", default: "http://simulator:9000" },
    timeout_seconds: { type: "number", title: "Timeout Seconds", default: 5.0 } } } },
  { type: "other", config_schema: { type: "object", required: ["host"], properties: {
    host: { type: "string", title: "Host" }, port: { type: "integer", title: "Port", default: 502 }, tls: { type: "boolean", title: "Tls", default: false } } } },
];
const auth = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "a", role: "admin" } }, "GET /api/connectors": { body: connectors } };

describe("SourceForm", () => {
  it("submits typed config and secret separately", async () => {
    const calls = mockFetch({ ...auth, "POST /api/sources": { status: 201, body: { id: 3 } } });
    const onDone = vi.fn();
    renderWithProviders(<SourceForm onDone={onDone} />);
    await userEvent.type(await screen.findByLabelText("Name"), "sim");
    expect(screen.getByLabelText("Url")).toHaveValue("http://simulator:9000");
    await userEvent.clear(screen.getByLabelText("Timeout Seconds"));
    await userEvent.type(screen.getByLabelText("Timeout Seconds"), "2.5");
    await userEvent.type(screen.getByLabelText("Secret"), "sim-key");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "sim", connector_type: "simulator", config: { url: "http://simulator:9000", timeout_seconds: 2.5 }, secret: "sim-key", enabled: true,
    });
    expect(onDone).toHaveBeenCalled();
  });

  it("switches fields with the connector type and renders checkbox and integer inputs", async () => {
    mockFetch(auth);
    renderWithProviders(<SourceForm onDone={() => {}} />);
    await userEvent.selectOptions(await screen.findByLabelText("Connector"), "other");
    expect(screen.getByLabelText("Host")).toBeRequired();
    expect(screen.getByLabelText("Port")).toHaveAttribute("step", "1");
    expect(screen.getByLabelText("Tls")).not.toBeChecked();
  });

  it("shows a pydantic validation error from the API", async () => {
    mockFetch({ ...auth, "POST /api/sources": { status: 422, body: { detail: [{ loc: ["config", "url"], msg: "Input should be a valid URL", type: "url_parsing" }] } } });
    renderWithProviders(<SourceForm onDone={() => {}} />);
    await userEvent.type(await screen.findByLabelText("Name"), "sim");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("config.url: Input should be a valid URL");
  });
});
```

- [x] **Step 2: Run it to see it fail**: `npm test -- src/components/SchemaForm.test.tsx` → `Failed to resolve import "./SourceForm"`.

- [x] **Step 3: Implement**

`frontend/src/components/SchemaForm.tsx`:

```tsx
import type { FormField, RawValues } from "../lib/schemaForm";

export function SchemaForm({ fields, values, onChange }: { fields: FormField[]; values: RawValues; onChange: (v: RawValues) => void }) {
  const set = (name: string, value: string | boolean) => onChange({ ...values, [name]: value });
  return (
    <>
      {fields.map((f) => (
        <label key={f.name}>
          {f.label}
          {f.kind === "boolean" ? (
            <input type="checkbox" checked={values[f.name] === true} onChange={(e) => set(f.name, e.target.checked)} />
          ) : (
            <input type={f.kind === "string" ? "text" : "number"} step={f.kind === "integer" ? "1" : f.kind === "number" ? "any" : undefined}
              required={f.required} value={String(values[f.name] ?? "")} onChange={(e) => set(f.name, e.target.value)} />
          )}
          {f.description && <small className="muted">{f.description}</small>}
        </label>
      ))}
    </>
  );
}
```

`frontend/src/components/SourceForm.tsx`:

```tsx
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { keys, useConnectors, useInvalidate } from "../api/queries";
import type { SourceIn } from "../api/types";
import { coerceValues, fieldsFromSchema, initialValues, type RawValues } from "../lib/schemaForm";
import { SchemaForm } from "./SchemaForm";

export function SourceForm({ onDone }: { onDone: () => void }) {
  const { data: connectors = [], error: loadError } = useConnectors(true);
  const invalidate = useInvalidate();
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [values, setValues] = useState<RawValues>({});
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const connector = connectors.find((c) => c.type === type) ?? connectors[0];
  const fields = useMemo(() => (connector ? fieldsFromSchema(connector.config_schema) : []), [connector]);
  useEffect(() => { if (connector && type !== connector.type) setType(connector.type); }, [connector, type]);
  useEffect(() => { setValues(initialValues(fields)); }, [fields]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const body: SourceIn = { name, connector_type: connector!.type, config: coerceValues(fields, values), secret: secret || null, enabled };
    try {
      await api.post("/api/sources", body);
      setSecret("");
      await invalidate(keys.sources);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loadError) return <p className="error" role="alert">{loadError.message}</p>;
  if (!connector) return <p className="muted">loading connectors…</p>;
  return (
    <form onSubmit={submit}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
      <label>Connector
        <select value={connector.type} onChange={(e) => setType(e.target.value)}>
          {connectors.map((c) => <option key={c.type} value={c.type}>{c.type}</option>)}
        </select>
      </label>
      <SchemaForm fields={fields} values={values} onChange={setValues} />
      <label>Secret<input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
      <label>Enabled<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button type="submit">Save</button><button type="button" onClick={onDone}>Cancel</button></div>
    </form>
  );
}
```

In `SourcesPage.tsx` replace `{showAdd && <p className="muted">(form: Task 9)</p>}` with `{showAdd && <SourceForm onDone={() => setShowAdd(false)} />}` and import it.

- [x] **Step 4: Run**: `npm test -- src/components/SchemaForm.test.tsx src/pages/SourcesPage.test.tsx && npm run typecheck` → `Tests  5 passed (5)`. Against the real stack: add `simulator` with secret `sim-key`, Test → `ok 3 ms`.

- [x] **Step 5: Commit and push**: `git add frontend && git commit -m "Add schema-generated source form" && git push`

---

### Task 10: Points table — browse, map, edit, unmap

**Files:**
- Create: `frontend/src/components/MappingForm.tsx`, `frontend/src/pages/SourcePointsPage.tsx`
- Modify: `frontend/src/main.tsx` (route `/sources/:id/points` → `<SourcePointsPage />`)
- Test: `frontend/src/pages/SourcePointsPage.test.tsx`

**Interfaces:**
- Produces: `MappingForm({ assets, initial?, onSubmit, onCancel })` with Asset `<select>`, Metric `<select>` from `METRICS`, Interval (seconds, blank = API default), Scale (default 1), Custom unit (enabled only for metric `custom`); submits `Omit<MappingIn, "point_id">`.
- Uses: `POST /api/sources/{id}/browse` → 202 `{job_id}` (admin), `GET /api/sources/{id}/points` (operator; rows embed `mapping`), `POST /api/mappings` (admin, 201; 409 when the point is already mapped or the asset already has that metric), `PATCH /api/mappings/{id}`, `DELETE /api/mappings/{id}` (admin, 204), `GET /api/assets` for the asset select.

- [x] **Step 1: Write the failing test**

`frontend/src/pages/SourcePointsPage.test.tsx`:

```tsx
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { SourcePointsPage } from "./SourcePointsPage";

const points = [
  { id: 7, address: "panel1/power", name: "Panel 1 power", data_type: "float", unit_hint: "kW", mapping: null },
  { id: 8, address: "panel1/energy", name: "Panel 1 energy", data_type: "float", unit_hint: "kWh",
    mapping: { id: 2, asset_id: 4, metric: "energy_kwh", scale: 1, interval_seconds: 60, custom_unit: null } },
];
const routes = {
  "GET /api/setup": { body: { needed: false } }, "GET /api/me": { body: { id: 1, username: "a", role: "admin" } },
  "GET /api/assets": { body: [{ id: 4, parent_id: null, name: "Panel 1", kind: "panel", sort_order: 0 }] },
  "GET /api/sources/2/points": { body: points },
  "POST /api/sources/2/browse": { status: 202, body: { job_id: 11 } },
  "GET /api/jobs/11": { body: { id: 11, kind: "browse_source", status: "done", result: { count: 2 }, created_at: "t", finished_at: "t" } },
  "POST /api/mappings": { status: 201, body: { id: 3, point_id: 7, asset_id: 4, metric: "active_power_kw", scale: 1, interval_seconds: 5, custom_unit: null } },
  "DELETE /api/mappings/2": { status: 204 },
};

describe("SourcePointsPage", () => {
  it("browses, then maps an unmapped point", async () => {
    const calls = mockFetch(routes);
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });
    await userEvent.click(await screen.findByRole("button", { name: "Browse points" }));
    expect(await screen.findByText("found 2 points")).toBeInTheDocument();
    const row = (await screen.findByText("panel1/power")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Map" }));
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "4");
    await userEvent.selectOptions(screen.getByLabelText("Metric"), "active_power_kw");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(calls.find((c) => c.path === "/api/mappings")?.body).toEqual({
      point_id: 7, asset_id: 4, metric: "active_power_kw", scale: 1, interval_seconds: null, custom_unit: null,
    });
  });

  it("shows the existing mapping and unmaps it", async () => {
    const calls = mockFetch(routes);
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });
    const row = (await screen.findByText("panel1/energy")).closest("tr")!;
    expect(within(row).getByText(/Panel 1 · energy_kwh/)).toBeInTheDocument();
    await userEvent.click(within(row).getByRole("button", { name: "Unmap" }));
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/mappings/2")).toBe(true);
  });

  it("shows the API conflict message", async () => {
    mockFetch({ ...routes, "POST /api/mappings": { status: 409, body: { detail: "this point is already mapped, or the asset already has this metric" } } });
    renderWithProviders(<SourcePointsPage />, { route: "/sources/2/points", path: "/sources/:id/points" });
    const row = (await screen.findByText("panel1/power")).closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Map" }));
    await userEvent.selectOptions(screen.getByLabelText("Asset"), "4");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already mapped");
  });
});
```

- [x] **Step 2: Run it to see it fail**: `npm test -- src/pages/SourcePointsPage.test.tsx` → `Failed to resolve import "./SourcePointsPage"`.

- [x] **Step 3: Implement**

`frontend/src/components/MappingForm.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { METRICS, type Asset, type MappingIn, type Metric } from "../api/types";

export type MappingBody = Omit<MappingIn, "point_id">;

export function MappingForm({ assets, initial, onSubmit, onCancel }: {
  assets: Asset[]; initial?: Partial<MappingBody>; onSubmit: (body: MappingBody) => Promise<void>; onCancel: () => void;
}) {
  const [assetId, setAssetId] = useState(initial?.asset_id ? String(initial.asset_id) : "");
  const [metric, setMetric] = useState<Metric>(initial?.metric ?? "active_power_kw");
  const [interval, setInterval_] = useState(initial?.interval_seconds ? String(initial.interval_seconds) : "");
  const [scale, setScale] = useState(String(initial?.scale ?? 1));
  const [unit, setUnit] = useState(initial?.custom_unit ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (assetId === "") return setError("choose an asset");
    try {
      await onSubmit({
        asset_id: Number(assetId), metric, scale: Number(scale) || 1,
        interval_seconds: interval.trim() === "" ? null : Number(interval),
        custom_unit: metric === "custom" && unit.trim() !== "" ? unit.trim() : null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <form onSubmit={submit}>
      <label>Asset
        <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
          <option value="">(choose)</option>
          {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </label>
      <label>Metric
        <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
          {METRICS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </label>
      <label>Interval (s, blank = default)<input type="number" min="1" step="1" value={interval} onChange={(e) => setInterval_(e.target.value)} /></label>
      <label>Scale<input type="number" step="any" min="0" value={scale} onChange={(e) => setScale(e.target.value)} /></label>
      <label>Custom unit<input value={unit} disabled={metric !== "custom"} onChange={(e) => setUnit(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row"><button type="submit">Save</button><button type="button" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}
```

`frontend/src/pages/SourcePointsPage.tsx`:

```tsx
import { useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api/client";
import { keys, useAssets, useInvalidate, usePoints } from "../api/queries";
import type { PointRow } from "../api/types";
import { JobStatus } from "../components/JobStatus";
import { MappingForm, type MappingBody } from "../components/MappingForm";

export function SourcePointsPage() {
  const sourceId = Number(useParams().id);
  const { data: points = [], error, isLoading } = usePoints(sourceId);
  const { data: assets = [] } = useAssets();
  const invalidate = useInvalidate();
  const [browseJob, setBrowseJob] = useState<number | null>(null);
  const [editing, setEditing] = useState<PointRow | null>(null);
  const assetName = (id: number) => assets.find((a) => a.id === id)?.name ?? `#${id}`;

  const browse = async () => {
    const { job_id } = await api.post<{ job_id: number }>(`/api/sources/${sourceId}/browse`);
    setBrowseJob(job_id);
  };
  const refresh = async () => { await invalidate(keys.points(sourceId)); setEditing(null); };
  const save = async (body: MappingBody) => {
    if (editing!.mapping) await api.patch(`/api/mappings/${editing!.mapping.id}`, body);
    else await api.post("/api/mappings", { point_id: editing!.id, ...body });
    await refresh();
  };
  const unmap = async (mappingId: number) => { await api.del(`/api/mappings/${mappingId}`); await refresh(); };

  if (isLoading) return <p className="muted">loading…</p>;
  if (error) return <p className="error" role="alert">{error.message}</p>;
  return (
    <>
      <p><Link to="/sources">Sources</Link> / source {sourceId}</p>
      <h1>Points</h1>
      <div className="row">
        <button onClick={browse}>Browse points</button>
        <JobStatus jobId={browseJob} />
        {browseJob !== null && <button onClick={() => invalidate(keys.points(sourceId))}>Refresh list</button>}
      </div>
      {points.length === 0 && <p className="muted">No points yet. Browse the source to discover them.</p>}
      <table>
        <thead><tr><th>Address</th><th>Name</th><th>Type</th><th>Unit hint</th><th>Mapped to</th><th></th></tr></thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.id}>
              <td>{p.address}</td><td>{p.name}</td><td>{p.data_type}</td><td>{p.unit_hint ?? ""}</td>
              <td>{p.mapping ? `${assetName(p.mapping.asset_id)} · ${p.mapping.metric} · every ${p.mapping.interval_seconds}s · ×${p.mapping.scale}` : <span className="muted">unmapped</span>}</td>
              <td className="row">
                <button onClick={() => setEditing(p)}>{p.mapping ? "Edit" : "Map"}</button>
                {p.mapping && <button onClick={() => unmap(p.mapping!.id)}>Unmap</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing && (
        <>
          <h2>{editing.mapping ? "Edit mapping" : "Map"} {editing.address}</h2>
          <MappingForm assets={assets} initial={editing.mapping ?? undefined} onSubmit={save} onCancel={() => setEditing(null)} />
        </>
      )}
    </>
  );
}
```

In `main.tsx`, import `SourcePointsPage` and replace the last placeholder; `App` now has no placeholders.

- [x] **Step 4: Run the whole suite**: `npm test && npm run typecheck` → `Tests  47 passed (47)` (Tasks 1–10: 4 + 9 + 11 + 6 + 3 + 2 + 2 + 4 + 3 + 3).

- [x] **Step 5: Commit and push**: `git add frontend && git commit -m "Add points table with browse, map, edit and unmap" && git push`

---

### Task 11: Caddy, frontend image and the `web` service

**Files:**
- Create: `deploy/Caddyfile`, `frontend/Dockerfile`
- Modify: `compose.yaml` (add `web`, remove `ports` from `api`), `scripts/smoke.py` (default URL)
- Test: `scripts/check_web.sh` (shell smoke of the built stack; no unit test applies)

**Interfaces:**
- Produces: `web` service on `:80`: static `dist` with SPA fallback to `index.html`; `/api/*` proxied to `api:8000` unbuffered so SSE events arrive as they are sent.

- [x] **Step 1: Write the stack check (fails until `web` exists)**

`scripts/check_web.sh`:

```bash
#!/usr/bin/env sh
# Checks the built web service: SPA, API proxy, and that SSE is not buffered.
set -eu
BASE="${1:-http://localhost}"
curl -fsS "$BASE/" | grep -q '<div id="root">' && echo "index: ok"
curl -fsS "$BASE/assets" | grep -q '<div id="root">' && echo "spa fallback: ok"
[ "$(curl -fsS "$BASE/api/health")" = '{"status":"ok"}' ] && echo "api proxy: ok"
# Unauthenticated stream must be refused by the API, not by Caddy (proves the route exists).
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/stream")" = "401" ] && echo "stream route: ok"
```

```bash
chmod +x scripts/check_web.sh && scripts/check_web.sh
```

Expected: `curl: (7) Failed to connect to localhost port 80`.

- [x] **Step 2: Create the Caddyfile and image**

`deploy/Caddyfile`:

```
:80

handle /api/* {
	reverse_proxy api:8000 {
		flush_interval -1
	}
}

handle {
	root * /srv
	try_files {path} /index.html
	file_server
}
```

`frontend/Dockerfile` (build context is the repo root so the Caddyfile is reachable):

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
```

- [x] **Step 3: Update compose.yaml and smoke.py**

In `compose.yaml`, delete the `ports:` block under `api` (the healthcheck stays; it runs inside the container) and add after `api`:

```yaml
  web:
    build:
      context: .
      dockerfile: frontend/Dockerfile
    image: dcdash-web:local
    restart: unless-stopped
    ports:
      - "80:80"
    depends_on:
      api:
        condition: service_healthy
```

In `scripts/smoke.py` change the default:

```python
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost"
```

and the docstring line to `Then run:  uv run --project backend python scripts/smoke.py [base_url]   (default http://localhost, through Caddy)`.

- [x] **Step 4: Build, start and check**

```bash
docker compose --profile dev up -d --build
scripts/check_web.sh
uv run --project backend python scripts/smoke.py
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/api/health
```

Expected: the four `ok` lines; smoke.py finishes with its existing success message; the last curl prints `000` (port 8000 is no longer published). In a browser at `http://localhost/`, the setup page loads and, after mapping a panel, values on the asset page update within a few seconds (SSE through Caddy).

- [x] **Step 5: Commit and push**

```bash
git add deploy frontend/Dockerfile compose.yaml scripts && git commit -m "Serve the UI through Caddy and proxy /api" && git push
```

---

### Task 12: README, final verification

**Files:**
- Modify: `README.md`

- [x] **Step 1: Update the README**

Replace the `Status:` paragraph with:

```
Status: Phase 1B. The web UI is served at `http://localhost/`; the API is
proxied at `http://localhost/api` (interactive docs at `/api/docs`). Storage
panel, user management, OPC UA and Modbus connectors arrive in Phase 1C.
```

In "Run it", after `Later starts need only \`docker compose up -d\`.` add:

```
Open `http://localhost/`. The first visit asks you to create the admin
account. Then: Sources → Add source → Test → Points → Browse points → Map;
Assets → open the asset to see live and historical values.
```

Replace the smoke-test lines with:

```bash
scripts/setup.sh --profile dev
uv run --project backend python scripts/smoke.py          # drives http://localhost through Caddy
scripts/check_web.sh                                     # SPA, proxy and SSE route checks
```

Add `web` to the Services table: `| \`web\` | Caddy: serves the UI, proxies \`/api\` to \`api\` |`.

Add to "Develop":

```
Frontend (needs the stack running for the API):

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173, /api proxied to localhost:8000
npm test
npm run typecheck
```

For `npm run dev` to reach the API without Caddy, temporarily publish it:
`docker compose run --rm -p 8000:8000 api` or add `ports: ["8000:8000"]` to a
`compose.override.yaml` (ignored by git).
```

Add `compose.override.yaml` to `.gitignore`.

- [x] **Step 2: Final verification**

```bash
cd frontend && npm ci && npm run build && npm test && cd ..
docker compose --profile dev up -d --build && scripts/check_web.sh && uv run --project backend python scripts/smoke.py
git status --short
```

Expected: `vite build` reports `dist/index.html` and assets; all tests pass; stack checks print `ok`; `git status` shows only `README.md` and `.gitignore`.

- [x] **Step 3: Commit and push**

```bash
git add README.md .gitignore && git commit -m "Document the web UI and dev workflow" && git push
```

---

## Deferred to 1C

- Storage panel (database size, growth, retention settings) and the Users screen (create, roles, deactivate) — spec section 9 rows 5 and 6.
- Playwright end-to-end test (spec section 13): first-time setup through a live value on an asset page, run against the Compose stack.
- Rollup tiers: the chart keeps querying raw readings through `time_bucket`; once 1C adds tiers the `series` endpoint changes and `useSeries` is unaffected.
- Source editing (`PATCH /api/sources/{id}`): the API supports it; the UI exposes delete and re-add only. 1C adds an edit form reusing `SchemaForm`.
- Editing an asset's mappings from the asset page; in 1B mappings are edited from the source's points table only.
