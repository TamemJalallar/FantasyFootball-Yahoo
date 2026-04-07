const fs = require('node:fs/promises');
const path = require('node:path');

const CACHE_PATH = path.resolve(process.cwd(), 'cache', 'matchups.json');

async function readCache() {
  try {
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(payload) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

module.exports = {
  CACHE_PATH,
  readCache,
  writeCache
};
