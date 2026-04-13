const crypto = require('node:crypto');
const {
  normalizeYahooMatchups,
  normalizeEspnMatchups,
  normalizeSleeperMatchups
} = require('./normalizer');
const { createMockMatchups } = require('./mockData');
const { readCache, writeCache } = require('./cacheStore');
const { loadTdState, saveTdState } = require('./tdStateStore');
const { toArray, toNumber, safeString } = require('./utils');
const { resolveProvider, fetchByProvider } = require('./providerRegistry');
const { dispatchIntegrations } = require('./integrations');

const BENCH_POSITIONS = new Set(['BN', 'IR', 'IR+', 'NA']);
const FALLBACK_TD_STATS = {
  '5': 'Passing TD',
  '6': 'Rushing TD',
  '7': 'Receiving TD',
  '8': 'Return TD'
};
const DEFAULT_GAME_DAYS = ['thu', 'sun', 'mon'];

function payloadHash(payload) {
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function normalizeDayToken(day) {
  return String(day || '').trim().slice(0, 3).toLowerCase();
}

function getScheduleParts(scheduleAware, now = new Date()) {
  const requestedTimezone = safeString(scheduleAware?.timezone || 'America/New_York', 'America/New_York');
  const format = (timezone) => new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    hour12: false
  }).formatToParts(now);

  let timezone = requestedTimezone;
  let fallback = false;
  let parts;

  try {
    parts = format(timezone);
  } catch {
    timezone = 'UTC';
    fallback = true;
    parts = format(timezone);
  }

  const weekday = normalizeDayToken(parts.find((part) => part.type === 'weekday')?.value);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);

  return {
    timezone,
    fallback,
    weekday,
    hour: Number.isFinite(hour) ? hour : 0
  };
}

function isHourInWindow(hour, startHour, endHour) {
  if (startHour === endHour) {
    return true;
  }
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  return hour >= startHour || hour < endHour;
}

function computeScheduleWindowState(scheduleAware = {}, now = new Date()) {
  const enabled = Boolean(scheduleAware?.enabled);
  if (!enabled) {
    return {
      enabled: false,
      active: false,
      timezone: safeString(scheduleAware?.timezone || 'America/New_York', 'America/New_York'),
      weekday: null,
      hour: null,
      isGameDay: false,
      inWindow: false,
      gameDays: DEFAULT_GAME_DAYS
    };
  }

  const gameDays = (Array.isArray(scheduleAware.gameDays) ? scheduleAware.gameDays : DEFAULT_GAME_DAYS)
    .map(normalizeDayToken)
    .filter(Boolean);
  const uniqueGameDays = [...new Set(gameDays.length ? gameDays : DEFAULT_GAME_DAYS)];
  const startHour = Math.max(0, Math.min(23, Number(scheduleAware.gameWindowStartHour ?? 9)));
  const endHour = Math.max(1, Math.min(24, Number(scheduleAware.gameWindowEndHour ?? 24)));

  const parts = getScheduleParts(scheduleAware, now);
  const isGameDay = uniqueGameDays.includes(parts.weekday);
  const inWindow = isHourInWindow(parts.hour, startHour, endHour);

  return {
    enabled: true,
    active: isGameDay && inWindow,
    timezone: parts.timezone,
    timezoneFallback: parts.fallback,
    weekday: parts.weekday,
    hour: parts.hour,
    isGameDay,
    inWindow,
    gameDays: uniqueGameDays,
    gameWindowStartHour: startHour,
    gameWindowEndHour: endHour
  };
}

function getIn(obj, path, fallback = null) {
  let current = obj;
  for (const segment of path) {
    if (current === null || current === undefined) {
      return fallback;
    }
    current = current[segment];
  }
  return current ?? fallback;
}

function isTouchdownLabel(label) {
  const value = safeString(label, '').toLowerCase();
  return value.includes('touchdown') || /\btd\b/.test(value);
}

function uniqueTeamKeys(payload, { liveOnly = false } = {}) {
  const keys = new Set();

  for (const matchup of payload?.matchups || []) {
    if (liveOnly && !matchup?.isLive) {
      continue;
    }

    if (matchup?.teamA?.key) {
      keys.add(matchup.teamA.key);
    }
    if (matchup?.teamB?.key) {
      keys.add(matchup.teamB.key);
    }
  }

  return [...keys];
}

function buildTeamMetaByKey(payload) {
  const map = {};

  for (const matchup of payload?.matchups || []) {
    if (matchup?.teamA?.key) {
      map[matchup.teamA.key] = {
        matchupId: matchup.id,
        teamName: matchup.teamA.name,
        manager: matchup.teamA.manager
      };
    }

    if (matchup?.teamB?.key) {
      map[matchup.teamB.key] = {
        matchupId: matchup.id,
        teamName: matchup.teamB.name,
        manager: matchup.teamB.manager
      };
    }
  }

  return map;
}

function detectScoreChanges(previousPayload, nextPayload) {
  if (!previousPayload?.matchups?.length || !nextPayload?.matchups?.length) {
    return [];
  }

  const before = new Map();
  for (const matchup of previousPayload.matchups) {
    before.set(matchup.id, matchup);
  }

  const changes = [];

  for (const current of nextPayload.matchups) {
    const prev = before.get(current.id);
    if (!prev) {
      continue;
    }

    const teamAChanged = Number(prev.teamA?.points ?? 0) !== Number(current.teamA?.points ?? 0);
    const teamBChanged = Number(prev.teamB?.points ?? 0) !== Number(current.teamB?.points ?? 0);

    if (!teamAChanged && !teamBChanged) {
      continue;
    }

    changes.push({
      matchupId: current.id,
      teamA: {
        from: prev.teamA?.points,
        to: current.teamA?.points,
        key: current.teamA?.key
      },
      teamB: {
        from: prev.teamB?.points,
        to: current.teamB?.points,
        key: current.teamB?.key
      }
    });
  }

  return changes;
}

function leaderKey(matchup) {
  const a = Number(matchup?.teamA?.points ?? 0);
  const b = Number(matchup?.teamB?.points ?? 0);
  if (a === b) {
    return null;
  }
  return a > b ? matchup?.teamA?.key : matchup?.teamB?.key;
}

function detectLeadChanges(previousPayload, nextPayload) {
  if (!previousPayload?.matchups?.length || !nextPayload?.matchups?.length) {
    return [];
  }

  const before = new Map(previousPayload.matchups.map((item) => [item.id, item]));
  const changes = [];

  for (const current of nextPayload.matchups) {
    const prev = before.get(current.id);
    if (!prev) {
      continue;
    }

    const prevLeader = leaderKey(prev);
    const nextLeader = leaderKey(current);

    if (prevLeader !== nextLeader && nextLeader) {
      changes.push({
        matchupId: current.id,
        previousLeaderKey: prevLeader,
        newLeaderKey: nextLeader,
        status: current.status
      });
    }
  }

  return changes;
}

function detectUpsetStarts(previousPayload, nextPayload) {
  if (!nextPayload?.matchups?.length) {
    return [];
  }

  const before = new Map((previousPayload?.matchups || []).map((item) => [item.id, item]));

  return nextPayload.matchups
    .filter((matchup) => matchup.isUpset)
    .filter((matchup) => !before.get(matchup.id)?.isUpset)
    .map((matchup) => ({
      matchupId: matchup.id,
      teamA: matchup.teamA,
      teamB: matchup.teamB,
      status: matchup.status
    }));
}

function detectFinalized(previousPayload, nextPayload) {
  if (!nextPayload?.matchups?.length) {
    return [];
  }

  const before = new Map((previousPayload?.matchups || []).map((item) => [item.id, item]));

  return nextPayload.matchups
    .filter((matchup) => matchup.isFinal)
    .filter((matchup) => !before.get(matchup.id)?.isFinal)
    .map((matchup) => ({
      matchupId: matchup.id,
      winnerKey: matchup.winnerKey,
      teamA: matchup.teamA,
      teamB: matchup.teamB
    }));
}

