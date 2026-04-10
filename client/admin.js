const $ = (id) => document.getElementById(id);

const ADMIN_KEY_STORAGE = 'obs_overlay_admin_key';

const THEME_PACKS = {
  'neon-grid': {
    overlay: {
      scenePreset: 'centered-card',
      themePack: 'neon-grid'
    },
    theme: {
      primary: '#13f1b7',
      secondary: '#3d5cff',
      background: 'rgba(8, 12, 24, 0.72)',
      text: '#f6f8ff',
      mutedText: '#aab3ca'
    }
  },
  'classic-gold': {
    overlay: {
      scenePreset: 'lower-third',
      themePack: 'classic-gold'
    },
    theme: {
      primary: '#f3b341',
      secondary: '#cb8e2b',
      background: 'rgba(27, 19, 6, 0.82)',
      text: '#fff2d2',
      mutedText: '#d2bf95'
    }
  },
  'ice-night': {
    overlay: {
      scenePreset: 'sidebar-widget',
      themePack: 'ice-night'
    },
    theme: {
      primary: '#6dd9ff',
      secondary: '#8f9dff',
      background: 'rgba(10, 18, 34, 0.8)',
      text: '#eef6ff',
      mutedText: '#9eb5cb'
    }
  }
};

const state = {
  settings: null,
  status: null,
  auth: null,
  profiles: [],
  activeProfileId: null,
  diagnostics: null,
  diagnosticsTimer: null,
  statusTimer: null
};

function bool(input) {
  return Boolean(input?.checked);
}

function numberValue(input, fallback = null) {
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}

function getAdminKey() {
  return ($('adminApiKeyInput')?.value || localStorage.getItem(ADMIN_KEY_STORAGE) || '').trim();
}

function withAdminHeaders(headers = {}) {
  const key = getAdminKey();
  if (!key) {
    return headers;
  }

  return {
    ...headers,
    'x-admin-key': key
  };
}

function setPill(id, label, ok) {
  const node = $(id);
  node.textContent = label;
  node.classList.remove('good', 'bad');
  node.classList.add(ok ? 'good' : 'bad');
}

