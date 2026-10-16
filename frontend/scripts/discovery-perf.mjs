// Discovery speed harness (w12b): the same steps on any build of the front end (a `dist` folder), answered by page.route (no server, no docker, no stack).
// usage (from frontend/):  npx vite build --outDir /tmp/dist-x --emptyOutDir && node scripts/discovery-perf.mjs <label> /tmp/dist-x <out.json> [scenario ...]
//   scenarios: expandAll:60 expandAll:150 expandAll:500 expandOne:60 expandOne:150 expandOne:500 expandOne:2000 toggle hover drag
//              dragLive hoverLive (online sources: live edges) dragGroup:<n> (one open group of n points) dragW7u hoverW7u (W7u's 2,286-node graph); default: the first ten
//   env: REPEAT=n samples per scenario (default 3, the median is reported, every sample is kept), CPU_SLOWDOWN=4 (a CPU four times slower),
//        INJECT_CSS='...' (a stylesheet added to the page, for what-if runs), PROFILE_OUT=file.cpuprofile (hover only), SHOT=file.png
// A sample = a fresh browser context at 1440 x 900. "toVisibleMs" = from the click to the first frame in which the first new point node is drawn
// and visible (React Flow keeps a node hidden until it is measured); "busyMs" = the long tasks (>50 ms) started after the click, summed.
// Needs playwright-core and esbuild from node_modules (both are there for the end-to-end suite and Vite).
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The mock graph builder of the end-to-end specs is TypeScript: bundle it once into a temporary module.
const bundled = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "discovery-perf-")), "graphModel.mjs");
await build({ entryPoints: [path.join(FRONTEND, "e2e/graphModel.ts")], bundle: true, format: "esm", outfile: bundled, logLevel: "silent" });
const { bigModel, bigPointId, bigSourceId, bigGroup } = await import(pathToFileURL(bundled).href);

const ROOT = FRONTEND;
const ORIGIN = "http://perf.test";
const [label, DIST, outFile, ...wanted] = process.argv.slice(2);
const REPEAT = Number(process.env.REPEAT ?? 3);

const permissionsSource = fs.readFileSync(`${ROOT}/src/lib/permissions.ts`, "utf8");
const PERMISSIONS = [...permissionsSource.slice(0, permissionsSource.indexOf("] as const")).matchAll(/"([a-z]+\.[a-z]+)"/g)].map((m) => m[1]);
const USER = { id: 1, username: "admin", role: "admin", permissions: PERMISSIONS, preferences: { mode: "light", theme: "navy-gold" } };
const MIME = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".html": "text/html" };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function makeAnswer(model) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p.startsWith("/api/")) {
      if (request.method() !== "GET") return route.fulfill({ status: 204 });
      if (p === "/api/setup") return json(route, { needed: false });
      if (p === "/api/me") return json(route, USER);
      if (p === "/api/site") return json(route, { timezone: "UTC", currency: null });
      if (p === "/api/discovery/graph") return json(route, model);
      return json(route, p.endsWith("s") ? [] : {});
    }
    let file = path.join(DIST, p === "/" ? "index.html" : p);
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = `${DIST}/index.html`;
    return route.fulfill({ status: 200, contentType: MIME[path.extname(file)] ?? "application/octet-stream", body: fs.readFileSync(file) });
  };
}

const round = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length === 0 ? null : s[Math.floor(s.length / 2)]; };

async function cameraStill(page) {
  let last = "", same = 0;
  for (let i = 0; i < 200; i++) {
    const now = await page.locator(".react-flow__viewport").evaluate((el) => getComputedStyle(el).transform);
    same = now === last ? same + 1 : 0;
    last = now;
    if (same >= 2) return;
    await page.waitForTimeout(120);
  }
  throw new Error("the camera never came to rest");
}
async function openPage(browser, model) {
  const context = await browser.newContext({ baseURL: `${ORIGIN}/`, viewport: { width: 1440, height: 900 } });
  await context.route("**/*", makeAnswer(model));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  if (process.env.INJECT_CSS) await page.addInitScript((css) => { document.addEventListener("DOMContentLoaded", () => { const el = document.createElement("style"); el.textContent = css; document.head.appendChild(el); }); }, process.env.INJECT_CSS);
  await page.goto("/discovery");
  await page.locator(".react-flow__node").first().waitFor({ state: "visible", timeout: 60_000 });
  await cameraStill(page);
  // CPU_SLOWDOWN=4: the page runs on a CPU four times slower (a laptop over a remote desktop), after the first load.
  if (process.env.CPU_SLOWDOWN) await (await context.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.CPU_SLOWDOWN) });
  return { context, page, errors };
}

