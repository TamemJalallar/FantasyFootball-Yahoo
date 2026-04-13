require('dotenv').config();

const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');
const express = require('express');
const { createLogger } = require('./logger');
const { loadSettings, updateSettings, redactSecrets, getAdminApiKey, getOverlayApiKey } = require('./configStore');
const { YahooAuthService } = require('./yahooAuth');
const { YahooApiClient } = require('./yahooApi');
const { EspnApiClient } = require('./espnApi');
const { SleeperApiClient } = require('./sleeperApi');
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
const packageJsonPath = path.resolve(rootDir, 'package.json');
const packageJson = fs.existsSync(packageJsonPath)
  ? JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  : {};

const logger = createLogger({ level: process.env.LOG_LEVEL || 'info' });
const sseHub = new SseHub(logger);
const metrics = new Metrics();
metrics.set('sse_clients_connected', 0);
const historyStore = new HistoryStore({ logger });

const getSettings = async () => loadSettings();

const authService = new YahooAuthService({ logger, getSettings });
const yahooApi = new YahooApiClient({ logger, authService, metrics });
const espnApi = new EspnApiClient({ logger, metrics });
const sleeperApi = new SleeperApiClient({ logger, metrics });
const audioQueue = new AudioQueue({ logger, getSettings, metrics });
const obsController = new ObsController({ logger, getSettings, metrics });
const dataService = new DataService({
  logger,
  getSettings,
  yahooApi,
  espnApi,
  sleeperApi,
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
      provider: settings.data.provider,
      refreshIntervalMs: settings.data.refreshIntervalMs,
      scoreboardPollMs: settings.data.scoreboardPollMs,
      tdScanIntervalMs: settings.data.tdScanIntervalMs,
      retryJitterPct: settings.data.retryJitterPct,
      mockMode: settings.data.mockMode,
      mockSeedConfigured: Boolean(settings.data.mockSeed),
      safeMode: settings.data.safeMode,
      rateLimitBudget: settings.data.rateLimitBudget,
      adaptivePolling: settings.data.adaptivePolling,
      scheduleAware: settings.data.scheduleAware,
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
      adminApiKeyRequired: Boolean(settings.security?.adminApiKey || process.env.ADMIN_API_KEY),
      overlayApiKeyRequired: Boolean(settings.security?.overlayApiKey)
    },
    audio: {
      enabled: settings.audio?.enabled || false,
      minDispatchIntervalMs: settings.audio?.minDispatchIntervalMs || 1200,
      maxQueueSize: settings.audio?.maxQueueSize || 50,
      endpointConfigured: Boolean(settings.audio?.endpointUrl),
      templates: settings.audio?.templates || {}
    },
    integrations: {
      enabled: settings.integrations?.enabled || false,
      discordConfigured: Boolean(settings.integrations?.discordWebhookUrl),
      slackConfigured: Boolean(settings.integrations?.slackWebhookUrl),
      sendTouchdowns: settings.integrations?.sendTouchdowns ?? true,
      sendLeadChanges: settings.integrations?.sendLeadChanges ?? true,
      sendUpsets: settings.integrations?.sendUpsets ?? true,
      sendFinals: settings.integrations?.sendFinals ?? true
    },
    obs: {
      enabled: settings.obs?.enabled || false,
      wsUrl: settings.obs?.wsUrl || '',
      sceneCooldownMs: settings.obs?.sceneCooldownMs || 7000,
      scenesConfigured: Boolean(settings.obs?.scenes?.touchdown || settings.obs?.scenes?.upset || settings.obs?.scenes?.gameOfWeek || settings.obs?.scenes?.default)
    }
  };
}

function safeExec(command) {
  try {
    return execSync(command, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8'
    }).trim();
  } catch {
    return '';
  }
}

function resolveRepositoryUrl() {
  const value = packageJson?.repository;
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value.url) {
    return String(value.url);
  }
  return '';
}

