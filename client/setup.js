const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(window.location.search);
const overlayKey = String(query.get('overlayKey') || '').trim();
const providerThemeParam = String(query.get('providerTheme') || '').trim().toLowerCase();

const SCENE_PRESETS = [
  {
    label: 'Main Matchup - Centered Card',
    route: '/overlay/centered-card',
    purpose: 'Primary head-to-head coverage',
    placement: 'Center screen',
    size: '1920x1080'
  },
  {
    label: 'Scoreboard - Lower Third',
    route: '/overlay/lower-third',
    purpose: 'In-game score strip',
    placement: 'Bottom third',
    size: '1920x420'
  },
  {
    label: 'Sidebar - Two Up Ready',
    route: '/overlay/sidebar-widget',
    purpose: 'Persistent side panel',
    placement: 'Right side',
    size: '640x1080'
  },
  {
    label: 'Ticker Bar - Footer',
    route: '/overlay/bottom-ticker',
    purpose: 'Continuous matchup crawl',
    placement: 'Bottom edge',
    size: '1920x220'
  },
  {
    label: 'Ticker-Only Mode',
    route: '/overlay/ticker',
    purpose: 'Dedicated horizontal ticker scene',
    placement: 'Bottom edge',
    size: '1920x140'
  }
];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeProvider(value, fallback = 'yahoo') {
  const key = String(value || '').trim().toLowerCase();
  return ['yahoo', 'espn', 'sleeper', 'mock'].includes(key) ? key : fallback;
}

function withOverlayKey(url) {
  if (!overlayKey) {
    return url;
  }
  const parsed = new URL(url, window.location.origin);
  parsed.searchParams.set('overlayKey', overlayKey);
  return parsed.toString();
}

function buildOverlayUrl(path) {
  const parsed = new URL(path, window.location.origin);
  for (const [k, value] of query.entries()) {
    if (['overlayKey', 'preset', 'mode'].includes(k)) {
      continue;
    }
    parsed.searchParams.set(k, value);
  }
  return withOverlayKey(parsed.toString());
}

async function fetchJson(url, { needsOverlayKey = false } = {}) {
  const target = needsOverlayKey ? withOverlayKey(url) : url;
  const res = await fetch(target, { cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message || `Request failed (${res.status})`);
  }
  return body;
}

function setChecklistNode(parent, { ok, title, detail }) {
  const node = document.createElement('article');
  node.className = `check-item ${ok ? 'ok' : 'warn'}`;
  node.innerHTML = `<strong>${ok ? 'PASS' : 'TODO'}</strong><span><strong>${escapeHtml(title)}:</strong> ${escapeHtml(detail)}</span>`;
  parent.appendChild(node);
}

function renderChecklist(snapshot) {
  const root = $('checkGrid');
  root.innerHTML = '';

  const settings = snapshot?.settings || {};
  const payload = snapshot?.payload || {};
  const status = snapshot?.status || {};
  const auth = snapshot?.authStatus || {};
  const provider = normalizeProvider(payload?.league?.source || settings?.data?.provider || 'yahoo', 'yahoo');
  const matchups = payload?.matchups || [];

  const providerConfigured = provider === 'yahoo'
    ? Boolean(settings?.league?.leagueId && settings?.yahoo?.clientId)
    : provider === 'espn'
      ? Boolean(settings?.espn?.leagueId)
      : provider === 'sleeper'
        ? Boolean(settings?.sleeper?.leagueId)
        : true;

  const authReady = provider === 'yahoo'
    ? Boolean(auth.configured && auth.authorized)
    : true;

  const leagueTargetSet = provider === 'yahoo'
    ? Boolean(settings?.league?.leagueId && (settings?.league?.gameKey || settings?.league?.season))
    : provider === 'espn'
      ? Boolean(settings?.espn?.leagueId && settings?.espn?.season)
      : provider === 'sleeper'
        ? Boolean(settings?.sleeper?.leagueId && settings?.sleeper?.season)
        : true;

  const hasData = matchups.length > 0;
  const lastSuccessAt = status?.lastSuccessAt ? new Date(status.lastSuccessAt).getTime() : 0;
  const syncing = Boolean(lastSuccessAt && (Date.now() - lastSuccessAt) < (4 * 60 * 1000));

  const checks = [];

  const addCheck = (entry) => {
    checks.push(entry);
    setChecklistNode(root, entry);
  };

  addCheck({
    ok: providerConfigured,
    title: 'Provider',
    detail: providerConfigured ? `${provider.toUpperCase()} provider config is set.` : 'Provider configuration is incomplete.'
  });

  addCheck({
    ok: authReady,
    title: 'Auth',
    detail: authReady
      ? (provider === 'yahoo' ? 'Yahoo OAuth authorized.' : 'No OAuth required for active provider.')
      : 'Complete Yahoo OAuth in Admin.'
  });

  addCheck({
    ok: leagueTargetSet,
    title: 'League',
    detail: leagueTargetSet ? 'League + week target configured.' : 'League target settings are incomplete.'
  });

  addCheck({
    ok: hasData,
    title: 'Data',
    detail: hasData ? `Loaded ${matchups.length} matchup(s).` : 'No matchup data yet. Run test/refresh in Admin.'
  });

  addCheck({
    ok: syncing,
    title: 'Sync',
    detail: syncing ? 'Recent sync detected.' : 'Recent sync not detected.'
  });

  addCheck({
    ok: Boolean(buildOverlayUrl('/overlay')),
    title: 'Overlay URL',
    detail: 'Browser Source URL generated and copy-ready.'
  });

  return checks;
}

