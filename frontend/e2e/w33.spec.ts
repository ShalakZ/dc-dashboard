import { expect, test, type APIRequestContext, type APIResponse, type Browser, type Locator, type Page } from "@playwright/test";
import { expectNoRowAction } from "./shell";

// W33 (devices that move or disappear): a source that stopped answering is moved, with its mappings, to the address where its server turned up (with a preview, a tick and an Undo), and Discovery
// says which sources the latest scan of the same range did not find and removes the leftovers in one go. Admin `admin` / `correct-horse`. The contract is the plan
// docs/superpowers/plans/2026-10-22-w33-discovery-freshness-and-moves.md (rulings R2 to R8, P6, P7, F-M11, F-M16) and the rulings of .waves/w33.md.
//
// WHICH SERVER, AND WHY. Every case talks to ONE endpoint: the stand-in Historian of the simulator, `simulator:9100` (an HTTP server of the `simulator` connector type, the same key `sim-key` as the plain simulator). It is the one
// endpoint of the stack that no other spec keeps a source at: `simulator:9000` is the journey's hand-added `sim`, `simulator:4840` is the discovery journey's fully mapped OPC UA source, and a scan that meets a source at an
// endpoint LINKS to it and creates NOTHING new, so a new source (the scan's duplicate that a move merges away) can only appear where the endpoint is free. The OPC UA move is covered by the backend tests and by the
// controller's drill; it cannot be driven here without taking the endpoint from a source this spec does not own. Always use the NAME `simulator`: the address behind it changes when the stack's containers are recreated.
// The Historian's points have the same addresses and names whoever browses them, which is what the "possibly" match compares.
//
// IT MAKES ITS OWN DATA and needs nothing from the stack beyond the sign-in. Names: `W33 <run> ...` for the asset, the hand-added sources and the scope; the sources a scan makes carry the probe's label
// (`DCDash simulator at simulator:9100`) and are found again by the scan that last saw them (a scan of a scope named `W33 <run> ...`); the account and role of case 5 start `w33-`. afterAll removes it all, each step on its own and also
// after a failed case; beforeAll sweeps what an earlier run that stopped half way left. FIRST, case 1 scans its scope and reads where the scan LINKED the finding at port 9100: to a source this run did not find there
// before the scan (the scan made it: it is removed again, so the endpoint is free) or to a source it did not make (somebody else holds the endpoint: every case then SKIPS, with the holder's name as the reason; nothing of
// anybody else's is ever deleted).
//   1  THE SETUP. The hand-added source O `W33 <run> old` (the `simulator` type, at the live endpoint, switched off, with the key) browses its points; two of them (M001_kW and M001_kWh) are mapped to the asset `W33 <run>`. O has NO stored identity
//      (nothing has run Test or Check connection on it; the graph says `identity: null`). Its address is then changed to `http://127.0.0.1:9100` (the collector's own loopback: nothing listens, the connection is refused at once) and it is
//      switched on: it reads offline with an open incident whose code is `unreachable`.
//   2  THE OFFER. A scan of the scope finds the live endpoint and makes a new source C (a Historian needs its key to be browsed, so C starts with no points: the spec gives C the key and browses it, as a person would). The API then
//      offers O the move: `move_candidate` of O's Sources row and of C's graph entry are an offer of kind `possibly` (O has no identity, so only the addresses speak: both mapped addresses, with their names, exist on C).
//   3  THE SOURCES ROW MENU. At 1024 x 768 the row menu of the offline O opens with **Move to new address...** as its FIRST item and nothing in it is cut off or covered.
//   4  THE DISCOVERY CARD. C's card says `Looks like <O>` (the whole sentence in its title) and has **Move <O> to <C>...**; the dialog opens from it, shows `From ... to ...`, `All 2 mapped addresses and their names exist on the new server.`,
//      what else happens and the tick `I checked that this is the same device`; Move stays off (aria-disabled) until it is ticked; Cancel gives the focus back to the card's button.
//   5  PERMISSIONS. A role without `sources.edit` (it has `sources.view`, `sources.test`, `discovery.view`) sees the row but its menu has no **Move to new address...**, C's card has no **Move...**, and both routes answer 403.
//   6  THE MOVE FROM SOURCES. Row menu, dialog, tick, **Move 2 mappings**: O keeps its two mappings and the SAME point and mapping ids (compared through the API before and after), is at `http://simulator:9100` and turns online, C is gone from
//      Discovery, the toast offers **Undo**; the Undo (toast) puts `127.0.0.1:9100` back, O's identity is null again and it goes offline again. The Audit page reads `Moved ... from 127.0.0.1:9100 to simulator:9100 (2 mappings kept, the duplicate
//      removed) (matched by its 2 mapped addresses)` and `Undid the move of ...: back at 127.0.0.1:9100`.
//   7  THE SECOND ROUND. A new scan makes a new C; the move is made from Discovery's card; the Audit drawer's **Undo this move** puts the address back; a second Undo of the same entry is refused in words (`this move was already undone`). O
//      and its asset are then deleted, so the next case starts without an old source.
//   8  NOT SEEN. Three scans of ONE scope (one range, so one digest): scan 1 makes A (a source with nothing mapped), A's address is changed to a dead one; scan 2 makes M (given the key, browsed, one point mapped, switched off, dead address);
//      scan 3 makes B. The API says A and M are `not_seen` by scan 3 (last seen in 1 and in 2) and B is not. Discovery: A's card is dimmed and reads `Not seen in scan #3 (last seen in #1, ...)`, M's reads `Mapped: move it or delete it on Sources`, B's
//      is as usual; the panel of A says it in full; **Turn on Not seen lately** (More Discovery actions) shows only A and M, and turning it off brings B back; **Remove not seen (N)...** lists A's name and removes A and NOT M (the mapped
//      one stays; with sources of other people that are not seen too, the dialog is opened and cancelled and A goes through the API instead).
// Playwright matches names by SUBSTRING and case-insensitively: every lookup that could meet a longer name is `exact: true` ("Move 2 mappings" is inside no other name, but "Undo" is inside "Undo this move"). The cases are SERIAL and depend on
// each other (O and C are the subjects of 2 to 7), so a failing case skips the ones after it. Two assertions depend on the collector's timing and are given generous polls: O reads offline (about 2 s measured) and online again after a move.

const ADMIN = { username: "admin", password: "correct-horse" };
const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost/";

const RUN = Date.now().toString(36);
/** A name that belongs to this run. */
const name = (what: string): string => `W33 ${RUN} ${what}`;
/** What an earlier run that stopped half way may have left behind: `W33 ` and a run id (Date.now() in base 36 is 8 characters until 2059). The asset is `W33 <run>` itself. */
const LEFTOVER = /^W33 [0-9a-z]{8}( |$)/;

const HOST = "simulator";
const PORT = 9100;
const LIVE = `http://${HOST}:${PORT}`;
const DEAD = `http://127.0.0.1:${PORT}`;
const DEAD_TWO = `http://127.0.0.2:${PORT}`;
const KEY = "sim-key";
const POWER = "M001_kW";
const ENERGY = "M001_kWh";

