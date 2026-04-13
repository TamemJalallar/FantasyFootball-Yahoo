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
const { EventLogStore } = require('./eventLogStore');
const { LogoCache, LOGO_CACHE_DIR } = require('./logoCache');
const { buildZip } = require('./zipBuilder');
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
const eventLogStore = new EventLogStore({ logger });
const logoCache = new LogoCache({ logger, metrics });

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
  obsController,
  eventLogStore,
  logoCache
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/assets', express.static(path.resolve(rootDir, 'public', 'assets')));
app.use('/themes', express.static(path.resolve(rootDir, 'public', 'themes')));
app.use('/client', express.static(path.resolve(rootDir, 'client')));
app.use('/logo-cache', express.static(LOGO_CACHE_DIR));

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
      cooldownsMs: settings.audio?.cooldownsMs || {},
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

function normalizeProvider(raw, fallback = 'yahoo') {
  const key = String(raw || '').trim().toLowerCase();
  return ['yahoo', 'espn', 'sleeper', 'mock'].includes(key) ? key : fallback;
}

function buildProviderValidation(settings, authStatus = null) {
  const provider = normalizeProvider(settings?.data?.provider || 'yahoo', 'yahoo');
  const issues = [];
  const warnings = [];

  if (provider === 'yahoo') {
    if (!settings?.yahoo?.clientId) {
      issues.push('Yahoo clientId is required.');
    }
    if (!settings?.yahoo?.clientSecret) {
      issues.push('Yahoo clientSecret is required.');
    }
    if (!settings?.league?.leagueId) {
      issues.push('Yahoo leagueId is required.');
    }
    if (!settings?.league?.gameKey && !settings?.league?.season) {
      issues.push('Yahoo gameKey or season is required.');
    }
    if (authStatus && !authStatus.authorized) {
      warnings.push('Yahoo OAuth is not completed yet.');
    }
  } else if (provider === 'espn') {
    if (!settings?.espn?.leagueId) {
      issues.push('ESPN leagueId is required.');
    }
    if (!settings?.espn?.season) {
      issues.push('ESPN season is required.');
    }
    if ((settings?.espn?.swid && !settings?.espn?.espnS2) || (!settings?.espn?.swid && settings?.espn?.espnS2)) {
      warnings.push('For private leagues, provide both ESPN SWID and ESPN S2.');
    }
  } else if (provider === 'sleeper') {
    if (!settings?.sleeper?.leagueId) {
      issues.push('Sleeper leagueId is required.');
    }
    if (!settings?.sleeper?.season) {
      issues.push('Sleeper season is required.');
    }
  }

  if (Number(settings?.data?.scoreboardPollMs || 0) < 5000) {
    warnings.push('Scoreboard poll below 5000ms will be clamped.');
  }
  if (Number(settings?.data?.tdScanIntervalMs || 0) < 5000) {
    warnings.push('TD scan poll below 5000ms will be clamped.');
  }

  return {
    ok: issues.length === 0,
    provider,
    issues,
    warnings
  };
}

function getBaseUrl(req) {
  const fromEnv = String(process.env.APP_BASE_URL || '').trim();
  if (fromEnv) {
    return fromEnv.replace(/\/$/, '');
  }

  const protocol = req.protocol || 'http';
  const host = req.get('host') || `localhost:${port}`;
  return `${protocol}://${host}`;
}

function buildObsSceneExport({ req, settings }) {
  const baseUrl = getBaseUrl(req);
  const overlayKey = String(settings?.security?.overlayApiKey || '').trim();
  const withKey = (url) => {
    if (!overlayKey) {
      return url;
    }
    const parsed = new URL(url);
    parsed.searchParams.set('overlayKey', overlayKey);
    return parsed.toString();
  };

  const scenes = [
    {
      id: 'centered-card',
      label: 'Main Matchup - Centered Card',
      route: '/overlay/centered-card',
      width: 1920,
      height: 1080
    },
    {
      id: 'lower-third',
      label: 'Scoreboard - Lower Third',
      route: '/overlay/lower-third',
      width: 1920,
      height: 420
    },
    {
      id: 'sidebar-widget',
      label: 'Sidebar - Two Up Ready',
      route: '/overlay/sidebar-widget',
      width: 640,
      height: 1080
    },
    {
      id: 'bottom-ticker',
      label: 'Ticker Bar - Footer',
      route: '/overlay/bottom-ticker',
      width: 1920,
      height: 220
    },
    {
      id: 'ticker',
      label: 'Ticker-Only Mode',
      route: '/overlay/ticker',
      width: 1920,
      height: 140
    }
  ].map((scene) => ({
    ...scene,
    url: withKey(`${baseUrl}${scene.route}`)
  }));

  return {
    generatedAt: new Date().toISOString(),
    baseUrl,
    provider: normalizeProvider(settings?.data?.provider || 'yahoo', 'yahoo'),
    scenePreset: settings?.overlay?.scenePreset || 'centered-card',
    scenes
  };
}

