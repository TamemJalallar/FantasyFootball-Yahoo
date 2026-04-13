const { spawn } = require('node:child_process');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${url}/health`, { cache: 'no-store' });
      if (res.ok) {
        return true;
      }
    } catch {
      // keep trying
    }
    await sleep(400);
  }
  throw new Error('Timed out waiting for health endpoint.');
}

async function run() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch (error) {
    throw new Error(`Playwright is not installed. Run npm install first. (${error.message})`);
  }

  const port = Number(process.env.SMOKE_PORT || 3099);
  const baseUrl = `http://127.0.0.1:${port}`;

  const env = {
    ...process.env,
    PORT: String(port),
    APP_BASE_URL: baseUrl,
    MOCK_MODE: 'true'
  };

  const server = spawn(process.execPath, ['server/index.js'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  server.stdout.on('data', (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
  });
  server.stderr.on('data', (chunk) => {
    process.stderr.write(`[server] ${chunk}`);
  });

  try {
    await waitForHealth(baseUrl);

    const browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage();

    await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#statusLine', { timeout: 10000 });

    await page.goto(`${baseUrl}/setup`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#checkGrid', { timeout: 10000 });

    await page.goto(`${baseUrl}/overlay/centered-card`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#overlayRoot', { timeout: 10000 });

    await browser.close();
    process.stdout.write('Playwright smoke passed: /admin, /setup, /overlay routes are reachable.\n');
  } finally {
    if (!server.killed) {
      server.kill('SIGTERM');
      await sleep(500);
    }
  }
}

run().catch((error) => {
  process.stderr.write(`Smoke test failed: ${error.message}\n`);
  process.exit(1);
});
