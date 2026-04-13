const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const LOGO_CACHE_DIR = path.resolve(process.cwd(), 'cache', 'logos');

function getExtensionFromUrl(url) {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname || '';
    const ext = path.extname(pathname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif'].includes(ext)) {
      return ext === '.jpeg' ? '.jpg' : ext;
    }
  } catch {
    // ignore
  }
  return '.img';
}

function hashUrl(url) {
  return crypto.createHash('sha1').update(String(url || '')).digest('hex');
}

function sanitizeFilename(fileName) {
  return String(fileName || '').replace(/[^a-z0-9._-]/gi, '_');
}

class LogoCache {
  constructor({ logger, metrics = null }) {
    this.logger = logger;
    this.metrics = metrics;
    this.known = new Map();
  }

  async init() {
    await fs.mkdir(LOGO_CACHE_DIR, { recursive: true });
  }

  fileNameForUrl(url) {
    const ext = getExtensionFromUrl(url);
    return sanitizeFilename(`${hashUrl(url)}${ext}`);
  }

  filePathForUrl(url) {
    return path.join(LOGO_CACHE_DIR, this.fileNameForUrl(url));
  }

  publicUrlForFile(fileName) {
    return `/logo-cache/${encodeURIComponent(fileName)}`;
  }

  extractLogoUrls(payload) {
    const urls = new Set();
    for (const matchup of payload?.matchups || []) {
      for (const team of [matchup?.teamA, matchup?.teamB]) {
        const logo = String(team?.logo || '').trim();
        if (logo && /^https?:\/\//i.test(logo)) {
          urls.add(logo);
        }
      }
    }
    return [...urls];
  }

  rewritePayloadLogos(payload) {
    if (!payload?.matchups?.length) {
      return payload;
    }

    for (const matchup of payload.matchups) {
      for (const team of [matchup?.teamA, matchup?.teamB]) {
        const logo = String(team?.logo || '').trim();
        if (!logo) {
          continue;
        }

        const mapped = this.known.get(logo);
        if (mapped) {
          team.logo = this.publicUrlForFile(mapped);
        }
      }
    }

    return payload;
  }

  async warmFromPayload(payload, { timeoutMs = 6000 } = {}) {
    const urls = this.extractLogoUrls(payload);
    return this.warmUrls(urls, { timeoutMs });
  }

  async warmUrls(urls = [], { timeoutMs = 6000 } = {}) {
    const list = [...new Set((urls || []).map((url) => String(url || '').trim()).filter(Boolean))];
    if (!list.length) {
      return { warmed: 0, skipped: 0, failed: 0, total: 0 };
    }

    let warmed = 0;
    let skipped = 0;
    let failed = 0;

    for (const url of list) {
      const fileName = this.fileNameForUrl(url);
      const target = path.join(LOGO_CACHE_DIR, fileName);

      try {
        await fs.access(target);
        this.known.set(url, fileName);
        skipped += 1;
        continue;
      } catch {
        // continue download
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 6000));

      try {
        const res = await fetch(url, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            Accept: 'image/*,*/*;q=0.8'
          }
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const arrayBuf = await res.arrayBuffer();
        const data = Buffer.from(arrayBuf);
        if (!data.length) {
          throw new Error('Empty image payload');
        }

        await fs.writeFile(target, data);
        this.known.set(url, fileName);
        warmed += 1;
      } catch (error) {
        failed += 1;
        this.logger?.warn('Logo cache warm failed', { url, error: error.message });
      } finally {
        clearTimeout(timer);
      }
    }

    this.metrics?.inc('logo_cache_warm_total', warmed);
    this.metrics?.inc('logo_cache_warm_failed_total', failed);
    this.metrics?.set('logo_cache_known_total', this.known.size);

    return {
      warmed,
      skipped,
      failed,
      total: list.length
    };
  }
}

module.exports = {
  LOGO_CACHE_DIR,
  LogoCache
};