// Runs in the page: click, wait for `doneSel` to be drawn and visible, then one more frame; the long tasks since the click are summed.
const TIMED_CLICK = async ({ buttonScript, doneSel, goneSel }) => {
  const find = new Function(`return (${buttonScript})`)();
  const button = find();
  if (!button) throw new Error("button not found");
  const longs = [];
  const po = new PerformanceObserver((list) => { for (const e of list.getEntries()) longs.push({ at: e.startTime, ms: e.duration }); });
  po.observe({ entryTypes: ["longtask"] });
  const t0 = performance.now();
  button.click();
  let tVisible = null;
  await new Promise((resolve) => {
    const tick = () => {
      const n = document.querySelector(goneSel ?? doneSel);
      if (goneSel ? !n : n && getComputedStyle(n).visibility !== "hidden") { tVisible = performance.now(); resolve(); return; }
      if (performance.now() - t0 > 90_000) { resolve(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const tPaint = performance.now();
  // settle: no long task for 400 ms (at most 8 s)
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const lastEnd = longs.length ? Math.max(...longs.map((l) => l.at + l.ms)) : t0;
    if (performance.now() - lastEnd > 400) break;
  }
  po.disconnect();
  return {
    toVisibleMs: tVisible === null ? null : tVisible - t0, toPaintMs: tPaint - t0, busyMs: longs.reduce((s, l) => s + l.ms, 0),
    longTasks: longs.length, worstTaskMs: longs.reduce((m, l) => Math.max(m, l.ms), 0), nodes: document.querySelectorAll(".react-flow__node").length,
  };
};

async function expandAllSample(browser, points) {
  const groups = points >= 500 ? 10 : 6;
  const shapes = [{ groups, pointsPerGroup: Math.round(points / groups), status: "offline" }];
  const { context, page, errors } = await openPage(browser, bigModel(shapes));
  const first = bigPointId(shapes, 1, 1, 1);
  const r = await page.evaluate(TIMED_CLICK, {
    buttonScript: `() => [...document.querySelectorAll(".graph-bar button")].find((b) => b.textContent === "Expand all")`,
    doneSel: `.react-flow__node[data-id="point:${first}"]`,
  });
  await context.close();
  return { ...r, errors };
}
async function expandOneSample(browser, points) {
  const shapes = [{ groups: 1, pointsPerGroup: points, status: "offline" }];
  const { context, page, errors } = await openPage(browser, bigModel(shapes));
  const sid = bigSourceId(1);
  await page.locator(`.react-flow__node[data-id="src:${sid}"]`).getByRole("button", { name: /^Expand W7u Big 1$/ }).dispatchEvent("click");
  const cluster = page.locator(`.react-flow__node[data-id="cluster:${sid}:${bigGroup(1, 1)}"]`);
  await cluster.waitFor({ state: "visible", timeout: 30_000 });
  await cameraStill(page);
  const r = await page.evaluate(TIMED_CLICK, {
    buttonScript: `() => document.querySelector('.react-flow__node[data-id="cluster:${sid}:${bigGroup(1, 1)}"] button[aria-label="Expand ${bigGroup(1, 1)}"]')`,
    doneSel: `.react-flow__node[data-id="point:${bigPointId(shapes, 1, 1, 1)}"]`,
  });
  await context.close();
  return { ...r, errors };
}

// The drag/hover graph: ten sources of four groups of 49 points = 2,022 nodes once everything is open (no group over 50 points, so paging changes nothing).
const dragShapes = (status) => Array.from({ length: 10 }, () => ({ groups: 4, pointsPerGroup: 49, status }));
async function openDrag(browser, status = "offline") {
  if (status === "w7u") return openW7u(browser);
  if (String(status).startsWith("group")) return openGroup(browser, Number(String(status).slice(5)));
  const { context, page, errors } = await openPage(browser, bigModel(dragShapes(status)));
  const expand = page.locator(".graph-bar").getByRole("button", { name: "Expand all", exact: true });
  for (let pass = 0; pass < 12; pass++) {
    if ((await expand.getAttribute("aria-disabled")) === "true") break;
    await expand.click();
    await page.waitForTimeout(1500);
  }
  await page.waitForTimeout(1500);
  const nodes = await page.locator(".react-flow__node").count();
  await page.getByRole("button", { name: "fit view" }).click();
  await cameraStill(page);
  const zoomOf = () => page.locator(".react-flow__viewport").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  for (let i = 0; i < 12 && (await zoomOf()) < 0.55; i++) { await page.getByRole("button", { name: "zoom in" }).click(); await cameraStill(page); }
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT.replace(".png", "-drag.png") });
  return { context, page, errors, nodes };
}

// W7u's own graph and steps (ab.mjs), for a like-for-like reference against the 7 fps W7u measured: six groups of 1000 points in the first source, two of them opened.
const W7U_SHAPES = [
  { groups: 6, pointsPerGroup: 1000, status: "offline" }, { groups: 6, pointsPerGroup: 10 },
  ...Array.from({ length: 8 }, () => ({ groups: 4, pointsPerGroup: 5 })),
];
async function openW7u(browser) {
  const { context, page, errors } = await openPage(browser, bigModel(W7U_SHAPES));
  await page.locator(".graph-bar").getByRole("button", { name: "Expand all", exact: true }).click();
  const poll = async (fn, ok, ms) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 150)); } };
  await page.waitForTimeout(2500); // the groups of the small sources are drawn (a build that draws only what is on screen shows fewer of them)
  for (const g of [1, 2]) {
    const group = page.locator(`.react-flow__node[data-id="cluster:${bigSourceId(1)}:${bigGroup(1, g)}"]`);
    await group.waitFor({ state: "attached" });
    await group.getByRole("button", { name: `Expand ${bigGroup(1, g)}`, exact: true }).dispatchEvent("click");
  }
  // Every node is in the DOM on a build that draws them all (>= 2,000); a build that draws only what is on screen settles at fewer: wait until the count holds still.
  let still = 0, lastCount = -1;
  await poll(async () => { const n = await page.locator(".react-flow__node").count(); still = n === lastCount ? still + 1 : 0; lastCount = n; return n >= 2000 || still >= 8 ? n : 0; }, (n) => n > 0, 120_000);
  const nodes = await page.locator(".react-flow__node").count();
  await page.getByRole("button", { name: "fit view" }).click();
  await cameraStill(page);
  const zoomOf = () => page.locator(".react-flow__viewport").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  for (let i = 0; i < 12 && (await zoomOf()) < 0.55; i++) { await page.getByRole("button", { name: "zoom in" }).click(); await cameraStill(page); }
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
  return { context, page, errors, nodes };
}

