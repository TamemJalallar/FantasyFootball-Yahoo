const DEFAULT_SETTINGS = {
  league: {
    leagueId: '',
    gameKey: '',
    season: new Date().getFullYear(),
    week: 'current',
    teamNameOverrides: {}
  },
  yahoo: {
    clientId: '',
    clientSecret: '',
    redirectUri: '',
    scope: 'fspt-r'
  },
  data: {
    refreshIntervalMs: 45000,
    maxRetryDelayMs: 300000,
    useCacheOnFailure: true,
    mockMode: true
  },
  overlay: {
    mode: 'carousel',
    rotationIntervalMs: 9000,
    layout: 'full',
    twoMatchupLayout: false,
    scenePreset: 'centered-card',
    showProjections: true,
    showRecords: true,
    showLogos: true,
    showTicker: true,
    showTdAlerts: true,
    tdAlertDurationMs: 8000,
    highlightClosest: true,
    highlightUpset: true,
    gameOfWeekMatchupId: '',
    soundHookUrl: ''
  },
  theme: {
    fontScale: 1,
    darkMode: true,
    compact: false,
    primary: '#13f1b7',
    secondary: '#3d5cff',
    background: 'rgba(8, 12, 24, 0.72)',
    text: '#f6f8ff',
    mutedText: '#aab3ca'
  },
  dev: {
    showUpdatedIndicator: true,
    verboseLogs: false
  }
};

module.exports = {
  DEFAULT_SETTINGS
};
