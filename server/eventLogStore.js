const fs = require('node:fs/promises');
const path = require('node:path');

const EVENT_LOG_PATH = path.resolve(process.cwd(), 'cache', 'event-log.jsonl');

function toSafeString(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function normalizeSeverity(value) {
  const key = String(value || '').trim().toLowerCase();
  if (['debug', 'info', 'warn', 'error'].includes(key)) {
    return key;
  }
  return 'info';
}

class EventLogStore {
  constructor({ logger, maxEntries = 5000 }) {
    this.logger = logger;
    this.maxEntries = Math.max(500, Number(maxEntries) || 5000);
    this.writeChain = Promise.resolve();
    this.appendCount = 0;
  }

  async init() {
    await fs.mkdir(path.dirname(EVENT_LOG_PATH), { recursive: true });
    try {
      await fs.access(EVENT_LOG_PATH);
    } catch {
      await fs.writeFile(EVENT_LOG_PATH, '', 'utf8');
    }
  }

  async append(event = {}) {
    const row = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
      kind: toSafeString(event.kind, 'system'),
      type: toSafeString(event.type, 'event'),
      severity: normalizeSeverity(event.severity),
      message: toSafeString(event.message, 'Event captured'),
      data: event.data && typeof event.data === 'object' ? event.data : {}
    };

    const line = `${JSON.stringify(row)}\n`;
    this.writeChain = this.writeChain
      .then(() => fs.appendFile(EVENT_LOG_PATH, line, 'utf8'))
      .then(async () => {
        this.appendCount += 1;
        if (this.appendCount % 50 === 0) {
          await this.compact();
        }
      })
      .catch((error) => {
        this.logger?.warn('Event log append failed', { error: error.message });
      });

    return this.writeChain;
  }

  async listRecent({ limit = 200, kind = '' } = {}) {
    const safeLimit = Math.max(1, Math.min(2000, Number(limit) || 200));
    const kindFilter = toSafeString(kind).toLowerCase();

    try {
      const raw = await fs.readFile(EVENT_LOG_PATH, 'utf8');
      const rows = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      const filtered = kindFilter
        ? rows.filter((row) => String(row.kind || '').toLowerCase() === kindFilter)
        : rows;

      return filtered.slice(-safeLimit).reverse();
    } catch {
      return [];
    }
  }

  async clear() {
    await fs.writeFile(EVENT_LOG_PATH, '', 'utf8');
  }

  async compact() {
    try {
      const raw = await fs.readFile(EVENT_LOG_PATH, 'utf8');
      const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
      if (lines.length <= this.maxEntries) {
        return;
      }

      const keep = lines.slice(-this.maxEntries);
      await fs.writeFile(EVENT_LOG_PATH, `${keep.join('\n')}\n`, 'utf8');
    } catch (error) {
      this.logger?.warn('Event log compact failed', { error: error.message });
    }
  }
}

module.exports = {
  EVENT_LOG_PATH,
  EventLogStore
};
