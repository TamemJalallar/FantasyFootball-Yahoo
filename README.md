# OBS Yahoo Fantasy Football Overlay (Local)

A lightweight local Node.js + Express app that renders a polished, OBS-ready browser overlay for Yahoo Fantasy Football weekly matchups.

## What You Get
- Yahoo Fantasy API integration with local OAuth flow
- Live matchup polling with automatic push updates over Server-Sent Events (SSE)
- OBS-friendly overlay route at `/overlay` with transparent background
- Rotating matchup carousel and optional ticker mode
- Admin UI at `/admin` for credentials, league config, display toggles, and theme controls
- Cache fallback (`/cache/matchups.json`) so the overlay stays up during API failures
- Mock mode for previewing layout without Yahoo auth
- Scene presets: bottom ticker, sidebar widget, lower-third, centered card
- Bonus features included:
  - Closest matchup highlight
  - Upset alert highlight
  - Game of the Week pin
  - Manual next-matchup trigger (admin button + keyboard shortcut `N` / `→`)
  - Optional score-change webhook/sound hook
  - Live TD player alerts (starter touchdown detection)

## Project Structure

```txt
OBS/
├─ client/
│  ├─ admin.html
│  ├─ admin.css
│  ├─ admin.js
│  ├─ overlay.html
│  ├─ overlay.css
│  └─ overlay.js
├─ server/
│  ├─ index.js
│  ├─ dataService.js
│  ├─ yahooAuth.js
│  ├─ yahooApi.js
│  ├─ normalizer.js
│  ├─ configStore.js
│  ├─ tokenStore.js
│  ├─ cacheStore.js
│  ├─ sseHub.js
│  ├─ mockData.js
│  ├─ defaultSettings.js
│  ├─ logger.js
│  └─ utils.js
├─ public/
│  ├─ assets/
│  │  └─ logo-fallback.svg
│  └─ themes/
│     ├─ neon-grid.css
│     ├─ classic-gold.css
│     └─ ice-night.css
├─ config/
│  ├─ settings.json
│  └─ settings.example.json
├─ cache/
│  └─ .gitkeep
├─ .env.example
├─ .gitignore
├─ package.json
└─ README.md
```

## Install & Run

1. Install dependencies:
```bash
npm install
```

2. Copy environment template:
```bash
cp .env.example .env
```

3. Start app:
```bash
npm run dev
```
or
```bash
npm start
```

4. Open admin page:
- [http://localhost:3030/admin](http://localhost:3030/admin)

5. Overlay URL:
- [http://localhost:3030/overlay](http://localhost:3030/overlay)

## Yahoo OAuth Setup (Practical Flow)

1. Create a Yahoo developer app and get:
- Client ID
- Client Secret

2. In Yahoo app settings, set redirect URI to:
- `http://localhost:3030/auth/callback`

3. In `/admin`, enter:
- Client ID
- Client Secret
- Redirect URI
- Scope (`fspt-r`)

4. Save settings, then click **Start Yahoo OAuth**.

5. Complete Yahoo authorization in browser.

6. App stores tokens locally in:
- `config/tokens.json`

7. Token behavior:
- Access token auto-refreshes when needed
- Refresh token is reused and replaced if Yahoo returns a new one

## League & Data Configuration

Use `/admin` to set:
- `league_id`
- `game_key` (recommended)
- OR `season` (app attempts to resolve `game_key`)
- week (`current` or custom week)
- polling interval
- retry/backoff max delay
- optional team name overrides JSON

Example overrides JSON:
```json
{
  "449.l.12345.t.1": "PrimeTime Ballers",
  "449.l.12345.t.4": "Monday Night Mayhem"
}
```

## Overlay Display Controls

From admin page you can configure:
- Carousel or ticker mode
- One-matchup or two-matchup layout
- Rotation interval
- Compact/full layout
- Show/hide projections, records, logos, footer ticker
- Show/hide TD alerts + alert duration
- Closest matchup + upset alerts
- Game of the Week matchup id
- Scene preset
- Theme colors and font scale

## OBS Browser Source Setup

1. Add **Browser Source** in OBS.
2. Set URL to:
- `http://localhost:3030/overlay`
3. Recommended dimensions:
- Width: `1920`
- Height: `1080`
4. Keep background transparent (default in this overlay).
5. Optional query params for per-scene variants:
- `?preset=centered-card`
- `?preset=lower-third`
- `?preset=sidebar-widget`
- `?preset=bottom-ticker`
- `?mode=ticker`
- `?twoUp=1`
- `?scale=0.9`

Examples:
- `http://localhost:3030/overlay?preset=lower-third`
- `http://localhost:3030/overlay?preset=sidebar-widget&twoUp=1&scale=0.95`

## Live Update Behavior

- Polls Yahoo on configured interval
- Uses SSE (`/events`) to push updates to overlay immediately
- Detects changed scores and animates score values
- Avoids full page reload/flicker
- Backoff retry when Yahoo fails
- Uses last known cache if upstream is down

## Mock/Fallback Preview Mode

If Yahoo auth is not ready yet:
- Enable **Mock mode** in `/admin`
- Overlay generates dynamic sample matchups
- Use this for style/layout tuning before live auth

## Config & Theme Files

- Main runtime config: `config/settings.json`
- Example config: `config/settings.example.json`
- Env template: `.env.example`
- Sample palette files: `public/themes/*.css`

## Sound Hook (Optional)

Set `soundHookUrl` in admin. On score or TD updates, the server sends:

```json
{
  "type": "overlay_update",
  "scoreChanges": [
    {
      "matchupId": "...",
      "teamA": {"from": 98.3, "to": 101.7, "key": "..."},
      "teamB": {"from": 87.2, "to": 87.2, "key": "..."}
    }
  ],
  "tdEvents": [
    {
      "playerName": "Amon-Ra St. Brown",
      "fantasyTeamName": "PrimeTime Ballers",
      "tdTypes": ["Receiving TD"]
    }
  ],
  "ts": "2026-04-06T00:00:00.000Z"
}
```

When there are no score/TD changes, no hook payload is sent.

Legacy score-only shape (still conceptually supported):

```json
{
  "type": "overlay_update",
  "changes": [
    {
      "matchupId": "...",
      "teamA": {"from": 98.3, "to": 101.7, "key": "..."},
      "teamB": {"from": 87.2, "to": 87.2, "key": "..."}
    }
  ],
  "ts": "2026-04-06T00:00:00.000Z"
}
```

Use that endpoint to trigger local audio or stream automation.

## Troubleshooting

### OAuth fails or callback errors
- Verify redirect URI matches exactly in Yahoo app and admin config
- Ensure Client ID/Secret are correct
- Re-run OAuth from `/admin`
- Clear tokens using **Clear Stored Tokens** and retry

### No live data
- Confirm mock mode is OFF
- Confirm `league_id` and `game_key` are correct
- Use **Test API Connection** in admin
- Check server logs for Yahoo response errors

### Overlay not updating in OBS
- Confirm OBS Browser Source URL is `http://localhost:3030/overlay`
- Ensure local app is running
- Click **Force Refresh** in admin
- If needed, refresh Browser Source in OBS

### Logos missing
- Yahoo logos are used when available
- Overlay automatically falls back to generated initials badge

### Rate-limit or intermittent Yahoo errors
- Increase refresh interval (e.g., 45s to 60s+)
- Keep backoff enabled (default)
- App will keep rendering cached data on transient failures

## Notes

- This app is local-first and production-minded for stream reliability.
- Credentials and tokens are stored locally for convenience in development workflows.
- If you want, this can be extended with SQLite persistence and historical matchup snapshots.
