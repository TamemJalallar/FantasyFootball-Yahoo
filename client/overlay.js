const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  payload: null,
  status: null,
  activeIndex: 0,
  rotationTimer: null,
  eventSource: null,
  changedTeamKeys: new Set(),
  tdAlertTimers: []
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatScore(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '--';
  }
  return Number(value).toFixed(2).replace(/\.00$/, '.0');
}

function formatRecord(record, enabled) {
  if (!enabled || !record) {
    return '';
  }
  return `Record ${record}`;
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).slice(0, 2);
  return parts.map((x) => x[0] || '').join('').toUpperCase() || 'FF';
}

function statusClass(status) {
  if (status === 'live') return 'live';
  if (status === 'final') return 'final';
  return 'upcoming';
}

function parseQueryOverrides(settings) {
  const params = new URLSearchParams(window.location.search);
  const override = JSON.parse(JSON.stringify(settings));

  if (params.get('mode')) {
    override.overlay.mode = params.get('mode');
  }

  if (params.get('preset')) {
    override.overlay.scenePreset = params.get('preset');
  }

  if (params.get('scale')) {
    const scale = Number(params.get('scale'));
    if (Number.isFinite(scale) && scale > 0.3 && scale < 3) {
      document.documentElement.style.setProperty('--overlay-scale', String(scale));
    }
  }

  if (params.get('twoUp') === '1') {
    override.overlay.twoMatchupLayout = true;
  }

  return override;
}

function setBodyClasses(settings) {
  const preset = settings.overlay.scenePreset || 'centered-card';
  document.body.className = '';
  document.body.classList.add(`preset-${preset}`);

  if (settings.overlay.layout === 'compact' || settings.theme.compact) {
    document.body.classList.add('compact');
  }
}

function applyTheme(settings) {
  document.documentElement.style.setProperty('--primary', settings.theme.primary || '#13f1b7');
  document.documentElement.style.setProperty('--secondary', settings.theme.secondary || '#3d5cff');
  document.documentElement.style.setProperty('--bg-glass', settings.theme.background || 'rgba(8, 12, 24, 0.72)');
  document.documentElement.style.setProperty('--text-main', settings.theme.text || '#f6f8ff');
  document.documentElement.style.setProperty('--text-muted', settings.theme.mutedText || '#aab3ca');
  document.documentElement.style.setProperty('--font-scale', String(settings.theme.fontScale || 1));
}

function setDevUpdated(updatedAt) {
  const node = $('devUpdated');

  if (!state.settings?.dev?.showUpdatedIndicator) {
    node.classList.add('hidden');
    return;
  }

  const value = updatedAt ? new Date(updatedAt).toLocaleTimeString() : '--';
  node.textContent = `Updated ${value}`;
  node.classList.remove('hidden');
}

function clearTdAlerts() {
  for (const timer of state.tdAlertTimers) {
    clearTimeout(timer);
  }
  state.tdAlertTimers = [];
  const container = $('tdAlerts');
  container.innerHTML = '';
}

function renderTdEvents(tdEvents = []) {
  const container = $('tdAlerts');

  if (!state.settings?.overlay?.showTdAlerts) {
    container.classList.add('hidden');
    clearTdAlerts();
    return;
  }

  container.classList.remove('hidden');
  if (!tdEvents.length) {
    return;
  }

  const duration = Number(state.settings.overlay.tdAlertDurationMs || 8000);

  for (const event of tdEvents) {
    const card = document.createElement('article');
    card.className = 'td-alert';

    const title = document.createElement('p');
    title.className = 'td-title';
    title.textContent = `${event.playerName || 'Player'} TD`;

    const subtitle = document.createElement('p');
    subtitle.className = 'td-sub';
    const details = [
      event.fantasyTeamName || '',
      event.manager || '',
      Array.isArray(event.tdTypes) && event.tdTypes.length ? event.tdTypes.join(', ') : ''
    ].filter(Boolean).join(' • ');
    subtitle.textContent = details || 'Touchdown scored';

    card.appendChild(title);
    card.appendChild(subtitle);
    container.prepend(card);

    while (container.children.length > 4) {
      container.removeChild(container.lastElementChild);
    }

    requestAnimationFrame(() => {
      card.classList.add('show');
    });

    const hideTimer = setTimeout(() => {
      card.classList.remove('show');
      card.classList.add('hide');
      const removeTimer = setTimeout(() => {
        card.remove();
      }, 360);
      state.tdAlertTimers.push(removeTimer);
    }, duration);

    state.tdAlertTimers.push(hideTimer);
  }
}

