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

### Docker Compose (recommended)

The repo ships with a `docker-compose.yml` and `.env.example`:

```bash
git clone https://github.com/gverbist/killer-organiser.git
cd killer-organiser
cp .env.example .env
# Generate a session secret and put it in .env:
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up -d
```

Then open:
- GM panel: <http://localhost:3000/gm>
- Player portal: <http://localhost:3000/>

To wipe state and start over: `docker compose down -v`.

The compose file also has a commented-out **nginx reverse proxy** service block — uncomment it (and provide your own `nginx.conf` + TLS certs in `./nginx/`) to terminate HTTPS in front of the app.

### Plain `docker run`

If you'd rather not use compose:

```bash
docker run -d \
  --name killer \
  -p 3000:3000 \
  -v killer-data:/data \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  ghcr.io/gverbist/killer-organiser:latest
```

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

## How to use

The app has two views, each meant for a different person and a different device:

- **`/gm`** — Game Master. One person runs this on whatever device they have handy (laptop is easiest, phone works too).
- **`/`** — Player portal. Every participant opens this on their own phone.

Players and the GM all hit the same server. If you're hosting locally, share your machine's LAN IP (e.g. `http://192.168.1.42:3000/`) so phones on the same Wi-Fi can connect. For remote play, put it behind a reverse proxy (Caddy, nginx, Cloudflare Tunnel — anything that gives you HTTPS).

### For the Game Master

#### 1. Create the game

Open `/gm`. On first run you'll see a simple form:

- **Game name** — anything ("Office Killers Spring 2026", "Camp Murder").
- **Kill method** *(optional)* — the agreed weapon, e.g. *"sticker on the back"*, *"water gun"*, *"point and say BANG"*. Players see this in their portal as a reminder.
- **GM password** — at least 4 characters. You'll need it to log back in if your session expires or you switch devices.

Click **Create game**. You're now in the **Setup** view.

#### 2. Add players

Two ways:

- **Single player** — type a name, hit *Add* (or press Enter).
- **Bulk paste** — paste a newline-separated list, hit *Add all*. Empty lines are ignored.

Use real first names (or distinctive nicknames) — players will see their *target's first name only*, so make sure each first name is unique enough to identify someone in the crowd. If you have two Sarahs, add them as "Sarah K" and "Sarah M".

You can **Remove** players at any point during setup. After the game starts, the player list is locked.

#### 3. Start the game

Click **Start game** when you have at least 2 players. The app then:

- Shuffles everyone into a random secret circle (A → B → C → … → A).
- Generates a unique random 4-digit **PIN** per player.
- Switches the panel into **Live game** mode.

#### 4. Hand out PINs

The GM panel now shows a **PINs** card with everyone's name and PIN. Two ways to distribute:

- **Print** — click *Print* (top-right of the PIN card). The page is styled for clean black-and-white printing. Cut into strips and hand them out.
- **Share digitally** — read PINs out one at a time, or screenshot and send privately. Don't post the whole list publicly: the PIN is the only thing protecting a player's target.

#### 5. Run the game

While the game runs, the **Players** card shows everyone live with:

- Status badge (alive / dead)
- Their current target's name (so *you* can see the chain — players only see first names)
- Kill count
- "Claims a kill" badge whenever a player taps **I made a kill** in their portal

You'll mostly do one thing during play: **confirm kills**. The button label adapts to the situation:

| Situation | Button | What it does |
|---|---|---|
| Player has tapped *I made a kill* | **Confirm claim** | Eliminates that player's *target*; killer inherits next target. |
| You witnessed a kill (no claim) | **Confirm kill** (on the *eliminated player's* row) | Same thing: eliminates that player; whoever was hunting them inherits the next target. |

Two confirmation steps are always required (tap → "Yes, eliminate X?") so you don't kill someone by mistake.

Other actions:

- **Dismiss claim** — clears a false-alarm claim without killing anyone. Use when a player accidentally tapped the button.
- **Reassign** — manually change a player's target. Useful when a player has gone permanently offline / dropped out / a dispute requires it. The dropdown only shows alive players.
- **Undo last kill** — fully reverses the most recent confirmed kill: victim back to alive, killer's target restored, kill count decremented, and if the game had ended, it goes back to active. Only the *very last* kill can be undone (one level deep).
- **Reset game** *(top-right)* — archives the current run and starts the create-game flow over. The form has a Cancel button and your typed input is preserved while you fill it in.

#### 6. End of game

When only one player is left alive, the panel automatically switches to the **Game over** view with a winner banner and the final leaderboard sorted by kill count. Click **Reset / New game** to archive this run and start fresh.

#### Common situations

- **A player loses their PIN** — click *Print* again, or look at the PIN card on your panel and tell them their PIN privately.
- **A dispute about whether a kill counts** — if you decide the kill stands, just confirm. If it doesn't, **Dismiss** the claim and let play continue.
- **Two players claim a kill on the same target simultaneously** — only one can really be right (only one person targets any given victim). Check the panel to see who's currently targeting whom, dismiss the wrong claim.
- **A player drops out mid-game** — **Reassign** the target of whoever was hunting them to skip past the dropped player. Then **Reassign** the dropped player out of the chain too if you want them entirely removed.
- **You restart the server** — your game state is preserved (it's all in SQLite). But your session cookie is gone, so log back in with the GM password. Players' PINs still work.

### For players

#### 1. Open the portal

Go to whatever URL the GM gave you (e.g. `http://192.168.1.42:3000/`). You'll see a single field asking for your 4-digit PIN.

#### 2. Enter your PIN

Type the PIN your GM gave you. Hit **Enter**. Your phone remembers it (`localStorage`), so you can close the tab and come back without re-entering.

#### 3. Hunt your target

You'll see:

- Your name (just to confirm the right person logged in)
- **Your target** — the first name of who you're hunting
- The agreed kill method
- Your kill count

Go find your target and "kill" them with whatever method the group agreed on.

#### 4. Claim the kill

Hit **I made a kill** and confirm. The screen now says *"Kill claim sent. Waiting for the GM to confirm…"*.

The GM will verify and either:

- **Confirm** the kill — your screen will refresh to show your **new target** (the one your victim was hunting), and your kill count goes up.
- **Dismiss** the claim — back to the same target, no change to kills.

The portal auto-refreshes every 15 seconds (and immediately whenever you open the tab), so you'll see the new target without doing anything.

#### 5. If you get killed

You'll see *"☠ Eliminated"* with your final kill count. You're out — but stick around to watch the carnage.

#### 6. If you win

Outlast everyone and you'll see *"🏆 You won!"*. Glory awaits.

#### Notes for players

- **Don't share your target name.** That's the whole game. Even a casual mention can give it away.
- **Your target is shown by first name only.** If two players share a first name, the GM should have added them with a distinguishing surname — ask the GM if you're unsure who you're after.
- **You can only claim a kill on your current target.** The button doesn't ask who you killed because it's always the person shown on screen.
- **Closed the tab? Tab crashed?** Just reopen the URL — your PIN is remembered.
- **Want to log out?** Tap *Sign out* on your portal. You'll need your PIN again to log back in.

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
├── docker-compose.yml     # Pinned-version deploy with named volume; commented nginx proxy stub
├── .env.example           # Template for SESSION_SECRET (.env itself is gitignored)
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

The original game *Killer* was published by Steve Jackson Games in 1981. This tool has no affiliation with them; it just makes their game easier to run.

---

## License

No license declared. If you'd like to use, fork, or modify this for your own group, open an issue or just go ahead — but be aware that without an explicit license, default copyright applies.
