import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:8792", timezoneId: "America/Los_Angeles" },
  webServer: { command: "node tests/browser/server.mjs", url: "http://127.0.0.1:8792", reuseExistingServer: false },
});
