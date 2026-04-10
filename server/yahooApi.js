const { XMLParser } = require('fast-xml-parser');

const API_BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';

function withTimeout(ms = 12_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

class YahooApiClient {
  constructor({ logger, authService, metrics = null }) {
    this.logger = logger;
    this.authService = authService;
    this.metrics = metrics;
    this.parser = new XMLParser({
      ignoreAttributes: true,
      parseTagValue: false,
      trimValues: true
    });
  }

  async request(pathWithParams) {
    const startedAt = Date.now();
    const accessToken = await this.authService.refreshAccessTokenIfNeeded();
    if (!accessToken) {
      throw new Error('Not authorized with Yahoo yet. Complete OAuth in /admin.');
    }

    const timeout = withTimeout();

    try {
      const response = await fetch(`${API_BASE}/${pathWithParams}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/xml'
        },
        signal: timeout.signal
      });

      const text = await response.text();

      if (!response.ok) {
        const message = text.slice(0, 300) || `HTTP ${response.status}`;
        const error = new Error(`Yahoo API request failed: ${message}`);
        error.statusCode = response.status;
        error.isRateLimit = response.status === 429 || /rate.?limit/i.test(message);

        const retryAfterHeader = Number(response.headers.get('retry-after'));
        if (Number.isFinite(retryAfterHeader) && retryAfterHeader > 0) {
          error.retryAfterMs = retryAfterHeader * 1000;
        }

        throw error;
      }

      this.metrics?.inc('yahoo_requests_total');
      this.metrics?.set('yahoo_last_request_duration_ms', Date.now() - startedAt);
      return this.parser.parse(text);
    } catch (error) {
      this.metrics?.inc('yahoo_requests_failed_total');
      this.logger.warn('Yahoo API request failed', { pathWithParams, error: error.message });
      throw error;
    } finally {
      timeout.clear();
    }
  }

  async fetchLeagueMetadata(leagueKey) {
    return this.request(`league/${leagueKey}`);
  }

  async fetchScoreboard(leagueKey, week) {
    const weekPart = week === 'current' ? '' : `;week=${week}`;
    return this.request(`league/${leagueKey}/scoreboard${weekPart}`);
  }

  async fetchStandings(leagueKey) {
    return this.request(`league/${leagueKey}/standings`);
  }

  async fetchLeagueSettings(leagueKey) {
    return this.request(`league/${leagueKey}/settings`);
  }

  async fetchTeamRosterWithStats(teamKey, week) {
    const numericWeek = Number(week);
    if (Number.isFinite(numericWeek) && numericWeek > 0) {
      return this.request(`team/${teamKey}/roster;week=${numericWeek}/players/stats;type=week;week=${numericWeek}`);
    }

    return this.request(`team/${teamKey}/roster/players/stats;type=week`);
  }

  async fetchGameKeyForSeason(season) {
    const payload = await this.request(`games;game_codes=nfl;seasons=${season}`);
    const gamesNode = payload?.fantasy_content?.games?.game;
    const game = Array.isArray(gamesNode) ? gamesNode[0] : gamesNode;
    return game?.game_key || null;
  }
}

module.exports = {
  YahooApiClient
};
