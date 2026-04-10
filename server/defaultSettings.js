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
    refreshIntervalMs: 10000,
    scoreboardPollMs: 10000,
    tdScanIntervalMs: 10000,
    maxRetryDelayMs: 300000,
    retryJitterPct: 0.15,
    tdDedupWindowMs: 90000,
    adaptivePolling: {
      enabled: true,
      liveMs: 10000,
      mixedMs: 20000,
      idleMs: 45000
    },
    circuitBreaker: {
      enabled: true,
      failureThreshold: 4,
      cooldownMs: 60000,
      rateLimitCooldownMs: 120000
    },
    history: {
      enabled: true,
      retentionDays: 14
    },
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
    showScoreDelta: true,
    highlightClosest: true,
    highlightUpset: true,
    gameOfWeekMatchupId: '',
    soundHookUrl: '',
    themePack: 'neon-grid'
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
  },
  security: {
    adminApiKey: '',
    reducedAnimations: false,
    useOsKeychain: false
  },
  audio: {
    enabled: false,
    endpointUrl: '',
    minDispatchIntervalMs: 1200,
    maxQueueSize: 50
  },
  obs: {
    enabled: false,
    wsUrl: 'ws://127.0.0.1:4455',
    password: '',
    sceneCooldownMs: 7000,
    scenes: {
      touchdown: '',
      upset: '',
      gameOfWeek: '',
      default: ''
    }
  }
};

module.exports = {
  DEFAULT_SETTINGS
};