function applyOverlaySettings(payload, settings) {
  const clone = JSON.parse(JSON.stringify(payload));

  if (!settings.overlay.highlightClosest) {
    clone.matchups.forEach((matchup) => {
      delete matchup.isClosest;
    });
  }

  if (!settings.overlay.highlightUpset) {
    clone.matchups.forEach((matchup) => {
      delete matchup.isUpset;
    });
  }

  if (settings.overlay.gameOfWeekMatchupId) {
    clone.matchups.forEach((matchup) => {
      matchup.isGameOfWeek = matchup.id === settings.overlay.gameOfWeekMatchupId;
    });
  }

  clone.matchups.sort((a, b) => {
    if (a.isGameOfWeek && !b.isGameOfWeek) {
      return -1;
    }
    if (!a.isGameOfWeek && b.isGameOfWeek) {
      return 1;
    }
    return 0;
  });

  return clone;
}

function serializeTdState({ leagueKey, week, state }) {
  return {
    leagueKey,
    week,
    savedAt: new Date().toISOString(),
    players: [...state.entries()].map(([key, value]) => ({ key, value }))
  };
}

function deserializeTdState(payload) {
  if (!payload || !Array.isArray(payload.players)) {
    return {
      leagueKey: null,
      week: null,
      state: new Map()
    };
  }

  const state = new Map();
  for (const row of payload.players) {
    if (row?.key && row?.value) {
      state.set(row.key, row.value);
    }
  }

  return {
    leagueKey: payload.leagueKey || null,
    week: Number(payload.week || 0) || null,
    state
  };
}

function computeTdEventsFromStates({ previousState, currentState, teamMeta, tdStatLabels, now = new Date() }) {
  const tdEvents = [];
  const nowIso = now.toISOString();
  const nowMs = now.getTime();

  for (const [snapshotKey, current] of currentState.entries()) {
    const previous = previousState.get(snapshotKey);
    const prevTotal = previous?.totalTouchdowns || 0;

    if (current.totalTouchdowns <= prevTotal) {
      continue;
    }

    const changedTypes = [];
    for (const [statId, currentValue] of Object.entries(current.tdBreakdown)) {
      const previousValue = previous?.tdBreakdown?.[statId] || 0;
      if (currentValue > previousValue) {
        changedTypes.push(tdStatLabels[statId] || `Stat ${statId}`);
      }
    }

    const team = teamMeta[current.teamKey] || {};
    const playerPointDelta = Number((Number(current.points || 0) - Number(previous?.points || 0)).toFixed(2));

    tdEvents.push({
      id: `${nowMs}-${current.playerKey}`,
      ts: nowIso,
      playerKey: current.playerKey,
      playerName: current.playerName,
      fantasyTeamKey: current.teamKey,
      fantasyTeamName: team.teamName || 'Fantasy Team',
      manager: team.manager || '',
      matchupId: team.matchupId || null,
      touchdownDelta: Number((current.totalTouchdowns - prevTotal).toFixed(2)),
      totalTouchdowns: current.totalTouchdowns,
      playerPoints: current.points,
      playerPointDelta,
      tdTypes: changedTypes.length ? changedTypes : current.tdTypes
    });
  }

  return tdEvents;
}

function computePlayerScoreChangesFromStates({ previousState, currentState, teamMeta, now = new Date() }) {
  const rows = [];
  const nowIso = now.toISOString();

  for (const [snapshotKey, current] of currentState.entries()) {
    const previous = previousState.get(snapshotKey);
    const previousPoints = Number(previous?.points || 0);
    const currentPoints = Number(current?.points || 0);
    const delta = Number((currentPoints - previousPoints).toFixed(2));
    if (!delta) {
      continue;
    }

    const team = teamMeta[current.teamKey] || {};
    rows.push({
      ts: nowIso,
      playerKey: current.playerKey,
      playerName: current.playerName,
      fantasyTeamKey: current.teamKey,
      fantasyTeamName: team.teamName || 'Fantasy Team',
      matchupId: team.matchupId || null,
      from: previousPoints,
      to: currentPoints,
      delta
    });
  }

  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return rows;
}

class DataService {
  constructor({
    logger,
    getSettings,
    yahooApi,
    espnApi = null,
    sleeperApi = null,
    authService,
    sseHub,
    metrics = null,
    historyStore = null,
    audioQueue = null,
    obsController = null,
    eventLogStore = null,
    logoCache = null
  }) {
    this.logger = logger;
    this.getSettings = getSettings;
    this.yahooApi = yahooApi;
    this.espnApi = espnApi;
    this.sleeperApi = sleeperApi;
    this.authService = authService;
    this.sseHub = sseHub;
    this.metrics = metrics;
    this.historyStore = historyStore;
    this.audioQueue = audioQueue;
    this.obsController = obsController;
    this.eventLogStore = eventLogStore;
    this.logoCache = logoCache;

    this.currentPayload = null;
    this.currentHash = null;
    this.lastSuccessAt = null;
    this.lastError = null;

    this.scoreFailureCount = 0;
    this.tdFailureCount = 0;
    this.running = false;
    this.scoreTimeoutRef = null;
    this.tdTimeoutRef = null;

    this.touchdownStatCache = new Map();
    this.playerTdState = new Map();
    this.playerTdLeagueKey = null;
    this.playerTdWeek = null;
    this.recentTdFingerprint = new Map();

    this.lastScoreboardPollAt = null;
    this.lastTdScanAt = null;

    this.circuit = {
      openUntil: null,
      reason: null,
      tripCount: 0,
      skippedPolls: 0
    };

    this.pollRecords = [];
    this.recentLeadChanges = [];
    this.recentUpsetEvents = [];
    this.recentFinalEvents = [];
    this.recentTdEvents = [];
    this.recentPlayerScoreChanges = [];
    this.lastScoreChanges = [];
    this.scheduleWindowState = null;
    this.nextScoreboardDelayMs = null;
    this.nextTdDelayMs = null;
    this.lastSettings = null;
    this.lastProvider = 'unknown';
    this.controlState = {
      rotationPaused: false,
      pinnedMatchupId: '',
      forceStoryAt: null
    };

    this.replayMode = {
      active: false,
      timer: null,
      startedAt: null,
      snapshots: [],
      index: 0,
      intervalMs: 2500,
      originalWasRunning: false
    };
  }

  async init() {
    this.historyStore?.init();
    await this.eventLogStore?.init();
    await this.logoCache?.init();

    const cached = await readCache();
    if (cached) {
      this.logoCache?.rewritePayloadLogos(cached);
      this.currentPayload = cached;
      this.currentHash = payloadHash(cached);
      this.lastSuccessAt = cached.updatedAt || null;
      this.logger.info('Loaded cached matchup payload');
      this.logoCache?.warmFromPayload(cached).catch(() => {});
      await this.logEvent({
        kind: 'startup',
        type: 'cache_loaded',
        message: 'Loaded cached matchup payload at startup.',
        data: {
          updatedAt: this.lastSuccessAt
        }
      });
    }

    const tdStatePayload = await loadTdState();
    const tdState = deserializeTdState(tdStatePayload);
    this.playerTdLeagueKey = tdState.leagueKey;
    this.playerTdWeek = tdState.week;
    this.playerTdState = tdState.state;
  }

  async logEvent(event = {}) {
    await this.eventLogStore?.append(event);
  }

  async persistTdState() {
    await saveTdState(
      serializeTdState({
        leagueKey: this.playerTdLeagueKey,
        week: this.playerTdWeek,
        state: this.playerTdState
      })
    );
  }

  recordPoll(record) {
    this.pollRecords.unshift({
      ts: new Date().toISOString(),
      ...record
    });

    if (this.pollRecords.length > 200) {
      this.pollRecords = this.pollRecords.slice(0, 200);
    }
  }

