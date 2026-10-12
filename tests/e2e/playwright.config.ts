import { defineConfig, devices } from '@playwright/test'

const port = 4173

// Relative paths resolve from this folder. The report stays outside outputDir,
// because Playwright clears outputDir at the start of each run.
export default defineConfig({
  testDir: 'journeys',
  outputDir: '../../artifacts/e2e/results',
  reporter: [['list'], ['html', { outputFolder: '../../artifacts/e2e/report', open: 'never' }]],
  forbidOnly: !!process.env.CI,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node serve.mjs ${port}`,
    cwd: '.',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
  },
})
