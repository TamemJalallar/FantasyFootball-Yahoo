const crypto = require('node:crypto');
const { normalizeYahooMatchups } = require('./normalizer');
const { createMockMatchups } = require('./mockData');
const { readCache, writeCache } = require('./cacheStore');
const { loadTdState, saveTdState } = require('./tdStateStore');
const { toArray, toNumber, safeString } = require('./utils');

const BENCH_POSITIONS = new Set(['BN', 'IR', 'IR+', 'NA']);
const FALLBACK_TD_STATS = {
  '5': 'Passing TD',
  '6': 'Rushing TD',
  '7': 'Receiving TD',
  '8': 'Return TD'
};

function payloadHash(payload) {
  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
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
      tdTypes: changedTypes.length ? changedTypes : current.tdTypes
    });
  }

  return tdEvents;
}

class DataService {
  constructor({
    logger,
    getSettings,
    yahooApi,
    authService,
    sseHub,
    metrics = null,
    historyStore = null,
    audioQueue = null,
    obsController = null
  }) {
    this.logger = logger;
    this.getSettings = getSettings;
    this.yahooApi = yahooApi;
    this.authService = authService;
    this.sseHub = sseHub;
    this.metrics = metrics;
    this.historyStore = historyStore;
    this.audioQueue = audioQueue;
    this.obsController = obsController;

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
    this.lastScoreChanges = [];
  }

