require('dotenv').config();

const path = require('node:path');
const express = require('express');
const { createLogger } = require('./logger');
const { loadSettings, updateSettings, redactSecrets, getAdminApiKey } = require('./configStore');
const { YahooAuthService } = require('./yahooAuth');
const { YahooApiClient } = require('./yahooApi');
const { DataService } = require('./dataService');
const { SseHub } = require('./sseHub');
const { Metrics } = require('./metrics');
const { HistoryStore } = require('./historyStore');
const { AudioQueue } = require('./audioQueue');
const { ObsController } = require('./obsController');
const {
  listProfiles,
  getProfile,
  upsertProfile,
  setActiveProfile,
  deleteProfile
} = require('./profileStore');

const app = express();
const port = Number(process.env.PORT || 3030);
const rootDir = process.cwd();

const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });
const sseHub = new SseHub(logger);
const metrics = new Metrics();
const historyStore = new HistoryStore({ logger });

const getSettings = async () => loadSettings();

const authService = new YahooAuthService({ logger, getSettings });
const yahooApi = new YahooApiClient({ logger, authService, metrics });
const audioQueue = new AudioQueue({ logger, getSettings, metrics });
const obsController = new ObsController({ logger, getSettings, metrics });
const dataService = new DataService({
  logger,
  getSettings,
  yahooApi,
  authService,
  sseHub,
  metrics,
  historyStore,
  audioQueue,
  obsController
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
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
      scoreboardPollMs: settings.data.scoreboardPollMs,
      tdScanIntervalMs: settings.data.tdScanIntervalMs,
      retryJitterPct: settings.data.retryJitterPct,
      mockMode: settings.data.mockMode,
      adaptivePolling: settings.data.adaptivePolling,
      circuitBreaker: {
        enabled: settings.data.circuitBreaker?.enabled,
        failureThreshold: settings.data.circuitBreaker?.failureThreshold,
        cooldownMs: settings.data.circuitBreaker?.cooldownMs,
        rateLimitCooldownMs: settings.data.circuitBreaker?.rateLimitCooldownMs
      }
    },
    overlay: settings.overlay,
    theme: settings.theme,
    dev: settings.dev,
    security: {
      reducedAnimations: settings.security?.reducedAnimations || false,
      useOsKeychain: settings.security?.useOsKeychain || false,
      adminApiKeyRequired: Boolean(settings.security?.adminApiKey || process.env.ADMIN_API_KEY)
    },
    audio: {
      enabled: settings.audio?.enabled || false,
      minDispatchIntervalMs: settings.audio?.minDispatchIntervalMs || 1200,
      maxQueueSize: settings.audio?.maxQueueSize || 50,
      endpointConfigured: Boolean(settings.audio?.endpointUrl)
    },
    obs: {
      enabled: settings.obs?.enabled || false,
      wsUrl: settings.obs?.wsUrl || '',
      sceneCooldownMs: settings.obs?.sceneCooldownMs || 7000,
      scenesConfigured: Boolean(settings.obs?.scenes?.touchdown || settings.obs?.scenes?.upset || settings.obs?.scenes?.gameOfWeek || settings.obs?.scenes?.default)
    }
  };
}

async function requireAdmin(req, res, next) {
  const requiredKey = await getAdminApiKey();
  if (!requiredKey) {
    return next();
  }

  const providedKey = String(req.header('x-admin-key') || req.query.adminKey || '').trim();
  if (providedKey && providedKey === requiredKey) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    message: 'Unauthorized. Provide valid x-admin-key.'
  });
}

app.get('/health', (_req, res) => {
  const snapshot = dataService.getSnapshot();
  res.json({
    ok: true,
    service: 'obs-yahoo-fantasy-overlay',
    timestamp: new Date().toISOString(),
    status: snapshot.status,
    hasPayload: Boolean(snapshot.payload),
    metrics: metrics.snapshot()
  });
});

app.get('/metrics', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(metrics.toPrometheus());
});

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
  metrics.inc('sse_clients_connected_total');

  const settings = await getSettings();
  const authStatus = await authService.getAuthStatus();
  const profiles = await listProfiles();

  const initPayload = {
    ...dataService.getSnapshot(),
    settings: buildPublicRuntimeSettings(settings),
    authStatus,
    profiles
  };

  res.write(`event: init\ndata: ${JSON.stringify(initPayload)}\n\n`);

  req.on('close', () => {
    sseHub.unregister(res);
  });
});

