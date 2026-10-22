const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "tests",
  timeout: 30_000,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:4173" },
  webServer: {
    command: "node tests/serve.js",
    url: "http://127.0.0.1:4173/tricky.html",
    reuseExistingServer: !process.env.CI,
  },
});