const OLD = name("old");
const ASSET = `W33 ${RUN}`;
const SCOPE = name("hist");
const ROLE = "w33-no-edit";
const USER = "w33-viewer";
const PASSWORD = `w33-${RUN}-password`;
const MOVE_ITEM = "Move to new address...";
const TICK = "I checked that this is the same device";
const NOT_FOUND_TEXT = "A later scan of the same range did not find it.";

// ---------------------------------------------------------------------------------------------------------------------------------
// The API shapes this spec reads (written here, so a change of the server shows up as a failure)

interface ApiMatch { kind: string; evidence: string; value: string | null; addresses: number; missing_addresses: number | null; needs_tick: boolean }
type RowCandidate = { kind: "offer"; to_source_id: number; to_name: string; to_endpoint: string; match: ApiMatch } | { kind: "two"; count: number };
interface ApiSource {
  id: number; name: string; connector_type: string; config: { url?: string }; enabled: boolean; status: string; origin: string;
  mapped_points: number; offline_since: string | null; move_candidate: RowCandidate | null;
}
interface ApiPoint { id: number; address: string; name: string; mapping: { id: number } | null }
interface ApiGraphPoint { id: number; mapping_id: number | null; asset_id: number | null }
interface GraphCandidate {
  kind: "offer" | "two"; from_source_id?: number; from_name?: string; from_endpoint?: string; mappings?: number; assets?: number; match?: ApiMatch; count?: number;
}
interface NotSeen { scan_id: number; at: string; last_seen_scan_id: number; last_seen_at: string }
interface GraphSource {
  id: number; name: string; connector_type: string; origin: "manual" | "discovered"; config: { url?: string }; point_count: number; needs_credentials: boolean;
  last_scan: { scan_id: number; at: string } | null; not_seen: NotSeen | null; identity: { instance: string | null; usable: boolean; different: boolean } | null;
  move_candidate: GraphCandidate | null; clusters: { key: string; points: ApiGraphPoint[] }[]; ungrouped: ApiGraphPoint[];
}
interface ApiGraph { sources: GraphSource[]; assets: { id: number }[]; unidentified: unknown[] }
interface ApiScope { id: number; name: string }
interface ApiFinding { host: string; port: number; source_id: number | null; connector_type: string | null; outcome: string; detail: string }
interface ApiScan { id: number; status: string; error: string | null; scope_name: string; findings: ApiFinding[] }
interface ApiAsset { id: number; parent_id: number | null; name: string }
interface ApiJob { id: number; status: string }
interface ApiUser { id: number; username: string }
interface ApiRole { id: number; name: string; builtin: boolean }
interface ApiEvent { id: number; kind: string; code: string | null }
interface ApiAudit { id: number; action: string; detail: Record<string, unknown> }
interface RemoveAnswer { removed: { id: number; name: string }[]; skipped: { id: number; name: string | null; reason: string }[] }

async function json<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(path);
  expect(response.ok(), `GET ${path}: ${response.status()} ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}
const graphOf = (request: APIRequestContext) => json<ApiGraph>(request, "/api/discovery/graph");
const sourcesOf = (request: APIRequestContext) => json<ApiSource[]>(request, "/api/sources");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `use` with the request context of a fresh browser context in which `who` is signed in. */
async function as<T>(browser: Browser, who: { username: string; password: string }, use: (request: APIRequestContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  try {
    const login = await context.request.post("/api/login", { data: who });
    expect(login.ok(), `${who.username} signs in: ${login.status()} ${await login.text()}`).toBe(true);
    return await use(context.request);
  } finally {
    await context.close();
  }
}
const asAdmin = <T>(browser: Browser, use: (request: APIRequestContext) => Promise<T>) => as(browser, ADMIN, use);

async function signIn(page: Page): Promise<void> {
  const login = await page.request.post("/api/login", { data: ADMIN });
  expect(login.ok(), `signing in: ${login.status()} ${await login.text()}`).toBe(true);
}

/** The host and port of a stored source URL (`http://127.0.0.1:9100/` -> `127.0.0.1:9100`). */
const hostPortOf = (url: string | undefined): string => (url ? new URL(url).host : "");

const pointsOfGraph = (source: GraphSource): ApiGraphPoint[] => [...source.clusters.flatMap((c) => c.points), ...source.ungrouped];
const isMappedInGraph = (source: GraphSource): boolean => pointsOfGraph(source).some((p) => p.mapping_id !== null || p.asset_id !== null);
/** What Remove not seen may take: discovered, marked not seen, nothing mapped (the page's own rule, written again). */
const removableNotSeen = (graph: ApiGraph): GraphSource[] => graph.sources.filter((s) => s.origin === "discovered" && s.not_seen !== null && !isMappedInGraph(s));

// ---------------------------------------------------------------------------------------------------------------------------------
// Scans, removals, waiting

async function scopeNamed(request: APIRequestContext): Promise<ApiScope> {
  const found = (await json<ApiScope[]>(request, "/api/scopes")).find((s) => s.name === SCOPE);
  if (found) return found;
  const made = await request.post("/api/scopes", { data: { name: SCOPE, targets: [HOST], ports: [PORT] } });
  expect(made.status(), `creating the scope: ${await made.text()}`).toBe(201);
  return (await made.json()) as ApiScope;
}

/** Previews and starts a scan of this run's scope (a scan somebody else started makes the start answer 409: it is tried again for a while), polls until it has ended and asserts it ended `done`. */
async function runScan(request: APIRequestContext): Promise<ApiScan> {
  const scope = await scopeNamed(request);
  let scanId = 0;
  for (let attempt = 0; attempt < 40 && scanId === 0; attempt++) {
    const preview = await json<{ hosts: number; digest: string }>(request, `/api/scopes/${scope.id}/preview`);
    const started = await request.post(`/api/scopes/${scope.id}/scan`, { data: { confirm_host_count: preview.hosts, digest: preview.digest } });
    if (started.status() === 202) scanId = ((await started.json()) as { scan_id: number }).scan_id;
    else if (started.status() === 409) await sleep(3_000);
    else throw new Error(`starting the scan: ${started.status()} ${await started.text()}`);
  }
  expect(scanId, "a scan could be started").toBeGreaterThan(0);
  let last: ApiScan | undefined;
  await expect
    .poll(async () => {
      last = await json<ApiScan>(request, `/api/scans/${scanId}`);
      return last.status === "done" || last.status === "failed";
    }, { timeout: 120_000, intervals: [500, 1000, 2000], message: `scan #${scanId} never ended` })
    .toBe(true);
  expect(last!.status, `scan #${scanId} ended ${last!.status}: ${last!.error}`).toBe("done");
  return last!;
}

/** The finding of a scan at the Historian's port. */
function findingOf(scan: ApiScan): ApiFinding {
  const found = scan.findings.find((f) => f.port === PORT);
  expect(found, `scan #${scan.id} has a finding at port ${PORT} (findings: ${JSON.stringify(scan.findings)})`).toBeDefined();
  expect(found!.source_id, `the finding at port ${PORT} is linked to a source`).not.toBeNull();
  return found!;
}

/** Removes discovered sources with nothing mapped through Discovery's own route (a running scan makes it answer 409: tried again). */
async function removeDiscovered(request: APIRequestContext, ids: number[]): Promise<RemoveAnswer> {
  let last = "";
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await request.post("/api/discovery/sources/remove", { data: { source_ids: ids } });
    if (response.ok()) return (await response.json()) as RemoveAnswer;
    last = `${response.status()} ${await response.text()}`;
    if (response.status() !== 409) break;
    await sleep(2_000);
  }
  throw new Error(`removing discovered sources ${ids.join(", ")}: ${last}`);
}

