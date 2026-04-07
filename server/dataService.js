const crypto = require('node:crypto');
const { normalizeYahooMatchups } = require('./normalizer');
const { createMockMatchups } = require('./mockData');
const { readCache, writeCache } = require('./cacheStore');
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

function uniqueTeamKeys(payload) {
  const keys = new Set();
  for (const matchup of payload?.matchups || []) {
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
  for (const m of previousPayload.matchups) {
    before.set(m.id, m);
  }

  const changes = [];

  for (const current of nextPayload.matchups) {
    const prev = before.get(current.id);
    if (!prev) {
      continue;
    }

    const teamAChanged = Number(prev.teamA?.points ?? 0) !== Number(current.teamA?.points ?? 0);
    const teamBChanged = Number(prev.teamB?.points ?? 0) !== Number(current.teamB?.points ?? 0);

    if (teamAChanged || teamBChanged) {
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
  }

  return changes;
}

function applyOverlaySettings(payload, settings) {
  const clone = JSON.parse(JSON.stringify(payload));

  if (!settings.overlay.highlightClosest) {
    clone.matchups.forEach((m) => {
      delete m.isClosest;
    });
  }

  if (!settings.overlay.highlightUpset) {
    clone.matchups.forEach((m) => {
      delete m.isUpset;
    });
  }

  if (settings.overlay.gameOfWeekMatchupId) {
    clone.matchups.forEach((m) => {
      m.isGameOfWeek = m.id === settings.overlay.gameOfWeekMatchupId;
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

class DataService {
  constructor({ logger, getSettings, yahooApi, authService, sseHub }) {
    this.logger = logger;
    this.getSettings = getSettings;
    this.yahooApi = yahooApi;
    this.authService = authService;
    this.sseHub = sseHub;

    this.currentPayload = null;
    this.currentHash = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.failureCount = 0;
    this.running = false;
    this.timeoutRef = null;

    this.touchdownStatCache = new Map();
    this.playerTdState = new Map();
    this.playerTdLeagueKey = null;
    this.playerTdWeek = null;
  }

  async init() {
    const cached = await readCache();
    if (cached) {
      this.currentPayload = cached;
      this.currentHash = payloadHash(cached);
      this.lastSuccessAt = cached.updatedAt || null;
      this.logger.info('Loaded cached matchup payload');
    }
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

  async detectTouchdownEvents(payload, settings) {
    if (!settings.overlay.showTdAlerts) {
      return [];
    }

    if (payload?.league?.source !== 'yahoo') {
      this.playerTdState.clear();
      this.playerTdLeagueKey = null;
      this.playerTdWeek = null;
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

    try {
      const { tdStatIds, tdStatLabels } = await this.resolveTouchdownStatConfig(leagueKey);
      if (!tdStatIds.size) {
        return [];
      }

      const teamKeys = uniqueTeamKeys(payload);
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
        return [];
      }

      const teamMeta = buildTeamMetaByKey(payload);
      const tdEvents = [];

      for (const [snapshotKey, current] of currentState.entries()) {
        const previous = this.playerTdState.get(snapshotKey);
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
          id: `${Date.now()}-${current.playerKey}`,
          ts: new Date().toISOString(),
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

      this.playerTdState = currentState;
      this.playerTdLeagueKey = leagueKey;
      this.playerTdWeek = week;

      return tdEvents;
    } catch (error) {
      this.logger.warn('Touchdown detection failed', { error: error.message });
      return [];
    }
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

  buildStatus() {
    return {
      running: this.running,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      failureCount: this.failureCount,
      hasData: Boolean(this.currentPayload),
      mode: this.currentPayload?.league?.source || 'unknown'
    };
  }

  getSnapshot() {
    return {
      payload: this.currentPayload,
      status: this.buildStatus()
    };
  }

  async pollOnce({ forceBroadcast = false } = {}) {
    const settings = await this.getSettings();

    try {
      const rawPayload = await this.fetchPayload(settings);
      const payload = applyOverlaySettings(rawPayload, settings);
      const nextHash = payloadHash(payload);

      const scoreChanges = detectScoreChanges(this.currentPayload, payload);
      const tdEvents = await this.detectTouchdownEvents(payload, settings);
      const changed = forceBroadcast || nextHash !== this.currentHash || tdEvents.length > 0;

      this.currentPayload = payload;
      this.currentHash = nextHash;
      this.lastSuccessAt = payload.updatedAt || new Date().toISOString();
      this.lastError = null;
      this.failureCount = 0;

      await writeCache(payload);
      await this.triggerScoreHook(scoreChanges, tdEvents, settings.overlay.soundHookUrl);

      if (changed) {
        this.sseHub.broadcast('update', {
          payload,
          scoreChanges,
          tdEvents,
          status: this.buildStatus()
        });
      } else {
        this.sseHub.broadcast('status', this.buildStatus());
      }

      this.logger.debug('Poll success', {
        matchups: payload.matchups?.length || 0,
        changed,
        tdEvents: tdEvents.length,
        source: payload.league?.source
      });
    } catch (error) {
      this.failureCount += 1;
      this.lastError = {
        message: error.message,
        at: new Date().toISOString()
      };
      this.sseHub.broadcast('status', this.buildStatus());

      this.logger.error('Poll failed', {
        error: error.message,
        failures: this.failureCount
      });

      if (!this.currentPayload) {
        const cached = await readCache();
        if (cached) {
          this.currentPayload = cached;
          this.currentHash = payloadHash(cached);
          this.logger.warn('Fallback to cached payload after failure');
        }
      }
    }
  }

  getDelayMs(settings) {
    const base = Number(settings.data.refreshIntervalMs || 45000);
    if (this.failureCount === 0) {
      return base;
    }

    const max = Number(settings.data.maxRetryDelayMs || 300000);
    return Math.min(base * (2 ** this.failureCount), max);
  }

  async scheduleNextPoll() {
    if (!this.running) {
      return;
    }

    const settings = await this.getSettings();
    const delay = this.getDelayMs(settings);

    this.timeoutRef = setTimeout(async () => {
      await this.pollOnce();
      await this.scheduleNextPoll();
    }, delay);
  }

  async start() {
    if (this.running) {
      return;
    }

    this.running = true;
    await this.pollOnce({ forceBroadcast: true });
    await this.scheduleNextPoll();
    this.logger.info('Polling service started');
  }

  stop() {
    this.running = false;
    if (this.timeoutRef) {
      clearTimeout(this.timeoutRef);
      this.timeoutRef = null;
    }
    this.logger.info('Polling service stopped');
  }

  async forceRefresh() {
    await this.pollOnce({ forceBroadcast: true });
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
  DataService
};