function renderReadiness(snapshot, checks = [], validation = null) {
  const passed = checks.filter((item) => item.ok).length;
  const total = checks.length || 1;
  const score = Math.round((passed / total) * 100);

  const scoreNode = $('readinessScore');
  scoreNode.classList.remove('warn', 'bad');
  if (score < 60) {
    scoreNode.classList.add('bad');
  } else if (score < 100) {
    scoreNode.classList.add('warn');
  }

  const mode = snapshot?.status?.mode || snapshot?.payload?.league?.source || 'unknown';
  const provider = validation?.provider ? String(validation.provider).toUpperCase() : String(mode).toUpperCase();
  scoreNode.innerHTML = `<strong>${score}%</strong> readiness (${passed}/${total} checks passing) - Provider: ${escapeHtml(provider)}`;

  const actions = $('readinessActions');
  actions.innerHTML = '';

  const addAction = (label, href) => {
    const a = document.createElement('a');
    a.className = 'btn ghost';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = label;
    actions.appendChild(a);
  };

  const failedTitles = new Set(checks.filter((item) => !item.ok).map((item) => String(item.title || '').toLowerCase()));
  if (failedTitles.has('provider') || failedTitles.has('league')) {
    addAction('Fix Provider/League In Admin', '/admin');
  }
  if (failedTitles.has('auth')) {
    addAction('Complete Yahoo OAuth In Admin', '/admin');
  }
  if (failedTitles.has('data') || failedTitles.has('sync')) {
    addAction('Open Admin And Run Test Connection', '/admin');
  }
  if (failedTitles.has('overlay url')) {
    addAction('Open Overlay Preview', buildOverlayUrl('/overlay'));
  }

  if (!actions.children.length) {
    addAction('Open Admin', '/admin');
    addAction('Open Overlay', buildOverlayUrl('/overlay'));
  }

  if (validation?.issues?.length) {
    const issue = document.createElement('p');
    issue.className = 'subtle';
    issue.textContent = `Validation: ${validation.issues.join(' ')}`;
    actions.appendChild(issue);
  }
}

function renderSceneCards() {
  const root = $('sceneCards');
  root.innerHTML = '';

  for (const preset of SCENE_PRESETS) {
    const url = buildOverlayUrl(preset.route);
    const card = document.createElement('article');
    card.className = 'scene-card';
    card.innerHTML = `
      <h3>${escapeHtml(preset.label)}</h3>
      <p class="scene-kicker">Preset route: ${escapeHtml(preset.route)}</p>
      <div class="scene-meta">
        <p><strong>Use case:</strong> ${escapeHtml(preset.purpose)}</p>
        <p><strong>Placement:</strong> ${escapeHtml(preset.placement)}</p>
        <p><strong>Recommended size:</strong> ${escapeHtml(preset.size)}</p>
      </div>
      <input class="scene-url" type="text" readonly value="${escapeHtml(url)}" />
      <div class="scene-actions">
        <a class="btn ghost" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Preview</a>
        <button class="btn ghost copy-url-btn" type="button">Copy URL</button>
        <button class="btn ghost copy-label-btn" type="button">Copy Scene Label</button>
      </div>
    `;

    card.querySelector('.copy-url-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        $('statusLine').textContent = `Copied URL for "${preset.label}".`;
      } catch {
        $('statusLine').textContent = `Clipboard copy failed for "${preset.label}".`;
      }
    });

    card.querySelector('.copy-label-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(preset.label);
        $('statusLine').textContent = `Copied scene label "${preset.label}".`;
      } catch {
        $('statusLine').textContent = `Clipboard copy failed for "${preset.label}".`;
      }
    });

    root.appendChild(card);
  }
}

