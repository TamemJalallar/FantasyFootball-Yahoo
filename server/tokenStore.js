const fs = require('node:fs/promises');
const path = require('node:path');
const { shouldUseOsKeychain, findPassword, setPassword, deletePassword } = require('./keychainStore');

const TOKENS_PATH = path.resolve(process.cwd(), 'config', 'tokens.json');
const KEYCHAIN_TOKENS_ACCOUNT = 'tokens:yahoo';

async function loadTokens() {
  if (await shouldUseOsKeychain()) {
    try {
      const raw = await findPassword(KEYCHAIN_TOKENS_ACCOUNT);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  try {
    const raw = await fs.readFile(TOKENS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveTokens(tokens) {
  const payload = {
    ...tokens,
    updatedAt: new Date().toISOString()
  };

  if (await shouldUseOsKeychain()) {
    await setPassword(KEYCHAIN_TOKENS_ACCOUNT, JSON.stringify(payload));
    return payload;
  }

  await fs.mkdir(path.dirname(TOKENS_PATH), { recursive: true });
  await fs.writeFile(TOKENS_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

async function clearTokens() {
  if (await shouldUseOsKeychain()) {
    await deletePassword(KEYCHAIN_TOKENS_ACCOUNT);
    return;
  }

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