function createLogoNode(team) {
  if (state.settings.overlay.showLogos && team.logo) {
    const src = escapeHtml(team.logo);
    const alt = escapeHtml(`${team.name} logo`);
    return `<img class="logo" src="${src}" alt="${alt}" loading="lazy" />`;
  }

  const text = escapeHtml(initials(team.name));
  return `<div class="logo logo-fallback" aria-hidden="true">${text}</div>`;
}

function createTeamRow(team, isLeading, sideLabel) {
  const changed = state.changedTeamKeys.has(team.key) ? 'score-pop' : '';
  const extra = [
    formatRecord(team.record, state.settings.overlay.showRecords),
    state.settings.overlay.showProjections && team.projected !== null ? `Proj ${formatScore(team.projected)}` : '',
    team.winProbability !== null && team.winProbability !== undefined ? `Win ${Number(team.winProbability).toFixed(1)}%` : ''
  ].filter(Boolean).join(' • ');

  return `
    <article class="team-row ${isLeading ? 'leading' : ''}">
      ${createLogoNode(team)}
      <div class="team-meta">
        <p class="team-name">${escapeHtml(team.name)}</p>
        <p class="team-manager">${escapeHtml(sideLabel)}: ${escapeHtml(team.manager || 'Manager')}</p>
        ${extra ? `<p class="team-extra">${escapeHtml(extra)}</p>` : ''}
      </div>
      <div class="team-score ${changed}">${formatScore(team.points)}</div>
    </article>
  `;
}

function createBadgeList(matchup) {
  const badges = [`<span class="badge ${statusClass(matchup.status)}">${matchup.status}</span>`];

  if (matchup.isGameOfWeek) {
    badges.push('<span class="badge">Game of the Week</span>');
  }

  if (matchup.isClosest) {
    badges.push('<span class="badge">Closest</span>');
  }

  if (matchup.isUpset) {
    badges.push('<span class="badge">Upset Alert</span>');
  }

  return badges.join('');
}

function createMatchupCard(matchup) {
  const a = matchup.teamA;
  const b = matchup.teamB;
  const aLeads = (a.points ?? 0) >= (b.points ?? 0);

  const cardClasses = [
    'matchup-card',
    matchup.status === 'final' ? 'final' : '',
    matchup.isClosest ? 'closest' : '',
    matchup.isUpset ? 'upset' : ''
  ].filter(Boolean).join(' ');

  return `
    <section class="${cardClasses}">
      <header class="matchup-head">
        <div class="badges">${createBadgeList(matchup)}</div>
        <span class="week-label">Week ${matchup.week}</span>
      </header>

      ${createTeamRow(a, aLeads, 'Home')}
      ${createTeamRow(b, !aLeads, 'Away')}

      ${state.settings.overlay.showProjections
    ? `<div class="projection"><span>Projected Winner: ${escapeHtml(matchup.projectedWinnerKey === a.key ? a.name : b.name)}</span><span>Diff ${formatScore(matchup.scoreDiff)}</span></div>`
    : ''}
    </section>
  `;
}

function renderCarousel() {
  const stage = $('carouselStage');
  const tickerStage = $('tickerStage');
  tickerStage.classList.add('hidden');
  stage.classList.remove('hidden');

  const matchups = state.payload?.matchups || [];

  if (!matchups.length) {
    stage.innerHTML = '<div class="matchup-wrap"><section class="matchup-card"><p>No matchup data available.</p></section></div>';
    return;
  }

  const twoUp = state.settings.overlay.twoMatchupLayout && matchups.length > 1;

  if (twoUp) {
    const m1 = matchups[state.activeIndex % matchups.length];
    const m2 = matchups[(state.activeIndex + 1) % matchups.length];

    stage.innerHTML = `
      <div class="matchup-wrap two-up">
        ${createMatchupCard(m1)}
        ${createMatchupCard(m2)}
      </div>
    `;
  } else {
    const current = matchups[state.activeIndex % matchups.length];
    stage.innerHTML = `
      <div class="matchup-wrap">
        ${createMatchupCard(current)}
      </div>
    `;
  }
}

function tickerText(matchup) {
  const a = matchup.teamA;
  const b = matchup.teamB;
  return `${escapeHtml(a.name)} ${formatScore(a.points)} - ${formatScore(b.points)} ${escapeHtml(b.name)}`;
}

