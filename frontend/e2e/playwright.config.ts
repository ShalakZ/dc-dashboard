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
  ],
});
