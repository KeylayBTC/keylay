// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 20000,
  expect: { timeout: 5000 },
  fullyParallel: false,   // session tests share a server; keep sequential
  retries: 0,
  reporter: 'list',

  use: {
    // dev-server.js serves index.html at :3000 and starts the relay at :8080.
    // location.hostname === 'localhost' so the app auto-connects to ws://localhost:8080.
    baseURL: 'http://localhost:3000',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Starts tests/dev-server.js which runs both the static HTTP server and the
  // WebSocket relay. Playwright waits for http://localhost:3000 to respond before
  // running any tests.
  webServer: {
    command: 'node tests/dev-server.js',
    url: 'http://localhost:3000',
    reuseExistingServer: false,
    timeout: 10000,
  },
});
