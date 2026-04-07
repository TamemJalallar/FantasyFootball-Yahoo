const crypto = require('node:crypto');
const { loadTokens, saveTokens, clearTokens, hasValidAccessToken } = require('./tokenStore');

const AUTH_BASE = 'https://api.login.yahoo.com/oauth2';

function buildBasicAuth(clientId, clientSecret) {
  return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

function withTimeout(ms = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

class YahooAuthService {
  constructor({ logger, getSettings }) {
    this.logger = logger;
    this.getSettings = getSettings;
    this.pendingStates = new Map();
  }

  async getCredentials() {
    const settings = await this.getSettings();
    const { yahoo } = settings;

    return {
      clientId: yahoo.clientId,
      clientSecret: yahoo.clientSecret,
      redirectUri: yahoo.redirectUri,
      scope: yahoo.scope || 'fspt-r'
    };
  }

  async getAuthorizeUrl() {
    const { clientId, redirectUri, scope } = await this.getCredentials();

    if (!clientId || !redirectUri) {
      throw new Error('Yahoo client ID and redirect URI are required before starting OAuth.');
    }

    const state = crypto.randomBytes(16).toString('hex');
    this.pendingStates.set(state, Date.now());

    const url = new URL(`${AUTH_BASE}/request_auth`);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('language', 'en-us');
    url.searchParams.set('scope', scope || 'fspt-r');
    url.searchParams.set('state', state);

    return { url: url.toString(), state };
  }

  pruneStates() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [state, timestamp] of this.pendingStates.entries()) {
      if (timestamp < cutoff) {
        this.pendingStates.delete(state);
      }
    }
  }

  async exchangeCodeForToken(code, state) {
    this.pruneStates();
    if (!state || !this.pendingStates.has(state)) {
      throw new Error('Invalid OAuth state. Please retry authorization.');
    }

    this.pendingStates.delete(state);

    const { clientId, clientSecret, redirectUri } = await this.getCredentials();

    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error('Yahoo credentials are incomplete. Set client ID, client secret, and redirect URI.');
    }

    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      code
    });

    const timeout = withTimeout();

    try {
      const response = await fetch(`${AUTH_BASE}/get_token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${buildBasicAuth(clientId, clientSecret)}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString(),
        signal: timeout.signal
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(body.error_description || body.error || `Token exchange failed with HTTP ${response.status}`);
      }

      const expiresAt = new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000).toISOString();
      const tokens = await saveTokens({ ...body, expires_at: expiresAt });
      return tokens;
    } finally {
      timeout.clear();
    }
  }

  async refreshAccessTokenIfNeeded() {
    const tokens = await loadTokens();

    if (hasValidAccessToken(tokens)) {
      return tokens.access_token;
    }

    if (!tokens || !tokens.refresh_token) {
      return null;
    }

    const { clientId, clientSecret, redirectUri } = await this.getCredentials();

    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error('Yahoo credentials are incomplete.');
    }

    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      redirect_uri: redirectUri,
      refresh_token: tokens.refresh_token
    });

    const timeout = withTimeout();

    try {
      const response = await fetch(`${AUTH_BASE}/get_token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${buildBasicAuth(clientId, clientSecret)}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString(),
        signal: timeout.signal
      });

      const body = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(body.error_description || body.error || `Token refresh failed with HTTP ${response.status}`);
      }

      const merged = {
        ...tokens,
        ...body,
        refresh_token: body.refresh_token || tokens.refresh_token,
        expires_at: new Date(Date.now() + (Number(body.expires_in) || 3600) * 1000).toISOString()
      };

      await saveTokens(merged);
      this.logger.info('Yahoo access token refreshed');
      return merged.access_token;
    } finally {
      timeout.clear();
    }
  }

  async getAuthStatus() {
    const tokens = await loadTokens();
    const creds = await this.getCredentials();

    return {
      configured: Boolean(creds.clientId && creds.clientSecret && creds.redirectUri),
      authorized: Boolean(tokens && tokens.refresh_token),
      accessTokenValid: hasValidAccessToken(tokens),
      expiresAt: tokens?.expires_at || null,
      tokenUpdatedAt: tokens?.updatedAt || null
    };
  }

  async logout() {
    await clearTokens();
  }
}

module.exports = {
  YahooAuthService
};
