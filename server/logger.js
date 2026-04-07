const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function createLogger({ level = 'info' } = {}) {
  const current = LEVELS[level] || LEVELS.info;

  function print(method, name, message, meta) {
    if (LEVELS[name] < current) {
      return;
    }

    const ts = new Date().toISOString();
    const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
    method(`[${ts}] [${name.toUpperCase()}] ${message}${suffix}`);
  }

  return {
    debug: (message, meta) => print(console.log, 'debug', message, meta),
    info: (message, meta) => print(console.log, 'info', message, meta),
    warn: (message, meta) => print(console.warn, 'warn', message, meta),
    error: (message, meta) => print(console.error, 'error', message, meta)
  };
}

module.exports = {
  createLogger
};