// One source with one open group of `points` points, a point dragged: how the cost of a drag grows with the size of a group (the owner's "over 100-150 points").
async function openGroup(browser, points) {
  const shapes = [{ groups: 1, pointsPerGroup: points, status: "offline" }];
  const { context, page, errors } = await openPage(browser, bigModel(shapes));
  const sid = bigSourceId(1);
  await page.locator(`.react-flow__node[data-id="src:${sid}"]`).getByRole("button", { name: /^Expand W7u Big 1$/ }).dispatchEvent("click");
  const cluster = page.locator(`.react-flow__node[data-id="cluster:${sid}:${bigGroup(1, 1)}"]`);
  await cluster.waitFor({ state: "visible", timeout: 30_000 });
  await cluster.getByRole("button", { name: `Expand ${bigGroup(1, 1)}`, exact: true }).dispatchEvent("click");
  await page.waitForTimeout(1500);
  const nodes = await page.locator(".react-flow__node").count();
  await page.getByRole("button", { name: "fit view" }).click();
  await cameraStill(page);
  const zoomOf = () => page.locator(".react-flow__viewport").evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).a);
  for (let i = 0; i < 12 && (await zoomOf()) < 0.55; i++) { await page.getByRole("button", { name: "zoom in" }).click(); await cameraStill(page); }
  return { context, page, errors, nodes };
}

