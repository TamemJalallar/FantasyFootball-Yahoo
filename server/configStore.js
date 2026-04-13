const fs = require('node:fs/promises');
const path = require('node:path');
const { deepClone, deepMerge, clampNumber } = require('./utils');
const { DEFAULT_SETTINGS } = require('./defaultSettings');
const { getSecret, setSecret } = require('./secretStore');

const SETTINGS_PATH = path.resolve(process.cwd(), 'config', 'settings.json');

function envBool(value) {
  return String(value).toLowerCase() === 'true';
}

function normalizeWeekValue(raw, { min = 1, max = 25, fallback = 'current' } = {}) {
  if (raw === 'current') {
    return 'current';
  }

  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) {
    return fallback;
  }

  return numeric;
}

function normalizeProviderKey(raw, fallback = 'yahoo') {
  const key = String(raw || '').trim().toLowerCase();
  return ['yahoo', 'espn', 'sleeper', 'mock'].includes(key) ? key : fallback;
}

function normalizeProviderPack(pack, fallbackPack) {
  const source = pack || {};
  const fallback = fallbackPack || {};
  return {
    primary: String(source.primary || fallback.primary || '#13f1b7'),
    secondary: String(source.secondary || fallback.secondary || '#3d5cff'),
    background: String(source.background || fallback.background || 'rgba(8, 12, 24, 0.72)'),
    text: String(source.text || fallback.text || '#f6f8ff'),
    mutedText: String(source.mutedText || fallback.mutedText || '#aab3ca'),
    displayFont: String(source.displayFont || fallback.displayFont || 'Rajdhani'),
    bodyFont: String(source.bodyFont || fallback.bodyFont || 'Rajdhani'),
    badgeLabel: String(source.badgeLabel || fallback.badgeLabel || 'Fantasy'),
    badgeColor: String(source.badgeColor || fallback.badgeColor || '#13f1b7'),
    badgeLogoUrl: String(source.badgeLogoUrl || fallback.badgeLogoUrl || '')
  };
}

