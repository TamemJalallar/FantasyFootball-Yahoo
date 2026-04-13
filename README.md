# Yahoo Fantasy Football OBS Overlay (Local)

A local Node.js + Express app that builds a real-time Yahoo Fantasy Football overlay for OBS Browser Source.

It supports:
- live matchup scoreboard polling
- touchdown player scan + alerts
- player-level scoring deltas for richer TD context
- rotating matchup carousel/ticker layouts
- no-refresh overlay updates via SSE
- admin/config UI with profile switching
- reliability features (cache fallback, retries, circuit breaker, diagnostics)

## Architecture

### Backend (`/server`)
- `index.js`: Express app, routes, SSE bootstrap.
- `dataService.js`: polling engine, change detection, TD scan, event pipeline.
- `yahooAuth.js`: Yahoo OAuth flow and token refresh.
- `yahooApi.js`: Yahoo REST calls.
- `normalizer.js`: converts Yahoo payloads to a stable internal overlay model.
- `configStore.js`: settings load/validate/save.
- `tokenStore.js`, `secretStore.js`, `keychainStore.js`: local secret/token persistence.
- `historyStore.js`: optional snapshot/event history (SQLite when available).
- `profileStore.js`: multi-league profile save/switch.
- `audioQueue.js`: throttled event hook dispatch.
- `obsController.js`: optional OBS WebSocket scene triggers.
- `metrics.js`: lightweight counters/gauges + Prometheus text endpoint.

### Frontend (`/client`)
- `overlay.html/css/js`: broadcast overlay rendering for `/overlay`.
- `admin.html/css/js`: local control panel at `/admin`.

### Data Flow
1. Poll scoreboard at high frequency.
2. Normalize matchup payload.
3. Detect score/lead/upset/final changes.
4. Broadcast `update`/`status` events over SSE.
5. Overlay applies updates without full rerender.
6. Separate TD scanner runs on its own interval and emits TD events.

## Quick Start

1. Install dependencies:
```bash
npm install
```

2. Create env file:
```bash
cp .env.example .env
```

3. Start local server:
```bash
npm run dev
```

