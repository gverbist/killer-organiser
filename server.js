const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const crypto = require('crypto');
const dao = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[WARN] SESSION_SECRET env var not set. Using random secret; sessions reset on restart.');
}

app.use(express.json({ limit: '64kb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function requireGM(req, res, next) {
  if (!req.session || !req.session.gmAuthed) {
    return res.status(401).json({ error: 'GM authentication required' });
  }
  next();
}

function requirePlayer(req, res, next) {
  const headerPin = req.get('x-player-pin');
  const bodyPin = req.body && req.body.pin;
  const pin = (headerPin || bodyPin || '').toString().trim();
  if (!/^\d{4}$/.test(pin)) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }
  const game = dao.getCurrentGame();
  if (!game) return res.status(404).json({ error: 'No active game' });
  const player = dao.getPlayerByPin(game.id, pin);
  if (!player) return res.status(401).json({ error: 'Invalid PIN' });
  req.game = game;
  req.player = player;
  next();
}

app.get('/api/gm/state', (req, res) => {
  const game = dao.getCurrentGame();
  res.json({
    hasGame: !!game,
    gameStatus: game ? game.status : null,
    gmAuthed: !!(req.session && req.session.gmAuthed)
  });
});

app.post('/api/gm/login', async (req, res) => {
  const password = (req.body && req.body.password) || '';
  const game = dao.getCurrentGame();
  if (!game) return res.status(404).json({ error: 'No game to log in to' });
  try {
    const ok = await bcrypt.compare(String(password), game.gm_password_hash);
    if (!ok) return res.status(401).json({ error: 'Wrong password' });
    req.session.gmAuthed = true;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Login error' });
  }
});

app.post('/api/gm/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => res.json({ ok: true }));
  } else {
    res.json({ ok: true });
  }
});

app.post('/api/game/create', async (req, res) => {
  const { name, weapon, gmPassword } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Game name required' });
  if (!gmPassword || String(gmPassword).length < 4) {
    return res.status(400).json({ error: 'GM password must be at least 4 characters' });
  }
  const existing = dao.getCurrentGame();
  if (existing && !(req.session && req.session.gmAuthed)) {
    return res.status(401).json({ error: 'GM auth required to replace existing game' });
  }
  try {
    const hash = await bcrypt.hash(String(gmPassword), 10);
    const id = dao.createGame(String(name).trim(), String(weapon || '').trim(), hash);
    req.session.gmAuthed = true;
    res.json({ ok: true, gameId: id });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create game' });
  }
});

app.post('/api/game/start', requireGM, (req, res) => {
  const game = dao.getCurrentGame();
  if (!game) return res.status(404).json({ error: 'No game' });
  if (game.status !== 'setup') return res.status(400).json({ error: 'Game already started' });
  const players = dao.listPlayers(game.id);
  if (players.length < 2) return res.status(400).json({ error: 'Need at least 2 players' });
  try {
    dao.startGame(game.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/game/status', requireGM, (req, res) => {
  const game = dao.getCurrentGame();
  if (!game) return res.json({ game: null, players: [] });
  res.json(dao.getGameStatus(game.id));
});

app.post('/api/players/add', requireGM, (req, res) => {
  const game = dao.getCurrentGame();
  if (!game) return res.status(404).json({ error: 'No game' });
  if (game.status !== 'setup') return res.status(400).json({ error: 'Cannot add players after start' });

  const { name, names } = req.body || {};
  const added = [];
  if (Array.isArray(names)) {
    for (const n of names) {
      if (typeof n !== 'string') continue;
      const trimmed = n.trim();
      if (!trimmed) continue;
      if (trimmed.length > 80) continue;
      const p = dao.addPlayer(game.id, trimmed);
      if (p) added.push(p);
    }
  } else if (typeof name === 'string') {
    const trimmed = name.trim();
    if (!trimmed) return res.status(400).json({ error: 'Name required' });
    if (trimmed.length > 80) return res.status(400).json({ error: 'Name too long' });
    const p = dao.addPlayer(game.id, trimmed);
    if (p) added.push(p);
  } else {
    return res.status(400).json({ error: 'name or names required' });
  }
  res.json({ ok: true, added });
});

app.delete('/api/players/:id', requireGM, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
  const game = dao.getCurrentGame();
  if (!game) return res.status(404).json({ error: 'No game' });
  if (game.status !== 'setup') return res.status(400).json({ error: 'Cannot remove players after start' });
  dao.removePlayer(id, game.id);
  res.json({ ok: true });
});

app.post('/api/gm/confirm-kill', requireGM, (req, res) => {
  const { victimId } = req.body || {};
  const id = parseInt(victimId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid victimId' });
  const game = dao.getCurrentGame();
  if (!game) return res.status(404).json({ error: 'No game' });
  try {
    dao.confirmKill(game.id, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/gm/undo-kill', requireGM, (req, res) => {
  const game = dao.getCurrentGame();
  if (!game) return res.status(404).json({ error: 'No game' });
  try {
    dao.undoLastKill(game.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/gm/dismiss-claim', requireGM, (req, res) => {
  const { playerId } = req.body || {};
  const id = parseInt(playerId, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid playerId' });
  const game = dao.getCurrentGame();
  if (!game) return res.status(404).json({ error: 'No game' });
  dao.dismissClaim(game.id, id);
  res.json({ ok: true });
});

app.post('/api/gm/reassign', requireGM, (req, res) => {
  const { playerId, newTargetId } = req.body || {};
  const pid = parseInt(playerId, 10);
  const tid = parseInt(newTargetId, 10);
  if (!Number.isFinite(pid) || !Number.isFinite(tid)) {
    return res.status(400).json({ error: 'Invalid ids' });
  }
  const game = dao.getCurrentGame();
  if (!game) return res.status(404).json({ error: 'No game' });
  try {
    dao.reassignTarget(game.id, pid, tid);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/player/me', requirePlayer, (req, res) => {
  const view = dao.getPlayerView(req.player.id);
  if (!view) return res.status(404).json({ error: 'Player not found' });
  res.json(view);
});

app.post('/api/player/claim-kill', requirePlayer, (req, res) => {
  if (req.game.status !== 'active') return res.status(400).json({ error: 'Game not active' });
  if (req.player.status !== 'alive') return res.status(400).json({ error: 'You are eliminated' });
  dao.claimKill(req.player.id);
  res.json({ ok: true });
});

app.get('/gm', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gm.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Killer Organiser listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