function renderTickerMode() {
  const stage = $('tickerStage');
  const carouselStage = $('carouselStage');

  carouselStage.classList.add('hidden');
  stage.classList.remove('hidden');

  const matchups = state.payload?.matchups || [];

  if (!matchups.length) {
    stage.innerHTML = '<div class="ticker-track"><span class="ticker-item">No live data.</span></div>';
    return;
  }

  const items = [...matchups, ...matchups].map((matchup) => {
    const klass = ['ticker-item', matchup.isClosest ? 'closest' : '', matchup.isUpset ? 'upset' : ''].filter(Boolean).join(' ');
    return `<span class="${klass}">${tickerText(matchup)}</span>`;
  }).join('');

  stage.innerHTML = `<div class="ticker-track">${items}</div>`;
}

function renderFooterTicker() {
  const footer = $('footerTicker');

  if (!state.settings.overlay.showTicker || !state.payload?.matchups?.length) {
    footer.classList.add('hidden');
    footer.innerHTML = '';
    return;
  }

  const line = [...state.payload.matchups, ...state.payload.matchups]
    .map((m) => `${tickerText(m)} (${m.status.toUpperCase()})`)
    .join('    •    ');

  footer.classList.remove('hidden');
  footer.innerHTML = `<div class="line">${line}</div>`;
}

function render() {
  if (!state.settings) {
    return;
  }

  applyTheme(state.settings);
  setBodyClasses(state.settings);
  setDevUpdated(state.payload?.updatedAt || state.status?.lastSuccessAt);

  if (state.settings.overlay.mode === 'ticker') {
    renderTickerMode();
  } else {
    renderCarousel();
  }

  renderFooterTicker();

  window.setTimeout(() => {
    state.changedTeamKeys.clear();
  }, 800);
}

function stopRotation() {
  if (state.rotationTimer) {
    clearInterval(state.rotationTimer);
    state.rotationTimer = null;
  }
}

function nextMatchup() {
  const length = state.payload?.matchups?.length || 0;
  if (!length) {
    return;
  }

  state.activeIndex = (state.activeIndex + 1) % length;
  if (state.settings.overlay.mode === 'carousel') {
    renderCarousel();
    renderFooterTicker();
  }
}

function startRotation() {
  stopRotation();

  if (!state.settings || state.settings.overlay.mode === 'ticker') {
    return;
  }

  const length = state.payload?.matchups?.length || 0;
  if (length <= 1) {
    return;
  }

  const ms = Number(state.settings.overlay.rotationIntervalMs || 9000);
  state.rotationTimer = setInterval(nextMatchup, ms);
}

function onPayloadUpdate(payload, scoreChanges = [], tdEvents = []) {
  state.payload = payload;

  const length = state.payload?.matchups?.length || 0;
  if (state.activeIndex >= length) {
    state.activeIndex = 0;
  }

  state.changedTeamKeys.clear();
  for (const change of scoreChanges) {
    if (change.teamA?.from !== change.teamA?.to) {
      state.changedTeamKeys.add(change.teamA.key);
    }
    if (change.teamB?.from !== change.teamB?.to) {
      state.changedTeamKeys.add(change.teamB.key);
    }
  }

  render();
  renderTdEvents(tdEvents);
  startRotation();
}

function connectSse() {
  const es = new EventSource('/events');
  state.eventSource = es;

  es.addEventListener('init', (event) => {
    const data = JSON.parse(event.data || '{}');
    state.settings = parseQueryOverrides(data.settings);
    state.status = data.status;
    onPayloadUpdate(data.payload || { matchups: [] }, [], []);
  });

  es.addEventListener('update', (event) => {
    const data = JSON.parse(event.data || '{}');
    state.status = data.status || state.status;
    onPayloadUpdate(data.payload || state.payload, data.scoreChanges || [], data.tdEvents || []);
  });

  es.addEventListener('status', (event) => {
    const data = JSON.parse(event.data || '{}');
    state.status = data;
    setDevUpdated(data.lastSuccessAt);
  });

  es.addEventListener('config', (event) => {
    const data = JSON.parse(event.data || '{}');
    if (data.settings) {
      state.settings = parseQueryOverrides(data.settings);
      render();
      renderTdEvents([]);
      startRotation();
    }
  });

  es.addEventListener('control', (event) => {
    const data = JSON.parse(event.data || '{}');
    if (data.action === 'next') {
      nextMatchup();
    }
  });

  es.onerror = () => {
    if (state.eventSource) {
      setDevUpdated(state.status?.lastSuccessAt || null);
    }
  };
}

window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'n' || event.key === 'ArrowRight') {
    nextMatchup();
  }
});

connectSse();
