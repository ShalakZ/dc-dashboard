import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  globalSetup: "./global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost/",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "journey", testMatch: "journey.spec.ts", use: { ...devices["Desktop Chrome"] } },
    {
      name: "discovery",
      testMatch: "discovery.spec.ts",
      dependencies: ["journey"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "phase3",
      testMatch: "phase3.spec.ts",
      dependencies: ["discovery"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "headers",
      testMatch: "headers.spec.ts",
      dependencies: ["phase3"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w3a",
      testMatch: "w3a.spec.ts",
      dependencies: ["headers"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w3b",
      testMatch: "w3b.spec.ts",
      dependencies: ["w3a"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w3c",
      testMatch: "w3c.spec.ts",
      dependencies: ["w3b"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w3d",
      testMatch: "w3d.spec.ts",
      dependencies: ["w3c"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7a",
      testMatch: "w7a.spec.ts",
      dependencies: ["w3d"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w8",
      testMatch: "w8.spec.ts",
      dependencies: ["w7a"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7b",
      testMatch: "w7b.spec.ts",
      dependencies: ["w8"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7c",
      testMatch: "w7c.spec.ts",
      dependencies: ["w7b"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7d",
      testMatch: "w7d.spec.ts",
      dependencies: ["w7c"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7e",
      testMatch: "w7e.spec.ts",
      dependencies: ["w7d"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7f",
      testMatch: "w7f.spec.ts",
      dependencies: ["w7e"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7g",
      testMatch: "w7g.spec.ts",
      dependencies: ["w7f"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7h",
      testMatch: "w7h.spec.ts",
      dependencies: ["w7g"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7i",
      testMatch: "w7i.spec.ts",
      dependencies: ["w7h"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7j",
      testMatch: "w7j.spec.ts",
      dependencies: ["w7i"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w9a",
      testMatch: "w9a.spec.ts",
      dependencies: ["w7j"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w9b",
      testMatch: "w9b.spec.ts",
      dependencies: ["w9a"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7k",
      testMatch: "w7k.spec.ts",
      dependencies: ["w9b"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w9c",
      testMatch: "w9c.spec.ts",
      dependencies: ["w7k"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7l",
      testMatch: "w7l.spec.ts",
      dependencies: ["w9c"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7m",
      testMatch: "w7m.spec.ts",
      dependencies: ["w7l"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7n",
      testMatch: "w7n.spec.ts",
      dependencies: ["w7m"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7o",
      testMatch: "w7o.spec.ts",
      dependencies: ["w7n"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7p",
      testMatch: "w7p.spec.ts",
      dependencies: ["w7o"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    {
      name: "w7q",
      testMatch: "w7q.spec.ts",
      dependencies: ["w7p"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    // Nothing may come after this one that needs a discovered source unless it scans for it first (w7t does, in its beforeAll): its Clear unmapped removes every unmapped discovered source of the shared stack.
    {
      name: "w7r",
      testMatch: "w7r.spec.ts",
      dependencies: ["w7q"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } },
    },
    // It works on assets and roles only (never a source), so it may follow w7r.
    {
      name: "w7s",
      testMatch: "w7s.spec.ts",
      dependencies: ["w7r"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // The LAST project that works on the real layout: its Tidy layout removes every saved node place of the shared stack and each case clears the layout first, so
    // nothing may come after it that reads a saved place from the stack. w7r (before it) may have removed the discovered Modbus source (Clear unmapped), so w7t scans its
    // own scope in beforeAll to bring it back.
    {
      name: "w7t",
      testMatch: "w7t.spec.ts",
      dependencies: ["w7s"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // WRITES NOTHING and needs no discovery data from the stack: every case answers GET /api/discovery/graph and the layout's PUT and DELETE through page.route from a generated
    // model (e2e/graphModel.ts, synthetic ids from 9,000,000 up), and any other write the app tries is refused and fails the case. That is why it may stand after w7t,
    // whose Tidy layout would otherwise matter to it. Its measurements go to .superpowers/sdd/2026-10-15-w7u-discovery-premium/measure.json.
    {
      name: "w7u",
      testMatch: "w7u.spec.ts",
      dependencies: ["w7t"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // It seeds a month of history into the stack (`docker compose exec ... python -m dcdash.seed.history`, so it runs only
    // when COMPOSE_PROJECT_NAME starts with dcdash_e2e_ and skips itself otherwise), closes and reopens the previous month, and in afterAll deletes the
    // seed again and puts the month back to open. Nothing may come after it that does not expect a stack that has just held a closed month (w12a works on
    // mappings, assets and roles only, and does not care). It measures 1440 x 900 first and 1024 x 640 by itself.
    {
      name: "w11",
      testMatch: "w11.spec.ts",
      dependencies: ["w7u"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    // The tail of the chain. It READS what the projects before it left (a group of some source with nothing mapped; it scans for one itself when there is none) and puts every
    // mapping, asset, account and role it makes back, so nothing that follows it sees a difference. Each case that needs a size sets it itself (1440 x 900, 1024 x 640).
    {
      name: "w12a",
      testMatch: "w12a.spec.ts",
      dependencies: ["w11"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
