const TEAM_NAMES = [
  'Gridiron Reapers',
  'Sunday Surge',
  'Red Zone Syndicate',
  'Play Action Heroes',
  'Fourth and Wild',
  'No Punt Intended',
  'Goal Line Unit',
  'Snap Decision',
  'Air Raid Club',
  'Waiver Wire Kings'
];

const MANAGERS = [
  'Taylor',
  'Jordan',
  'Avery',
  'Cameron',
  'Skyler',
  'Riley',
  'Morgan',
  'Quinn',
  'Harper',
  'Logan'
];

function seededNumber(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function createTeam(seed, idx) {
  const base = 85 + seededNumber(seed + idx * 17) * 70;
  const projected = base + (seededNumber(seed + idx * 7) * 18 - 9);
  const wins = Math.floor(seededNumber(seed + idx * 13) * 8) + 2;
  const losses = Math.floor(seededNumber(seed + idx * 11) * 6) + 1;

  return {
    id: `mock-t-${idx}`,
    key: `mock.t.${idx}`,
    name: TEAM_NAMES[idx % TEAM_NAMES.length],
    manager: MANAGERS[idx % MANAGERS.length],
    logo: null,
    points: Number(base.toFixed(2)),
    projected: Number(projected.toFixed(2)),
    record: `${wins}-${losses}`,
    winProbability: Number((40 + seededNumber(seed + idx * 5) * 20).toFixed(1))
  };
}

function createMockMatchups({ week = 1, pinnedMatchupId = '' } = {}) {
  const now = Date.now() / 1000;
  const seed = Math.floor(now / 45);
  const matchups = [];

  for (let i = 0; i < 5; i += 1) {
    const teamA = createTeam(seed + i, i * 2);
    const teamB = createTeam(seed + i + 4, i * 2 + 1);
    const diff = Number((teamA.points - teamB.points).toFixed(2));
    const isLive = i < 4;
    const isFinal = i === 4;

    matchups.push({
      id: `mock-matchup-${i + 1}`,
      week,
      status: isFinal ? 'final' : (isLive ? 'live' : 'upcoming'),
      isLive,
      isFinal,
      teamA,
      teamB,
      projectedWinnerKey: (teamA.projected || 0) >= (teamB.projected || 0) ? teamA.key : teamB.key,
      winnerKey: diff >= 0 ? teamA.key : teamB.key,
      scoreDiff: Math.abs(diff),
      isClose: Math.abs(diff) <= 8,
      isUpset: ((teamA.projected || 0) < (teamB.projected || 0) && diff > 0) || ((teamB.projected || 0) < (teamA.projected || 0) && diff < 0),
      isGameOfWeek: pinnedMatchupId && pinnedMatchupId === `mock-matchup-${i + 1}`
    });
  }

  const closest = [...matchups]
    .filter((m) => m.isLive)
    .sort((a, b) => Math.abs(a.teamA.points - a.teamB.points) - Math.abs(b.teamA.points - b.teamB.points))[0];

  if (closest) {
    closest.isClosest = true;
  }

  return {
    league: {
      leagueKey: 'mock.l.12345',
      leagueId: '12345',
      name: 'Mock Broadcast League',
      season: new Date().getFullYear(),
      week,
      source: 'mock'
    },
    matchups,
    updatedAt: new Date().toISOString()
  };
}

module.exports = {
  createMockMatchups
};
