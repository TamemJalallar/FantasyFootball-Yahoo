const path = require('node:path');
let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  DatabaseSync = null;
}

const HISTORY_DB_PATH = path.resolve(process.cwd(), 'cache', 'history.db');

function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

class HistoryStore {
  constructor({ logger }) {
    this.logger = logger;
    this.db = null;
    this.ready = false;
  }

  init() {
    if (!DatabaseSync) {
      this.logger.warn('node:sqlite is unavailable; history snapshots disabled on this Node version');
      this.ready = false;
      return;
    }

    try {
      this.db = new DatabaseSync(HISTORY_DB_PATH);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          league_key TEXT,
          week INTEGER,
          source TEXT,
          payload_hash TEXT,
          payload_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS score_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL,
          matchup_id TEXT,
          team_key TEXT,
          from_points REAL,
          to_points REAL,
          delta REAL,
          reason TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);
        CREATE INDEX IF NOT EXISTS idx_score_events_ts ON score_events(ts);
      `);

      this.ready = true;
    } catch (error) {
      this.logger.warn('History store init failed; continuing without SQLite history', {
        error: error.message
      });
      this.ready = false;
    }
  }

  isReady() {
    return this.ready && Boolean(this.db);
  }

  saveSnapshot({ payload, hash, scoreChanges = [], leadChanges = [] }) {
    if (!this.isReady() || !payload) {
      return;
    }

    const leagueKey = payload?.league?.leagueKey || '';
    const week = Number(payload?.league?.week || 0) || null;
    const source = payload?.league?.source || 'unknown';
    const ts = payload.updatedAt || new Date().toISOString();

    const insertSnapshot = this.db.prepare(`
      INSERT INTO snapshots (ts, league_key, week, source, payload_hash, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    insertSnapshot.run(ts, leagueKey, week, source, hash || '', JSON.stringify(payload));

    const insertScoreEvent = this.db.prepare(`
      INSERT INTO score_events (ts, matchup_id, team_key, from_points, to_points, delta, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const change of scoreChanges) {
      if (change.teamA && change.teamA.from !== change.teamA.to) {
        const delta = Number((Number(change.teamA.to || 0) - Number(change.teamA.from || 0)).toFixed(2));
        insertScoreEvent.run(ts, change.matchupId, change.teamA.key, change.teamA.from, change.teamA.to, delta, 'score_change');
      }

      if (change.teamB && change.teamB.from !== change.teamB.to) {
        const delta = Number((Number(change.teamB.to || 0) - Number(change.teamB.from || 0)).toFixed(2));
        insertScoreEvent.run(ts, change.matchupId, change.teamB.key, change.teamB.from, change.teamB.to, delta, 'score_change');
      }
    }

    for (const lead of leadChanges) {
      insertScoreEvent.run(ts, lead.matchupId, lead.newLeaderKey, null, null, 0, 'lead_change');
    }
  }

  prune(retentionDays = 14) {
    if (!this.isReady()) {
      return;
    }

    const days = Math.max(1, Number(retentionDays) || 14);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const deleteSnapshots = this.db.prepare('DELETE FROM snapshots WHERE ts < ?');
    const deleteEvents = this.db.prepare('DELETE FROM score_events WHERE ts < ?');

    deleteSnapshots.run(cutoff);
    deleteEvents.run(cutoff);
  }

  recentSnapshots({ hours = 24, limit = 40 } = {}) {
    if (!this.isReady()) {
      return [];
    }

    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 40));
    const cutoff = new Date(Date.now() - Math.max(1, Number(hours) || 24) * 60 * 60 * 1000).toISOString();

    const stmt = this.db.prepare(`
      SELECT id, ts, league_key, week, source, payload_hash, payload_json
      FROM snapshots
      WHERE ts >= ?
      ORDER BY ts DESC
      LIMIT ?
    `);

    return stmt.all(cutoff, safeLimit).map((row) => {
      const payload = safeJson(row.payload_json, null);
      return {
        id: row.id,
        ts: row.ts,
        leagueKey: row.league_key,
        week: row.week,
        source: row.source,
        hash: row.payload_hash,
        matchupCount: payload?.matchups?.length || 0,
        payload
      };
    });
  }

  recentScoreEvents({ hours = 24, limit = 120 } = {}) {
    if (!this.isReady()) {
      return [];
    }

    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 120));
    const cutoff = new Date(Date.now() - Math.max(1, Number(hours) || 24) * 60 * 60 * 1000).toISOString();

    const stmt = this.db.prepare(`
      SELECT id, ts, matchup_id, team_key, from_points, to_points, delta, reason
      FROM score_events
      WHERE ts >= ?
      ORDER BY ts DESC
      LIMIT ?
    `);

    return stmt.all(cutoff, safeLimit).map((row) => ({
      id: row.id,
      ts: row.ts,
      matchupId: row.matchup_id,
      teamKey: row.team_key,
      from: row.from_points,
      to: row.to_points,
      delta: row.delta,
      reason: row.reason
    }));
  }
}

module.exports = {
  HistoryStore,
  HISTORY_DB_PATH
};
