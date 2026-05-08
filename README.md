# Killer Organiser

A mobile-first web app for running [Killer](https://en.wikipedia.org/wiki/Killer_(game)) — the live-action assassination party game (also known as Wink Murder, Mafia, or "office Killer"). One Game Master assigns secret targets; players hunt each other with whatever silly method the group agrees on (water guns, stickers, a tap on the shoulder); the last person standing wins.

This app handles the bookkeeping: target assignment, kill confirmation, the inevitable "wait, who do I have now?" — so the GM can focus on adjudicating disputes about whether a sticker really counts.

---

## Features

### Game Master panel — `/gm`

- Create a game with a name and a custom kill method ("water gun", "post-it on the back", whatever)
- Add players one at a time or paste a newline-separated list
- Start the game — every player gets a unique 4-digit PIN and a randomly-assigned target forming a single closed cycle
- Printable PIN sheet to hand out to players
- Live player list during play: name, status, target, kill count
- One-tap **Confirm kill** with claim awareness (when a player has claimed a kill, the button confirms eliminating *their target*, not them)
- **Dismiss claim** for false alarms
- **Undo last kill** — fully restores prior state, including ending an end-of-game state
- **Reassign target** — manual override for disputes
- Auto-detected end of game with winner banner and final leaderboard
- **Reset / new game** at any time (archives the current run)

### Player portal — `/`

- 4-digit PIN entry with numeric keypad on mobile
- Big, bold target reveal (first name only — no surnames leaked)
- "I made a kill" button with inline confirmation (no browser dialogs)
- "Pending GM confirmation" state while waiting
- Eliminated state with final kill count
- Winner banner if you outlast everyone
- Auto-refreshes every 15 s and on tab focus
- PIN remembered in `localStorage` so a player can close the tab and come back

### Security & robustness

- GM password hashed with **bcrypt** (cost 10)
- Session cookies with `httpOnly`, `sameSite=lax`
- Player PIN auth gates **only** that player's own data — no surface to enumerate other players
- All SQL is parameterized (no string concatenation)
- All player-controlled text is rendered via `textContent`, never `innerHTML`
- 67-test functional suite covering happy paths, boundaries, security probes, and weird edge cases (broken-cycle reassignment, undo of game-ending kill, etc.)

---

## Quick start

### Docker (recommended)

```bash
docker run -d \
  --name killer \
  -p 3000:3000 \
  -v killer-data:/data \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  ghcr.io/gverbist/killer-organiser:latest
```

Then open:
- GM panel: <http://localhost:3000/gm>
- Player portal: <http://localhost:3000/>

The named volume `killer-data` keeps the SQLite database across restarts.

### Local Node

Requires Node 18+ (tested on 22).

```bash
git clone https://github.com/gverbist/killer-organiser.git
cd killer-organiser
npm install
SESSION_SECRET="$(openssl rand -hex 32)" npm start
```

No build step. The SQLite database is created on first run at `./killer.db`.

---

## How a game runs

1. **GM** opens `/gm`, fills in *Game name*, optional *Kill method*, and a *GM password* — clicks **Create game**.
2. **GM** adds players (single or bulk paste) and clicks **Start game**.
3. The app generates a secret cycle (everyone targets exactly one person) and a unique 4-digit PIN per player. The GM hands out (or prints) the PIN sheet.
4. **Players** open `/`, enter their PIN, and see only their own target.
5. When a player makes a kill in real life, they hit **I made a kill**. This raises a flag in the GM panel.
6. **GM** verifies and clicks **Confirm claim** on that player's row — the target is eliminated, the killer inherits the next target in the chain, kill count increments.
7. Optional: GM can **Dismiss** a false claim, **Reassign** a target after a dispute, or **Undo** the last kill if something went wrong.
8. When only one player remains, the game ends automatically and shows the winner. GM can **Reset / New game** any time.

---

## Configuration

Environment variables read at startup:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port to listen on. |
| `SESSION_SECRET` | random | Secret used to sign session cookies. **Set this in production** — otherwise it regenerates on each restart and invalidates active GM sessions. |
| `DB_PATH` | `./killer.db` (or `/data/killer.db` in Docker) | SQLite file path. The directory must be writable. |

---

## API reference

All POST/PUT/DELETE bodies are JSON. GM endpoints require a session cookie set by `POST /api/gm/login` (or auto-set by `POST /api/game/create` for the first game). Player endpoints require an `X-Player-Pin` header.

### Public

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/gm/state` | `{ hasGame, gameStatus, gmAuthed }` — used by the GM frontend to decide which view to render. |
| `POST` | `/api/gm/login` | `{ password }` → 200 / 401 |
| `POST` | `/api/gm/logout` | Clears session. |
| `POST` | `/api/game/create` | `{ name, weapon?, gmPassword }`. No auth required if no game exists; otherwise GM auth required (replaces & archives the current game). |

### GM-only

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/game/status` | Full state: `{ game, players[] }` including PINs and target ids. |
| `POST` | `/api/players/add` | `{ name }` or `{ names: [...] }`. Setup phase only. |
| `DELETE` | `/api/players/:id` | Setup phase only. |
| `POST` | `/api/game/start` | Generates PINs and target cycle. Requires ≥2 players. |
| `POST` | `/api/gm/confirm-kill` | `{ victimId }` — eliminates victim, killer (whoever targets them) inherits target. |
| `POST` | `/api/gm/undo-kill` | Reverts the most recent confirmed kill. |
| `POST` | `/api/gm/reassign` | `{ playerId, newTargetId }` |
| `POST` | `/api/gm/dismiss-claim` | `{ playerId }` clears a pending kill claim without eliminating anyone. |

### Player-only (header `X-Player-Pin: NNNN`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/player/me` | Returns *only* this player's view: name, status, kill count, target's first name, weapon, game status, win flag. Never another player's data. |
| `POST` | `/api/player/claim-kill` | Sets the pending-claim flag visible to the GM. |

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 | Built-in `fetch`, no transpile. |
| Server | Express 4 | Familiar; one file. |
| DB | SQLite via `better-sqlite3` | File-based, sync API, zero ops. WAL enabled. |
| Auth | `express-session` + `bcryptjs` | GM password hashed; player PIN check per request. |
| Frontend | Vanilla HTML / CSS / JS | No build step. Mobile-first dark theme, system fonts, 48 px tap targets. |
| Tests | Custom mini-runner over Node's `assert` | No test framework dependency. |

---

## Project structure

```
.
├── server.js              # Express app, all routes, static file serving
├── db.js                  # SQLite schema + helpers (transactions, target chain)
├── tests.js               # 67-case functional test suite
├── public/
│   ├── gm.html            # GM panel shell
│   ├── gm.js              # GM panel logic — DOM via createElement + textContent
│   ├── player.html        # Player portal shell
│   ├── player.js          # Player portal logic
│   └── style.css          # Mobile-first dark theme
├── Dockerfile             # Multi-stage on node:22-bookworm-slim, runs as uid 10001
├── .dockerignore
└── .github/workflows/
    └── release.yml        # Test + multi-arch build & push to GHCR
```

---

## Development

```bash
npm install
npm test          # runs the 67-test suite (boots an in-process server on an ephemeral port + isolated SQLite DB)
npm start         # serves on PORT (default 3000)
```

The test suite exercises every API endpoint and probes for:
- Auth boundaries on every protected route
- Single-cycle target chain after start (every player targeted by exactly one other)
- PIN isolation (response shape locked, no cross-player leaks)
- Idempotency / double-confirm rejection
- Undo state restoration including end-of-game reversal
- SQL-injection-style and HTML-special player names
- Reassignment edge cases that break the cycle

---

## CI & Releases

A push to `main` runs the test suite, then builds a multi-arch (`linux/amd64`, `linux/arm64`) image and publishes it to **GHCR**:

- `ghcr.io/gverbist/killer-organiser:latest` — current main
- `ghcr.io/gverbist/killer-organiser:sha-<short>` — every push
- `ghcr.io/gverbist/killer-organiser:1.2.3`, `1.2`, `1` — when you push a `v1.2.3` tag

To cut a release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

---

## Acknowledgements

This project was developed collaboratively with **Claude** (Anthropic's Claude Opus 4.7) using **Claude Code**. The conversation followed a single comprehensive product spec and iterated on UX bugs, feature additions, the test suite, and the deployment pipeline — each step driven by a short prompt and reviewed before commit.

The original game *Killer* was published by Steve Jackson Games in 1981. This tool has no affiliation with them; it just makes their game easier to run.

---

## License

No license declared. If you'd like to use, fork, or modify this for your own group, open an issue or just go ahead — but be aware that without an explicit license, default copyright applies.
