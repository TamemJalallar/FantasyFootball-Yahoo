const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = 'obs-yahoo-fantasy-overlay';
const SETTINGS_PATH = path.resolve(process.cwd(), 'config', 'settings.json');

async function shouldUseOsKeychain() {
  if (String(process.env.USE_OS_KEYCHAIN || '').toLowerCase() === 'true') {
    return process.platform === 'darwin';
  }

  if (process.platform !== 'darwin') {
    return false;
  }

  try {
    const raw = await fs.readFile(SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Boolean(parsed?.security?.useOsKeychain);
  } catch {
    return false;
  }
}

async function findPassword(account) {
  const { stdout } = await execFileAsync('security', [
    'find-generic-password',
    '-a',
    account,
    '-s',
    KEYCHAIN_SERVICE,
    '-w'
  ]);

  return String(stdout || '').trim();
}

async function setPassword(account, value) {
  await execFileAsync('security', [
    'add-generic-password',
    '-a',
    account,
    '-s',
    KEYCHAIN_SERVICE,
    '-w',
    String(value),
    '-U'
  ]);
}

async function deletePassword(account) {
  try {
    await execFileAsync('security', [
      'delete-generic-password',
      '-a',
      account,
      '-s',
      KEYCHAIN_SERVICE
    ]);
  } catch {
    // Ignore missing keys.
  }
}

module.exports = {
  shouldUseOsKeychain,
  findPassword,
  setPassword,
  deletePassword,
  KEYCHAIN_SERVICE
};
