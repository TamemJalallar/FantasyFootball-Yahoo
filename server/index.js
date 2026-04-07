require('dotenv').config();

const path = require('node:path');
const express = require('express');
const { createLogger } = require('./logger');
const { loadSettings, updateSettings, redactSecrets } = require('./configStore');
const { YahooAuthService } = require('./yahooAuth');
const { YahooApiClient } = require('./yahooApi');
const { DataService } = require('./dataService');
const { SseHub } = require('./sseHub');

const app = express();
const port = Number(process.env.PORT || 3030);
const rootDir = process.cwd();

const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });
const sseHub = new SseHub(logger);

const getSettings = async () => loadSettings();

const authService = new YahooAuthService({ logger, getSettings });
const yahooApi = new YahooApiClient({ logger, authService });
const dataService = new DataService({
  logger,
  getSettings,
  yahooApi,
  authService,
  sseHub
});

app.use(express.json({ limit: '1mb' }));
app.use('/assets', express.static(path.resolve(rootDir, 'public', 'assets')));
app.use('/themes', express.static(path.resolve(rootDir, 'public', 'themes')));
app.use('/client', express.static(path.resolve(rootDir, 'client')));

function buildPublicRuntimeSettings(settings) {
  return {
    league: {
      leagueId: settings.league.leagueId,
      gameKey: settings.league.gameKey,
      season: settings.league.season,
      week: settings.league.week
    },
    data: {
      refreshIntervalMs: settings.data.refreshIntervalMs,
      mockMode: settings.data.mockMode
    },
    overlay: settings.overlay,
    theme: settings.theme,
    dev: settings.dev
  };
}

app.get('/', (_req, res) => {
  res.redirect('/admin');
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.resolve(rootDir, 'client', 'admin.html'));
});

app.get('/overlay', (_req, res) => {
  res.sendFile(path.resolve(rootDir, 'client', 'overlay.html'));
});

app.get('/events', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.flushHeaders();
  sseHub.register(res);

  const settings = await getSettings();
  const authStatus = await authService.getAuthStatus();

  const initPayload = {
    ...dataService.getSnapshot(),
    settings: buildPublicRuntimeSettings(settings),
    authStatus
  };

  res.write(`event: init\ndata: ${JSON.stringify(initPayload)}\n\n`);

  req.on('close', () => {
    sseHub.unregister(res);
  });
});

app.get('/api/config', async (_req, res) => {
  const settings = await getSettings();
  res.json({
    settings: redactSecrets(settings)
  });
});

app.get('/api/status', async (_req, res) => {
  const settings = await getSettings();
  const authStatus = await authService.getAuthStatus();

  res.json({
    status: dataService.buildStatus(),
    auth: authStatus,
    mode: settings.data.mockMode ? 'mock' : 'yahoo'
  });
});

app.get('/api/data', (_req, res) => {
  res.json(dataService.getSnapshot());
});

app.get('/api/public-config', async (_req, res) => {
  const settings = await getSettings();
  res.json({ settings: buildPublicRuntimeSettings(settings) });
});

app.put('/api/config', async (req, res) => {
  const incoming = req.body || {};
  const current = await getSettings();

  if (incoming.yahoo) {
    if (!incoming.yahoo.clientSecret || incoming.yahoo.clientSecret === '********') {
      incoming.yahoo.clientSecret = current.yahoo.clientSecret;
    }
    if (!incoming.yahoo.redirectUri) {
      incoming.yahoo.redirectUri = current.yahoo.redirectUri;
    }
    if (!incoming.yahoo.scope) {
      incoming.yahoo.scope = current.yahoo.scope || 'fspt-r';
    }
  }

  const settings = await updateSettings(incoming);

  sseHub.broadcast('config', {
    settings: buildPublicRuntimeSettings(settings)
  });

  await dataService.forceRefresh();

  res.json({
    ok: true,
    settings: redactSecrets(settings)
  });
});

app.post('/api/refresh', async (_req, res) => {
  await dataService.forceRefresh();
  res.json({ ok: true });
});

app.post('/api/test-connection', async (_req, res) => {
  try {
    const result = await dataService.testConnection();
    res.json(result);
  } catch (error) {
    res.status(400).json({
      ok: false,
      message: error.message
    });
  }
});

app.post('/api/control/next', (_req, res) => {
  dataService.manualNext();
  res.json({ ok: true });
});

app.post('/api/auth/logout', async (_req, res) => {
  await authService.logout();
  res.json({ ok: true });
});

app.get('/auth/start', async (_req, res) => {
  try {
    const { url } = await authService.getAuthorizeUrl();
    res.redirect(url);
  } catch (error) {
    res.status(400).send(`<pre>Yahoo auth setup issue: ${error.message}</pre><p><a href="/admin">Back to admin</a></p>`);
  }
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    res.status(400).send(`<h2>Yahoo OAuth failed</h2><pre>${errorDescription || error}</pre><p><a href="/admin">Back to admin</a></p>`);
    return;
  }

  if (!code) {
    res.status(400).send('<h2>Missing authorization code.</h2><p><a href="/admin">Back to admin</a></p>');
    return;
  }

  try {
    await authService.exchangeCodeForToken(String(code), String(state || ''));
    await dataService.forceRefresh();

    res.send('<h2>Yahoo OAuth complete.</h2><p>You can close this window and return to <a href="/admin">Admin</a>.</p>');
  } catch (authErr) {
    logger.error('OAuth callback failed', { error: authErr.message });
    res.status(400).send(`<h2>Yahoo OAuth callback error</h2><pre>${authErr.message}</pre><p><a href="/admin">Back to admin</a></p>`);
  }
});

app.use((err, _req, res, _next) => {
  logger.error('Unhandled server error', { error: err.message });
  res.status(500).json({
    ok: false,
    message: 'Internal server error',
    detail: err.message
  });
});

async function start() {
  await dataService.init();
  await dataService.start();

  app.listen(port, () => {
    logger.info(`OBS Yahoo overlay running on http://localhost:${port}`);
  });
}

start().catch((error) => {
  logger.error('Fatal startup error', { error: error.message });
  process.exit(1);
});