app.get('/api/public-config', async (_req, res) => {
  const settings = await getSettings();
  res.json({ settings: buildPublicRuntimeSettings(settings) });
});

app.get('/api/config', requireAdmin, async (_req, res) => {
  const settings = await getSettings();
  res.json({
    settings: redactSecrets(settings)
  });
});

app.get('/api/config/export', requireAdmin, async (_req, res) => {
  const settings = await getSettings();
  const safe = redactSecrets(settings);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="overlay-config.export.json"');
  res.send(JSON.stringify(safe, null, 2));
});

app.post('/api/config/import', requireAdmin, async (req, res) => {
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

  if (incoming.security && incoming.security.adminApiKey === '********') {
    incoming.security.adminApiKey = current.security.adminApiKey;
  }

  if (incoming.obs && incoming.obs.password === '********') {
    incoming.obs.password = current.obs.password;
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

app.get('/api/status', requireAdmin, async (_req, res) => {
  const settings = await getSettings();
  const authStatus = await authService.getAuthStatus();

  res.json({
    status: dataService.buildStatus(),
    auth: authStatus,
    mode: settings.data.mockMode ? 'mock' : 'yahoo',
    metrics: metrics.snapshot()
  });
});

app.get('/api/diagnostics', requireAdmin, async (req, res) => {
  const hours = Number(req.query.hours || 24);
  res.json({
    ok: true,
    diagnostics: dataService.getDiagnostics({ hours })
  });
});

app.get('/api/history', requireAdmin, async (req, res) => {
  const hours = Number(req.query.hours || 24);
  const diagnostics = dataService.getDiagnostics({ hours });
  res.json({
    ok: true,
    history: diagnostics.history
  });
});

app.get('/api/data', requireAdmin, (_req, res) => {
  res.json(dataService.getSnapshot());
});

app.put('/api/config', requireAdmin, async (req, res) => {
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

  if (incoming.security && incoming.security.adminApiKey === '********') {
    incoming.security.adminApiKey = current.security.adminApiKey;
  }

  if (incoming.obs && incoming.obs.password === '********') {
    incoming.obs.password = current.obs.password;
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

app.post('/api/refresh', requireAdmin, async (_req, res) => {
  await dataService.forceRefresh();
  res.json({ ok: true });
});

app.post('/api/test-connection', requireAdmin, async (_req, res) => {
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

app.post('/api/control/next', requireAdmin, (_req, res) => {
  dataService.manualNext();
  res.json({ ok: true });
});

app.post('/api/auth/logout', requireAdmin, async (_req, res) => {
  await authService.logout();
  res.json({ ok: true });
});

app.get('/api/profiles', requireAdmin, async (_req, res) => {
  res.json({
    ok: true,
    ...(await listProfiles())
  });
});

app.post('/api/profiles/save', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const settings = await getSettings();

  const profile = await upsertProfile({
    id: body.id,
    name: body.name,
    settings: body.settings || settings
  });

  res.json({
    ok: true,
    profile,
    ...(await listProfiles())
  });
});

app.post('/api/profiles/switch', requireAdmin, async (req, res) => {
  const profileId = String(req.body?.profileId || '').trim();
  if (!profileId) {
    res.status(400).json({ ok: false, message: 'profileId is required.' });
    return;
  }

  const profile = await getProfile(profileId);
  if (!profile) {
    res.status(404).json({ ok: false, message: 'Profile not found.' });
    return;
  }

  const current = await getSettings();
  const next = {
    ...profile.settings,
    yahoo: {
      ...profile.settings.yahoo,
      clientSecret: current.yahoo.clientSecret
    },
    security: {
      ...profile.settings.security,
      adminApiKey: current.security.adminApiKey
    },
    obs: {
      ...profile.settings.obs,
      password: current.obs.password
    }
  };

  const settings = await updateSettings(next);
  await setActiveProfile(profileId);

  sseHub.broadcast('config', {
    settings: buildPublicRuntimeSettings(settings)
  });

  await dataService.forceRefresh();

  res.json({
    ok: true,
    settings: redactSecrets(settings),
    ...(await listProfiles())
  });
});

app.delete('/api/profiles/:profileId', requireAdmin, async (req, res) => {
  const ok = await deleteProfile(req.params.profileId);
  if (!ok) {
    res.status(404).json({ ok: false, message: 'Profile not found.' });
    return;
  }

  res.json({
    ok: true,
    ...(await listProfiles())
  });
});

app.get('/auth/start', requireAdmin, async (_req, res) => {
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