// A toggle in an already big graph (2,022 nodes drawn): collapse one group of 49 points, then open it again: the rebuild of everything for one branch.
async function toggleSample(browser) {
  const { context, page, errors, nodes } = await openDrag(browser, "offline");
  const sid = bigSourceId(1);
  const gid = `cluster:${sid}:${bigGroup(1, 1)}`;
  const shapes = dragShapes("offline");
  const first = bigPointId(shapes, 1, 1, 1);
  await page.locator(`.react-flow__node[data-id="${gid}"]`).waitFor({ state: "attached" });
  const collapse = await page.evaluate(TIMED_CLICK, { buttonScript: `() => document.querySelector('.react-flow__node[data-id="${gid}"] button[aria-label="Collapse ${bigGroup(1, 1)}"]')`, goneSel: `.react-flow__node[data-id="point:${first}"]` });
  const expand = await page.evaluate(TIMED_CLICK, { buttonScript: `() => document.querySelector('.react-flow__node[data-id="${gid}"] button[aria-label="Expand ${bigGroup(1, 1)}"]')`, doneSel: `.react-flow__node[data-id="point:${first}"]` });
  await context.close();
  return { nodes, collapseMs: collapse.toVisibleMs, collapseBusyMs: collapse.busyMs, expandMs: expand.toVisibleMs, expandBusyMs: expand.busyMs, errors };
}
async function visiblePoints(page, count) {
  return page.evaluate((n) => {
    const pane = document.querySelector(".react-flow__pane").getBoundingClientRect();
    const middle = { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 };
    const found = [];
    for (const el of Array.from(document.querySelectorAll('.react-flow__node[data-id^="point:"]'))) {
      const r = el.getBoundingClientRect();
      if (r.left < pane.left + 160 || r.right > pane.right - 220 || r.top < pane.top + 110 || r.bottom > pane.bottom - 150) continue;
      found.push({ id: el.getAttribute("data-id"), box: { x: r.left, y: r.top, width: r.width, height: r.height }, d: Math.hypot(r.left + r.width / 2 - middle.x, r.top + r.height / 2 - middle.y) });
    }
    return found.sort((a, b) => a.d - b.d).slice(0, n);
  }, count);
}
async function dragSample(browser, status = "offline") {
  const { context, page, errors, nodes } = await openDrag(browser, status);
  const frames = async (seconds, dx) => {
    const [p] = await visiblePoints(page, 1);
    if (!p) throw new Error("no point node lies in the middle of the canvas");
    const grab = { x: p.box.x + 8, y: p.box.y + 4 };
    await page.evaluate(() => {
      const log = { gap: [], long: [], stop: false };
      window.__f = log;
      let last = performance.now();
      const tick = (now) => { log.gap.push(now - last); last = now; if (!log.stop) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) log.long.push(e.duration); }).observe({ entryTypes: ["longtask"] }); } catch { /* none */ }
    });
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + dx + 3, grab.y + 3, { steps: 3 });
    const t0 = Date.now();
    let moves = 0;
    while (Date.now() - t0 < seconds * 1000) {
      const t = (Date.now() - t0) / 1000;
      await page.mouse.move(grab.x + dx, grab.y + Math.sin(t * Math.PI * 1.6) * 100);
      moves++;
    }
    await page.mouse.move(grab.x + dx, grab.y, { steps: 3 });
    await page.mouse.up();
    const log = await page.evaluate(() => { window.__f.stop = true; return { gap: window.__f.gap, long: window.__f.long }; });
    return { moves, gaps: log.gap.slice(1), long: log.long };
  };
  await frames(1, 0); // warm-up, thrown away
  const { moves, gaps, long } = await frames(3, 0);
  const sorted = [...gaps].sort((a, b) => a - b);
  const windowMs = gaps.reduce((s, g) => s + g, 0);
  await context.close();
  return {
    nodes, moves, frames: gaps.length, windowMs: round(windowMs), fps: round(gaps.length / (windowMs / 1000)), medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: round(sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]), worstMs: round(sorted[sorted.length - 1]),
    over50: gaps.filter((g) => g > 50).length, longTasks: long.length, longTaskMs: round(long.reduce((s, d) => s + d, 0)), errors,
  };
}
async function hoverSample(browser, status = "offline") {
  const { context, page, errors, nodes } = await openDrag(browser, status);
  const points = await visiblePoints(page, 6);
  if (points.length < 4) throw new Error("not enough point nodes in the middle of the canvas");
  await page.evaluate(() => {
    window.__h = { t0: 0, t1: 0, t2: 0 };
    document.addEventListener("mouseover", (e) => { if (e.target instanceof Element && e.target.closest(".react-flow__node")) window.__h.t0 = performance.now(); }, true);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.target instanceof Element && r.target.classList.contains("lit") && window.__h.t1 === 0) {
          window.__h.t1 = performance.now();
          requestAnimationFrame(() => requestAnimationFrame(() => { window.__h.t2 = performance.now(); }));
        }
      }
    }).observe(document.querySelector(".react-flow__nodes"), { attributes: true, attributeFilter: ["class"], subtree: true });
  });
  const samples = [];
  let cdp = null;
  if (process.env.PROFILE_OUT) { cdp = await context.newCDPSession(page); await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 100 }); await cdp.send("Profiler.start"); }
  for (const p of points) {
    await page.evaluate(() => { window.__h = { t0: 0, t1: 0, t2: 0 }; });
    await page.mouse.move(p.box.x + 40, p.box.y + 20);
    await page.waitForTimeout(700);
    const h = await page.evaluate(() => window.__h);
    if (h.t1 > 0) samples.push({ toClassMs: h.t1 - h.t0, afterDwellMs: h.t1 - h.t0 - 120, classToPaintMs: h.t2 - h.t1 });
    await page.mouse.move(5, 300); // off every node: the highlight lets go
    await page.waitForTimeout(400);
  }
  if (cdp) fs.writeFileSync(process.env.PROFILE_OUT, JSON.stringify((await cdp.send("Profiler.stop")).profile));
  await context.close();
  return { nodes, samples: samples.length, afterDwellMs: round(median(samples.map((s) => s.afterDwellMs))), classToPaintMs: round(median(samples.map((s) => s.classToPaintMs))), all: samples.map((s) => ({ a: round(s.afterDwellMs), p: round(s.classToPaintMs) })), errors };
}