/** The source reads offline and has an open incident of a server that did not answer at all. */
async function waitOffline(request: APIRequestContext, id: number): Promise<void> {
  await expect
    .poll(async () => {
      const row = (await sourcesOf(request)).find((s) => s.id === id);
      if (row?.status !== "offline") return false;
      const open = await json<{ items: ApiEvent[] }>(request, `/api/events?source=${id}&open=1`);
      return open.items.some((e) => e.kind === "source.offline" && (e.code === "unreachable" || e.code === "timeout"));
    }, { message: `source ${id} reads offline with an unreachable incident`, timeout: 90_000, intervals: [1_000, 2_000] })
    .toBe(true);
}

async function waitOnline(request: APIRequestContext, id: number): Promise<void> {
  await expect
    .poll(async () => (await sourcesOf(request)).find((s) => s.id === id)?.status, { message: `source ${id} reads online`, timeout: 90_000, intervals: [1_000, 2_000] })
    .toBe("online");
}

async function browse(request: APIRequestContext, id: number): Promise<number> {
  const started = await request.post(`/api/sources/${id}/browse`);
  expect(started.status(), `browsing source ${id}: ${await started.text()}`).toBe(202);
  const jobId = ((await started.json()) as { job_id: number }).job_id;
  await expect.poll(async () => (await json<ApiJob>(request, `/api/jobs/${jobId}`)).status, { message: "the browse job ends", timeout: 30_000 }).toBe("done");
  return (await json<ApiPoint[]>(request, `/api/sources/${id}/points`)).length;
}

/** Gives a source a scan made the key of the Historian (the scan cannot know it) and browses it, as a person would: it then has its points. */
async function giveKeyAndBrowse(request: APIRequestContext, id: number): Promise<number> {
  const patched = await request.patch(`/api/sources/${id}`, { data: { secret: KEY } });
  expect(patched.ok(), `giving source ${id} its key: ${patched.status()} ${await patched.text()}`).toBe(true);
  return browse(request, id);
}

async function setUrl(request: APIRequestContext, id: number, url: string, extra: { enabled?: boolean } = {}): Promise<void> {
  const patched = await request.patch(`/api/sources/${id}`, { data: { config: { url }, ...extra } });
  expect(patched.ok(), `changing the address of source ${id}: ${patched.status()} ${await patched.text()}`).toBe(true);
}

/** O's row of the Sources list, as the API serves it. */
async function oldRow(request: APIRequestContext): Promise<ApiSource> {
  const found = (await sourcesOf(request)).find((s) => s.id === world.oldId);
  expect(found, `the source ${OLD} exists`).toBeDefined();
  return found!;
}

/** Waits until the API offers O the move (a scan has found the new source and the match has been decided) and returns the offer. */
async function waitForOffer(request: APIRequestContext): Promise<Extract<RowCandidate, { kind: "offer" }>> {
  const seen: { value: RowCandidate | null } = { value: null };
  await expect
    .poll(async () => {
      seen.value = (await oldRow(request)).move_candidate;
      return seen.value?.kind ?? "none";
    }, { message: "the Sources list offers the move", timeout: 60_000, intervals: [1_000, 2_000] })
    .not.toBe("none");
  const answer = seen.value;
  expect(answer?.kind, "one server could be this one (another old source that also wants the new one makes it two)").toBe("offer");
  return answer as Extract<RowCandidate, { kind: "offer" }>;
}

/**
 * The source a scan made: its finding is linked to a source that was not there before. It is renamed `W33 <run> <label>` AT ONCE (the scan names it `DCDash simulator at simulator:9100`, a name nothing tells from somebody else's source;
 * a name of this spec's is how the clean-up finds it, and nothing else is ever deleted). Returns its id.
 */
async function adoptScanSource(request: APIRequestContext, scan: ApiScan, knownBefore: ReadonlySet<number>, label: string): Promise<number> {
  const id = findingOf(scan).source_id!;
  expect(knownBefore.has(id), "the scan made a NEW source (the endpoint is free)").toBe(false);
  const renamed = await request.patch(`/api/sources/${id}`, { data: { name: name(label) } });
  expect(renamed.ok(), `naming the scan's source: ${renamed.status()} ${await renamed.text()}`).toBe(true);
  return id;
}

/** A scan, its new source (named for this run), given its key and browsed, as a person would: it then has its points. */
async function newSourceFromScan(request: APIRequestContext, knownBefore: ReadonlySet<number>, label: string): Promise<number> {
  const id = await adoptScanSource(request, await runScan(request), knownBefore, label);
  expect(await giveKeyAndBrowse(request, id), "the Historian has many points").toBeGreaterThan(10);
  return id;
}

const knownIds = async (request: APIRequestContext): Promise<Set<number>> => new Set((await graphOf(request)).sources.map((s) => s.id));

// ---------------------------------------------------------------------------------------------------------------------------------
// Clean-up

/**
 * Everything this spec may have made, in the order that works: accounts, roles, the assets (their mappings go with them), the sources named `W33 <run> ...` (the hand-added one, and the ones a scan made, which are renamed
 * at once: a mapped one is deleted with its confirmation, an unmapped discovered one is removed through Discovery), the scopes. Each step on its own; the problems are raised at the end. Nothing is ever deleted by its address:
 * a source somebody else holds at the endpoint is theirs.
 */