  async init() {
    this.historyStore?.init();

    const cached = await readCache();
    if (cached) {
      this.currentPayload = cached;
      this.currentHash = payloadHash(cached);
      this.lastSuccessAt = cached.updatedAt || null;
      this.logger.info('Loaded cached matchup payload');
    }

    const tdStatePayload = await loadTdState();
    const tdState = deserializeTdState(tdStatePayload);
    this.playerTdLeagueKey = tdState.leagueKey;
    this.playerTdWeek = tdState.week;
    this.playerTdState = tdState.state;
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
      lastScoreboardPollAt: this.lastScoreboardPollAt,
      lastTdScanAt: this.lastTdScanAt,
      degradedMode: this.getDegradedMode(),
      circuitOpenUntil: this.circuit.openUntil,
      circuitReason: this.circuit.reason,
      circuitTripCount: this.circuit.tripCount,
      skippedPolls: this.circuit.skippedPolls
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
    return {
      status: this.buildStatus(),
      metrics: this.metrics?.snapshot() || {},
      pollRecords: this.pollRecords.slice(0, 120),
      recentLeadChanges: this.recentLeadChanges.slice(0, 40),
      recentUpsetEvents: this.recentUpsetEvents.slice(0, 40),
      recentFinalEvents: this.recentFinalEvents.slice(0, 40),
      recentTdEvents: this.recentTdEvents.slice(0, 40),
      lastScoreChanges: this.lastScoreChanges.slice(0, 40),
      history: {
        snapshots: this.historyStore?.recentSnapshots({ hours: h, limit: 30 }) || [],
        scoreEvents: this.historyStore?.recentScoreEvents({ hours: h, limit: 100 }) || []
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

  async fetchPayload(settings) {
    if (settings.data.mockMode) {
      return createMockMatchups({
        week: settings.league.week === 'current' ? 1 : Number(settings.league.week || 1),
        pinnedMatchupId: settings.overlay.gameOfWeekMatchupId
      });
    }

    return this.fetchLivePayload(settings);
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

      if (totalTouchdowns <= 0) {
        continue;
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
      return [];
    }

    if (payload?.league?.source !== 'yahoo') {
      this.playerTdState.clear();
      this.playerTdLeagueKey = null;
      this.playerTdWeek = null;
      await this.persistTdState();
      return [];
    }

    const liveMatchups = (payload?.matchups || []).filter((matchup) => matchup.isLive);
    if (!liveMatchups.length) {
      return [];
    }

    const leagueKey = safeString(payload?.league?.leagueKey, '');
    const week = Number(payload?.league?.week || 0);

    if (!leagueKey || !week) {
      return [];
    }

    const { tdStatIds, tdStatLabels } = await this.resolveTouchdownStatConfig(leagueKey);
    if (!tdStatIds.size) {
      return [];
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
      return [];
    }

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

    return this.dedupeTdEvents(tdEvents, settings.data?.tdDedupWindowMs);
  }

  async triggerScoreHook(scoreChanges, tdEvents, hookUrl) {
    if (!hookUrl || (!scoreChanges.length && !tdEvents.length)) {
      return;
    }

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
          ts: new Date().toISOString()
        })
      });
    } catch (error) {
      this.logger.warn('Score hook failed', { error: error.message });
    }
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

    if (!adaptive.enabled || !this.currentPayload?.matchups?.length) {
      return fallback;
    }

    const liveCount = this.currentPayload.matchups.filter((item) => item.isLive).length;
    const finalCount = this.currentPayload.matchups.filter((item) => item.isFinal).length;
    const upcomingCount = this.currentPayload.matchups.filter((item) => item.status === 'upcoming').length;

    if (liveCount > 0) {
      return Number(adaptive.liveMs || fallback);
    }

    if (finalCount > 0 && upcomingCount > 0) {
      return Number(adaptive.mixedMs || fallback);
    }

    return Number(adaptive.idleMs || fallback);
  }

  getTdBaseMs(settings) {
    const adaptive = settings.data?.adaptivePolling || {};
    const fallback = Number(settings.data.tdScanIntervalMs || settings.data.refreshIntervalMs || 10000);

    if (!adaptive.enabled || !this.currentPayload?.matchups?.length) {
      return fallback;
    }

    const liveCount = this.currentPayload.matchups.filter((item) => item.isLive).length;
    if (liveCount > 0) {
      return Number(adaptive.liveMs || fallback);
    }

    return Number(adaptive.idleMs || fallback);
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

    return this.applyJitter(delay, settings);
  }

  getTdDelayMs(settings) {
    const base = this.getTdBaseMs(settings);
    const max = Number(settings.data.maxRetryDelayMs || 300000);

    let delay = base;
    if (this.tdFailureCount > 0) {
      delay = Math.min(base * (2 ** this.tdFailureCount), max);
    }

    return this.applyJitter(delay, settings);
  }

  async pollScoreboard({ forceBroadcast = false } = {}) {
    const settings = await this.getSettings();
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
      await this.triggerScoreHook(scoreChanges, [], settings.overlay.soundHookUrl);

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
          tdEvents: [],
          leadChanges,
          upsetEvents,
          finalEvents,
          status: this.buildStatus()
        });
      } else {
        this.sseHub.broadcast('status', this.buildStatus());
      }

      this.metrics?.inc('scoreboard_polls_total');
      this.metrics?.set('scoreboard_failure_count', this.scoreFailureCount);
      this.metrics?.set('overlay_has_data', this.currentPayload ? 1 : 0);
      this.metrics?.set('scoreboard_last_duration_ms', Date.now() - startedAt);
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

      if (!this.currentPayload) {
        const cached = await readCache();
        if (cached) {
          this.currentPayload = cached;
          this.currentHash = payloadHash(cached);
          this.logger.warn('Fallback to cached payload after scoreboard failure');
        }
      }
    }
  }

  async scanTouchdowns({ forceBroadcast = false } = {}) {
    const settings = await this.getSettings();
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

      const tdEvents = await this.detectTouchdownEvents(this.currentPayload, settings);
      this.tdFailureCount = 0;
      this.lastTdScanAt = new Date().toISOString();

      this.metrics?.inc('td_scans_total');
      this.metrics?.set('td_failure_count', this.tdFailureCount);
      this.metrics?.set('td_scan_last_duration_ms', Date.now() - startedAt);

      if (!tdEvents.length && !forceBroadcast) {
        this.recordPoll({ kind: 'td_scan', success: true, durationMs: Date.now() - startedAt, tdEvents: 0 });
        return;
      }

      await this.triggerScoreHook([], tdEvents, settings.overlay.soundHookUrl);
      this.pushRecent('recentTdEvents', tdEvents, 80);

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
        tdEvents,
        leadChanges: [],
        upsetEvents: [],
        finalEvents: [],
        status: this.buildStatus()
      });

      this.metrics?.inc('td_events_sent_total', tdEvents.length);
      this.recordPoll({ kind: 'td_scan', success: true, durationMs: Date.now() - startedAt, tdEvents: tdEvents.length });
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

    this.running = true;
    await this.pollScoreboard({ forceBroadcast: true });
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
    await this.pollScoreboard({ forceBroadcast: true });
    await this.scanTouchdowns({ forceBroadcast: true });
  }

  manualNext() {
    this.sseHub.broadcast('control', { action: 'next' });
  }

  async testConnection() {
    const settings = await this.getSettings();

    if (settings.data.mockMode) {
      return {
        ok: true,
        mode: 'mock',
        message: 'Mock mode is enabled. Disable mock mode to test Yahoo API.'
      };
    }

    const authStatus = await this.authService.getAuthStatus();
    if (!authStatus.configured) {
      throw new Error('Yahoo credentials are not configured.');
    }
    if (!authStatus.authorized) {
      throw new Error('Yahoo OAuth is not completed yet.');
    }

    const payload = await this.fetchLivePayload(settings);

    return {
      ok: true,
      mode: 'yahoo',
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
    deserializeTdState,
    serializeTdState,
    detectScoreChanges,
    detectLeadChanges,
    detectUpsetStarts,
    detectFinalized
  }
};