function updateStatusLine() {
  const statusLine = $('statusLine');
  const banner = $('degradedBanner');

  if (!state.status) {
    statusLine.textContent = 'Status unavailable.';
    banner.classList.add('hidden');
    return;
  }

  const last = state.status.lastSuccessAt
    ? new Date(state.status.lastSuccessAt).toLocaleString()
    : 'never';

  if (state.status.lastError) {
    statusLine.textContent = `Last sync failed at ${new Date(state.status.lastError.at).toLocaleTimeString()} (${state.status.lastError.phase || 'unknown'}): ${state.status.lastError.message}`;
  } else {
    statusLine.textContent = `Running in ${state.status.mode || 'unknown'} mode. Last successful sync: ${last}.`;
  }

  if (state.status.degradedMode) {
    const circuit = state.status.circuitOpenUntil
      ? ` Circuit open until ${new Date(state.status.circuitOpenUntil).toLocaleTimeString()} (${state.status.circuitReason || 'unknown reason'}).`
      : '';
    banner.textContent = `Degraded Mode Active: scoreboard failures ${state.status.scoreboardFailureCount}, TD failures ${state.status.tdFailureCount}.${circuit}`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function applyThemePreview() {
  const preview = $('themePreview');
  const card = preview.querySelector('.preview-card');

  card.style.background = $('bgColor').value || 'rgba(8, 12, 24, 0.72)';
  card.style.color = $('textColor').value;
  card.style.borderColor = `${$('secondaryColor').value}80`;

  preview.style.setProperty('--accent', $('primaryColor').value);
  preview.style.setProperty('--accent-2', $('secondaryColor').value);
}

function setWeekMode(mode, weekNumber) {
  $('weekMode').value = mode;
  $('weekNumber').disabled = mode === 'current';
  if (mode === 'current') {
    $('weekNumber').value = Number.isFinite(weekNumber) ? String(weekNumber) : '1';
  }
}

function renderProfiles() {
  const select = $('profileSelect');

  if (!state.profiles.length) {
    select.innerHTML = '<option value="">No profiles yet</option>';
    return;
  }

  select.innerHTML = state.profiles
    .map((profile) => {
      const active = profile.id === state.activeProfileId ? ' (Active)' : '';
      return `<option value="${profile.id}">${profile.name}${active}</option>`;
    })
    .join('');

  if (state.activeProfileId) {
    select.value = state.activeProfileId;
  }
}

function fillForm(settings) {
  state.settings = settings;

  $('yahooClientId').value = settings.yahoo.clientId || '';
  $('yahooClientSecret').value = settings.yahoo.clientSecret || '';
  $('yahooRedirectUri').value = settings.yahoo.redirectUri || '';
  $('yahooScope').value = settings.yahoo.scope || 'fspt-r';

  $('leagueId').value = settings.league.leagueId || '';
  $('gameKey').value = settings.league.gameKey || '';
  $('season').value = settings.league.season || '';

  if (settings.league.week === 'current') {
    setWeekMode('current', 1);
  } else {
    setWeekMode('custom', Number(settings.league.week || 1));
    $('weekNumber').value = settings.league.week;
  }

  $('refreshIntervalMs').value = settings.data.refreshIntervalMs;
  $('scoreboardPollMs').value = settings.data.scoreboardPollMs || settings.data.refreshIntervalMs || 10000;
  $('tdScanIntervalMs').value = settings.data.tdScanIntervalMs || settings.data.refreshIntervalMs || 10000;
  $('maxRetryDelayMs').value = settings.data.maxRetryDelayMs;
  $('retryJitterPct').value = settings.data.retryJitterPct ?? 0.15;
  $('tdDedupWindowMs').value = settings.data.tdDedupWindowMs ?? 90000;

  $('adaptiveEnabled').checked = Boolean(settings.data.adaptivePolling?.enabled);
  $('adaptiveLiveMs').value = settings.data.adaptivePolling?.liveMs ?? 10000;
  $('adaptiveMixedMs').value = settings.data.adaptivePolling?.mixedMs ?? 20000;
  $('adaptiveIdleMs').value = settings.data.adaptivePolling?.idleMs ?? 45000;

  $('circuitEnabled').checked = Boolean(settings.data.circuitBreaker?.enabled);
  $('circuitFailureThreshold').value = settings.data.circuitBreaker?.failureThreshold ?? 4;
  $('circuitCooldownMs').value = settings.data.circuitBreaker?.cooldownMs ?? 60000;
  $('circuitRateLimitCooldownMs').value = settings.data.circuitBreaker?.rateLimitCooldownMs ?? 120000;

  $('historyEnabled').checked = Boolean(settings.data.history?.enabled);
  $('historyRetentionDays').value = settings.data.history?.retentionDays ?? 14;

  $('mockMode').checked = Boolean(settings.data.mockMode);
  $('teamOverrides').value = JSON.stringify(settings.league.teamNameOverrides || {}, null, 2);

  $('overlayMode').value = settings.overlay.mode;
  $('scenePreset').value = settings.overlay.scenePreset;
  $('rotationIntervalMs').value = settings.overlay.rotationIntervalMs;
  $('fontScale').value = settings.theme.fontScale;
  $('themePack').value = settings.overlay.themePack || 'neon-grid';

  $('twoMatchupLayout').checked = Boolean(settings.overlay.twoMatchupLayout);
  $('compactLayout').checked = settings.overlay.layout === 'compact';
  $('darkMode').checked = Boolean(settings.theme.darkMode);
  $('showUpdatedIndicator').checked = Boolean(settings.dev.showUpdatedIndicator);
  $('showProjections').checked = Boolean(settings.overlay.showProjections);
  $('showRecords').checked = Boolean(settings.overlay.showRecords);
  $('showLogos').checked = Boolean(settings.overlay.showLogos);
  $('showTicker').checked = Boolean(settings.overlay.showTicker);
  $('showTdAlerts').checked = Boolean(settings.overlay.showTdAlerts);
  $('showScoreDelta').checked = Boolean(settings.overlay.showScoreDelta);
  $('tdAlertDurationMs').value = settings.overlay.tdAlertDurationMs || 8000;
  $('highlightClosest').checked = Boolean(settings.overlay.highlightClosest);
  $('highlightUpset').checked = Boolean(settings.overlay.highlightUpset);

  if (!$('adminApiKeyInput').value.trim() && settings.security?.adminApiKey) {
    $('adminApiKeyInput').value = settings.security.adminApiKey;
  }

  $('gameOfWeekMatchupId').value = settings.overlay.gameOfWeekMatchupId || '';
  $('soundHookUrl').value = settings.overlay.soundHookUrl || '';

  $('primaryColor').value = settings.theme.primary || '#13f1b7';
  $('secondaryColor').value = settings.theme.secondary || '#3d5cff';
  $('textColor').value = settings.theme.text || '#f6f8ff';
  $('mutedTextColor').value = settings.theme.mutedText || '#aab3ca';
  $('bgColor').value = settings.theme.background || 'rgba(8, 12, 24, 0.72)';

  $('reducedAnimations').value = String(Boolean(settings.security?.reducedAnimations));
  $('useOsKeychain').checked = Boolean(settings.security?.useOsKeychain);

  $('audioEnabled').checked = Boolean(settings.audio?.enabled);
  $('audioEndpointUrl').value = settings.audio?.endpointUrl || '';
  $('audioMinDispatchIntervalMs').value = settings.audio?.minDispatchIntervalMs ?? 1200;
  $('audioMaxQueueSize').value = settings.audio?.maxQueueSize ?? 50;

  $('obsEnabled').checked = Boolean(settings.obs?.enabled);
  $('obsWsUrl').value = settings.obs?.wsUrl || 'ws://127.0.0.1:4455';
  $('obsPassword').value = settings.obs?.password || '';
  $('obsSceneCooldownMs').value = settings.obs?.sceneCooldownMs ?? 7000;
  $('obsSceneTouchdown').value = settings.obs?.scenes?.touchdown || '';
  $('obsSceneUpset').value = settings.obs?.scenes?.upset || '';
  $('obsSceneGameOfWeek').value = settings.obs?.scenes?.gameOfWeek || '';
  $('obsSceneDefault').value = settings.obs?.scenes?.default || '';

  applyThemePreview();
}

function collectForm() {
  let overrides;
  try {
    overrides = JSON.parse($('teamOverrides').value || '{}');
  } catch {
    throw new Error('Team overrides must be valid JSON.');
  }

  const weekMode = $('weekMode').value;
  const week = weekMode === 'current' ? 'current' : numberValue($('weekNumber'), 1);

  return {
    yahoo: {
      clientId: $('yahooClientId').value.trim(),
      clientSecret: $('yahooClientSecret').value,
      redirectUri: $('yahooRedirectUri').value.trim(),
      scope: $('yahooScope').value.trim() || 'fspt-r'
    },
    league: {
      leagueId: $('leagueId').value.trim(),
      gameKey: $('gameKey').value.trim(),
      season: numberValue($('season'), new Date().getFullYear()),
      week,
      teamNameOverrides: overrides
    },
    data: {
      refreshIntervalMs: numberValue($('refreshIntervalMs'), 10000),
      scoreboardPollMs: numberValue($('scoreboardPollMs'), 10000),
      tdScanIntervalMs: numberValue($('tdScanIntervalMs'), 10000),
      maxRetryDelayMs: numberValue($('maxRetryDelayMs'), 300000),
      retryJitterPct: numberValue($('retryJitterPct'), 0.15),
      tdDedupWindowMs: numberValue($('tdDedupWindowMs'), 90000),
      adaptivePolling: {
        enabled: bool($('adaptiveEnabled')),
        liveMs: numberValue($('adaptiveLiveMs'), 10000),
        mixedMs: numberValue($('adaptiveMixedMs'), 20000),
        idleMs: numberValue($('adaptiveIdleMs'), 45000)
      },
      circuitBreaker: {
        enabled: bool($('circuitEnabled')),
        failureThreshold: numberValue($('circuitFailureThreshold'), 4),
        cooldownMs: numberValue($('circuitCooldownMs'), 60000),
        rateLimitCooldownMs: numberValue($('circuitRateLimitCooldownMs'), 120000)
      },
      history: {
        enabled: bool($('historyEnabled')),
        retentionDays: numberValue($('historyRetentionDays'), 14)
      },
      mockMode: bool($('mockMode'))
    },
    overlay: {
      mode: $('overlayMode').value,
      scenePreset: $('scenePreset').value,
      rotationIntervalMs: numberValue($('rotationIntervalMs'), 9000),
      twoMatchupLayout: bool($('twoMatchupLayout')),
      layout: bool($('compactLayout')) ? 'compact' : 'full',
      showProjections: bool($('showProjections')),
      showRecords: bool($('showRecords')),
      showLogos: bool($('showLogos')),
      showTicker: bool($('showTicker')),
      showTdAlerts: bool($('showTdAlerts')),
      showScoreDelta: bool($('showScoreDelta')),
      tdAlertDurationMs: numberValue($('tdAlertDurationMs'), 8000),
      highlightClosest: bool($('highlightClosest')),
      highlightUpset: bool($('highlightUpset')),
      gameOfWeekMatchupId: $('gameOfWeekMatchupId').value.trim(),
      soundHookUrl: $('soundHookUrl').value.trim(),
      themePack: $('themePack').value
    },
    theme: {
      fontScale: numberValue($('fontScale'), 1),
      darkMode: bool($('darkMode')),
      compact: bool($('compactLayout')),
      primary: $('primaryColor').value,
      secondary: $('secondaryColor').value,
      background: $('bgColor').value.trim(),
      text: $('textColor').value,
      mutedText: $('mutedTextColor').value
    },
    dev: {
      showUpdatedIndicator: bool($('showUpdatedIndicator'))
    },
    security: {
      adminApiKey: $('adminApiKeyInput').value.trim(),
      reducedAnimations: $('reducedAnimations').value === 'true',
      useOsKeychain: bool($('useOsKeychain'))
    },
    audio: {
      enabled: bool($('audioEnabled')),
      endpointUrl: $('audioEndpointUrl').value.trim(),
      minDispatchIntervalMs: numberValue($('audioMinDispatchIntervalMs'), 1200),
      maxQueueSize: numberValue($('audioMaxQueueSize'), 50)
    },
    obs: {
      enabled: bool($('obsEnabled')),
      wsUrl: $('obsWsUrl').value.trim(),
      password: $('obsPassword').value,
      sceneCooldownMs: numberValue($('obsSceneCooldownMs'), 7000),
      scenes: {
        touchdown: $('obsSceneTouchdown').value.trim(),
        upset: $('obsSceneUpset').value.trim(),
        gameOfWeek: $('obsSceneGameOfWeek').value.trim(),
        default: $('obsSceneDefault').value.trim()
      }
    }
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: withAdminHeaders(options.headers || {})
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || body.detail || `Request failed (${response.status})`);
  }

  return body;
}

function notify(nodeId, message, ok = true) {
  const node = $(nodeId);
  node.textContent = message;
  node.style.color = ok ? '#88ffe0' : '#ff9cad';
}

async function refreshProfiles() {
  const payload = await fetchJson('/api/profiles');
  state.profiles = payload.profiles || [];
  state.activeProfileId = payload.activeProfileId || null;
  renderProfiles();
}

async function load() {
  const rememberedKey = localStorage.getItem(ADMIN_KEY_STORAGE) || '';
  if (rememberedKey) {
    $('adminApiKeyInput').value = rememberedKey;
  }

  const [{ settings }, statusPayload] = await Promise.all([
    fetchJson('/api/config'),
    fetchJson('/api/status')
  ]);

  state.status = statusPayload.status;
  state.auth = statusPayload.auth;

  fillForm(settings);
  refreshAuthPills();
  updateStatusLine();

  await refreshProfiles();
  await refreshDiagnostics();

  const overlayUrl = `${window.location.origin}/overlay`;
  $('overlayUrl').value = overlayUrl;
  renderPresetLinks(overlayUrl);
}

function renderPresetLinks(base) {
  const node = $('presetLinks');
  const links = [
    { label: 'Centered Card', url: `${base}?preset=centered-card` },
    { label: 'Lower Third', url: `${base}?preset=lower-third` },
    { label: 'Sidebar Widget', url: `${base}?preset=sidebar-widget` },
    { label: 'Bottom Ticker', url: `${base}?preset=bottom-ticker` },
    { label: 'Ticker Mode', url: `${base}?mode=ticker` },
    { label: 'Two-Up Sidebar', url: `${base}?preset=sidebar-widget&twoUp=1&scale=0.95` }
  ];

  node.innerHTML = links
    .map((link) => `<div><strong>${link.label}:</strong> <a href="${link.url}" target="_blank" rel="noreferrer">${link.url}</a></div>`)
    .join('');
}

function refreshAuthPills() {
  if (!state.auth) {
    return;
  }

  setPill('oauthConfigured', `Configured: ${state.auth.configured ? 'Yes' : 'No'}`, state.auth.configured);
  setPill('oauthAuthorized', `Authorized: ${state.auth.authorized ? 'Yes' : 'No'}`, state.auth.authorized);

  const expiryText = state.auth.expiresAt
    ? new Date(state.auth.expiresAt).toLocaleString()
    : 'N/A';

  const expiryNode = $('oauthExpiry');
  expiryNode.textContent = `Token Expiry: ${expiryText}`;
  expiryNode.classList.remove('good', 'bad');
  expiryNode.classList.add(state.auth.accessTokenValid ? 'good' : 'bad');
}

async function saveSettings() {
  const payload = collectForm();

  const result = await fetchJson('/api/config', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  fillForm(result.settings);
  await refreshStatus();
  await refreshDiagnostics();
}

async function refreshStatus() {
  const statusPayload = await fetchJson('/api/status');
  state.status = statusPayload.status;
  state.auth = statusPayload.auth;
  refreshAuthPills();
  updateStatusLine();
}

async function refreshDiagnostics() {
  const payload = await fetchJson('/api/diagnostics?hours=24');
  state.diagnostics = payload.diagnostics;

  const output = {
    status: payload.diagnostics.status,
    metrics: payload.diagnostics.metrics,
    recentPolls: (payload.diagnostics.pollRecords || []).slice(0, 12),
    recentLeadChanges: (payload.diagnostics.recentLeadChanges || []).slice(0, 8),
    recentUpsetEvents: (payload.diagnostics.recentUpsetEvents || []).slice(0, 8),
    recentTdEvents: (payload.diagnostics.recentTdEvents || []).slice(0, 8)
  };

  $('diagnosticsOutput').textContent = JSON.stringify(output, null, 2);
}

async function testConnection() {
  notify('testResult', 'Testing API connection...');

  try {
    const result = await fetchJson('/api/test-connection', {
      method: 'POST'
    });

    if (result.mode === 'mock') {
      notify('testResult', result.message, true);
    } else {
      notify(
        'testResult',
        `OK: ${result.league.name} | Week ${result.league.week} | Matchups ${result.matchupCount}`,
        true
      );
    }

    await refreshStatus();
  } catch (error) {
    notify('testResult', error.message, false);
  }
}

async function forceRefresh() {
  await fetchJson('/api/refresh', { method: 'POST' });
  await refreshStatus();
  await refreshDiagnostics();
}

async function forceNext() {
  await fetchJson('/api/control/next', { method: 'POST' });
}

async function logoutTokens() {
  await fetchJson('/api/auth/logout', { method: 'POST' });
  await refreshStatus();
}

async function exportConfig() {
  const response = await fetch('/api/config/export', {
    headers: withAdminHeaders({})
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Export failed (${response.status})`);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'overlay-config.export.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function importConfigFromFile(file) {
  const raw = await file.text();
  const payload = JSON.parse(raw);

  const result = await fetchJson('/api/config/import', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  fillForm(result.settings);
  await refreshStatus();
  await refreshDiagnostics();
}

function applyThemePack() {
  const packId = $('themePack').value;
  const pack = THEME_PACKS[packId];
  if (!pack) {
    return;
  }

  $('primaryColor').value = pack.theme.primary;
  $('secondaryColor').value = pack.theme.secondary;
  $('textColor').value = pack.theme.text;
  $('mutedTextColor').value = pack.theme.mutedText;
  $('bgColor').value = pack.theme.background;
  $('scenePreset').value = pack.overlay.scenePreset;
  applyThemePreview();
}

async function saveProfileFromCurrent() {
  const name = $('profileNameInput').value.trim() || `Profile ${new Date().toLocaleTimeString()}`;
  const settings = collectForm();

  const payload = await fetchJson('/api/profiles/save', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ name, settings })
  });

  state.profiles = payload.profiles || [];
  state.activeProfileId = payload.activeProfileId || null;
  renderProfiles();
}

async function switchSelectedProfile() {
  const profileId = $('profileSelect').value;
  if (!profileId) {
    throw new Error('Select a profile first.');
  }

  const payload = await fetchJson('/api/profiles/switch', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ profileId })
  });

  fillForm(payload.settings);
  state.profiles = payload.profiles || [];
  state.activeProfileId = payload.activeProfileId || null;
  renderProfiles();
  await refreshStatus();
  await refreshDiagnostics();
}

async function deleteSelectedProfile() {
  const profileId = $('profileSelect').value;
  if (!profileId) {
    throw new Error('Select a profile first.');
  }

  if (!window.confirm('Delete selected profile?')) {
    return;
  }

  const payload = await fetchJson(`/api/profiles/${encodeURIComponent(profileId)}`, {
    method: 'DELETE'
  });

  state.profiles = payload.profiles || [];
  state.activeProfileId = payload.activeProfileId || null;
  renderProfiles();
}

function bindEvents() {
  $('weekMode').addEventListener('change', (event) => {
    setWeekMode(event.target.value, numberValue($('weekNumber'), 1));
  });

  ['primaryColor', 'secondaryColor', 'textColor', 'mutedTextColor', 'bgColor'].forEach((id) => {
    $(id).addEventListener('input', applyThemePreview);
  });

  $('themePackApplyBtn').addEventListener('click', applyThemePack);

  $('saveBtn').addEventListener('click', async () => {
    try {
      await saveSettings();
      notify('testResult', 'Settings saved.', true);
    } catch (error) {
      notify('testResult', error.message, false);
    }
  });

  $('testBtn').addEventListener('click', () => {
    testConnection().catch((error) => notify('testResult', error.message, false));
  });

  $('refreshBtn').addEventListener('click', () => {
    forceRefresh().catch((error) => notify('testResult', error.message, false));
  });

  $('nextBtn').addEventListener('click', () => {
    forceNext().catch((error) => notify('testResult', error.message, false));
  });

  $('oauthStartBtn').addEventListener('click', () => {
    const key = getAdminKey();
    if (key) {
      window.location.href = `/auth/start?adminKey=${encodeURIComponent(key)}`;
      return;
    }

    window.location.href = '/auth/start';
  });

  $('oauthLogoutBtn').addEventListener('click', () => {
    logoutTokens().catch((error) => notify('testResult', error.message, false));
  });

  $('copyOverlayBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('overlayUrl').value);
      notify('testResult', 'Overlay URL copied to clipboard.', true);
    } catch {
      notify('testResult', 'Clipboard copy failed. Copy manually.', false);
    }
  });

  $('rememberAdminKeyBtn').addEventListener('click', () => {
    const key = $('adminApiKeyInput').value.trim();
    if (!key) {
      notify('testResult', 'Enter an admin key first.', false);
      return;
    }

    localStorage.setItem(ADMIN_KEY_STORAGE, key);
    notify('testResult', 'Admin key remembered in browser.', true);
  });

  $('clearAdminKeyBtn').addEventListener('click', () => {
    localStorage.removeItem(ADMIN_KEY_STORAGE);
    $('adminApiKeyInput').value = '';
    notify('testResult', 'Remembered admin key cleared.', true);
  });

  $('exportConfigBtn').addEventListener('click', () => {
    exportConfig().catch((error) => notify('testResult', error.message, false));
  });

  $('importConfigBtn').addEventListener('click', () => {
    $('importConfigFile').click();
  });

  $('importConfigFile').addEventListener('change', async (event) => {
    const [file] = event.target.files || [];
    if (!file) {
      return;
    }

    try {
      await importConfigFromFile(file);
      notify('testResult', 'Config imported successfully.', true);
    } catch (error) {
      notify('testResult', `Import failed: ${error.message}`, false);
    } finally {
      event.target.value = '';
    }
  });

  $('profileSaveBtn').addEventListener('click', () => {
    saveProfileFromCurrent()
      .then(() => notify('testResult', 'Profile saved.', true))
      .catch((error) => notify('testResult', error.message, false));
  });

  $('profileSwitchBtn').addEventListener('click', () => {
    switchSelectedProfile()
      .then(() => notify('testResult', 'Profile switched.', true))
      .catch((error) => notify('testResult', error.message, false));
  });

  $('profileDeleteBtn').addEventListener('click', () => {
    deleteSelectedProfile()
      .then(() => notify('testResult', 'Profile deleted.', true))
      .catch((error) => notify('testResult', error.message, false));
  });

  $('refreshDiagnosticsBtn').addEventListener('click', () => {
    refreshDiagnostics().catch((error) => notify('testResult', error.message, false));
  });

  state.statusTimer = setInterval(() => {
    refreshStatus().catch(() => {});
  }, 15000);

  state.diagnosticsTimer = setInterval(() => {
    refreshDiagnostics().catch(() => {});
  }, 20000);
}

load()
  .then(bindEvents)
  .catch((error) => {
    $('statusLine').textContent = `Failed to load admin config: ${error.message}`;
  });