async function removeMine(request: APIRequestContext): Promise<void> {
  const problems: string[] = [];
  const attempt = async (what: string, step: () => Promise<void>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      problems.push(`${what}: ${String(error)}`);
    }
  };
  const gone = async (what: string, response: APIResponse): Promise<void> => {
    if (![200, 204, 404].includes(response.status())) problems.push(`${what}: ${response.status()} ${await response.text()}`);
  };
  await attempt("the accounts", async () => {
    for (const user of (await json<ApiUser[]>(request, "/api/users")).filter((u) => u.username.startsWith("w33-"))) await gone(`user ${user.username}`, await request.delete(`/api/users/${user.id}`));
  });
  await attempt("the roles", async () => {
    for (const role of (await json<ApiRole[]>(request, "/api/roles")).filter((r) => !r.builtin && r.name.startsWith("w33-"))) await gone(`role ${role.name}`, await request.delete(`/api/roles/${role.id}`));
  });
  await attempt("the assets", async () => {
    for (const asset of (await json<ApiAsset[]>(request, "/api/assets")).filter((a) => a.parent_id === null && LEFTOVER.test(a.name))) await gone(`asset ${asset.name}`, await request.delete(`/api/assets/${asset.id}?confirm=true`));
  });
  await attempt("the sources", async () => {
    const ours = (await graphOf(request)).sources.filter((s) => LEFTOVER.test(s.name));
    for (const source of ours.filter((s) => s.origin === "manual" || isMappedInGraph(s))) await gone(`source ${source.name}`, await request.delete(`/api/sources/${source.id}?confirm=true`));
    const plain = ours.filter((s) => s.origin === "discovered" && !isMappedInGraph(s)).map((s) => s.id);
    if (plain.length > 0) await removeDiscovered(request, plain);
  });
  await attempt("the scopes", async () => {
    for (const scope of (await json<ApiScope[]>(request, "/api/scopes")).filter((s) => /^W33 [0-9a-z]{8} /.test(s.name))) await gone(`scope ${scope.name}`, await request.delete(`/api/scopes/${scope.id}`));
  });
  expect(problems, "everything this spec made was removed").toEqual([]);
}

/** What the cases hand to each other. */
const world = {
  blocked: null as string | null,
  oldId: 0, assetId: 0, newId: 0, scanId: 0,
  pointIds: [] as number[], pointsBefore: [] as string[],
  auditId: 0,
};

test.beforeAll(async ({ browser }) => {
  await asAdmin(browser, removeMine); // what an earlier run that stopped half way left behind
});

test.afterAll(async ({ browser }) => {
  await asAdmin(browser, removeMine);
});

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

/** Every case after the first needs the setup: when the endpoint is somebody else's, they skip with the reason. */
const needSetup = () => test.skip(world.blocked !== null, world.blocked ?? "");

// ---------------------------------------------------------------------------------------------------------------------------------
// Locators and small helpers for the pages

const heading1 = (page: Page, text: string) => page.getByRole("heading", { level: 1, name: text, exact: true });
/** A Sources row, found by the title of its name cell. */
const sourceRow = (page: Page, sourceName: string) => page.getByRole("row").filter({ has: page.locator(`.cell-name[title="${sourceName}"]`) });
const toastWith = (page: Page, text: string) => page.locator(".toast-stack .toast").filter({ hasText: text });
const moveDialog = (page: Page) => page.getByRole("dialog", { name: `Move to new address: ${OLD}`, exact: true });
const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const srcNode = (page: Page, id: number) => node(page, `src:${id}`);
const overflowButton = (page: Page) => page.getByRole("button", { name: "More Discovery actions", exact: true });
const overflowMenu = (page: Page) => page.getByRole("menu", { name: "Discovery actions", exact: true });

/** Resolves once `target` has stopped moving: React Flow animates the viewport, and boxes taken mid-animation are stale. */
async function stopped(target: Locator): Promise<void> {
  let previous = "";
  await expect.poll(async () => {
    const now = JSON.stringify(await target.boundingBox());
    const same = now !== "null" && now === previous;
    previous = now;
    return same;
  }, { intervals: [150], message: "never stopped moving" }).toBe(true);
}

async function fitView(page: Page, target: Locator): Promise<void> {
  await page.getByRole("button", { name: "fit view" }).click();
  await stopped(target);
}

/** Re-fit when `target` is not fully inside the canvas (a node that is off-screen cannot be clicked). */
async function ensureOnCanvas(page: Page, target: Locator): Promise<void> {
  const pane = (await page.locator(".react-flow__pane").boundingBox())!;
  const box = await target.boundingBox();
  const inside = box !== null && box.x >= pane.x && box.y >= pane.y && box.x + box.width <= pane.x + pane.width && box.y + box.height <= pane.y + pane.height;
  if (!inside) await fitView(page, target);
}

/** Opens Discovery with a window tall enough for the whole graph at the smallest zoom (the stack's other sources and assets are drawn too) and fits the view. */
async function openDiscovery(page: Page): Promise<void> {
  const graph = await graphOf(page.request);
  const rows = Math.max(graph.assets.length * 64, graph.sources.length * 176 + graph.unidentified.length * 64);
  const need = Math.ceil(rows * 0.5 * 1.3 + 350);
  const view = page.viewportSize()!;
  if (need > view.height) await page.setViewportSize({ width: view.width, height: Math.min(need, 12_000) });
  await page.goto("/discovery");
  await expect(heading1(page, "Discovery")).toBeVisible();
  await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 30_000 });
  await stopped(page.locator(".react-flow__node").first());
  await fitView(page, page.locator(".react-flow__node").first());
}

