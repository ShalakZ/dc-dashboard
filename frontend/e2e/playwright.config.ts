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
    // LAST: its Tidy layout removes every saved node place of the shared stack and each case clears the layout first, so nothing may come after it that reads a
    // saved place. w7r (before it) may have removed the discovered Modbus source (Clear unmapped), so w7t scans its own scope in beforeAll to bring it back.
    {
      name: "w7t",
      testMatch: "w7t.spec.ts",
      dependencies: ["w7s"],
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
