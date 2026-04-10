class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.counters = new Map();
    this.gauges = new Map();
  }

  inc(name, value = 1) {
    this.counters.set(name, (this.counters.get(name) || 0) + value);
  }

  set(name, value) {
    this.gauges.set(name, Number(value) || 0);
  }

  snapshot() {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      counters: Object.fromEntries(this.counters.entries()),
      gauges: Object.fromEntries(this.gauges.entries())
    };
  }

  toPrometheus() {
    const lines = [`# generated_at ${new Date().toISOString()}`];

    for (const [key, value] of this.counters.entries()) {
      lines.push(`${sanitizeMetricName(key)} ${value}`);
    }

    for (const [key, value] of this.gauges.entries()) {
      lines.push(`${sanitizeMetricName(key)} ${value}`);
    }

    lines.push(`app_uptime_seconds ${Math.round((Date.now() - this.startedAt) / 1000)}`);
    return `${lines.join('\n')}\n`;
  }
}

function sanitizeMetricName(name) {
  return String(name).replace(/[^a-zA-Z0-9_:]/g, '_');
}

module.exports = {
  Metrics
};
