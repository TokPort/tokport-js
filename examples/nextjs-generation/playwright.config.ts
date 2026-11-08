import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  use: { baseURL: "http://127.0.0.1:3105", ...devices["iPhone 14"], defaultBrowserType: "chromium" },
  webServer: { command: "bun run dev --port 3105", url: "http://127.0.0.1:3105", reuseExistingServer: false, timeout: 120_000 },
});
