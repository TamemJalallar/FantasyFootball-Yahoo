const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const PROFILES_PATH = path.resolve(process.cwd(), 'config', 'profiles.json');

function toId(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function sanitizeSettings(settings) {
  const copy = JSON.parse(JSON.stringify(settings || {}));

  if (copy?.yahoo?.clientSecret) {
    copy.yahoo.clientSecret = '';
  }

  if (copy?.security?.adminApiKey) {
    copy.security.adminApiKey = '';
  }

  return copy;
}

async function ensureProfilesFile() {
  try {
    await fs.access(PROFILES_PATH);
  } catch {
    await fs.mkdir(path.dirname(PROFILES_PATH), { recursive: true });
    await fs.writeFile(
      PROFILES_PATH,
      `${JSON.stringify({ activeProfileId: null, profiles: [] }, null, 2)}\n`,
      'utf8'
    );
  }
}

async function loadProfiles() {
  await ensureProfilesFile();
  try {
    const raw = await fs.readFile(PROFILES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      activeProfileId: parsed.activeProfileId || null,
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : []
    };
  } catch {
    return {
      activeProfileId: null,
      profiles: []
    };
  }
}

async function saveProfiles(payload) {
  await fs.mkdir(path.dirname(PROFILES_PATH), { recursive: true });
  await fs.writeFile(PROFILES_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function listProfiles() {
  const payload = await loadProfiles();
  const profiles = payload.profiles
    .map((profile) => ({
      id: profile.id,
      name: profile.name,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
      league: {
        leagueId: profile.settings?.league?.leagueId || '',
        gameKey: profile.settings?.league?.gameKey || '',
        season: profile.settings?.league?.season || null,
        week: profile.settings?.league?.week || 'current'
      }
    }))
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  return {
    activeProfileId: payload.activeProfileId,
    profiles
  };
}

async function getProfile(profileId) {
  const payload = await loadProfiles();
  const profile = payload.profiles.find((item) => item.id === profileId);
  return profile || null;
}

async function upsertProfile({ id, name, settings }) {
  const payload = await loadProfiles();
  const now = new Date().toISOString();

  const safeName = String(name || '').trim() || 'League Profile';
  let profileId = toId(id || safeName);
  if (!profileId) {
    profileId = crypto.randomBytes(4).toString('hex');
  }

  const next = {
    id: profileId,
    name: safeName,
    settings: sanitizeSettings(settings),
    updatedAt: now,
    createdAt: now
  };

  const idx = payload.profiles.findIndex((item) => item.id === profileId);
  if (idx >= 0) {
    next.createdAt = payload.profiles[idx].createdAt || now;
    payload.profiles[idx] = next;
  } else {
    payload.profiles.push(next);
  }

  if (!payload.activeProfileId) {
    payload.activeProfileId = profileId;
  }

  await saveProfiles(payload);
  return next;
}

async function setActiveProfile(profileId) {
  const payload = await loadProfiles();
  const exists = payload.profiles.some((item) => item.id === profileId);
  if (!exists) {
    throw new Error('Profile not found.');
  }

  payload.activeProfileId = profileId;
  await saveProfiles(payload);
}

async function deleteProfile(profileId) {
  const payload = await loadProfiles();
  const before = payload.profiles.length;
  payload.profiles = payload.profiles.filter((item) => item.id !== profileId);

  if (payload.profiles.length === before) {
    return false;
  }

  if (payload.activeProfileId === profileId) {
    payload.activeProfileId = payload.profiles[0]?.id || null;
  }

  await saveProfiles(payload);
  return true;
}

module.exports = {
  PROFILES_PATH,
  listProfiles,
  getProfile,
  upsertProfile,
  setActiveProfile,
  deleteProfile
};