const SCENARIOS = wanted.length ? wanted : ["expandAll:60", "expandAll:150", "expandAll:500", "expandOne:60", "expandOne:150", "expandOne:500", "expandOne:2000", "hover", "drag"];
const results = { label, dist: DIST, at: new Date().toISOString(), scenarios: {} };
const browser = await chromium.launch({ args: process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(" ") : [] });
for (const scenario of SCENARIOS) {
  const [kind, n] = scenario.split(":");
  const samples = [];
  const repeat = /^(drag|hover)/.test(kind) ? Math.min(REPEAT, 3) : REPEAT;
  for (let i = 0; i < repeat; i++) {
    try {
      samples.push(kind === "expandAll" ? await expandAllSample(browser, Number(n)) : kind === "expandOne" ? await expandOneSample(browser, Number(n)) : kind === "drag" ? await dragSample(browser) : kind === "dragLive" ? await dragSample(browser, "online") : kind === "dragW7u" ? await dragSample(browser, "w7u") : kind === "dragGroup" ? await dragSample(browser, `group${n}`) : kind === "toggle" ? await toggleSample(browser) : kind === "hoverW7u" ? await hoverSample(browser, "w7u") : kind === "hoverLive" ? await hoverSample(browser, "online") : await hoverSample(browser));
    } catch (e) { samples.push({ failure: String(e?.message ?? e).split("\n")[0] }); }
  }
  const ok = samples.filter((s) => !s.failure);
  const key = (k) => median(ok.map((s) => s[k]).filter((v) => typeof v === "number"));
  const summary = kind.startsWith("drag")
    ? { fps: key("fps"), p95Ms: key("p95Ms"), worstMs: key("worstMs"), longTasks: key("longTasks"), longTaskMs: key("longTaskMs"), nodes: key("nodes") }
    : kind === "toggle" ? { collapseMs: key("collapseMs"), collapseBusyMs: key("collapseBusyMs"), expandMs: key("expandMs"), expandBusyMs: key("expandBusyMs"), nodes: key("nodes") }
    : kind.startsWith("hover") ? { afterDwellMs: key("afterDwellMs"), classToPaintMs: key("classToPaintMs"), nodes: key("nodes") }
    : { toVisibleMs: key("toVisibleMs"), toPaintMs: key("toPaintMs"), busyMs: key("busyMs"), longTasks: key("longTasks"), worstTaskMs: key("worstTaskMs"), nodes: key("nodes") };
  results.scenarios[scenario] = { summary, failures: samples.length - ok.length, samples };
  console.log(label, scenario, JSON.stringify(summary), samples.length - ok.length ? `FAILED ${samples.length - ok.length}` : "");
  fs.writeFileSync(outFile, JSON.stringify(results, null, 1));
}
await browser.close();