function getRepoDetails() {
  const commit = safeExec('git rev-parse HEAD');
  const branch = safeExec('git rev-parse --abbrev-ref HEAD');
  const shortCommit = safeExec('git rev-parse --short HEAD');
  const lastCommitAt = safeExec('git log -1 --format=%cI');
  const lastCommitSubject = safeExec('git log -1 --format=%s');
  const isDirty = Boolean(safeExec('git status --porcelain'));

  return {
    name: String(packageJson?.name || 'obs-yahoo-fantasy-overlay'),
    version: String(packageJson?.version || '0.0.0'),
    repositoryUrl: resolveRepositoryUrl(),
    branch: branch || 'unknown',
    commit: commit || '',
    shortCommit: shortCommit || '',
    lastCommitAt: lastCommitAt || '',
    lastCommitSubject: lastCommitSubject || '',
    dirty: isDirty,
    nodeVersion: process.version,
    generatedAt: new Date().toISOString()
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

async function requireOverlayRead(req, res, next) {
  const requiredKey = await getOverlayApiKey();
  if (!requiredKey) {
    return next();
  }

  const providedKey = String(req.header('x-overlay-key') || req.query.overlayKey || '').trim();
  if (providedKey && providedKey === requiredKey) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    message: 'Unauthorized. Provide valid overlayKey.'
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

app.get('/setup', requireOverlayRead, (_req, res) => {
  res.sendFile(path.resolve(rootDir, 'client', 'setup.html'));
});

app.get('/overlay', requireOverlayRead, (_req, res) => {
  res.sendFile(path.resolve(rootDir, 'client', 'overlay.html'));
});

function buildOverlayRedirectUrl(req, defaults = {}) {
  const params = new URLSearchParams();
  const query = req.query || {};

  for (const [key, rawValue] of Object.entries(query)) {
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value === undefined || value === null || value === '') {
      continue;
    }
    params.set(key, String(value));
  }

  for (const [key, value] of Object.entries(defaults)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    params.set(key, String(value));
  }

  const suffix = params.toString();
  return suffix ? `/overlay?${suffix}` : '/overlay';
}

app.get('/overlay/centered-card', requireOverlayRead, (req, res) => {
  res.redirect(buildOverlayRedirectUrl(req, { preset: 'centered-card' }));
});

app.get('/overlay/lower-third', requireOverlayRead, (req, res) => {
  res.redirect(buildOverlayRedirectUrl(req, { preset: 'lower-third' }));
});

app.get('/overlay/sidebar-widget', requireOverlayRead, (req, res) => {
  res.redirect(buildOverlayRedirectUrl(req, { preset: 'sidebar-widget' }));
});

app.get('/overlay/bottom-ticker', requireOverlayRead, (req, res) => {
  res.redirect(buildOverlayRedirectUrl(req, { preset: 'bottom-ticker' }));
});

app.get('/overlay/ticker', requireOverlayRead, (req, res) => {
  res.redirect(buildOverlayRedirectUrl(req, { mode: 'ticker', preset: 'bottom-ticker' }));
});

app.get('/events', requireOverlayRead, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.flushHeaders();
  sseHub.register(res);
  metrics.inc('sse_clients_connected_total');
  metrics.set('sse_clients_connected', sseHub.getClientCount());

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
    metrics.inc('sse_clients_disconnected_total');
    metrics.set('sse_clients_connected', sseHub.getClientCount());
  });
});

app.get('/api/public-config', requireOverlayRead, async (_req, res) => {
  const settings = await getSettings();
  res.json({ settings: buildPublicRuntimeSettings(settings) });
});

app.get('/api/public-snapshot', requireOverlayRead, async (_req, res) => {
  const settings = await getSettings();
  const authStatus = await authService.getAuthStatus();
  res.json({
    ...dataService.getSnapshot(),
    settings: buildPublicRuntimeSettings(settings),
    authStatus
  });
});