4. Open:
- Admin: [http://localhost:3030/admin](http://localhost:3030/admin)
- Overlay: [http://localhost:3030/overlay](http://localhost:3030/overlay)

## Screenshots

### Animated Demo

![Overlay Animated Demo](docs/screenshots/overlay-demo.gif)

### Admin / Config

![Admin Config](docs/screenshots/admin-config.png)

### Overlay - Centered Card

![Overlay Centered Card](docs/screenshots/overlay-centered-card.png)

### Overlay - Lower Third

![Overlay Lower Third](docs/screenshots/overlay-lower-third.png)

### Overlay - Sidebar Two-Up

![Overlay Sidebar Two Up](docs/screenshots/overlay-sidebar-two-up.png)

### Overlay - Bottom Ticker

![Overlay Bottom Ticker](docs/screenshots/overlay-bottom-ticker.png)

To regenerate the GIF after UI updates:
```bash
node scripts/generate-demo-gif.js
```

## `.env.example`

```bash
PORT=3030
APP_BASE_URL=http://localhost:3030
YAHOO_CLIENT_ID=
YAHOO_CLIENT_SECRET=
YAHOO_REDIRECT_URI=http://localhost:3030/auth/callback
MOCK_MODE=true
ADMIN_API_KEY=
USE_OS_KEYCHAIN=false
```

## Yahoo OAuth Setup

1. Create Yahoo Developer app.
2. Set callback URI to `http://localhost:3030/auth/callback`.
3. In `/admin`, set `clientId`, `clientSecret`, redirect URI, and scope.
4. Save settings.
5. Click **Start Yahoo OAuth** and complete auth.

Storage behavior:
- Tokens: `config/tokens.json` (or macOS Keychain when enabled).
- Client secret/admin key: `config/secrets.json` (or macOS Keychain when enabled).
- Use `USE_OS_KEYCHAIN=true` or Admin setting `security.useOsKeychain=true` on macOS.

## High-Frequency Polling + TD Scan

Default frequency:
- scoreboard: every `10s` (`data.scoreboardPollMs`)
- TD scan: every `10s` (`data.tdScanIntervalMs`)

Adaptive polling:
- live slate: `adaptivePolling.liveMs`
- mixed slate: `adaptivePolling.mixedMs`
- idle slate: `adaptivePolling.idleMs`

Reliability controls:
- retry backoff + jitter
- circuit breaker with cooldown
- cached payload fallback
- preserved overlay rendering in degraded mode
- schedule-aware overnight throttling (NFL window aware)
- safe-mode startup fallback to cached/mock payload when Yahoo is unavailable

## Overlay Features

- carousel or ticker mode
- one-matchup or two-matchup layout
- score/projection/record/logo toggles
- smooth transitions for matchup rotation
- score delta indicators on changed scores
- closest matchup and upset highlight
- auto-redzone focus lock on close/upset/active swings
- matchup story cards between rotations (top score, closest game, momentum/player surge)
- final-score styling
- optional pinned Game of the Week
- dev-only updated indicator
- transparent background for OBS

## Admin Features

From `/admin` you can:
- manage Yahoo credentials + OAuth
- configure league id/game key/season/week
- set scoreboard and TD polling intervals
- configure schedule-aware polling window and off-hours poll rates
- tune adaptive polling + circuit breaker
- enable safe mode fallback behavior
- enable/disable projections/records/logos/ticker
- set theme colors/font scale/layout mode
- switch theme packs with one click
- save/switch/delete profiles (multi-league)
- force refresh and force next matchup
- export/import config JSON
- view diagnostics/events history
- export matchup timeline as JSON or CSV from history store
- configure audio hook and OBS scene automation

## Scene Presets + Query Params

Overlay route is fixed at `/overlay`.

Useful params:
- `preset=centered-card`
- `preset=lower-third`
- `preset=sidebar-widget`
- `preset=bottom-ticker`
- `mode=ticker`
- `twoUp=1`
- `scale=0.90`

Direct scene routes (OBS-friendly):
- `/overlay/centered-card`
- `/overlay/lower-third`
- `/overlay/sidebar-widget`
- `/overlay/bottom-ticker`
- `/overlay/ticker`

Example:
- `http://localhost:3030/overlay?preset=lower-third&scale=0.95`

## OBS Browser Source Setup

1. In OBS, add **Browser Source**.
2. URL: `http://localhost:3030/overlay`.
3. Recommended size: `1920 x 1080`.
4. Keep transparency enabled.
5. Optional: duplicate Browser Source with different query params per scene preset.

## API Endpoints

Public:
- `GET /health`
- `GET /metrics`
- `GET /events`
- `GET /api/public-config`
- `GET /overlay`
- `GET /overlay/centered-card`
- `GET /overlay/lower-third`
- `GET /overlay/sidebar-widget`
- `GET /overlay/bottom-ticker`
- `GET /overlay/ticker`
- `GET /admin`

Admin-protected (when `ADMIN_API_KEY` configured):
- `GET /api/config`
- `PUT /api/config`
- `GET /api/config/export`
- `POST /api/config/import`
- `GET /api/status`
- `GET /api/diagnostics`
- `GET /api/history`
- `GET /api/history/export?format=json|csv&hours=168`
- `GET /api/data`
- `POST /api/refresh`
- `POST /api/test-connection`
- `POST /api/control/next`
- `POST /api/auth/logout`
- `GET /auth/start`
- `GET /api/profiles`
- `POST /api/profiles/save`
- `POST /api/profiles/switch`
- `DELETE /api/profiles/:profileId`

## Mock/Fallback Mode

Use mock mode when Yahoo auth is not ready:
- Set `MOCK_MODE=true` in `.env`, or
- Toggle in Admin Data settings.

Mock mode keeps overlay fully testable for OBS scene/layout work.

## Tests and CI

Run locally:
```bash
npm test
```

GitHub Actions CI (`.github/workflows/ci.yml`) runs on push/PR:
- dependency install
- syntax checks
- unit tests

## Troubleshooting

### OAuth callback fails
- Verify redirect URI exactly matches Yahoo app config.
- Confirm client id/secret are valid.
- Use **Clear Stored Tokens** and retry.

### No live data
- Confirm league id and game key/season.
- Run **Test API Connection** in admin.
- Temporarily enable mock mode to verify overlay pipeline.

### Overlay not updating
- Check `/events` stream connectivity.
- Check `/health` and `/metrics`.
- Watch `/api/diagnostics` for polling errors/circuit-open state.

### TD alerts missing
- Ensure TD alerts are enabled.
- TD scan only tracks active lineup slots (bench/IR excluded).
- Dedup cooldown may suppress repeat events for same player total.

### Admin routes return 401
- If `ADMIN_API_KEY` is set, pass `x-admin-key` with admin requests.

### SQLite history unavailable
- `node:sqlite` may be unavailable on older Node versions.
- App will continue running; history snapshots are disabled gracefully.

## Customization Notes

Primary customization files:
- `config/settings.json` for persistent settings
- `client/overlay.css` for bespoke broadcast styling
- `public/themes/*.css` for reusable theme packs

For league-specific branding:
- use `league.teamNameOverrides`
- change `theme.primary`, `theme.secondary`, `theme.background`, `theme.text`
- set `overlay.scenePreset`, `overlay.layout`, `overlay.rotationIntervalMs`
