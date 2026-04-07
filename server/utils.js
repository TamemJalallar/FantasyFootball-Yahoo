function deepMerge(target, source) {
  if (!source || typeof source !== 'object') {
    return target;
  }

  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      target[key] = [...value];
      continue;
    }

    if (value && typeof value === 'object') {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      deepMerge(target[key], value);
      continue;
    }

    target[key] = value;
  }

  return target;
}

function deepClone(input) {
  return JSON.parse(JSON.stringify(input));
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, numeric));
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toArray(value) {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function safeString(value, fallback = '') {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatScore(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '--';
  }

  return Number(value).toFixed(2).replace(/\.00$/, '.0');
}

module.exports = {
  deepMerge,
  deepClone,
  clampNumber,
  toNumber,
  toArray,
  safeString,
  sleep,
  formatScore
};
