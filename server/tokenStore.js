const fs = require('node:fs/promises');
const path = require('node:path');

const TOKENS_PATH = path.resolve(process.cwd(), 'config', 'tokens.json');

async function loadTokens() {
  try {
    const raw = await fs.readFile(TOKENS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveTokens(tokens) {
  await fs.mkdir(path.dirname(TOKENS_PATH), { recursive: true });
  const payload = {
    ...tokens,
    updatedAt: new Date().toISOString()
  };
  await fs.writeFile(TOKENS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

async function clearTokens() {
  try {
    await fs.unlink(TOKENS_PATH);
  } catch {
    // Ignore if missing.
  }
}

function hasValidAccessToken(tokens) {
  if (!tokens || !tokens.access_token || !tokens.expires_at) {
    return false;
  }

  const expiresMs = new Date(tokens.expires_at).getTime();
  const now = Date.now();
  return Number.isFinite(expiresMs) && expiresMs - now > 60_000;
}

module.exports = {
  TOKENS_PATH,
  loadTokens,
  saveTokens,
  clearTokens,
  hasValidAccessToken
};
