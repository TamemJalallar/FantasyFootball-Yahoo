const fs = require('node:fs/promises');
const path = require('node:path');
const { deepClone, deepMerge, clampNumber } = require('./utils');
const { DEFAULT_SETTINGS } = require('./defaultSettings');
const { getSecret, setSecret } = require('./secretStore');

const SETTINGS_PATH = path.resolve(process.cwd(), 'config', 'settings.json');

function envBool(value) {
  return String(value).toLowerCase() === 'true';
}

function applyValidation(settings) {
  settings.data.refreshIntervalMs = clampNumber(settings.data.refreshIntervalMs, 5000, 900000, 10000);
  settings.data.scoreboardPollMs = clampNumber(settings.data.scoreboardPollMs, 5000, 900000, settings.data.refreshIntervalMs || 10000);
  settings.data.tdScanIntervalMs = clampNumber(settings.data.tdScanIntervalMs, 5000, 900000, settings.data.refreshIntervalMs || 10000);
  settings.data.maxRetryDelayMs = clampNumber(settings.data.maxRetryDelayMs, 15000, 1800000, 300000);
  settings.data.retryJitterPct = clampNumber(settings.data.retryJitterPct, 0, 0.5, 0.15);
  settings.data.tdDedupWindowMs = clampNumber(settings.data.tdDedupWindowMs, 10000, 3600000, 90000);

  settings.data.adaptivePolling = settings.data.adaptivePolling || {};
  settings.data.adaptivePolling.enabled = Boolean(settings.data.adaptivePolling.enabled);
  settings.data.adaptivePolling.liveMs = clampNumber(settings.data.adaptivePolling.liveMs, 5000, 900000, settings.data.scoreboardPollMs || 10000);
  settings.data.adaptivePolling.mixedMs = clampNumber(settings.data.adaptivePolling.mixedMs, 5000, 900000, 20000);
  settings.data.adaptivePolling.idleMs = clampNumber(settings.data.adaptivePolling.idleMs, 10000, 1800000, 45000);

  settings.data.circuitBreaker = settings.data.circuitBreaker || {};
  settings.data.circuitBreaker.enabled = Boolean(settings.data.circuitBreaker.enabled);
  settings.data.circuitBreaker.failureThreshold = clampNumber(settings.data.circuitBreaker.failureThreshold, 2, 20, 4);
  settings.data.circuitBreaker.cooldownMs = clampNumber(settings.data.circuitBreaker.cooldownMs, 10000, 900000, 60000);
  settings.data.circuitBreaker.rateLimitCooldownMs = clampNumber(settings.data.circuitBreaker.rateLimitCooldownMs, 20000, 1800000, 120000);

  settings.data.history = settings.data.history || {};
  settings.data.history.enabled = Boolean(settings.data.history.enabled);
  settings.data.history.retentionDays = clampNumber(settings.data.history.retentionDays, 1, 365, 14);

  settings.overlay.rotationIntervalMs = clampNumber(settings.overlay.rotationIntervalMs, 3000, 120000, 9000);
  settings.overlay.tdAlertDurationMs = clampNumber(settings.overlay.tdAlertDurationMs, 3000, 20000, 8000);
  settings.theme.fontScale = clampNumber(settings.theme.fontScale, 0.6, 2, 1);

  settings.overlay.showTdAlerts = Boolean(settings.overlay.showTdAlerts);
  settings.overlay.showScoreDelta = Boolean(settings.overlay.showScoreDelta);
  settings.security.reducedAnimations = Boolean(settings.security.reducedAnimations);
  settings.security.useOsKeychain = Boolean(settings.security.useOsKeychain);
  settings.audio.enabled = Boolean(settings.audio.enabled);
  settings.audio.minDispatchIntervalMs = clampNumber(settings.audio.minDispatchIntervalMs, 250, 30000, 1200);
  settings.audio.maxQueueSize = clampNumber(settings.audio.maxQueueSize, 5, 500, 50);

  settings.obs.enabled = Boolean(settings.obs.enabled);
  settings.obs.sceneCooldownMs = clampNumber(settings.obs.sceneCooldownMs, 0, 300000, 7000);
  settings.obs.wsUrl = String(settings.obs.wsUrl || '').trim() || 'ws://127.0.0.1:4455';
  settings.obs.password = String(settings.obs.password || '');
  settings.obs.scenes = settings.obs.scenes || {};
  settings.obs.scenes.touchdown = String(settings.obs.scenes.touchdown || '');
  settings.obs.scenes.upset = String(settings.obs.scenes.upset || '');
  settings.obs.scenes.gameOfWeek = String(settings.obs.scenes.gameOfWeek || '');
  settings.obs.scenes.default = String(settings.obs.scenes.default || '');

  settings.overlay.mode = settings.overlay.mode === 'ticker' ? 'ticker' : 'carousel';
  settings.overlay.layout = settings.overlay.layout === 'compact' ? 'compact' : 'full';

  const presets = new Set(['bottom-ticker', 'sidebar-widget', 'lower-third', 'centered-card']);
  if (!presets.has(settings.overlay.scenePreset)) {
    settings.overlay.scenePreset = 'centered-card';
  }

  settings.overlay.themePack = String(settings.overlay.themePack || 'neon-grid');

  settings.league.week = settings.league.week === 'current' ? 'current' : Number(settings.league.week || 'current');
  if (settings.league.week !== 'current' && (!Number.isInteger(settings.league.week) || settings.league.week < 1 || settings.league.week > 18)) {
    settings.league.week = 'current';
  }

  settings.security.adminApiKey = String(settings.security.adminApiKey || '').trim();

  return settings;
}