  pushRecent(listName, rows, limit = 60) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return;
    }

    this[listName] = [...rows, ...this[listName]].slice(0, limit);
  }

  isCircuitOpen() {
    if (!this.circuit.openUntil) {
      return false;
    }

    return Date.now() < new Date(this.circuit.openUntil).getTime();
  }

  openCircuit({ reason, cooldownMs }) {
    const openUntil = new Date(Date.now() + Math.max(10000, Number(cooldownMs) || 60000)).toISOString();
    this.circuit.openUntil = openUntil;
    this.circuit.reason = reason;
    this.circuit.tripCount += 1;
    this.logger.warn('Circuit breaker opened', { openUntil, reason, tripCount: this.circuit.tripCount });
    this.metrics?.inc('circuit_breaker_open_total');
  }

  closeCircuit() {
    this.circuit.openUntil = null;
    this.circuit.reason = null;
  }

  getDegradedMode() {
    return this.isCircuitOpen() || Boolean(this.lastError);
  }

  buildStatus() {
    return {
      running: this.running,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      scoreboardFailureCount: this.scoreFailureCount,
      tdFailureCount: this.tdFailureCount,
      hasData: Boolean(this.currentPayload),
      mode: this.currentPayload?.league?.source || 'unknown',
      provider: this.lastProvider,
      lastScoreboardPollAt: this.lastScoreboardPollAt,
      lastTdScanAt: this.lastTdScanAt,
      degradedMode: this.getDegradedMode(),
      circuitOpenUntil: this.circuit.openUntil,
      circuitReason: this.circuit.reason,
      circuitTripCount: this.circuit.tripCount,
      skippedPolls: this.circuit.skippedPolls,
      controlState: this.controlState,
      scheduleWindow: this.scheduleWindowState,
      nextScoreboardDelayMs: this.nextScoreboardDelayMs,
      nextTdDelayMs: this.nextTdDelayMs,
      replayMode: {
        active: this.replayMode.active,
        startedAt: this.replayMode.startedAt,
        snapshots: this.replayMode.snapshots.length,
        index: this.replayMode.index,
        intervalMs: this.replayMode.intervalMs
      }
    };
  }

  getSnapshot() {
    return {
      payload: this.currentPayload,
      status: this.buildStatus()
    };
  }

  getDiagnostics({ hours = 24 } = {}) {
    const h = Math.max(1, Math.min(168, Number(hours) || 24));
    const yahooBudget = this.yahooApi?.getBudgetTelemetry ? this.yahooApi.getBudgetTelemetry({ data: { rateLimitBudget: (this.lastSettings?.data?.rateLimitBudget || {}) } }) : null;
    return {
      status: this.buildStatus(),
      metrics: this.metrics?.snapshot() || {},
      yahooBudget,
      pollRecords: this.pollRecords.slice(0, 120),
      recentLeadChanges: this.recentLeadChanges.slice(0, 40),
      recentUpsetEvents: this.recentUpsetEvents.slice(0, 40),
      recentFinalEvents: this.recentFinalEvents.slice(0, 40),
      recentTdEvents: this.recentTdEvents.slice(0, 40),
      recentPlayerScoreChanges: this.recentPlayerScoreChanges.slice(0, 40),
      lastScoreChanges: this.lastScoreChanges.slice(0, 40),
      history: {
        snapshots: this.historyStore?.recentSnapshots({ hours: h, limit: 30 }) || [],
        scoreEvents: this.historyStore?.recentScoreEvents({ hours: h, limit: 100 }) || []
      },
      replayMode: {
        active: this.replayMode.active,
        startedAt: this.replayMode.startedAt,
        snapshots: this.replayMode.snapshots.length,
        index: this.replayMode.index,
        intervalMs: this.replayMode.intervalMs
      }
    };
  }

  async getLeagueKey(settings) {
    if (settings.league.gameKey) {
      return `${settings.league.gameKey}.l.${settings.league.leagueId}`;
    }

    if (settings.league.season) {
      const gameKey = await this.yahooApi.fetchGameKeyForSeason(settings.league.season);
      if (!gameKey) {
        throw new Error('Unable to resolve Yahoo game_key from season. Enter game_key manually in admin.');
      }
      return `${gameKey}.l.${settings.league.leagueId}`;
    }

    throw new Error('league.gameKey is required (or provide season so game key can be resolved).');
  }

  async fetchLivePayload(settings) {
    const leagueId = settings?.league?.leagueId;
    if (!leagueId) {
      throw new Error('league_id is missing. Set it in the admin page.');
    }

    const leagueKey = await this.getLeagueKey(settings);

    const [scoreboardPayload, standingsPayload] = await Promise.all([
      this.yahooApi.fetchScoreboard(leagueKey, settings.league.week),
      this.yahooApi.fetchStandings(leagueKey)
    ]);

    return normalizeYahooMatchups({
      scoreboardPayload,
      standingsPayload,
      settings
    });
  }

  getProviderWeek(providerSettings = {}, fallbackWeek = 'current') {
    const raw = providerSettings.week ?? fallbackWeek ?? 'current';
    if (raw === 'current') {
      return 'current';
    }

    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < 1) {
      return 'current';
    }

    return numeric;
  }

  async fetchEspnPayload(settings) {
    if (!this.espnApi) {
      throw new Error('ESPN provider is unavailable: espnApi client is not initialized.');
    }

    const provider = settings.espn || {};
    const leagueId = String(provider.leagueId || settings?.league?.leagueId || '').trim();
    if (!leagueId) {
      throw new Error('ESPN league_id is missing. Set espn.leagueId (or league.leagueId) in admin.');
    }

    const season = Number(provider.season || settings?.league?.season || new Date().getFullYear());
    const week = this.getProviderWeek(provider, settings?.league?.week);

    const leaguePayload = await this.espnApi.fetchLeague({
      leagueId,
      season,
      views: ['mMatchup', 'mTeam', 'mSettings', 'mStatus'],
      swid: provider.swid || '',
      espnS2: provider.espnS2 || ''
    });

    return normalizeEspnMatchups({
      leaguePayload,
      settings: {
        ...settings,
        espn: {
          ...provider,
          leagueId,
          season,
          week
        }
      }
    });
  }

  async fetchSleeperPayload(settings) {
    if (!this.sleeperApi) {
      throw new Error('Sleeper provider is unavailable: sleeperApi client is not initialized.');
    }

    const provider = settings.sleeper || {};
    const leagueId = String(provider.leagueId || settings?.league?.leagueId || '').trim();
    if (!leagueId) {
      throw new Error('Sleeper league_id is missing. Set sleeper.leagueId (or league.leagueId) in admin.');
    }

    const season = Number(provider.season || settings?.league?.season || new Date().getFullYear());
    const requestedWeek = this.getProviderWeek(provider, settings?.league?.week);

    const [statePayload, leaguePayload, usersPayload, rostersPayload] = await Promise.all([
      this.sleeperApi.fetchState(),
      this.sleeperApi.fetchLeague(leagueId),
      this.sleeperApi.fetchUsers(leagueId),
      this.sleeperApi.fetchRosters(leagueId)
    ]);

    const resolvedWeek = requestedWeek === 'current'
      ? Number(statePayload?.week || 1)
      : Number(requestedWeek);

    const matchupsPayload = await this.sleeperApi.fetchMatchups(leagueId, resolvedWeek);

    return normalizeSleeperMatchups({
      leaguePayload,
      usersPayload,
      rostersPayload,
      matchupsPayload,
      statePayload,
      settings: {
        ...settings,
        sleeper: {
          ...provider,
          leagueId,
          season,
          week: resolvedWeek
        }
      }
    });
  }

  async fetchPayload(settings) {
    const provider = resolveProvider(settings);
    this.lastProvider = provider;

    return fetchByProvider({
      provider,
      fetchers: {
        mock: async () => createMockMatchups({
          week: settings.league.week === 'current' ? 1 : Number(settings.league.week || 1),
          pinnedMatchupId: settings.overlay.gameOfWeekMatchupId,
          seedOverride: settings.data.mockSeed || process.env.MOCK_SEED || null
        }),
        yahoo: async () => this.fetchLivePayload(settings),
        espn: async () => this.fetchEspnPayload(settings),
        sleeper: async () => this.fetchSleeperPayload(settings)
      }
    });
  }

  async resolveTouchdownStatConfig(leagueKey) {
    if (this.touchdownStatCache.has(leagueKey)) {
      return this.touchdownStatCache.get(leagueKey);
    }

    const settingsPayload = await this.yahooApi.fetchLeagueSettings(leagueKey);
    const statNodes = toArray(getIn(settingsPayload, ['fantasy_content', 'league', 'settings', 'stat_categories', 'stats', 'stat'], []));

    const tdStatIds = new Set();
    const tdStatLabels = {};

    for (const stat of statNodes) {
      const statId = safeString(stat?.stat_id, '');
      const label = safeString(stat?.display_name || stat?.name || stat?.abbr || '', '');

      if (!statId || !label) {
        continue;
      }

      if (isTouchdownLabel(label)) {
        tdStatIds.add(statId);
        tdStatLabels[statId] = label;
      }
    }

    if (tdStatIds.size === 0) {
      for (const [statId, label] of Object.entries(FALLBACK_TD_STATS)) {
        tdStatIds.add(statId);
        tdStatLabels[statId] = label;
      }
    }

    const config = { tdStatIds, tdStatLabels };
    this.touchdownStatCache.set(leagueKey, config);
    return config;
  }

  async fetchTeamTouchdownSnapshot(teamKey, week, tdStatIds, tdStatLabels) {
    const payload = await this.yahooApi.fetchTeamRosterWithStats(teamKey, week);
    const players = toArray(getIn(payload, ['fantasy_content', 'team', 'roster', 'players', 'player'], []));
    const snapshots = [];

    for (const player of players) {
      const selectedPos = safeString(getIn(player, ['selected_position', 'position'], ''), '').toUpperCase();
      if (BENCH_POSITIONS.has(selectedPos)) {
        continue;
      }

      const playerKey = safeString(player?.player_key || player?.player_id, '');
      if (!playerKey) {
        continue;
      }

      const first = safeString(getIn(player, ['name', 'first'], ''), '');
      const last = safeString(getIn(player, ['name', 'last'], ''), '');
      const fullFromParts = `${first} ${last}`.trim();
      const playerName = safeString(getIn(player, ['name', 'full'], fullFromParts || playerKey), fullFromParts || playerKey);

      const statNodes = toArray(getIn(player, ['player_stats', 'stats', 'stat'], []));
      const tdBreakdown = {};
      let totalTouchdowns = 0;

      for (const stat of statNodes) {
        const statId = safeString(stat?.stat_id, '');
        if (!statId || !tdStatIds.has(statId)) {
          continue;
        }

        const value = toNumber(stat?.value, 0) || 0;
        if (value > 0) {
          tdBreakdown[statId] = value;
          totalTouchdowns += value;
        }
      }

      snapshots.push({
        playerKey,
        playerName,
        teamKey,
        position: selectedPos || 'UNK',
        points: toNumber(getIn(player, ['player_points', 'total'], 0), 0) || 0,
        totalTouchdowns,
        tdBreakdown,
        tdTypes: Object.keys(tdBreakdown).map((statId) => tdStatLabels[statId] || `Stat ${statId}`)
      });
    }

    return snapshots;
  }

  dedupeTdEvents(tdEvents, windowMs) {
    const now = Date.now();
    const dedupeWindow = Math.max(10000, Number(windowMs) || 90000);

    for (const [fingerprint, seenAt] of this.recentTdFingerprint.entries()) {
      if (now - seenAt > dedupeWindow) {
        this.recentTdFingerprint.delete(fingerprint);
      }
    }

    const next = [];

    for (const event of tdEvents) {
      const fingerprint = `${event.playerKey}:${event.totalTouchdowns}`;
      const seenAt = this.recentTdFingerprint.get(fingerprint);

      if (seenAt && now - seenAt <= dedupeWindow) {
        continue;
      }

      this.recentTdFingerprint.set(fingerprint, now);
      next.push(event);
    }

    return next;
  }

  async detectTouchdownEvents(payload, settings) {
    if (!settings.overlay.showTdAlerts) {
      return {
        tdEvents: [],
        playerScoreChanges: []
      };
    }

    if (payload?.league?.source !== 'yahoo') {
      this.playerTdState.clear();
      this.playerTdLeagueKey = null;
      this.playerTdWeek = null;
      await this.persistTdState();
      return {
        tdEvents: [],
        playerScoreChanges: []
      };
    }

    const liveMatchups = (payload?.matchups || []).filter((matchup) => matchup.isLive);
    if (!liveMatchups.length) {
      return {
        tdEvents: [],
        playerScoreChanges: []
      };
    }

    const leagueKey = safeString(payload?.league?.leagueKey, '');
    const week = Number(payload?.league?.week || 0);

    if (!leagueKey || !week) {
      return {
        tdEvents: [],
        playerScoreChanges: []
      };
    }

    const { tdStatIds, tdStatLabels } = await this.resolveTouchdownStatConfig(leagueKey);
    if (!tdStatIds.size) {
      return {
        tdEvents: [],
        playerScoreChanges: []
      };
    }

    const teamKeys = uniqueTeamKeys(payload, { liveOnly: true });

    const snapshotsByTeam = await Promise.all(teamKeys.map(async (teamKey) => {
      try {
        return await this.fetchTeamTouchdownSnapshot(teamKey, week, tdStatIds, tdStatLabels);
      } catch (error) {
        this.logger.warn('Failed fetching team roster stats for TD tracking', { teamKey, error: error.message });
        return [];
      }
    }));

    const currentState = new Map();
    for (const snapshots of snapshotsByTeam) {
      for (const snapshot of snapshots) {
        currentState.set(`${snapshot.teamKey}|${snapshot.playerKey}`, snapshot);
      }
    }

    const hasContextChanged = this.playerTdLeagueKey !== leagueKey || this.playerTdWeek !== week || this.playerTdState.size === 0;

    if (hasContextChanged) {
      this.playerTdLeagueKey = leagueKey;
      this.playerTdWeek = week;
      this.playerTdState = currentState;
      await this.persistTdState();
      return {
        tdEvents: [],
        playerScoreChanges: []
      };
    }

    const playerScoreChanges = computePlayerScoreChangesFromStates({
      previousState: this.playerTdState,
      currentState,
      teamMeta: buildTeamMetaByKey(payload),
      now: new Date()
    });

    const tdEvents = computeTdEventsFromStates({
      previousState: this.playerTdState,
      currentState,
      teamMeta: buildTeamMetaByKey(payload),
      tdStatLabels,
      now: new Date()
    });

    this.playerTdState = currentState;
    this.playerTdLeagueKey = leagueKey;
    this.playerTdWeek = week;
    await this.persistTdState();

    return {
      tdEvents: this.dedupeTdEvents(tdEvents, settings.data?.tdDedupWindowMs),
      playerScoreChanges
    };
  }

  async dispatchExternalHooks({
    settings,
    payload,
    scoreChanges = [],
    tdEvents = [],
    leadChanges = [],
    upsetEvents = [],
    finalEvents = [],
    playerScoreChanges = []
  }) {
    const hookUrl = settings?.overlay?.soundHookUrl;
    if (!hookUrl && !settings?.integrations?.enabled) {
      return;
    }

    if (hookUrl && (scoreChanges.length || tdEvents.length || leadChanges.length || upsetEvents.length || finalEvents.length)) {
      try {
        await fetch(hookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            type: 'overlay_update',
            scoreChanges,
            tdEvents,
            leadChanges,
            upsetEvents,
            finalEvents,
            playerScoreChanges,
            ts: new Date().toISOString()
          })
        });
      } catch (error) {
        this.logger.warn('Score hook failed', { error: error.message });
      }
    }

    await dispatchIntegrations({
      logger: this.logger,
      settings,
      payload,
      scoreChanges,
      tdEvents,
      leadChanges,
      upsetEvents,
      finalEvents
    });
  }

  queueAutomationEvents({ scoreChanges, tdEvents, leadChanges, upsetEvents, finalEvents, payload }) {
    for (const tdEvent of tdEvents) {
      this.audioQueue?.enqueue('touchdown', tdEvent);
    }

    for (const lead of leadChanges) {
      this.audioQueue?.enqueue('lead_change', lead);
    }

    for (const upset of upsetEvents) {
      this.audioQueue?.enqueue('upset', upset);
    }

    for (const finalEvent of finalEvents) {
      this.audioQueue?.enqueue('final', finalEvent);
    }

    if (tdEvents.length > 0) {
      this.obsController?.trigger('touchdown', { count: tdEvents.length, matchupId: tdEvents[0]?.matchupId });
      return;
    }

    if (upsetEvents.length > 0) {
      this.obsController?.trigger('upset', { count: upsetEvents.length, matchupId: upsetEvents[0]?.matchupId });
      return;
    }

    const gameOfWeekChange = scoreChanges.find((change) => {
      const matchup = payload?.matchups?.find((item) => item.id === change.matchupId);
      return Boolean(matchup?.isGameOfWeek);
    });

    if (gameOfWeekChange) {
      this.obsController?.trigger('game_of_week', { matchupId: gameOfWeekChange.matchupId });
    }
  }

  getScoreboardBaseMs(settings) {
    const adaptive = settings.data?.adaptivePolling || {};
    const fallback = Number(settings.data.scoreboardPollMs || settings.data.refreshIntervalMs || 10000);
    let base = fallback;

    if (adaptive.enabled && this.currentPayload?.matchups?.length) {
      const liveCount = this.currentPayload.matchups.filter((item) => item.isLive).length;
      const finalCount = this.currentPayload.matchups.filter((item) => item.isFinal).length;
      const upcomingCount = this.currentPayload.matchups.filter((item) => item.status === 'upcoming').length;

      if (liveCount > 0) {
        base = Number(adaptive.liveMs || fallback);
      } else if (finalCount > 0 && upcomingCount > 0) {
        base = Number(adaptive.mixedMs || fallback);
      } else {
        base = Number(adaptive.idleMs || fallback);
      }
    }

    return this.applyScheduleAwareDelay({
      kind: 'scoreboard',
      baseMs: base,
      settings
    });
  }

  getTdBaseMs(settings) {
    const adaptive = settings.data?.adaptivePolling || {};
    const fallback = Number(settings.data.tdScanIntervalMs || settings.data.refreshIntervalMs || 10000);
    let base = fallback;

    if (adaptive.enabled && this.currentPayload?.matchups?.length) {
      const liveCount = this.currentPayload.matchups.filter((item) => item.isLive).length;
      if (liveCount > 0) {
        base = Number(adaptive.liveMs || fallback);
      } else {
        base = Number(adaptive.idleMs || fallback);
      }
    }

    return this.applyScheduleAwareDelay({
      kind: 'td',
      baseMs: base,
      settings
    });
  }

  applyScheduleAwareDelay({ kind, baseMs, settings }) {
    const scheduleAware = settings.data?.scheduleAware || {};
    const scheduleWindow = computeScheduleWindowState(scheduleAware, new Date());
    const liveCount = this.currentPayload?.matchups?.filter((item) => item.isLive).length || 0;
    const offHoursMs = kind === 'td'
      ? Number(scheduleAware.offHoursTdMs || 60000)
      : Number(scheduleAware.offHoursScoreboardMs || 60000);

    let adjustedMs = Number(baseMs || 10000);
    let throttled = false;

    if (scheduleWindow.enabled && !scheduleWindow.active && liveCount === 0) {
      adjustedMs = Math.max(adjustedMs, offHoursMs);
      throttled = adjustedMs > baseMs;
    }

    this.scheduleWindowState = {
      ...scheduleWindow,
      kind,
      liveCount,
      throttled,
      offHoursMs
    };

    this.metrics?.set('schedule_window_active', scheduleWindow.active ? 1 : 0);
    this.metrics?.set('schedule_window_throttled', throttled ? 1 : 0);

    return adjustedMs;
  }

  applyJitter(delayMs, settings) {
    const jitterPct = Math.max(0, Math.min(0.5, Number(settings.data?.retryJitterPct || 0)));
    if (jitterPct <= 0) {
      return delayMs;
    }

    const jitter = (Math.random() * 2 - 1) * jitterPct;
    return Math.max(1000, Math.round(delayMs * (1 + jitter)));
  }

  getScoreboardDelayMs(settings) {
    const base = this.getScoreboardBaseMs(settings);
    const max = Number(settings.data.maxRetryDelayMs || 300000);

    let delay = base;
    if (this.scoreFailureCount > 0) {
      delay = Math.min(base * (2 ** this.scoreFailureCount), max);
    }

    if (this.isCircuitOpen()) {
      const remaining = new Date(this.circuit.openUntil).getTime() - Date.now();
      if (remaining > 0) {
        delay = Math.max(delay, remaining + 500);
      }
    }

    const withJitter = this.applyJitter(delay, settings);
    this.nextScoreboardDelayMs = withJitter;
    this.metrics?.set('scoreboard_effective_delay_ms', withJitter);
    return withJitter;
  }

  getTdDelayMs(settings) {
    const base = this.getTdBaseMs(settings);
    const max = Number(settings.data.maxRetryDelayMs || 300000);

    let delay = base;
    if (this.tdFailureCount > 0) {
      delay = Math.min(base * (2 ** this.tdFailureCount), max);
    }

    const withJitter = this.applyJitter(delay, settings);
    this.nextTdDelayMs = withJitter;
    this.metrics?.set('td_effective_delay_ms', withJitter);
    return withJitter;
  }

  async pollScoreboard({ forceBroadcast = false } = {}) {
    const settings = await this.getSettings();
    this.lastSettings = settings;
    const startedAt = Date.now();

    if (this.isCircuitOpen()) {
      this.circuit.skippedPolls += 1;
      this.lastScoreboardPollAt = new Date().toISOString();
      this.metrics?.inc('scoreboard_polls_skipped_total');
      this.metrics?.set('circuit_open', 1);
      this.recordPoll({ kind: 'scoreboard', success: false, skipped: true, reason: 'circuit_open' });
      this.sseHub.broadcast('status', this.buildStatus());
      return;
    }

    this.metrics?.set('circuit_open', 0);

    try {
      const previousPayload = this.currentPayload;
      const rawPayload = await this.fetchPayload(settings);
      const payload = applyOverlaySettings(rawPayload, settings);
      this.logoCache?.rewritePayloadLogos(payload);
      const nextHash = payloadHash(payload);

      const scoreChanges = detectScoreChanges(previousPayload, payload);
      const leadChanges = detectLeadChanges(previousPayload, payload);
      const upsetEvents = detectUpsetStarts(previousPayload, payload);
      const finalEvents = detectFinalized(previousPayload, payload);

      const changed = forceBroadcast || nextHash !== this.currentHash || scoreChanges.length > 0 || leadChanges.length > 0 || upsetEvents.length > 0 || finalEvents.length > 0;

      this.currentPayload = payload;
      this.currentHash = nextHash;
      this.lastSuccessAt = payload.updatedAt || new Date().toISOString();
      this.lastError = null;
      this.scoreFailureCount = 0;
      this.lastScoreboardPollAt = new Date().toISOString();
      this.closeCircuit();

      await writeCache(payload);
      this.logoCache?.warmFromPayload(payload).catch((error) => {
        this.logger.warn('Logo cache warm task failed', { error: error.message });
      });
      await this.dispatchExternalHooks({
        settings,
        payload,
        scoreChanges,
        tdEvents: [],
        leadChanges,
        upsetEvents,
        finalEvents,
        playerScoreChanges: []
      });

      if (settings.data?.history?.enabled) {
        this.historyStore?.saveSnapshot({ payload, hash: nextHash, scoreChanges, leadChanges });
        this.historyStore?.prune(settings.data?.history?.retentionDays || 14);
      }

      this.lastScoreChanges = scoreChanges.slice(0, 60);
      this.pushRecent('recentLeadChanges', leadChanges, 80);
      this.pushRecent('recentUpsetEvents', upsetEvents, 80);
      this.pushRecent('recentFinalEvents', finalEvents, 80);

      this.queueAutomationEvents({
        scoreChanges,
        tdEvents: [],
        leadChanges,
        upsetEvents,
        finalEvents,
        payload
      });

      if (changed) {
        this.sseHub.broadcast('update', {
          payload,
          scoreChanges,
          playerScoreChanges: [],
          tdEvents: [],
          leadChanges,
          upsetEvents,
          finalEvents,
          status: this.buildStatus()
        });
      } else {
        this.sseHub.broadcast('status', this.buildStatus());
      }

      await this.logEvent({
        kind: 'scoreboard',
        type: changed ? 'payload_updated' : 'payload_polled',
        message: changed
          ? `Scoreboard update processed (${scoreChanges.length} score changes).`
          : 'Scoreboard poll completed with no visible changes.',
        data: {
          provider: this.lastProvider,
          changed,
          scoreChanges: scoreChanges.length,
          leadChanges: leadChanges.length,
          upsetEvents: upsetEvents.length,
          finalEvents: finalEvents.length
        }
      });

      this.metrics?.inc('scoreboard_polls_total');
      this.metrics?.set('scoreboard_failure_count', this.scoreFailureCount);
      this.metrics?.set('overlay_has_data', this.currentPayload ? 1 : 0);
      this.metrics?.set('scoreboard_last_duration_ms', Date.now() - startedAt);
      const budget = this.yahooApi?.getBudgetTelemetry ? this.yahooApi.getBudgetTelemetry(settings) : null;
      if (budget) {
        this.metrics?.set('yahoo_rate_budget_usage_pct', budget.usagePct * 100);
        this.metrics?.set('yahoo_rate_budget_warning', budget.warning ? 1 : 0);
      }
      this.recordPoll({
        kind: 'scoreboard',
        success: true,
        durationMs: Date.now() - startedAt,
        changed,
        scoreChanges: scoreChanges.length,
        leadChanges: leadChanges.length,
        upsetEvents: upsetEvents.length,
        finalEvents: finalEvents.length
      });
    } catch (error) {
      this.scoreFailureCount += 1;
      this.lastError = {
        message: error.message,
        at: new Date().toISOString(),
        phase: 'scoreboard'
      };

      const circuitEnabled = Boolean(settings.data?.circuitBreaker?.enabled);
      const threshold = Number(settings.data?.circuitBreaker?.failureThreshold || 4);
      const rateLimitCooldown = Number(settings.data?.circuitBreaker?.rateLimitCooldownMs || 120000);
      const normalCooldown = Number(settings.data?.circuitBreaker?.cooldownMs || 60000);

      if (circuitEnabled && (error.isRateLimit || this.scoreFailureCount >= threshold)) {
        const cooldown = error.retryAfterMs || (error.isRateLimit ? rateLimitCooldown : normalCooldown);
        this.openCircuit({
          reason: error.isRateLimit ? 'rate_limit' : 'repeated_failures',
          cooldownMs: cooldown
        });
      }

      this.metrics?.inc('scoreboard_poll_failures_total');
      this.metrics?.set('scoreboard_failure_count', this.scoreFailureCount);
      this.metrics?.set('circuit_open', this.isCircuitOpen() ? 1 : 0);

      this.recordPoll({
        kind: 'scoreboard',
        success: false,
        durationMs: Date.now() - startedAt,
        error: error.message
      });

      this.sseHub.broadcast('status', this.buildStatus());

      this.logger.error('Scoreboard poll failed', {
        error: error.message,
        failures: this.scoreFailureCount,
        circuitOpen: this.isCircuitOpen()
      });

      await this.logEvent({
        kind: 'scoreboard',
        type: 'poll_failed',
        severity: 'error',
        message: `Scoreboard poll failed: ${error.message}`,
        data: {
          failures: this.scoreFailureCount,
          circuitOpen: this.isCircuitOpen()
        }
      });

      if (!this.currentPayload) {
        const cached = await readCache();
        if (cached) {
          this.currentPayload = cached;
          this.currentHash = payloadHash(cached);
          this.lastProvider = 'cache';
          this.logger.warn('Fallback to cached payload after scoreboard failure');
          this.sseHub.broadcast('update', {
            payload: this.currentPayload,
            scoreChanges: [],
            playerScoreChanges: [],
            tdEvents: [],
            leadChanges: [],
            upsetEvents: [],
            finalEvents: [],
            status: this.buildStatus()
          });
          await this.logEvent({
            kind: 'fallback',
            type: 'cache_fallback',
            severity: 'warn',
            message: 'Switched to cached payload after scoreboard failure.',
            data: {
              provider: this.lastProvider
            }
          });
          return;
        }

        if (settings.data?.safeMode?.enabled && settings.data?.safeMode?.fallbackToMock) {
          const fallbackPayload = applyOverlaySettings(createMockMatchups({
            week: settings.league.week === 'current' ? 1 : Number(settings.league.week || 1),
            pinnedMatchupId: settings.overlay.gameOfWeekMatchupId,
            seedOverride: settings.data.mockSeed || process.env.MOCK_SEED || null
          }), settings);
          this.currentPayload = fallbackPayload;
          this.currentHash = payloadHash(fallbackPayload);
          this.lastProvider = 'mock-safe';
          this.lastSuccessAt = fallbackPayload.updatedAt || new Date().toISOString();
          this.logger.warn('Safe mode fallback engaged: using mock payload after Yahoo failure');
          this.sseHub.broadcast('update', {
            payload: this.currentPayload,
            scoreChanges: [],
            playerScoreChanges: [],
            tdEvents: [],
            leadChanges: [],
            upsetEvents: [],
            finalEvents: [],
            status: this.buildStatus()
          });
          await this.logEvent({
            kind: 'fallback',
            type: 'mock_safe_mode_fallback',
            severity: 'warn',
            message: 'Safe mode fallback engaged with mock payload.',
            data: {
              provider: this.lastProvider
            }
          });
        }
      }
    }
  }

  async scanTouchdowns({ forceBroadcast = false } = {}) {
    const settings = await this.getSettings();
    this.lastSettings = settings;
    const startedAt = Date.now();

    try {
      if (!this.currentPayload) {
        this.recordPoll({ kind: 'td_scan', success: true, skipped: true, reason: 'no_payload' });
        return;
      }

      if (this.isCircuitOpen() && this.currentPayload.league?.source === 'yahoo') {
        this.recordPoll({ kind: 'td_scan', success: false, skipped: true, reason: 'circuit_open' });
        return;
      }

      const tdResult = await this.detectTouchdownEvents(this.currentPayload, settings);
      const tdEvents = tdResult.tdEvents || [];
      const playerScoreChanges = tdResult.playerScoreChanges || [];
      this.tdFailureCount = 0;
      this.lastTdScanAt = new Date().toISOString();

      this.metrics?.inc('td_scans_total');
      this.metrics?.set('td_failure_count', this.tdFailureCount);
      this.metrics?.set('td_scan_last_duration_ms', Date.now() - startedAt);

      if (!tdEvents.length && !playerScoreChanges.length && !forceBroadcast) {
        this.recordPoll({
          kind: 'td_scan',
          success: true,
          durationMs: Date.now() - startedAt,
          tdEvents: 0,
          playerScoreChanges: 0
        });
        return;
      }

      await this.dispatchExternalHooks({
        settings,
        payload: this.currentPayload,
        scoreChanges: [],
        tdEvents,
        leadChanges: [],
        upsetEvents: [],
        finalEvents: [],
        playerScoreChanges
      });
      this.pushRecent('recentTdEvents', tdEvents, 80);
      this.pushRecent('recentPlayerScoreChanges', playerScoreChanges, 120);

      this.queueAutomationEvents({
        scoreChanges: [],
        tdEvents,
        leadChanges: [],
        upsetEvents: [],
        finalEvents: [],
        payload: this.currentPayload
      });

      this.sseHub.broadcast('update', {
        payload: this.currentPayload,
        scoreChanges: [],
        playerScoreChanges,
        tdEvents,
        leadChanges: [],
        upsetEvents: [],
        finalEvents: [],
        status: this.buildStatus()
      });

      this.metrics?.inc('td_events_sent_total', tdEvents.length);
      this.recordPoll({
        kind: 'td_scan',
        success: true,
        durationMs: Date.now() - startedAt,
        tdEvents: tdEvents.length,
        playerScoreChanges: playerScoreChanges.length
      });

      await this.logEvent({
        kind: 'touchdown',
        type: tdEvents.length ? 'td_events_detected' : 'player_score_delta',
        message: tdEvents.length
          ? `Detected ${tdEvents.length} TD event(s).`
          : `Detected ${playerScoreChanges.length} player score change(s).`,
        data: {
          tdEvents: tdEvents.length,
          playerScoreChanges: playerScoreChanges.length
        }
      });
    } catch (error) {
      this.tdFailureCount += 1;
      this.lastError = {
        message: error.message,
        at: new Date().toISOString(),
        phase: 'td_scan'
      };
      this.metrics?.inc('td_scan_failures_total');
      this.metrics?.set('td_failure_count', this.tdFailureCount);

      this.recordPoll({ kind: 'td_scan', success: false, durationMs: Date.now() - startedAt, error: error.message });

      this.logger.error('TD scan failed', {
        error: error.message,
        failures: this.tdFailureCount
      });

      await this.logEvent({
        kind: 'touchdown',
        type: 'td_scan_failed',
        severity: 'error',
        message: `TD scan failed: ${error.message}`,
        data: {
          failures: this.tdFailureCount
        }
      });
    }
  }

  async scheduleNextScoreboardPoll() {
    if (!this.running) {
      return;
    }

    const settings = await this.getSettings();
    const delay = this.getScoreboardDelayMs(settings);

    this.scoreTimeoutRef = setTimeout(async () => {
      await this.pollScoreboard();
      await this.scheduleNextScoreboardPoll();
    }, delay);
  }

  async scheduleNextTdScan() {
    if (!this.running) {
      return;
    }

    const settings = await this.getSettings();
    const delay = this.getTdDelayMs(settings);

    this.tdTimeoutRef = setTimeout(async () => {
      await this.scanTouchdowns();
      await this.scheduleNextTdScan();
    }, delay);
  }

  async start() {
    if (this.running) {
      return;
    }
    if (this.replayMode.active) {
      await this.stopReplayWindow({ resume: false });
    }

    this.running = true;
    const settings = await this.getSettings();
    this.lastSettings = settings;

    const startupFallbackApplied = await this.applyStartupSafeModeFallback(settings);
    if (!startupFallbackApplied) {
      await this.pollScoreboard({ forceBroadcast: true });
    }

    await this.scanTouchdowns({ forceBroadcast: false });
    await this.scheduleNextScoreboardPoll();
    await this.scheduleNextTdScan();
    this.logger.info('Polling services started');
  }

  stop() {
    this.running = false;

    if (this.scoreTimeoutRef) {
      clearTimeout(this.scoreTimeoutRef);
      this.scoreTimeoutRef = null;
    }

    if (this.tdTimeoutRef) {
      clearTimeout(this.tdTimeoutRef);
      this.tdTimeoutRef = null;
    }

    this.logger.info('Polling services stopped');
  }

  async forceRefresh() {
    if (this.replayMode.active) {
      await this.stopReplayWindow({ resume: false });
    }
    await this.pollScoreboard({ forceBroadcast: true });
    await this.scanTouchdowns({ forceBroadcast: true });
  }

  async warmLogoCache() {
    if (!this.currentPayload) {
      return {
        warmed: 0,
        skipped: 0,
        failed: 0,
        total: 0,
        message: 'No current payload to warm logos from.'
      };
    }

    const result = await this.logoCache?.warmFromPayload(this.currentPayload) || {
      warmed: 0,
      skipped: 0,
      failed: 0,
      total: 0
    };

    this.logoCache?.rewritePayloadLogos(this.currentPayload);
    this.sseHub.broadcast('update', {
      payload: this.currentPayload,
      scoreChanges: [],
      playerScoreChanges: [],
      tdEvents: [],
      leadChanges: [],
      upsetEvents: [],
      finalEvents: [],
      status: this.buildStatus()
    });

    await this.logEvent({
      kind: 'logos',
      type: 'warm_completed',
      message: `Logo warm complete: ${result.warmed} warmed, ${result.skipped} cached, ${result.failed} failed.`,
      data: result
    });

    return result;
  }

  clearReplayTimer() {
    if (this.replayMode.timer) {
      clearInterval(this.replayMode.timer);
      this.replayMode.timer = null;
    }
  }

  async startReplayWindow({ minutes = 15, intervalMs = 2500 } = {}) {
    const replayMinutes = Math.max(1, Math.min(120, Number(minutes) || 15));
    const stepMs = Math.max(500, Math.min(10000, Number(intervalMs) || 2500));

    if (this.replayMode.active) {
      await this.stopReplayWindow({ resume: false });
    }

    if (!this.historyStore?.isReady?.()) {
      throw new Error('Replay unavailable: history store is not ready (node:sqlite may be unavailable).');
    }

    const hours = Math.max(1, Math.ceil(replayMinutes / 60));
    const cutoffMs = Date.now() - replayMinutes * 60 * 1000;
    const snapshots = (this.historyStore.recentSnapshots({ hours, limit: 400 }) || [])
      .filter((row) => {
        const tsMs = new Date(row.ts).getTime();
        return Number.isFinite(tsMs) && tsMs >= cutoffMs && row.payload;
      })
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    if (!snapshots.length) {
      throw new Error(`No snapshots found in the last ${replayMinutes} minute(s).`);
    }

    const payloads = snapshots.map((row) => row.payload).filter(Boolean);
    const wasRunning = this.running;
    if (wasRunning) {
      this.stop();
    }

    this.replayMode.active = true;
    this.replayMode.startedAt = new Date().toISOString();
    this.replayMode.snapshots = payloads;
    this.replayMode.index = 0;
    this.replayMode.intervalMs = stepMs;
    this.replayMode.originalWasRunning = wasRunning;

    const emit = () => {
      if (!this.replayMode.active || !this.replayMode.snapshots.length) {
        return;
      }
      const payload = this.replayMode.snapshots[this.replayMode.index] || this.replayMode.snapshots[0];
      this.logoCache?.rewritePayloadLogos(payload);
      this.currentPayload = payload;
      this.currentHash = payloadHash(payload);
      this.lastSuccessAt = new Date().toISOString();
      this.lastProvider = 'replay-window';

      this.sseHub.broadcast('update', {
        payload: this.currentPayload,
        scoreChanges: [],
        playerScoreChanges: [],
        tdEvents: [],
        leadChanges: [],
        upsetEvents: [],
        finalEvents: [],
        status: this.buildStatus()
      });

      this.replayMode.index = (this.replayMode.index + 1) % this.replayMode.snapshots.length;
    };

    emit();
    this.clearReplayTimer();
    this.replayMode.timer = setInterval(emit, stepMs);

    await this.logEvent({
      kind: 'replay',
      type: 'replay_started',
      message: `Replay mode started for last ${replayMinutes} minute(s).`,
      data: {
        minutes: replayMinutes,
        intervalMs: stepMs,
        snapshots: payloads.length
      }
    });

    return {
      ok: true,
      minutes: replayMinutes,
      intervalMs: stepMs,
      snapshots: payloads.length
    };
  }

  async stopReplayWindow({ resume = true } = {}) {
    const wasActive = this.replayMode.active;
    const shouldResume = Boolean(resume && this.replayMode.originalWasRunning);

    this.clearReplayTimer();
    this.replayMode.active = false;
    this.replayMode.startedAt = null;
    this.replayMode.snapshots = [];
    this.replayMode.index = 0;
    this.replayMode.intervalMs = 2500;
    this.replayMode.originalWasRunning = false;

    if (shouldResume) {
      await this.start();
    } else {
      this.sseHub.broadcast('status', this.buildStatus());
    }

    if (wasActive) {
      await this.logEvent({
        kind: 'replay',
        type: 'replay_stopped',
        message: 'Replay mode stopped.',
        data: {
          resumedPolling: shouldResume
        }
      });
    }

    return {
      ok: true,
      resumedPolling: shouldResume
    };
  }

  async applyStartupSafeModeFallback(settings) {
    const safeMode = settings?.data?.safeMode || {};
    const fallbackEnabled = Boolean(safeMode.enabled && safeMode.startupForceFallbackIfAuthDown);
    if (!fallbackEnabled) {
      return false;
    }

    const provider = resolveProvider(settings);
    if (provider !== 'yahoo') {
      return false;
    }

    let authStatus = null;
    try {
      authStatus = await this.authService.getAuthStatus();
    } catch (error) {
      this.logger.warn('Unable to resolve Yahoo auth status during startup fallback check', { error: error.message });
    }

    if (authStatus?.configured && authStatus.authorized) {
      return false;
    }

    const reason = authStatus?.configured
      ? 'safe mode startup fallback: Yahoo OAuth authorization missing'
      : 'safe mode startup fallback: Yahoo credentials missing';

    const circuitEnabled = Boolean(settings.data?.circuitBreaker?.enabled);
    if (circuitEnabled) {
      this.openCircuit({
        reason: 'startup_auth_unavailable',
        cooldownMs: Number(settings.data?.circuitBreaker?.cooldownMs || 60000)
      });
    }

    if (this.currentPayload) {
      this.lastProvider = 'cache-safe-startup';
      this.logger.warn('Using cached payload at startup while Yahoo auth is unavailable');
      this.sseHub.broadcast('status', this.buildStatus());
      await this.logEvent({
        kind: 'startup',
        type: 'safe_startup_cache',
        severity: 'warn',
        message: 'Startup safe mode used cached payload because Yahoo auth is unavailable.',
        data: {
          reason
        }
      });
      return true;
    }

    if (!safeMode.fallbackToMock) {
      this.lastError = {
        message: `${reason}; enable safeMode.fallbackToMock to render mock overlay data.`,
        at: new Date().toISOString(),
        phase: 'startup'
      };
      this.sseHub.broadcast('status', this.buildStatus());
      await this.logEvent({
        kind: 'startup',
        type: 'safe_startup_blocked',
        severity: 'warn',
        message: 'Startup safe mode detected unavailable Yahoo auth with no mock fallback.',
        data: {
          reason
        }
      });
      return false;
    }

    const fallbackPayload = applyOverlaySettings(createMockMatchups({
      week: settings.league.week === 'current' ? 1 : Number(settings.league.week || 1),
      pinnedMatchupId: settings.overlay.gameOfWeekMatchupId,
      seedOverride: settings.data.mockSeed || process.env.MOCK_SEED || null
    }), settings);

    this.currentPayload = fallbackPayload;
    this.currentHash = payloadHash(fallbackPayload);
    this.lastProvider = 'mock-safe-startup';
    this.lastSuccessAt = fallbackPayload.updatedAt || new Date().toISOString();
    this.lastError = {
      message: reason,
      at: new Date().toISOString(),
      phase: 'startup'
    };

    await writeCache(fallbackPayload);
    this.logger.warn('Startup safe mode fallback engaged with mock payload');

    this.sseHub.broadcast('update', {
      payload: this.currentPayload,
      scoreChanges: [],
      playerScoreChanges: [],
      tdEvents: [],
      leadChanges: [],
      upsetEvents: [],
      finalEvents: [],
      status: this.buildStatus()
    });

    await this.logEvent({
      kind: 'startup',
      type: 'safe_startup_mock',
      severity: 'warn',
      message: 'Startup safe mode fallback engaged with mock payload.',
      data: {
        reason
      }
    });

    return true;
  }

  manualNext() {
    this.sseHub.broadcast('control', { action: 'next' });
    this.logEvent({
      kind: 'control',
      type: 'manual_next',
      message: 'Manual next matchup requested.'
    }).catch(() => {});
  }

  setRotationPaused(paused) {
    this.controlState.rotationPaused = Boolean(paused);
    this.sseHub.broadcast('control', {
      action: 'set_rotation_paused',
      paused: this.controlState.rotationPaused
    });
    this.logEvent({
      kind: 'control',
      type: this.controlState.rotationPaused ? 'rotation_paused' : 'rotation_resumed',
      message: this.controlState.rotationPaused ? 'Overlay rotation paused.' : 'Overlay rotation resumed.'
    }).catch(() => {});
  }

  pinMatchup(matchupId) {
    this.controlState.pinnedMatchupId = String(matchupId || '').trim();
    this.sseHub.broadcast('control', {
      action: this.controlState.pinnedMatchupId ? 'pin_matchup' : 'clear_pin_matchup',
      matchupId: this.controlState.pinnedMatchupId
    });
    this.logEvent({
      kind: 'control',
      type: this.controlState.pinnedMatchupId ? 'matchup_pinned' : 'matchup_unpinned',
      message: this.controlState.pinnedMatchupId
        ? `Pinned matchup ${this.controlState.pinnedMatchupId}.`
        : 'Cleared pinned matchup.',
      data: {
        matchupId: this.controlState.pinnedMatchupId
      }
    }).catch(() => {});
  }

  triggerStoryCard() {
    this.controlState.forceStoryAt = new Date().toISOString();
    this.sseHub.broadcast('control', {
      action: 'force_story_card',
      ts: this.controlState.forceStoryAt
    });
    this.logEvent({
      kind: 'control',
      type: 'story_card_forced',
      message: 'Story card forced from admin control.'
    }).catch(() => {});
  }

  replaySnapshot(snapshot) {
    if (!snapshot) {
      return false;
    }

    this.logoCache?.rewritePayloadLogos(snapshot);
    this.currentPayload = snapshot;
    this.currentHash = payloadHash(snapshot);
    this.lastSuccessAt = new Date().toISOString();
    this.lastProvider = 'replay';

    this.sseHub.broadcast('update', {
      payload: this.currentPayload,
      scoreChanges: [],
      playerScoreChanges: [],
      tdEvents: [],
      leadChanges: [],
      upsetEvents: [],
      finalEvents: [],
      status: this.buildStatus()
    });

    this.logEvent({
      kind: 'replay',
      type: 'snapshot_replayed',
      message: 'Snapshot replayed to overlay.',
      data: {
        source: 'history_snapshot'
      }
    }).catch(() => {});

    return true;
  }

  async testConnection() {
    const settings = await this.getSettings();
    const provider = resolveProvider(settings);

    if (provider === 'mock') {
      return {
        ok: true,
        mode: 'mock',
        message: 'Mock mode is enabled. Disable mock mode or switch provider to test live APIs.'
      };
    }

    let payload = null;

    if (provider === 'yahoo') {
      const authStatus = await this.authService.getAuthStatus();
      if (!authStatus.configured) {
        throw new Error('Yahoo credentials are not configured.');
      }
      if (!authStatus.authorized) {
        throw new Error('Yahoo OAuth is not completed yet.');
      }

      payload = await this.fetchLivePayload(settings);
    } else if (provider === 'espn') {
      payload = await this.fetchEspnPayload(settings);
    } else if (provider === 'sleeper') {
      payload = await this.fetchSleeperPayload(settings);
    } else {
      throw new Error(`Unsupported provider '${provider}'`);
    }

    return {
      ok: true,
      mode: provider,
      league: payload.league,
      matchupCount: payload.matchups.length,
      updatedAt: payload.updatedAt
    };
  }
}

module.exports = {
  DataService,
  __testables: {
    isTouchdownLabel,
    computeTdEventsFromStates,
    computePlayerScoreChangesFromStates,
    deserializeTdState,
    serializeTdState,
    detectScoreChanges,
    detectLeadChanges,
    detectUpsetStarts,
    detectFinalized,
    computeScheduleWindowState
  }
};