function applyValidation(settings) {
  const provider = String(settings.data.provider || 'yahoo').trim().toLowerCase();
  settings.data.provider = ['yahoo', 'mock', 'espn', 'sleeper'].includes(provider) ? provider : 'yahoo';

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

  settings.data.scheduleAware = settings.data.scheduleAware || {};
  settings.data.scheduleAware.enabled = Boolean(settings.data.scheduleAware.enabled);
  settings.data.scheduleAware.timezone = String(settings.data.scheduleAware.timezone || '').trim() || 'America/New_York';

  const gameDays = Array.isArray(settings.data.scheduleAware.gameDays)
    ? settings.data.scheduleAware.gameDays
    : ['thu', 'sun', 'mon'];
  settings.data.scheduleAware.gameDays = [...new Set(gameDays
    .map((day) => String(day || '').trim().slice(0, 3).toLowerCase())
    .filter(Boolean))]
    .slice(0, 7);
  if (!settings.data.scheduleAware.gameDays.length) {
    settings.data.scheduleAware.gameDays = ['thu', 'sun', 'mon'];
  }

  settings.data.scheduleAware.gameWindowStartHour = clampNumber(settings.data.scheduleAware.gameWindowStartHour, 0, 23, 9);
  settings.data.scheduleAware.gameWindowEndHour = clampNumber(settings.data.scheduleAware.gameWindowEndHour, 1, 24, 24);
  settings.data.scheduleAware.offHoursScoreboardMs = clampNumber(settings.data.scheduleAware.offHoursScoreboardMs, 15000, 1800000, 60000);
  settings.data.scheduleAware.offHoursTdMs = clampNumber(settings.data.scheduleAware.offHoursTdMs, 15000, 1800000, 60000);

  settings.data.safeMode = settings.data.safeMode || {};
  settings.data.safeMode.enabled = Boolean(settings.data.safeMode.enabled);
  settings.data.safeMode.fallbackToMock = Boolean(settings.data.safeMode.fallbackToMock);
  settings.data.safeMode.startupForceFallbackIfAuthDown = Boolean(settings.data.safeMode.startupForceFallbackIfAuthDown);

  settings.data.rateLimitBudget = settings.data.rateLimitBudget || {};
  settings.data.rateLimitBudget.enabled = Boolean(settings.data.rateLimitBudget.enabled);
  settings.data.rateLimitBudget.perHour = clampNumber(settings.data.rateLimitBudget.perHour, 100, 100000, 1800);
  settings.data.rateLimitBudget.warnThresholdPct = clampNumber(settings.data.rateLimitBudget.warnThresholdPct, 0.1, 0.99, 0.8);
  settings.data.mockSeed = String(settings.data.mockSeed || '').trim();

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
  settings.overlay.providerThemeMode = ['auto', 'manual', 'off'].includes(String(settings.overlay.providerThemeMode || '').toLowerCase())
    ? String(settings.overlay.providerThemeMode || '').toLowerCase()
    : 'auto';
  settings.overlay.providerThemeManual = normalizeProviderKey(settings.overlay.providerThemeManual, 'yahoo');
  settings.overlay.providerBrandingEnabled = Boolean(settings.overlay.providerBrandingEnabled);
  settings.overlay.autoRedzone = settings.overlay.autoRedzone || {};
  settings.overlay.autoRedzone.enabled = Boolean(settings.overlay.autoRedzone.enabled);
  settings.overlay.autoRedzone.lockMs = clampNumber(settings.overlay.autoRedzone.lockMs, 5000, 120000, 25000);
  settings.overlay.autoRedzone.focusLimit = clampNumber(settings.overlay.autoRedzone.focusLimit, 1, 8, 3);
  settings.overlay.autoRedzone.maxScoreDiff = clampNumber(settings.overlay.autoRedzone.maxScoreDiff, 1, 60, 12);
  settings.overlay.storyCards = settings.overlay.storyCards || {};
  settings.overlay.storyCards.enabled = Boolean(settings.overlay.storyCards.enabled);
  settings.overlay.storyCards.interval = clampNumber(settings.overlay.storyCards.interval, 1, 6, 2);
  settings.overlay.branding = settings.overlay.branding || {};
  settings.overlay.branding.enabled = Boolean(settings.overlay.branding.enabled);
  settings.overlay.branding.leagueTitle = String(settings.overlay.branding.leagueTitle || 'Fantasy Football Live');
  settings.overlay.branding.watermarkEnabled = Boolean(settings.overlay.branding.watermarkEnabled);
  settings.overlay.branding.watermarkText = String(settings.overlay.branding.watermarkText || 'Yahoo Fantasy Overlay');
  settings.overlay.branding.watermarkLogoUrl = String(settings.overlay.branding.watermarkLogoUrl || '');
  settings.overlay.branding.fontDisplay = String(settings.overlay.branding.fontDisplay || 'Rajdhani');
  settings.overlay.branding.fontBody = String(settings.overlay.branding.fontBody || 'Rajdhani');
  settings.security.reducedAnimations = Boolean(settings.security.reducedAnimations);
  settings.security.useOsKeychain = Boolean(settings.security.useOsKeychain);
  settings.security.overlayApiKey = String(settings.security.overlayApiKey || '').trim();
  settings.theme.providerOverrideEnabled = Boolean(settings.theme.providerOverrideEnabled);
  settings.theme.providerPacks = settings.theme.providerPacks || {};
  const defaultProviderPacks = DEFAULT_SETTINGS.theme?.providerPacks || {};
  for (const providerKey of ['yahoo', 'espn', 'sleeper', 'mock']) {
    settings.theme.providerPacks[providerKey] = normalizeProviderPack(
      settings.theme.providerPacks[providerKey],
      defaultProviderPacks[providerKey]
    );
  }
  settings.audio.enabled = Boolean(settings.audio.enabled);
  settings.audio.minDispatchIntervalMs = clampNumber(settings.audio.minDispatchIntervalMs, 250, 30000, 1200);
  settings.audio.maxQueueSize = clampNumber(settings.audio.maxQueueSize, 5, 500, 50);
  settings.audio.cooldownsMs = settings.audio.cooldownsMs || {};
  settings.audio.cooldownsMs.touchdown = clampNumber(settings.audio.cooldownsMs.touchdown, 0, 120000, 1200);
  settings.audio.cooldownsMs.lead_change = clampNumber(settings.audio.cooldownsMs.lead_change, 0, 120000, 1800);
  settings.audio.cooldownsMs.upset = clampNumber(settings.audio.cooldownsMs.upset, 0, 120000, 2400);
  settings.audio.cooldownsMs.final = clampNumber(settings.audio.cooldownsMs.final, 0, 120000, 3000);
  settings.audio.templates = settings.audio.templates || {};
  settings.audio.templates.touchdown = String(settings.audio.templates.touchdown || 'default-td');
  settings.audio.templates.lead_change = String(settings.audio.templates.lead_change || 'default-lead');
  settings.audio.templates.upset = String(settings.audio.templates.upset || 'default-upset');
  settings.audio.templates.final = String(settings.audio.templates.final || 'default-final');

  settings.integrations = settings.integrations || {};
  settings.integrations.enabled = Boolean(settings.integrations.enabled);
  settings.integrations.discordWebhookUrl = String(settings.integrations.discordWebhookUrl || '').trim();
  settings.integrations.slackWebhookUrl = String(settings.integrations.slackWebhookUrl || '').trim();
  settings.integrations.sendTouchdowns = Boolean(settings.integrations.sendTouchdowns);
  settings.integrations.sendLeadChanges = Boolean(settings.integrations.sendLeadChanges);
  settings.integrations.sendUpsets = Boolean(settings.integrations.sendUpsets);
  settings.integrations.sendFinals = Boolean(settings.integrations.sendFinals);

  settings.obs.enabled = Boolean(settings.obs.enabled);
  settings.obs.sceneCooldownMs = clampNumber(settings.obs.sceneCooldownMs, 0, 300000, 7000);
  settings.obs.wsUrl = String(settings.obs.wsUrl || '').trim() || 'ws://127.0.0.1:4455';
  settings.obs.password = String(settings.obs.password || '');
  settings.obs.scenes = settings.obs.scenes || {};
  settings.obs.scenes.touchdown = String(settings.obs.scenes.touchdown || '');
  settings.obs.scenes.upset = String(settings.obs.scenes.upset || '');
  settings.obs.scenes.gameOfWeek = String(settings.obs.scenes.gameOfWeek || '');
  settings.obs.scenes.default = String(settings.obs.scenes.default || '');

  settings.espn = settings.espn || {};
  settings.espn.leagueId = String(settings.espn.leagueId || '').trim();
  settings.espn.season = clampNumber(settings.espn.season, 2010, 2100, settings.league.season || new Date().getFullYear());
  settings.espn.week = normalizeWeekValue(settings.espn.week, { min: 1, max: 25, fallback: 'current' });
  settings.espn.swid = String(settings.espn.swid || '').trim();
  settings.espn.espnS2 = String(settings.espn.espnS2 || '').trim();

  settings.sleeper = settings.sleeper || {};
  settings.sleeper.leagueId = String(settings.sleeper.leagueId || '').trim();
  settings.sleeper.season = clampNumber(settings.sleeper.season, 2010, 2100, settings.league.season || new Date().getFullYear());
  settings.sleeper.week = normalizeWeekValue(settings.sleeper.week, { min: 1, max: 25, fallback: 'current' });

  settings.overlay.mode = settings.overlay.mode === 'ticker' ? 'ticker' : 'carousel';
  settings.overlay.matchupScope = settings.overlay.matchupScope === 'team' ? 'team' : 'league';
  settings.overlay.focusTeam = String(settings.overlay.focusTeam || '').trim();
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

  const espnSwidFromStore = await getSecret('espnSwid');
  if (espnSwidFromStore && !settings.espn.swid) {
    settings.espn.swid = espnSwidFromStore;
  }

  const espnS2FromStore = await getSecret('espnS2');
  if (espnS2FromStore && !settings.espn.espnS2) {
    settings.espn.espnS2 = espnS2FromStore;
  }

  if (process.env.YAHOO_CLIENT_SECRET) {
    settings.yahoo.clientSecret = process.env.YAHOO_CLIENT_SECRET;
  }

  if (process.env.ESPN_LEAGUE_ID) {
    settings.espn.leagueId = process.env.ESPN_LEAGUE_ID;
  }
  if (process.env.ESPN_SEASON) {
    settings.espn.season = Number(process.env.ESPN_SEASON);
  }
  if (process.env.ESPN_WEEK) {
    settings.espn.week = process.env.ESPN_WEEK === 'current' ? 'current' : Number(process.env.ESPN_WEEK);
  }
  if (process.env.ESPN_SWID) {
    settings.espn.swid = process.env.ESPN_SWID;
  }
  if (process.env.ESPN_S2) {
    settings.espn.espnS2 = process.env.ESPN_S2;
  }

  if (process.env.SLEEPER_LEAGUE_ID) {
    settings.sleeper.leagueId = process.env.SLEEPER_LEAGUE_ID;
  }
  if (process.env.SLEEPER_SEASON) {
    settings.sleeper.season = Number(process.env.SLEEPER_SEASON);
  }
  if (process.env.SLEEPER_WEEK) {
    settings.sleeper.week = process.env.SLEEPER_WEEK === 'current' ? 'current' : Number(process.env.SLEEPER_WEEK);
  }

  const appBaseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3030}`;
  settings.yahoo.redirectUri = settings.yahoo.redirectUri || process.env.YAHOO_REDIRECT_URI || `${appBaseUrl}/auth/callback`;

  if (process.env.MOCK_MODE !== undefined) {
    settings.data.mockMode = envBool(process.env.MOCK_MODE);
  }

  if (process.env.ADMIN_API_KEY && !settings.security.adminApiKey) {
    settings.security.adminApiKey = process.env.ADMIN_API_KEY;
  }

  if (process.env.OVERLAY_API_KEY && !settings.security.overlayApiKey) {
    settings.security.overlayApiKey = process.env.OVERLAY_API_KEY;
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

  if (validated.espn.swid && validated.espn.swid !== '********') {
    await setSecret('espnSwid', validated.espn.swid);
  }

  if (validated.espn.espnS2 && validated.espn.espnS2 !== '********') {
    await setSecret('espnS2', validated.espn.espnS2);
  }

  const persistable = deepClone(validated);
  if (persistable.yahoo.clientSecret) {
    persistable.yahoo.clientSecret = '';
  }
  if (persistable.espn?.swid) {
    persistable.espn.swid = '';
  }
  if (persistable.espn?.espnS2) {
    persistable.espn.espnS2 = '';
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

  if (cloned.espn?.swid) {
    cloned.espn.swid = '********';
  }
  if (cloned.espn?.espnS2) {
    cloned.espn.espnS2 = '********';
  }

  if (cloned.security.adminApiKey) {
    cloned.security.adminApiKey = '********';
  }

  if (cloned.security.overlayApiKey) {
    cloned.security.overlayApiKey = '********';
  }

  if (cloned.obs?.password) {
    cloned.obs.password = '********';
  }

  if (cloned.integrations?.discordWebhookUrl) {
    cloned.integrations.discordWebhookUrl = '********';
  }
  if (cloned.integrations?.slackWebhookUrl) {
    cloned.integrations.slackWebhookUrl = '********';
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

async function getOverlayApiKey() {
  const settings = await loadSettings();
  return settings.security.overlayApiKey || '';
}

module.exports = {
  SETTINGS_PATH,
  loadSettings,
  saveSettings,
  updateSettings,
  redactSecrets,
  getAdminApiKey,
  getOverlayApiKey
};
