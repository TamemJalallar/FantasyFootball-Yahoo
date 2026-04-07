const fs = require('node:fs/promises');
const path = require('node:path');
const { deepClone, deepMerge, clampNumber } = require('./utils');
const { DEFAULT_SETTINGS } = require('./defaultSettings');

const SETTINGS_PATH = path.resolve(process.cwd(), 'config', 'settings.json');

function envBool(value) {
  return String(value).toLowerCase() === 'true';
}

function applyValidation(settings) {
  settings.data.refreshIntervalMs = clampNumber(settings.data.refreshIntervalMs, 15000, 900000, 45000);
  settings.data.maxRetryDelayMs = clampNumber(settings.data.maxRetryDelayMs, 30000, 1800000, 300000);
  settings.overlay.rotationIntervalMs = clampNumber(settings.overlay.rotationIntervalMs, 3000, 120000, 9000);
  settings.overlay.tdAlertDurationMs = clampNumber(settings.overlay.tdAlertDurationMs, 3000, 20000, 8000);
  settings.theme.fontScale = clampNumber(settings.theme.fontScale, 0.6, 2, 1);
  settings.overlay.showTdAlerts = Boolean(settings.overlay.showTdAlerts);

  settings.overlay.mode = settings.overlay.mode === 'ticker' ? 'ticker' : 'carousel';
  settings.overlay.layout = settings.overlay.layout === 'compact' ? 'compact' : 'full';

  const presets = new Set(['bottom-ticker', 'sidebar-widget', 'lower-third', 'centered-card']);
  if (!presets.has(settings.overlay.scenePreset)) {
    settings.overlay.scenePreset = 'centered-card';
  }

  settings.league.week = settings.league.week === 'current' ? 'current' : Number(settings.league.week || 'current');
  if (settings.league.week !== 'current' && (!Number.isInteger(settings.league.week) || settings.league.week < 1 || settings.league.week > 18)) {
    settings.league.week = 'current';
  }

  return settings;
}

function applyEnvDefaults(settings) {
  if (process.env.YAHOO_CLIENT_ID && !settings.yahoo.clientId) {
    settings.yahoo.clientId = process.env.YAHOO_CLIENT_ID;
  }
  if (process.env.YAHOO_CLIENT_SECRET && !settings.yahoo.clientSecret) {
    settings.yahoo.clientSecret = process.env.YAHOO_CLIENT_SECRET;
  }

  const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3030}`;
  settings.yahoo.redirectUri = settings.yahoo.redirectUri || process.env.YAHOO_REDIRECT_URI || `${appBaseUrl}/auth/callback`;

  if (process.env.MOCK_MODE !== undefined) {
    settings.data.mockMode = envBool(process.env.MOCK_MODE);
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
  return applyValidation(applyEnvDefaults(merged));
}

async function saveSettings(settings) {
  const validated = applyValidation(applyEnvDefaults(deepMerge(deepClone(DEFAULT_SETTINGS), settings)));
  await fs.writeFile(SETTINGS_PATH, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
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
  return cloned;
}

module.exports = {
  SETTINGS_PATH,
  loadSettings,
  saveSettings,
  updateSettings,
  redactSecrets
};