/** The open menu lies inside the window and nothing covers or cuts off any of its items. */
async function expectMenuReachable(page: Page, menu: Locator): Promise<void> {
  const view = page.viewportSize()!;
  await expect(async () => {
    const box = await menu.boundingBox();
    expect(box, "the open menu has a box").not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(view.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(view.height);
  }).toPass({ timeout: 5_000 });
  const hidden = await menu.evaluate((el) =>
    Array.from(el.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .filter((item) => {
        const box = item.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit === null || !el.contains(hit);
      })
      .map((item) => item.textContent ?? ""),
  );
  expect(hidden, "menu items covered by something else or cut off").toEqual([]);
}

/** Opens the Sources row menu of the old source and returns the menu. */
async function openOldMenu(page: Page): Promise<Locator> {
  const row = sourceRow(page, OLD);
  await expect(row).toBeVisible();
  await row.scrollIntoViewIfNeeded();
  await row.getByRole("button", { name: `Actions for ${OLD}`, exact: true }).click();
  const menu = page.getByRole("menu", { name: `Actions for ${OLD}`, exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

/** The mappings of O's points as the API serves them: `point id / address / mapping id`, sorted. */
async function pointsSnapshot(request: APIRequestContext, id: number): Promise<string[]> {
  return (await json<ApiPoint[]>(request, `/api/sources/${id}/points`)).map((p) => `${p.id}|${p.address}|${p.mapping?.id ?? "-"}`).sort();
}

/** What the open move dialog says: the checks every opener shares. Does not press anything. */
async function expectDialogContent(page: Page, dialog: Locator): Promise<void> {
  await expect(dialog.locator(".move-fromto")).toHaveText(`From ${DEAD} to ${LIVE}`);
  await expect(dialog.getByText("All 2 mapped addresses and their names exist on the new server.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Its 2 mappings on 1 asset keep their points and readings.", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/^The new source found by the scan \([\d,]+ points\) is removed; its points were never mapped\.$/)).toBeVisible();
  await expect(dialog.getByText(`The name stays "${OLD}".`, { exact: true })).toBeVisible();
  await expect(dialog.getByText("Readings taken after the move stay after an Undo.", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/mapped addresses? (was|were) not found/), "no address is missing on the new server").toHaveCount(0);
  await expect(dialog.getByRole("checkbox", { name: TICK, exact: true }), "a match by addresses alone asks for the tick").not.toBeChecked();
  const go = dialog.getByRole("button", { name: "Move 2 mappings", exact: true });
  await expect(go, "Move is off until the box is ticked").toHaveAttribute("aria-disabled", "true");
  await expect(page.locator(".shell"), "the page behind is inert").toHaveAttribute("inert", "");
}

// ---------------------------------------------------------------------------------------------------------------------------------

test.describe("W33: devices that move or disappear", () => {
  test.describe.configure({ mode: "serial" });

  test("1. the setup: an old source with two mappings and no identity is offline at a dead address, and the endpoint of the scan is free", async ({ page }) => {
    test.setTimeout(240_000);
    const request = page.request;

    await test.step(`the scan's endpoint ${HOST}:${PORT} is free (a source this run finds there before it makes any is somebody else's)`, async () => {
      const before = await knownIds(request);
      const finding = (await runScan(request)).findings.find((f) => f.port === PORT);
      if (!finding || finding.source_id === null) {
        world.blocked = `nothing answers at ${HOST}:${PORT}${finding ? ` (${finding.outcome}: ${finding.detail})` : ""}, so there is no server to move`;
      } else if (before.has(finding.source_id)) {
        const holder = (await graphOf(request)).sources.find((s) => s.id === finding.source_id);
        world.blocked = `${HOST}:${PORT} is already held by the source "${holder?.name ?? finding.source_id}", which this spec did not make: a scan would link to it and make no new source`;
      } else {
        // The scan made it: it is removed again (an unmapped discovered source), and the endpoint is free for the real run of this case.
        const removed = await removeDiscovered(request, [finding.source_id]);
        expect(removed.removed.map((r) => r.id)).toEqual([finding.source_id]);
      }
    });
    test.skip(world.blocked !== null, world.blocked ?? "");

    await test.step("an asset, and the old source at the live endpoint (switched off, with the key): its points are browsed and two are mapped", async () => {
      const asset = await request.post("/api/assets", { data: { name: ASSET, parent_id: null, kind: "generic", sort_order: 0 } });
      expect(asset.status(), `creating the asset: ${await asset.text()}`).toBe(201);
      world.assetId = ((await asset.json()) as ApiAsset).id;

      const made = await request.post("/api/sources", { data: { name: OLD, connector_type: "simulator", config: { url: LIVE }, secret: KEY, enabled: false } });
      expect(made.status(), `creating the source: ${await made.text()}`).toBe(201);
      world.oldId = ((await made.json()) as ApiSource).id;
      expect(await browse(request, world.oldId), "the Historian has many points").toBeGreaterThan(10);

      const points = await json<ApiPoint[]>(request, `/api/sources/${world.oldId}/points`);
      const power = points.find((p) => p.address === POWER);
      const energy = points.find((p) => p.address === ENERGY);
      expect(power && energy, `the Historian has ${POWER} and ${ENERGY}`).toBeTruthy();
      for (const [point, metric] of [[power!, "active_power_kw"], [energy!, "energy_kwh"]] as const) {
        const mapped = await request.post("/api/mappings", { data: { point_id: point.id, asset_id: world.assetId, metric } });
        expect(mapped.status(), `mapping ${point.address}: ${await mapped.text()}`).toBe(201);
      }
      world.pointIds = [power!.id, energy!.id];
      world.pointsBefore = await pointsSnapshot(request, world.oldId);
    });

    await test.step("it has no identity (nothing asked the server who it is), then its address is changed to the collector's own loopback and it is switched on: offline, unreachable", async () => {
      const graphed = (await graphOf(request)).sources.find((s) => s.id === world.oldId);
      expect(graphed?.identity ?? null, "no stored identity: only the addresses can say it is the same server").toBeNull();
      await setUrl(request, world.oldId, DEAD, { enabled: true });
      await waitOffline(request, world.oldId);
      const row = await oldRow(request);
      expect(row.mapped_points).toBe(2);
      expect(row.offline_since, "the list says since when").not.toBeNull();
      expect(row.move_candidate, "no scan has found the server again yet").toBeNull();
    });
  });

  test("2. a scan finds the server at the live address: the API offers the move, as a possible match by addresses", async ({ page }) => {
    needSetup();
    test.setTimeout(180_000);
    const request = page.request;
    const before = await knownIds(request);
    world.newId = await newSourceFromScan(request, before, "new one");

    const offer = await waitForOffer(request);
    expect(offer.to_source_id, "the offer names the new source").toBe(world.newId);
    expect(hostPortOf(offer.to_endpoint), "and the address it was found at").toBe(`${HOST}:${PORT}`);
    expect(offer.match).toMatchObject({ kind: "possibly", evidence: "addresses", value: null, addresses: 2, missing_addresses: 0, needs_tick: true });

    const graph = await graphOf(request);
    const fresh = graph.sources.find((s) => s.id === world.newId)!;
    expect(fresh.origin).toBe("discovered");
    expect(fresh.config.url).toMatch(new RegExp(`^http://${HOST}:${PORT}/?$`));
    expect(isMappedInGraph(fresh), "the scan's source has nothing mapped").toBe(false);
    expect(fresh.move_candidate).toMatchObject({ kind: "offer", from_source_id: world.oldId, from_name: OLD, mappings: 2, assets: 1 });
    expect(fresh.move_candidate?.match).toMatchObject({ kind: "possibly", addresses: 2, missing_addresses: 0 });
    expect(fresh.not_seen, "the scan just saw it").toBeNull();
  });

  test("3. Sources: Move to new address... is the FIRST item of the offline row's menu, and the menu is reachable at 1024 x 768", async ({ page }) => {
    needSetup();
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/sources");
    await expect(heading1(page, "Sources")).toBeVisible();
    const menu = await openOldMenu(page);
    const items = menu.getByRole("menuitem");
    await expect(items.first(), "the reason the row is worth a look comes first").toHaveText(MOVE_ITEM);
    await expect(items.filter({ hasText: MOVE_ITEM })).toHaveCount(1);
    expect(await items.count(), "the other items are still there").toBeGreaterThan(3);
    await expectMenuReachable(page, menu);
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(sourceRow(page, OLD).getByRole("button", { name: `Actions for ${OLD}`, exact: true }), "Escape puts the focus back on the row's menu button").toBeFocused();
  });

  test("4. Discovery: the new source's card says it looks like the old one and offers Move...; the dialog opens from it and asks for the tick", async ({ page }) => {
    needSetup();
    test.setTimeout(120_000);
    const fresh = (await graphOf(page.request)).sources.find((s) => s.id === world.newId)!;
    await openDiscovery(page);
    const card = srcNode(page, world.newId);
    await expect(card).toBeVisible();
    await ensureOnCanvas(page, card);

    const line = card.locator(".gsrc-seen");
    await expect(line, "the card's last line").toHaveText(`Looks like ${OLD}`);
    await expect(line, "the whole sentence is in the tooltip").toHaveAttribute("title", new RegExp(`^This looks like ${OLD} \\(2 mappings on 1 asset\\), which stopped answering at 127\\.0\\.0\\.1:${PORT}`));
    await expect(card.locator(".gnode"), "an offered source is not dimmed").not.toHaveClass(/gsrc-not-seen/);
    await expect(card.getByRole("button", { name: `Details for ${fresh.name}`, exact: true })).toBeVisible();

    const open = card.getByRole("button", { name: `Move ${OLD} to ${fresh.name}...`, exact: true });
    await expect(open).toBeVisible();
    await open.click();
    const dialog = moveDialog(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel", exact: true }), "the focus starts on Cancel").toBeFocused();
    await expect(dialog.getByRole("button", { name: "Move 2 mappings", exact: true })).toBeVisible();
    await expectDialogContent(page, dialog);

    // Pressing the disabled Move says what is missing and moves nothing.
    await dialog.getByRole("button", { name: "Move 2 mappings", exact: true }).click({ force: true }); // aria-disabled, not disabled: the click reaches the button, and Playwright's own check of "enabled" is skipped
    await expect(dialog.getByText("Tick the box to confirm before you move.", { exact: true })).toBeVisible();
    expect(hostPortOf((await oldRow(page.request)).config.url), "nothing moved").toBe(`127.0.0.1:${PORT}`);

    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".shell"), "the page is live again").not.toHaveAttribute("inert", "");
    await expect(open, "the focus is back on the button that opened the dialog").toBeFocused();
  });

  test("5. permissions: a role without sources.edit has no Move item and no Move... button, and the move routes answer 403", async ({ browser }) => {
    needSetup();
    test.setTimeout(180_000);
    await asAdmin(browser, async (request) => {
      const role = await request.post("/api/roles", { data: { name: ROLE, description: "made by w33.spec.ts", permissions: ["sources.view", "sources.test", "discovery.view"] } });
      expect(role.status(), `creating the role: ${await role.text()}`).toBe(201);
      const user = await request.post("/api/users", { data: { username: USER, password: PASSWORD, role: ROLE } });
      expect(user.status(), `creating the account: ${await user.text()}`).toBe(201);
    });
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 900 } });
    try {
      const login = await context.request.post("/api/login", { data: { username: USER, password: PASSWORD } });
      expect(login.ok(), `${USER} signs in: ${login.status()} ${await login.text()}`).toBe(true);
      const page = await context.newPage();

      await page.goto("/sources");
      await expect(heading1(page, "Sources")).toBeVisible();
      const row = sourceRow(page, OLD);
      await expect(row, "the account sees the offline source").toBeVisible();
      await expectNoRowAction(page, row, MOVE_ITEM);
      const row2 = (await json<ApiSource[]>(context.request, "/api/sources")).find((s) => s.id === world.oldId)!;
      expect(row2.move_candidate, "the API still tells it what is on offer (reading is not editing)").not.toBeNull();

      await openDiscovery(page);
      const card = srcNode(page, world.newId);
      await expect(card).toBeVisible();
      await expect(card.locator(".gsrc-seen"), "the card still says what it looks like").toHaveText(`Looks like ${OLD}`);
      await expect(card.getByRole("button", { name: /^Move .* to .*\.\.\.$/ }), "but offers no Move...").toHaveCount(0);

      const dry = await context.request.post(`/api/sources/${world.oldId}/move?dry_run=1`, { data: { to: world.newId, address: "as_found" } });
      expect(dry.status(), "the preview needs sources.edit").toBe(403);
      const undo = await context.request.post(`/api/sources/moves/1/undo`);
      expect(undo.status(), "the Undo needs sources.edit").toBe(403);
    } finally {
      await context.close();
    }
  });

  test("6. the move from Sources: the dialog, the tick, the same point ids, the source online, the duplicate gone, Undo from the toast, and the Audit page", async ({ page }) => {
    needSetup();
    test.setTimeout(240_000);
    const request = page.request;
    const mappingsBefore = await pointsSnapshot(request, world.oldId);
    expect(mappingsBefore, "the points are what case 1 saw").toEqual(world.pointsBefore);

    await page.goto("/sources");
    await expect(heading1(page, "Sources")).toBeVisible();
    const menu = await openOldMenu(page);
    await menu.getByRole("menuitem", { name: MOVE_ITEM, exact: true }).click();
    const dialog = moveDialog(page);
    await expect(dialog).toBeVisible();
    await expectDialogContent(page, dialog);

    await dialog.getByRole("checkbox", { name: TICK, exact: true }).check();
    const go = dialog.getByRole("button", { name: "Move 2 mappings", exact: true });
    await expect(go, "ticked: Move is on").not.toHaveAttribute("aria-disabled", "true");
    await go.click();
    await expect(dialog).toBeHidden();

    const moved = toastWith(page, `Moved "${OLD}" to ${HOST}:${PORT}. 2 mappings kept.`);
    await expect(moved).toBeVisible();
    await moved.hover(); // a hovered toast waits: the checks below take longer than its 10 s
    const undoButton = moved.getByRole("button", { name: "Undo", exact: true });
    await expect(undoButton, "the toast offers Undo").toBeVisible();

    await test.step("the source kept its two mappings and the very same points; it is at the live address and turns online", async () => {
      const row = await oldRow(request);
      expect(hostPortOf(row.config.url), "O points at the address the scan found").toBe(`${HOST}:${PORT}`);
      expect(row.mapped_points).toBe(2);
      expect(await pointsSnapshot(request, world.oldId), "same point ids, same mapping ids").toEqual(mappingsBefore);
      await waitOnline(request, world.oldId);
      expect((await oldRow(request)).move_candidate, "nothing left to offer").toBeNull();
      const graph = await graphOf(request);
      expect(graph.sources.some((s) => s.id === world.newId), "the duplicate is gone").toBe(false);
      expect(graph.sources.find((s) => s.id === world.oldId)?.identity?.instance, "O took the identity of the server it was moved to").toBeTruthy();
    });

    await test.step("Undo in the toast puts the dead address back", async () => {
      await undoButton.click();
      await expect(toastWith(page, `Moved back to 127.0.0.1:${PORT}`)).toBeVisible();
      await expect.poll(async () => hostPortOf((await oldRow(request)).config.url), { message: "the address is back", timeout: 20_000 }).toBe(`127.0.0.1:${PORT}`);
      expect(await pointsSnapshot(request, world.oldId), "the points are still the same").toEqual(mappingsBefore);
      expect((await graphOf(request)).sources.find((s) => s.id === world.oldId)?.identity ?? null, "and the identity is what it was before the move").toBeNull();
      await waitOffline(request, world.oldId);
      expect((await graphOf(request)).sources.some((s) => s.id === world.newId), "the duplicate is not recreated by the Undo").toBe(false);
    });

    await test.step("the Audit page reads both entries", async () => {
      const moves = (await json<{ items: ApiAudit[] }>(request, "/api/audit?action=source.moved&limit=50")).items.filter((e) => e.detail.name_before === OLD);
      expect(moves, "one move of this source").toHaveLength(1);
      world.auditId = moves[0].id;
      expect(moves[0].detail).toMatchObject({ host_before: "127.0.0.1", port_before: PORT, host_after: HOST, port_after: PORT, mappings: 2 });
      const undone = (await json<{ items: ApiAudit[] }>(request, "/api/audit?action=source.move_undone&limit=50")).items.filter((e) => e.detail.name_before === OLD || e.detail.name_after === OLD);
      expect(undone, "and one Undo").toHaveLength(1);

      await page.goto("/audit?action=source.moved");
      await expect(heading1(page, "Audit log")).toBeVisible();
      await expect(page.locator(`.audit-table tr[data-entry-id="${world.auditId}"]`)).toContainText(
        `Moved ${OLD} from 127.0.0.1:${PORT} to ${HOST}:${PORT} (2 mappings kept, the duplicate removed) (matched by its 2 mapped addresses)`,
      );
      await page.goto("/audit?action=source.move_undone");
      await expect(heading1(page, "Audit log")).toBeVisible();
      await expect(page.locator(".audit-table tbody tr").filter({ hasText: `Undid the move of ${OLD}: back at 127.0.0.1:${PORT}` })).toHaveCount(1);
    });
  });

  test("7. the second round: the move from Discovery, then Undo this move in the Audit drawer; a second Undo is refused; the old source is deleted", async ({ page }) => {
    needSetup();
    test.setTimeout(300_000);
    const request = page.request;
    await waitOffline(request, world.oldId);
    const before = await knownIds(request);
    world.newId = await newSourceFromScan(request, before, "new two");
    const offer = await waitForOffer(request);
    expect(offer.to_source_id).toBe(world.newId);
    expect(offer.match, "the Undo gave O its identity back, so the match is by addresses again").toMatchObject({ kind: "possibly", addresses: 2, missing_addresses: 0 });
    const fresh = (await graphOf(request)).sources.find((s) => s.id === world.newId)!;
    const mappingsBefore = await pointsSnapshot(request, world.oldId);

    await test.step("Discovery's card moves it", async () => {
      await openDiscovery(page);
      const card = srcNode(page, world.newId);
      await ensureOnCanvas(page, card);
      await card.getByRole("button", { name: `Move ${OLD} to ${fresh.name}...`, exact: true }).click();
      const dialog = moveDialog(page);
      await expect(dialog).toBeVisible();
      await expectDialogContent(page, dialog);
      await dialog.getByRole("checkbox", { name: TICK, exact: true }).check();
      await dialog.getByRole("button", { name: "Move 2 mappings", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(toastWith(page, `Moved "${OLD}" to ${HOST}:${PORT}. 2 mappings kept.`)).toBeVisible();
      await expect(srcNode(page, world.newId), "the duplicate's card is gone").toHaveCount(0);
      expect(hostPortOf((await oldRow(request)).config.url)).toBe(`${HOST}:${PORT}`);
      expect(await pointsSnapshot(request, world.oldId), "same point ids, same mapping ids").toEqual(mappingsBefore);
      await waitOnline(request, world.oldId);
    });

    await test.step("Undo this move in the Audit drawer", async () => {
      const entry = (await json<{ items: ApiAudit[] }>(request, "/api/audit?action=source.moved&limit=50")).items.filter((e) => e.detail.name_before === OLD).sort((a, b) => b.id - a.id)[0];
      expect(entry, "the second move is in the audit log").toBeDefined();
      expect(entry.id).not.toBe(world.auditId);
      world.auditId = entry.id;
      await page.goto("/audit?action=source.moved");
      await expect(heading1(page, "Audit log")).toBeVisible();
      const row = page.locator(`.audit-table tr[data-entry-id="${world.auditId}"]`);
      await expect(row).toBeVisible();
      await row.getByRole("button", { name: `Details of entry #${world.auditId}`, exact: true }).click();
      const drawer = page.getByRole("dialog", { name: "Audit entry", exact: true });
      await expect(drawer).toBeVisible();
      await expect(drawer).toContainText("source.moved");
      const undo = drawer.getByRole("button", { name: "Undo this move", exact: true });
      await expect(undo).toBeVisible();
      await undo.click();
      await expect(drawer.locator(".audit-undo-slot")).toContainText(`Moved back to 127.0.0.1:${PORT}`);
      await expect(undo, "the button waits after it worked").toHaveAttribute("aria-disabled", "true");
      await expect.poll(async () => hostPortOf((await oldRow(request)).config.url), { message: "the address is back", timeout: 20_000 }).toBe(`127.0.0.1:${PORT}`);
      await waitOffline(request, world.oldId);
    });

    await test.step("a second Undo of the same entry is refused in words, and nothing changes", async () => {
      const again = await request.post(`/api/sources/moves/${world.auditId}/undo`);
      expect(again.status()).toBe(409);
      expect(await again.text()).toContain("this move was already undone");
      expect(hostPortOf((await oldRow(request)).config.url)).toBe(`127.0.0.1:${PORT}`);
    });

    await test.step("the old source and its asset are deleted, so the next case starts without an old source", async () => {
      const gone = await request.delete(`/api/sources/${world.oldId}?confirm=true`);
      expect(gone.status(), `deleting the old source: ${await gone.text()}`).toBe(204);
      const asset = await request.delete(`/api/assets/${world.assetId}?confirm=true`);
      expect([200, 204], `deleting the asset: ${asset.status()}`).toContain(asset.status());
    });
  });

  test("8. Not seen: the sources the newest scan of the range did not find are dimmed, filtered and removed - the mapped one stays", async ({ page }) => {
    needSetup();
    test.setTimeout(300_000);
    const request = page.request;
    const ids = { a: 0, m: 0, b: 0 };
    const scans = { first: 0, second: 0, third: 0 };
    let notSeenAsset = 0;

    await test.step("three scans of one scope: A (nothing mapped) and M (one point mapped) leave the live address before the next scan", async () => {
      const asset = await request.post("/api/assets", { data: { name: ASSET, parent_id: null, kind: "generic", sort_order: 0 } });
      expect(asset.status(), `creating the asset: ${await asset.text()}`).toBe(201);
      notSeenAsset = ((await asset.json()) as ApiAsset).id;

      let known = await knownIds(request);
      const one = await runScan(request);
      ids.a = await adoptScanSource(request, one, known, "a");
      scans.first = one.id;
      await setUrl(request, ids.a, DEAD); // A is now the source of an address nothing answers at

      known = await knownIds(request);
      const two = await runScan(request);
      ids.m = await adoptScanSource(request, two, known, "m"); // the live address is free again: scan 2 made a new source
      scans.second = two.id;
      await giveKeyAndBrowse(request, ids.m);
      const point = (await json<ApiPoint[]>(request, `/api/sources/${ids.m}/points`)).find((p) => p.address === POWER);
      expect(point, `M has ${POWER}`).toBeDefined();
      const accepted = await request.post("/api/discovery/accept", { data: { source_id: ids.m, asset_id: notSeenAsset, points: [{ point_id: point!.id, metric: "active_power_kw", scale: 1 }] } });
      expect(accepted.status(), `mapping a point of M: ${await accepted.text()}`).toBe(201);
      await setUrl(request, ids.m, DEAD_TWO, { enabled: false }); // mapped, switched off (it never reads offline, so it is nobody's old source), and away from the live address

      known = await knownIds(request);
      const three = await runScan(request);
      ids.b = await adoptScanSource(request, three, known, "b");
      scans.third = three.id;
    });

    await test.step("the API: A and M are not seen by scan 3, B is", async () => {
      const graph = await graphOf(request);
      const get = (id: number) => graph.sources.find((s) => s.id === id)!;
      expect(get(ids.a).not_seen).toMatchObject({ scan_id: scans.third, last_seen_scan_id: scans.first });
      expect(get(ids.m).not_seen).toMatchObject({ scan_id: scans.third, last_seen_scan_id: scans.second });
      expect(get(ids.b).not_seen, "B was found by the newest scan").toBeNull();
      expect(isMappedInGraph(get(ids.m)), "M has a mapped point").toBe(true);
      expect(removableNotSeen(graph).map((s) => s.id), "A can be removed, M cannot").toContain(ids.a);
      expect(removableNotSeen(graph).map((s) => s.id)).not.toContain(ids.m);
    });

    const graph = await graphOf(request);
    const nameOf = (id: number) => graph.sources.find((s) => s.id === id)!.name;
    await openDiscovery(page);

    await test.step("the cards: A dimmed with its sentence, M says what to do, B as usual", async () => {
      await ensureOnCanvas(page, srcNode(page, ids.a));
      await expect(srcNode(page, ids.a).locator(".gnode")).toHaveClass(/gsrc-not-seen/);
      await expect(srcNode(page, ids.a).locator(".gsrc-seen")).toHaveText(new RegExp(`^Not seen in scan #${scans.third} \\(last seen in #${scans.first}(, [^)]+)?\\)$`));
      await ensureOnCanvas(page, srcNode(page, ids.m));
      await expect(srcNode(page, ids.m).locator(".gnode")).toHaveClass(/gsrc-not-seen/);
      await expect(srcNode(page, ids.m).locator(".gsrc-seen")).toHaveText("Mapped: move it or delete it on Sources");
      await expect(srcNode(page, ids.m).locator(".gsrc-seen")).toHaveAttribute("title", new RegExp(`^Not seen in scan #${scans.third} \\(last seen in #${scans.second}`));
      await ensureOnCanvas(page, srcNode(page, ids.b));
      await expect(srcNode(page, ids.b).locator(".gnode")).not.toHaveClass(/gsrc-not-seen/);
    });

    await test.step("the panel of A says it in full", async () => {
      await srcNode(page, ids.a).getByRole("button", { name: `Details for ${nameOf(ids.a)}`, exact: true }).click();
      const panel = page.locator('[aria-label="Source details"]');
      await expect(panel).toBeVisible();
      await expect(panel).toContainText(new RegExp(`Not seen in scan #${scans.third} \\(last seen in #${scans.first}`));
      await expect(panel).toContainText(NOT_FOUND_TEXT);
      await panel.getByRole("button", { name: "Close", exact: true }).click();
      await expect(panel).toBeHidden();
    });

    await test.step("Turn on Not seen lately shows only the sources that were not seen, and turning it off brings the others back", async () => {
      const menu = overflowMenu(page);
      await overflowButton(page).click();
      await expect(menu).toBeVisible();
      await menu.getByRole("menuitem", { name: "Turn on Not seen lately", exact: true }).click();
      await expect(menu).toBeHidden();
      await expect(srcNode(page, ids.a), "A stays").toHaveCount(1);
      await expect(srcNode(page, ids.m), "M stays").toHaveCount(1);
      await expect(srcNode(page, ids.b), "B is hidden by the filter").toHaveCount(0);
      const unmarked = (await graphOf(request)).sources.filter((s) => s.not_seen === null);
      expect(unmarked.length, "the stack has sources that were seen").toBeGreaterThan(0);
      for (const other of unmarked) await expect(srcNode(page, other.id), `${other.name} is hidden by the filter`).toHaveCount(0);

      await overflowButton(page).click();
      await expect(menu).toBeVisible();
      await menu.getByRole("menuitem", { name: "Turn off Not seen lately", exact: true }).click();
      await expect(menu).toBeHidden();
      await expect(srcNode(page, ids.b), "B is back").toHaveCount(1);
    });

    await test.step("Remove not seen lists A, removes A and leaves M", async () => {
      const removable = removableNotSeen(await graphOf(request));
      const foreign = removable.filter((s) => s.id !== ids.a);
      const menu = overflowMenu(page);
      await overflowButton(page).click();
      await expect(menu).toBeVisible();
      await menu.getByRole("menuitem", { name: `Remove not seen (${removable.length})...`, exact: true }).click();
      const title = removable.length === 1 ? `Remove "${nameOf(ids.a)}", which the latest scan did not find?` : `Remove ${removable.length} sources the latest scan did not find?`;
      const dialog = page.getByRole("dialog", { name: title, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Mapped sources and sources added by hand are never removed.");
      await expect(dialog).toContainText(nameOf(ids.a));
      if (foreign.length > 0) {
        // Sources of other people are not seen too: they would go with A. The dialog is only looked at; A is removed through the API (nobody else's source is touched).
        test.info().annotations.push({ type: "note", description: `Remove not seen was not confirmed: ${foreign.length} other source(s) of the stack are not seen too` });
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(dialog).toBeHidden();
        const removed = await removeDiscovered(request, [ids.a]);
        expect(removed.removed.map((r) => r.id)).toEqual([ids.a]);
      } else {
        await dialog.getByRole("button", { name: "Remove", exact: true }).click();
        await expect(dialog).toBeHidden();
        await expect(toastWith(page, "Removed 1 source")).toBeVisible();
      }
      await expect(srcNode(page, ids.a), "A is gone").toHaveCount(0);
      await expect(srcNode(page, ids.m), "M stays: it has a mapped point").toHaveCount(1);
      const after = await graphOf(request);
      expect(after.sources.some((s) => s.id === ids.a)).toBe(false);
      expect(after.sources.some((s) => s.id === ids.m), "M is still there").toBe(true);
      expect(after.sources.some((s) => s.id === ids.b), "so is B, which was seen").toBe(true);
      expect(removableNotSeen(after).map((s) => s.id), "nothing of ours is left to remove").not.toContain(ids.m);
    });
  });
});