async function applyEnvDefaults(settings) {
  if (process.env.YAHOO_CLIENT_ID && !settings.yahoo.clientId) {
    settings.yahoo.clientId = process.env.YAHOO_CLIENT_ID;
  }

  const secretFromStore = await getSecret('yahooClientSecret');
  if (secretFromStore && !settings.yahoo.clientSecret) {
    settings.yahoo.clientSecret = secretFromStore;
  }

  if (process.env.YAHOO_CLIENT_SECRET) {
    settings.yahoo.clientSecret = process.env.YAHOO_CLIENT_SECRET;
  }

  const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3030}`;
  settings.yahoo.redirectUri = settings.yahoo.redirectUri || process.env.YAHOO_REDIRECT_URI || `${appBaseUrl}/auth/callback`;

  if (process.env.MOCK_MODE !== undefined) {
    settings.data.mockMode = envBool(process.env.MOCK_MODE);
  }

  if (process.env.ADMIN_API_KEY && !settings.security.adminApiKey) {
    settings.security.adminApiKey = process.env.ADMIN_API_KEY;
  }

  if (process.env.USE_OS_KEYCHAIN !== undefined) {
    settings.security.useOsKeychain = envBool(process.env.USE_OS_KEYCHAIN);
  }

  return settings;
}

async function ensureFile() {
  try {
    await fs.access(SETTINGS_PATH);
  } catch {
    await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
    await fs.writeFile(SETTINGS_PATH, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`, 'utf8');
  }
}

async function loadSettings() {
  await ensureFile();
  const raw = await fs.readFile(SETTINGS_PATH, 'utf8');

  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const merged = deepMerge(deepClone(DEFAULT_SETTINGS), parsed);
  const withEnv = await applyEnvDefaults(merged);
  return applyValidation(withEnv);
}

async function saveSettings(settings) {
  const merged = deepMerge(deepClone(DEFAULT_SETTINGS), settings);
  const withEnv = await applyEnvDefaults(merged);
  const validated = applyValidation(withEnv);

  if (validated.yahoo.clientSecret && validated.yahoo.clientSecret !== '********') {
    await setSecret('yahooClientSecret', validated.yahoo.clientSecret);
  }

  const persistable = deepClone(validated);
  if (persistable.yahoo.clientSecret) {
    persistable.yahoo.clientSecret = '';
  }

  await fs.writeFile(SETTINGS_PATH, `${JSON.stringify(persistable, null, 2)}\n`, 'utf8');
  return validated;
}

async function updateSettings(partial) {
  const current = await loadSettings();
  const merged = deepMerge(current, partial || {});
  return saveSettings(merged);
}

function redactSecrets(settings) {
  const cloned = deepClone(settings);
  cloned.yahoo.hasClientSecret = Boolean(cloned.yahoo.clientSecret);
  if (cloned.yahoo.clientSecret) {
    cloned.yahoo.clientSecret = '********';
  }

  if (cloned.security.adminApiKey) {
    cloned.security.adminApiKey = '********';
  }

  if (cloned.obs?.password) {
    cloned.obs.password = '********';
  }

  return cloned;
}

async function getAdminApiKey() {
  if (process.env.ADMIN_API_KEY) {
    return process.env.ADMIN_API_KEY;
  }

  const settings = await loadSettings();
  return settings.security.adminApiKey || '';
}

module.exports = {
  SETTINGS_PATH,
  loadSettings,
  saveSettings,
  updateSettings,
  redactSecrets,
  getAdminApiKey
};
