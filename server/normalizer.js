const { toArray, toNumber, safeString } = require('./utils');

function getIn(obj, path, fallback = null) {
  let current = obj;
  for (const segment of path) {
    if (current === null || current === undefined) {
      return fallback;
    }
    current = current[segment];
  }
  return current ?? fallback;
}

function parseFantasyRoot(payload) {
  return payload?.fantasy_content || payload || {};
}

function parseLeague(payload) {
  const root = parseFantasyRoot(payload);
  return root.league || {};
}

function parseMatchupStatus(rawStatus) {
  const status = safeString(rawStatus).toLowerCase();
  if (['postevent', 'final', 'ended'].includes(status)) {
    return 'final';
  }
  if (['midevent', 'live', 'inprogress'].includes(status)) {
    return 'live';
  }
  return 'upcoming';
}

function extractManagerName(teamNode) {
  const managerNode = getIn(teamNode, ['managers', 'manager']) || teamNode?.manager;
  const manager = toArray(managerNode)[0] || managerNode;

  return safeString(
    manager?.nickname || manager?.manager_name || manager?.guid || manager?.email || '',
    'Manager'
  );
}

function extractTeamLogo(teamNode) {
  const logosNode = getIn(teamNode, ['team_logos', 'team_logo']);
  const logo = toArray(logosNode)[0] || logosNode;
  return safeString(logo?.url, null);
}

function extractRecord(teamNode, recordsByTeamKey) {
  const teamKey = safeString(teamNode?.team_key, '');
  if (teamKey && recordsByTeamKey[teamKey]) {
    return recordsByTeamKey[teamKey];
  }

  const wins = getIn(teamNode, ['team_standings', 'outcome_totals', 'wins']);
  const losses = getIn(teamNode, ['team_standings', 'outcome_totals', 'losses']);
  const ties = getIn(teamNode, ['team_standings', 'outcome_totals', 'ties']);

  if (wins === null || losses === null) {
    return null;
  }

  const tieNum = Number(ties || 0);
  return tieNum > 0 ? `${wins}-${losses}-${tieNum}` : `${wins}-${losses}`;
}

function findProb(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  if (node.win_probability !== undefined) {
    return toNumber(node.win_probability, null);
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (typeof value === 'object') {
      const nested = findProb(value);
      if (nested !== null) {
        return nested;
      }
    }
  }

  return null;
}

function normalizeTeam(teamNode, recordsByTeamKey, teamNameOverrides = {}) {
  const teamKey = safeString(teamNode?.team_key, '');
  const rawName = safeString(teamNode?.name, 'Unknown Team');

  return {
    id: safeString(teamNode?.team_id, teamKey || rawName),
    key: teamKey,
    name: teamNameOverrides[teamKey] || rawName,
    manager: extractManagerName(teamNode),
    logo: extractTeamLogo(teamNode),
    points: toNumber(getIn(teamNode, ['team_points', 'total']), null),
    projected: toNumber(getIn(teamNode, ['team_projected_points', 'total']), null),
    record: extractRecord(teamNode, recordsByTeamKey),
    winProbability: findProb(teamNode)
  };
}

function parseRecordsMap(standingsPayload) {
  const league = parseLeague(standingsPayload);
  const teams = toArray(getIn(league, ['standings', 'teams', 'team'], []));

  const byTeamKey = {};
  for (const team of teams) {
    const teamKey = safeString(team?.team_key, '');
    if (!teamKey) {
      continue;
    }

    const wins = getIn(team, ['team_standings', 'outcome_totals', 'wins']);
    const losses = getIn(team, ['team_standings', 'outcome_totals', 'losses']);
    const ties = Number(getIn(team, ['team_standings', 'outcome_totals', 'ties'], 0));

    if (wins !== null && losses !== null) {
      byTeamKey[teamKey] = ties > 0 ? `${wins}-${losses}-${ties}` : `${wins}-${losses}`;
    }
  }

  return byTeamKey;
}

function normalizeYahooMatchups({ scoreboardPayload, standingsPayload, settings }) {
  const leagueNode = parseLeague(scoreboardPayload);
  const recordsByTeamKey = parseRecordsMap(standingsPayload);
  const matchupNodes = toArray(getIn(leagueNode, ['scoreboard', 'matchups', 'matchup'], []));
  const overrides = settings?.league?.teamNameOverrides || {};

  const normalizedMatchups = matchupNodes
    .map((node, idx) => {
      const teams = toArray(getIn(node, ['teams', 'team'], [])).slice(0, 2);
      if (teams.length < 2) {
        return null;
      }

      const teamA = normalizeTeam(teams[0], recordsByTeamKey, overrides);
      const teamB = normalizeTeam(teams[1], recordsByTeamKey, overrides);
      const matchupId = safeString(node.matchup_id, `${teamA.key}-vs-${teamB.key || idx}`);
      const status = parseMatchupStatus(node.status);
      const diff = (teamA.points ?? 0) - (teamB.points ?? 0);

      const projectedWinnerKey =
        (teamA.projected ?? Number.NEGATIVE_INFINITY) >= (teamB.projected ?? Number.NEGATIVE_INFINITY)
          ? teamA.key
          : teamB.key;

      return {
        id: matchupId,
        week: Number(node.week || getIn(leagueNode, ['scoreboard', 'week']) || settings?.league?.week || 1),
        status,
        isLive: status === 'live',
        isFinal: status === 'final',
        teamA,
        teamB,
        winnerKey: safeString(node.winner_team_key, diff >= 0 ? teamA.key : teamB.key),
        projectedWinnerKey,
        scoreDiff: Math.abs(Number(diff.toFixed(2))),
        isClose: Math.abs(diff) <= 8,
        isUpset:
          (teamA.projected !== null && teamB.projected !== null && teamA.projected < teamB.projected && diff > 0) ||
          (teamA.projected !== null && teamB.projected !== null && teamB.projected < teamA.projected && diff < 0),
        isGameOfWeek: settings?.overlay?.gameOfWeekMatchupId === matchupId
      };
    })
    .filter(Boolean);

  const closest = [...normalizedMatchups]
    .filter((m) => m.isLive)
    .sort((a, b) => Math.abs((a.teamA.points ?? 0) - (a.teamB.points ?? 0)) - Math.abs((b.teamA.points ?? 0) - (b.teamB.points ?? 0)))[0];

  if (closest) {
    closest.isClosest = true;
  }

  const league = {
    leagueKey: safeString(leagueNode.league_key, ''),
    leagueId: safeString(leagueNode.league_id, settings?.league?.leagueId || ''),
    name: safeString(leagueNode.name, 'Yahoo Fantasy League'),
    season: Number(leagueNode.season || settings?.league?.season || new Date().getFullYear()),
    week: Number(getIn(leagueNode, ['scoreboard', 'week']) || leagueNode.current_week || settings?.league?.week || 1),
    source: 'yahoo'
  };

  return {
    league,
    matchups: normalizedMatchups,
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  normalizeYahooMatchups
};