app.get('/api/repo-details', (_req, res) => {
  res.json({
    ok: true,
    repo: getRepoDetails()
  });
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

  if (incoming.espn) {
    if (incoming.espn.swid === '********') {
      incoming.espn.swid = current.espn.swid;
    }
    if (incoming.espn.espnS2 === '********') {
      incoming.espn.espnS2 = current.espn.espnS2;
    }
  }

  if (incoming.security) {
    if (incoming.security.adminApiKey === '********') {
      incoming.security.adminApiKey = current.security.adminApiKey;
    }
    if (incoming.security.overlayApiKey === '********') {
      incoming.security.overlayApiKey = current.security.overlayApiKey;
    }
  }

  if (incoming.obs && incoming.obs.password === '********') {
    incoming.obs.password = current.obs.password;
  }

  if (incoming.integrations) {
    if (incoming.integrations.discordWebhookUrl === '********') {
      incoming.integrations.discordWebhookUrl = current.integrations.discordWebhookUrl;
    }
    if (incoming.integrations.slackWebhookUrl === '********') {
      incoming.integrations.slackWebhookUrl = current.integrations.slackWebhookUrl;
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

app.get('/api/status', requireAdmin, async (_req, res) => {
  const settings = await getSettings();
  const authStatus = await authService.getAuthStatus();
  const serviceStatus = dataService.buildStatus();

  res.json({
    status: serviceStatus,
    auth: authStatus,
    mode: serviceStatus.mode || settings.data.provider || 'unknown',
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
  const week = Number(req.query.week || 0) || null;
  const diagnostics = dataService.getDiagnostics({ hours });
  const snapshots = historyStore.recentSnapshots({ hours, limit: 50, week });
  res.json({
    ok: true,
    history: {
      ...diagnostics.history,
      snapshots
    }
  });
});

app.get('/api/history/export', requireAdmin, async (req, res) => {
  const hours = Number(req.query.hours || 168);
  const week = Number(req.query.week || 0) || null;
  const format = String(req.query.format || 'json').toLowerCase();
  const diagnostics = dataService.getDiagnostics({ hours });
  const scoreEvents = diagnostics.history?.scoreEvents || [];
  const snapshots = historyStore.recentSnapshots({ hours, limit: 200, week });

  if (format === 'csv') {
    const header = ['id', 'ts', 'matchupId', 'teamKey', 'from', 'to', 'delta', 'reason'];
    const escapeCell = (value) => {
      const raw = value === null || value === undefined ? '' : String(value);
      return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
    };

    const rows = scoreEvents.map((event) => ([
      event.id,
      event.ts,
      event.matchupId,
      event.teamKey,
      event.from,
      event.to,
      event.delta,
      event.reason
    ].map(escapeCell).join(',')));

    const csv = `${header.join(',')}\n${rows.join('\n')}\n`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="matchup-timeline.csv"');
    res.send(csv);
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="matchup-timeline.json"');
  res.send(JSON.stringify({
    ok: true,
    exportedAt: new Date().toISOString(),
    hours,
    week,
    snapshots,
    scoreEvents
  }, null, 2));
});

app.post('/api/history/replay', requireAdmin, async (req, res) => {
  const snapshotId = Number(req.body?.snapshotId || 0);
  const snapshot = historyStore.snapshotById(snapshotId);
  if (!snapshot?.payload) {
    res.status(404).json({ ok: false, message: 'Snapshot not found.' });
    return;
  }

  dataService.replaySnapshot(snapshot.payload);
  res.json({ ok: true, snapshotId });
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

  if (incoming.espn) {
    if (incoming.espn.swid === '********') {
      incoming.espn.swid = current.espn.swid;
    }
    if (incoming.espn.espnS2 === '********') {
      incoming.espn.espnS2 = current.espn.espnS2;
    }
  }

  if (incoming.security) {
    if (incoming.security.adminApiKey === '********') {
      incoming.security.adminApiKey = current.security.adminApiKey;
    }
    if (incoming.security.overlayApiKey === '********') {
      incoming.security.overlayApiKey = current.security.overlayApiKey;
    }
  }

  if (incoming.obs && incoming.obs.password === '********') {
    incoming.obs.password = current.obs.password;
  }

  if (incoming.integrations) {
    if (incoming.integrations.discordWebhookUrl === '********') {
      incoming.integrations.discordWebhookUrl = current.integrations.discordWebhookUrl;
    }
    if (incoming.integrations.slackWebhookUrl === '********') {
      incoming.integrations.slackWebhookUrl = current.integrations.slackWebhookUrl;
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

app.post('/api/control/pause', requireAdmin, (req, res) => {
  dataService.setRotationPaused(Boolean(req.body?.paused));
  res.json({ ok: true, paused: Boolean(req.body?.paused) });
});

app.post('/api/control/resume', requireAdmin, (_req, res) => {
  dataService.setRotationPaused(false);
  res.json({ ok: true, paused: false });
});

app.post('/api/control/pin', requireAdmin, (req, res) => {
  const matchupId = String(req.body?.matchupId || '').trim();
  dataService.pinMatchup(matchupId);
  res.json({ ok: true, matchupId });
});

app.post('/api/control/unpin', requireAdmin, (_req, res) => {
  dataService.pinMatchup('');
  res.json({ ok: true, matchupId: '' });
});

app.post('/api/control/story', requireAdmin, (_req, res) => {
  dataService.triggerStoryCard();
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
    espn: {
      ...profile.settings.espn,
      swid: current.espn.swid,
      espnS2: current.espn.espnS2
    },
    security: {
      ...profile.settings.security,
      adminApiKey: current.security.adminApiKey,
      overlayApiKey: current.security.overlayApiKey
    },
    integrations: {
      ...profile.settings.integrations,
      discordWebhookUrl: current.integrations.discordWebhookUrl,
      slackWebhookUrl: current.integrations.slackWebhookUrl
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
