# Recycle Heroes!

A single-screen kiosk app for event check-in/registration, plus an admin suite.
No routing, no backend server — all data lives in the browser's
`localStorage`. Optionally paired with an RFID/NFC card bridge so check-in
can be a tap instead of typing a username.

**Status:** actively developed, pre-beta. Admin tools are intentionally
unauthenticated for now (see [Security posture](#security-posture)) — this
is a decision to revisit at open-beta prep, not an oversight.

## Project structure

```
index.html            page shell; applies the saved theme before first
                       paint so there's no flash of the wrong one
src/
  index.js             minimal bootstrap (mounts <App />)
  App.js               check-in, registration, the entire admin suite,
                        validation, data integrity checks, CSV/JSON
                        export — all in one file (per spec: no JSX build
                        step, React.createElement directly)
  ZipHeatMap.js         Analytics panel's ZIP check-in density map
                        (Leaflet + OpenStreetMap tiles)
  PatternChart.js       Analytics panel's small-multiple check-in-by-
                        time-of-day charts
  App.css               styling, incl. dark/light theme variables
public/
  detroit_zip_polygons.geojson   local ZIP boundary data for the heat
                                   map (the map tiles themselves are
                                   fetched live; this file is not)
rfid-bridge/            standalone .NET console app — the RFID/NFC card
                        reader bridge (see below). Independent of the
                        web app; the app works fully without it.
reset-data/             fresh-start.json — an empty full-state snapshot
                        for wiping a device back to a blank slate via
                        the app's own Import JSON (see its own README)
```

## Running

1. One-time setup (requires internet, to fetch `react`, `react-dom`,
   `leaflet`, and `vite` from npm):
   ```
   npm install
   ```
2. Start the local dev server:
   ```
   npm run dev
   ```
   then open the printed `http://localhost:5173` URL in a browser.
   Check-in, registration, and everything in the admin suite *except the
   heat map* work with Wi-Fi/network disabled — data is read from and
   written to `localStorage` only, no server round-trips.
3. For a static, deployable build:
   ```
   npm run build
   npm run preview
   ```
   `npm run build` outputs a `dist/` folder that can be opened via any
   static file server (or hosted from a USB drive). Same network caveat as
   above applies at runtime — everything works locally except the heat map.

### RFID card bridge (optional)

Touch-free check-in via RFID/NFC cards needs the separate bridge program
running alongside the web app. Without it, everything still works with
typed usernames — the app just silently runs without card support.

```
cd rfid-bridge
dotnet run
```

Requires the [.NET 8 SDK](https://dotnet.microsoft.com/download) and an
ACR122U (or PC/SC-compatible) USB card reader. The bridge:

- talks to the reader over PC/SC, authenticates and reads/writes MIFARE
  Classic 1K cards (the cards currently on hand — **NTAG213/215 is the
  recommended card for any future purchase**, since it needs no
  authentication and has no sector-trailer bricking risk; the block-based
  Classic code is isolated so swapping later doesn't touch the rest)
- runs a localhost-only WebSocket server (`ws://localhost:8787/`) that the
  browser app connects to automatically — no configuration needed on the
  web app side, it just checks whether the bridge happens to be running
- a card tap is treated identically to typing a username (same validation,
  same check-in logic) — there's no separate, easy-to-drift code path
- **never overwrites an already-programmed card.** A write only proceeds
  if the tapped card reads back blank; an already-programmed card tapped
  during an armed write just checks that person in normally instead

Card activation itself is fully automatic: finishing registration arms a
25-second window for the very next card tapped, no button required. A
technician re-issuing a card for an existing user (lost card, first-timer
from before this existed) uses the low-key "Card Management" toggle tucked
just under the registration form — deliberately not a prominent button, so
a visitor doesn't stumble into it out of curiosity.

## Network use

Two things in this app talk to the network:

- **The heat map's basemap tiles** (`tile.openstreetmap.org`), loaded when
  an admin opens Analytics → Heat Map. If that request fails (no
  connection), the ZIP polygons still render — just without street
  imagery underneath them.
- **The RFID bridge's WebSocket connection**, `ws://localhost:8787/` —
  strictly localhost, never leaves the machine.

Nothing else — check-in, registration, storage, CSV/JSON export, the
integrity check — makes any network call.

## Data

Stored in `localStorage`, all under app-specific keys:

| Key | Contents |
|---|---|
| `recycleHeroesUsers` | Array of registrant records |
| `recycleHeroesCheckins` | Array of check-in events |
| `recycleHeroesVisitors` | Anonymous event-mode check-ins (email/phone only, no username) |
| `recycleHeroesEvents` | Scheduled events (name, start/end window, notes) |
| `recycleHeroesWeights` | Logged waste-weight entries (org-wide, not per-user) |
| `recycleHeroesTheme` | `"dark"` or `"light"` |
| `recycleHeroesMotd` | Admin's message-of-the-day string |

User record:

```json
{
  "username": "string (unique, 5-15 chars)",
  "email": "string (valid email)",
  "phone": "string, normalized to XXX-XXX-XXXX or +1XXXXXXXXXX",
  "zip": "string (5-digit US ZIP)",
  "curbsideInterest": "boolean (optional)",
  "noCurbsideAccess": "boolean (optional) — no curbside option where they live",
  "buildingName": "string (optional, only meaningful if noCurbsideAccess)",
  "smsOptIn": "boolean (optional)",
  "emailOptIn": "boolean (optional) — set together with smsOptIn from one combined checkbox",
  "registeredDate": "string, YYYY-MM-DD (Eastern calendar day)",
  "totalCheckins": "number",
  "firstCheckinDate": "string or null, YYYY-MM-DD",
  "lastCheckinDate": "string or null, YYYY-MM-DD",
  "eventsAttended": "array of event ids"
}
```

Check-in record:

```json
{
  "username": "string",
  "dateKey": "string, YYYY-MM-DD (Eastern calendar day — enforces 1/day outside event mode)",
  "timestamp": "string, ISO 8601 (exact moment of check-in)",
  "eventId": "string or null"
}
```

## Admin suite

⚙ gear icon, bottom-right corner, opens the Admin Panel drawer: integrity/
backup alerts (only shown when something's actually wrong), event-mode
stats, Message of the Day, and — in the drawer itself — four more panels,
each with its own icon:

- **📅 Events** — schedule/end events, the debug-only Event Mode override.
- **📊 Analytics** — Heat Map (live ZIP check-in density), Leaderboard,
  Patterns (check-ins by time of day), Achievements. Wide centered panel
  (a real map needs more room than a corner popover).
- **🔍 Database** — the single home for browsing and exporting data:
  - **Users** — searchable/filterable table (search matches username,
    email, phone, ZIP, or building), a column picker, and an "Export
    Custom Dataset" CSV button that exports exactly the filtered rows and
    checked-on columns — built for handing a curated slice to a specific
    funder or partner, not just a full dump.
  - **Check-ins** — search/delete the raw check-in log, export respects
    the current search filter.
  - **Weight Log** — log and edit waste-weight entries.
  - **Backup & Restore** — automatic backup setup/status, manual
    Backup Now, Import JSON, and **Data Integrity** (every record
    validated for structural issues — bad email/ZIP/phone format, wrong
    field types — with an Auto-Fix for what has an unambiguous correct
    value; genuinely invalid data is left flagged rather than guessed at).
- **🐞 Debug** — crash-testing aid, not a real feature: live user/check-in
  counts, a checkbox that bypasses check-in hours and the daily-limit gate,
  and an "Arm Wipe" tool to reclaim a physical test card for reuse. Not
  meant to be touched during normal operation.

Every one of these opens as its own floating panel and they can be open
simultaneously. Clicking a panel's icon brings it to the front if something
else currently covers it; clicking the icon of whichever panel is *already*
frontmost closes it — same as clicking a background window's taskbar icon.

## Export / Import

**Users tab (Database panel):** curated CSV — exactly the filtered rows and
checked-on columns, built in-browser.

**Backup & Restore:** full-state JSON (`Export`/`Backup Now`) covering
users, check-ins, events, visitors, weights, theme, and MOTD — the same
format `reset-data/fresh-start.json` uses. **Import JSON** overwrites all
current data after a confirmation step, and refuses to import a file that
fails the same integrity check the rest of the app runs.

## Security posture

Admin tools have no authentication — anyone at the kiosk who finds the ⚙
icon can open them. This is a deliberate, tracked decision for the current
phase, not an oversight: the real security pass (locking down admin
access, the Cards/Database tools, etc.) is planned for open-beta prep, once
the feature set itself has settled. Don't treat the current lack of auth as
a bug report.

## Notes

- No JSX build-step dependency: every component file uses
  `React.createElement` directly, so no JSX compiler/plugin is required.
  Web-app dependencies are just `react`, `react-dom`, `leaflet`, and `vite`.
  The RFID bridge is a separate .NET project (`PCSC` NuGet package only).
- `npm audit` may report advisories in `esbuild`/`vite`'s **dev server**
  (unrelated to the built app, and only relevant if the dev server were
  exposed to an untrusted network). Not a concern for local use.