function createDiagnosticsBundle({
  settings,
  authStatus,
  serviceStatus,
  diagnostics,
  repoDetails,
  events
}) {
  const entries = [
    {
      name: 'diagnostics/diagnostics.json',
      data: JSON.stringify({
        exportedAt: new Date().toISOString(),
        status: serviceStatus,
        diagnostics
      }, null, 2)
    },
    {
      name: 'diagnostics/config.redacted.json',
      data: JSON.stringify({
        settings: redactSecrets(settings),
        validation: buildProviderValidation(settings, authStatus)
      }, null, 2)
    },
    {
      name: 'diagnostics/auth.json',
      data: JSON.stringify(authStatus || {}, null, 2)
    },
    {
      name: 'diagnostics/repo.json',
      data: JSON.stringify(repoDetails || {}, null, 2)
    },
    {
      name: 'diagnostics/events.recent.json',
      data: JSON.stringify(events || [], null, 2)
    },
    {
      name: 'README.txt',
      data: [
        'Fantasy Football Overlay Diagnostics Bundle',
        `Exported: ${new Date().toISOString()}`,
        '',
        'Contents:',
        '- diagnostics/diagnostics.json',
        '- diagnostics/config.redacted.json',
        '- diagnostics/auth.json',
        '- diagnostics/repo.json',
        '- diagnostics/events.recent.json'
      ].join('\n')
    }
  ];

  return buildZip(entries);
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

app.get('/api/public-validation', requireOverlayRead, async (_req, res) => {
  const settings = await getSettings();
  const authStatus = await authService.getAuthStatus();
  res.json({
    ok: true,
    validation: buildProviderValidation(settings, authStatus)
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

app.post('/api/validate-config', requireAdmin, async (req, res) => {
  const current = await getSettings();
  const incoming = req.body?.settings && typeof req.body.settings === 'object'
    ? req.body.settings
    : null;
  const merged = incoming ? { ...current, ...incoming } : current;
  const authStatus = await authService.getAuthStatus();
  const validation = buildProviderValidation(merged, authStatus);

  res.json({
    ok: validation.ok,
    validation
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
  await eventLogStore.append({
    kind: 'config',
    type: 'config_imported',
    message: 'Configuration imported from JSON payload.'
  });

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

app.get('/api/obs/scenes/export', requireAdmin, async (req, res) => {
  const settings = await getSettings();
  const payload = buildObsSceneExport({ req, settings });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="obs-scene-map.json"');
  res.send(JSON.stringify(payload, null, 2));
});

app.post('/api/obs/scenes/import', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const scenePreset = String(body.scenePreset || '').trim();
  if (!scenePreset) {
    res.status(400).json({ ok: false, message: 'scenePreset is required.' });
    return;
  }

  const allowed = new Set(['centered-card', 'lower-third', 'sidebar-widget', 'bottom-ticker']);
  if (!allowed.has(scenePreset)) {
    res.status(400).json({ ok: false, message: 'Unsupported scenePreset value.' });
    return;
  }

  const importedScenes = Array.isArray(body.scenes) ? body.scenes.slice(0, 25) : [];
  const settings = await updateSettings({
    overlay: {
      scenePreset,
      sceneMap: importedScenes
    }
  });
  await dataService.forceRefresh();

  await eventLogStore.append({
    kind: 'obs',
    type: 'scene_map_imported',
    message: `OBS scene import applied scenePreset=${scenePreset}.`,
    data: {
      scenePreset
    }
  });

  res.json({
    ok: true,
    scenePreset,
    settings: redactSecrets(settings)
  });
});

app.get('/api/diagnostics', requireAdmin, async (req, res) => {
  const hours = Number(req.query.hours || 24);
  res.json({
    ok: true,
    diagnostics: dataService.getDiagnostics({ hours })
  });
});

app.get('/api/diagnostics/bundle', requireAdmin, async (req, res) => {
  const hours = Number(req.query.hours || 24);
  const settings = await getSettings();
  const authStatus = await authService.getAuthStatus();
  const serviceStatus = dataService.buildStatus();
  const diagnostics = dataService.getDiagnostics({ hours });
  const repoDetails = getRepoDetails();
  const events = await eventLogStore.listRecent({ limit: 300 });
  const zipBuffer = createDiagnosticsBundle({
    settings,
    authStatus,
    serviceStatus,
    diagnostics,
    repoDetails,
    events
  });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename=\"overlay-diagnostics-bundle.zip\"');
  res.send(zipBuffer);
});

app.get('/api/events/log', requireAdmin, async (req, res) => {
  const limit = Number(req.query.limit || 200);
  const kind = String(req.query.kind || '').trim();
  const events = await eventLogStore.listRecent({ limit, kind });
  res.json({
    ok: true,
    count: events.length,
    events
  });
});

app.delete('/api/events/log', requireAdmin, async (_req, res) => {
  await eventLogStore.clear();
  await eventLogStore.append({
    kind: 'events',
    type: 'log_cleared',
    severity: 'warn',
    message: 'Event log was cleared from admin.'
  });
  res.json({ ok: true });
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

app.post('/api/history/replay/window/start', requireAdmin, async (req, res) => {
  try {
    const minutes = Number(req.body?.minutes || 15);
    const intervalMs = Number(req.body?.intervalMs || 2500);
    const result = await dataService.startReplayWindow({ minutes, intervalMs });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message });
  }
});

app.post('/api/history/replay/window/stop', requireAdmin, async (_req, res) => {
  const result = await dataService.stopReplayWindow({ resume: true });
  res.json({ ok: true, ...result });
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
  await eventLogStore.append({
    kind: 'config',
    type: 'config_updated',
    message: 'Configuration updated from admin UI.'
  });

  res.json({
    ok: true,
    settings: redactSecrets(settings)
  });
});

app.post('/api/refresh', requireAdmin, async (_req, res) => {
  await dataService.forceRefresh();
  await eventLogStore.append({
    kind: 'control',
    type: 'force_refresh',
    message: 'Manual force refresh triggered.'
  });
  res.json({ ok: true });
});

app.post('/api/test-connection', requireAdmin, async (_req, res) => {
  try {
    const result = await dataService.testConnection();
    await eventLogStore.append({
      kind: 'provider',
      type: 'test_connection_ok',
      message: `Provider connection test passed (${result.mode}).`,
      data: {
        mode: result.mode,
        matchupCount: result.matchupCount || 0
      }
    });
    res.json(result);
  } catch (error) {
    await eventLogStore.append({
      kind: 'provider',
      type: 'test_connection_failed',
      severity: 'error',
      message: `Provider connection test failed: ${error.message}`
    });
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

app.post('/api/control/warm-logos', requireAdmin, async (_req, res) => {
  const result = await dataService.warmLogoCache();
  res.json({ ok: true, result });
});

app.post('/api/control/panic-fallback', requireAdmin, async (_req, res) => {
  const current = await getSettings();
  const updated = await updateSettings({
    data: {
      ...current.data,
      mockMode: true,
      safeMode: {
        ...(current.data?.safeMode || {}),
        enabled: true,
        fallbackToMock: true
      }
    }
  });

  await eventLogStore.append({
    kind: 'control',
    type: 'panic_fallback_enabled',
    severity: 'warn',
    message: 'Panic fallback enabled: mock mode forced on.',
    data: {
      providerBefore: current.data?.provider || 'unknown'
    }
  });

  await dataService.forceRefresh();
  res.json({
    ok: true,
    message: 'Panic fallback enabled. Mock mode is now active.',
    settings: redactSecrets(updated)
  });
});

app.post('/api/auth/logout', requireAdmin, async (_req, res) => {
  await authService.logout();
  await eventLogStore.append({
    kind: 'auth',
    type: 'yahoo_tokens_cleared',
    message: 'Yahoo stored tokens were cleared.'
  });
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
    await eventLogStore.append({
      kind: 'auth',
      type: 'yahoo_oauth_started',
      message: 'Yahoo OAuth flow started from admin.'
    });
    res.redirect(url);
  } catch (error) {
    await eventLogStore.append({
      kind: 'auth',
      type: 'yahoo_oauth_start_failed',
      severity: 'error',
      message: `Yahoo OAuth start failed: ${error.message}`
    });
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
    await eventLogStore.append({
      kind: 'auth',
      type: 'yahoo_oauth_completed',
      message: 'Yahoo OAuth callback completed successfully.'
    });

    res.send('<h2>Yahoo OAuth complete.</h2><p>You can close this window and return to <a href="/admin">Admin</a>.</p>');
  } catch (authErr) {
    logger.error('OAuth callback failed', { error: authErr.message });
    await eventLogStore.append({
      kind: 'auth',
      type: 'yahoo_oauth_callback_failed',
      severity: 'error',
      message: `Yahoo OAuth callback failed: ${authErr.message}`
    });
    res.status(400).send(`<h2>Yahoo OAuth callback error</h2><pre>${authErr.message}</pre><p><a href="/admin">Back to admin</a></p>`);
  }
});

app.use((err, _req, res, _next) => {
  logger.error('Unhandled server error', { error: err.message });
  eventLogStore.append({
    kind: 'server',
    type: 'unhandled_error',
    severity: 'error',
    message: `Unhandled server error: ${err.message}`
  }).catch(() => {});
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
    eventLogStore.append({
      kind: 'server',
      type: 'startup',
      message: `Server started on http://localhost:${port}`
    }).catch(() => {});
  });
}

start().catch((error) => {
  logger.error('Fatal startup error', { error: error.message });
  process.exit(1);
});