function renderProviderTheme(snapshot) {
  const settings = snapshot?.settings || {};
  const sourceProvider = normalizeProvider(snapshot?.payload?.league?.source || settings?.data?.provider || 'yahoo');
  const mode = String(settings?.overlay?.providerThemeMode || 'auto').toLowerCase();
  const manual = normalizeProvider(settings?.overlay?.providerThemeManual || 'yahoo');

  const active = mode === 'off'
    ? 'custom-only'
    : mode === 'manual'
      ? manual
      : sourceProvider;

  $('themeState').textContent = `Theme mode: ${mode.toUpperCase()} | Active provider pack: ${active.toUpperCase()} | Overlay provider source: ${sourceProvider.toUpperCase()}`;

  const providerLinks = $('providerLinks');
  providerLinks.innerHTML = '';
  const providers = ['yahoo', 'espn', 'sleeper', 'mock'];

  for (const provider of providers) {
    const link = buildOverlayUrl(`/overlay/centered-card?providerTheme=${provider}`);
    const node = document.createElement('article');
    node.className = 'provider-link-card';
    node.innerHTML = `
      <p>${escapeHtml(provider.toUpperCase())} preview link</p>
      <a class="btn ghost" href="${escapeHtml(link)}" target="_blank" rel="noreferrer">Open ${escapeHtml(provider.toUpperCase())} Theme</a>
    `;
    providerLinks.appendChild(node);
  }
}

function renderRepoDetails(repo) {
  const root = $('repoGrid');
  root.innerHTML = '';
  const rows = [
    ['Project', repo?.name || '--'],
    ['Version', repo?.version || '--'],
    ['Repository', repo?.repositoryUrl || '--'],
    ['Branch', repo?.branch || '--'],
    ['Commit', repo?.shortCommit ? `${repo.shortCommit} (${repo.commit || ''})` : '--'],
    ['Last Commit', repo?.lastCommitAt || '--'],
    ['Commit Subject', repo?.lastCommitSubject || '--'],
    ['Working Tree', repo?.dirty ? 'Dirty (uncommitted changes)' : 'Clean'],
    ['Node', repo?.nodeVersion || '--']
  ];

  for (const [label, value] of rows) {
    const item = document.createElement('article');
    item.className = 'repo-item';
    item.innerHTML = `
      <p class="repo-label">${escapeHtml(label)}</p>
      <p class="repo-value">${escapeHtml(String(value || '--'))}</p>
    `;
    root.appendChild(item);
  }
}

function buildSceneGuideMarkdown() {
  const lines = [
    '# OBS Scene Setup Guide',
    '',
    `Generated: ${new Date().toISOString()}`,
    ''
  ];

  for (const preset of SCENE_PRESETS) {
    const url = buildOverlayUrl(preset.route);
    lines.push(`## ${preset.label}`);
    lines.push(`- Use case: ${preset.purpose}`);
    lines.push(`- Placement: ${preset.placement}`);
    lines.push(`- Recommended size: ${preset.size}`);
    lines.push(`- URL: ${url}`);
    lines.push('');
  }

  return `${lines.join('\n').trim()}\n`;
}

function exportGuide() {
  const markdown = buildSceneGuideMarkdown();
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'obs-scene-setup-guide.md';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function loadPage() {
  $('openOverlayLink').href = buildOverlayUrl('/overlay');
  $('openAdminLink').href = '/admin';

  try {
    const [snapshot, repoPayload, validationPayload] = await Promise.all([
      fetchJson('/api/public-snapshot', { needsOverlayKey: true }),
      fetchJson('/api/repo-details'),
      fetchJson('/api/public-validation', { needsOverlayKey: true })
    ]);

    const checks = renderChecklist(snapshot);
    renderReadiness(snapshot, checks, validationPayload?.validation || null);
    renderSceneCards();
    renderProviderTheme(snapshot);
    renderRepoDetails(repoPayload.repo || {});

    const mode = snapshot?.status?.mode || snapshot?.payload?.league?.source || 'unknown';
    $('statusLine').textContent = `Setup loaded. Provider mode: ${String(mode).toUpperCase()}.`;
  } catch (error) {
    renderSceneCards();
    renderRepoDetails({});
    $('readinessScore').textContent = 'Readiness unavailable.';
    $('readinessActions').innerHTML = '<a class="btn ghost" href="/admin">Open Admin</a>';
    $('statusLine').textContent = `Setup data failed to load: ${error.message}${overlayKey ? '' : ' (If overlay key is enabled, append ?overlayKey=YOUR_KEY)'}`;
  }
}

$('exportGuideBtn').addEventListener('click', () => {
  exportGuide();
  $('statusLine').textContent = 'Scene guide exported.';
});

loadPage();
