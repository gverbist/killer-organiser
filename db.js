const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'killer.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    weapon TEXT,
    status TEXT NOT NULL DEFAULT 'setup',
    gm_password_hash TEXT NOT NULL,
    winner_id INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    ended_at INTEGER,
    archived INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    pin TEXT,
    target_id INTEGER,
    status TEXT NOT NULL DEFAULT 'alive',
    kill_count INTEGER NOT NULL DEFAULT 0,
    pending_kill_claim INTEGER NOT NULL DEFAULT 0,
    eliminated_at INTEGER,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS kills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    killer_id INTEGER NOT NULL,
    victim_id INTEGER NOT NULL,
    victim_prev_target_id INTEGER,
    killer_prev_kill_count INTEGER NOT NULL,
    victim_prev_status TEXT NOT NULL,
    victim_prev_kill_count INTEGER NOT NULL,
    killer_prev_pending_claim INTEGER NOT NULL,
    victim_prev_pending_claim INTEGER NOT NULL,
    game_status_before TEXT NOT NULL,
    confirmed_at INTEGER DEFAULT (strftime('%s', 'now')),
    undone INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_players_game ON players(game_id);
  CREATE INDEX IF NOT EXISTS idx_players_pin ON players(game_id, pin);
  CREATE INDEX IF NOT EXISTS idx_kills_game ON kills(game_id, undone, id);
`);

function getCurrentGame() {
  return db.prepare("SELECT * FROM games WHERE archived = 0 ORDER BY id DESC LIMIT 1").get();
}

function createGame(name, weapon, gmPasswordHash) {
  const txn = db.transaction(() => {
    db.prepare("UPDATE games SET archived = 1 WHERE archived = 0").run();
    const result = db.prepare(
      "INSERT INTO games (name, weapon, gm_password_hash, status) VALUES (?, ?, ?, 'setup')"
    ).run(name, weapon || '', gmPasswordHash);
    return result.lastInsertRowid;
  });
  return txn();
}

function archiveCurrentGame() {
  db.prepare("UPDATE games SET archived = 1 WHERE archived = 0").run();
}

function listPlayers(gameId) {
  return db.prepare("SELECT * FROM players WHERE game_id = ? ORDER BY id ASC").all(gameId);
}

function getPlayer(playerId, gameId) {
  if (gameId !== undefined) {
    return db.prepare("SELECT * FROM players WHERE id = ? AND game_id = ?").get(playerId, gameId);
  }
  return db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
}

function getPlayerByPin(gameId, pin) {
  if (!pin || typeof pin !== 'string' || !/^\d{4}$/.test(pin)) return null;
  return db.prepare("SELECT * FROM players WHERE game_id = ? AND pin = ?").get(gameId, pin);
}

function addPlayer(gameId, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return null;
  const result = db.prepare("INSERT INTO players (game_id, name) VALUES (?, ?)").run(gameId, trimmed);
  return { id: result.lastInsertRowid, name: trimmed };
}

function removePlayer(playerId, gameId) {
  db.prepare("DELETE FROM players WHERE id = ? AND game_id = ?").run(playerId, gameId);
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function generateUniquePin(usedPins) {
  let pin;
  let safety = 0;
  do {
    pin = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    safety++;
    if (safety > 100000) throw new Error('Unable to generate unique PIN');
  } while (usedPins.has(pin));
  usedPins.add(pin);
  return pin;
}

function startGame(gameId) {
  const players = listPlayers(gameId);
  if (players.length < 2) throw new Error('At least 2 players required');

  shuffleInPlace(players);
  const usedPins = new Set();

  const txn = db.transaction(() => {
    for (let i = 0; i < players.length; i++) {
      const target = players[(i + 1) % players.length];
      const pin = generateUniquePin(usedPins);
      db.prepare("UPDATE players SET pin = ?, target_id = ?, status = 'alive', kill_count = 0, pending_kill_claim = 0 WHERE id = ?")
        .run(pin, target.id, players[i].id);
    }
    db.prepare("UPDATE games SET status = 'active' WHERE id = ?").run(gameId);
  });
  txn();
}

function confirmKill(gameId, victimId) {
  const txn = db.transaction(() => {
    const game = db.prepare("SELECT * FROM games WHERE id = ?").get(gameId);
    if (!game) throw new Error('Game not found');
    if (game.status !== 'active') throw new Error('Game is not active');

    const victim = db.prepare("SELECT * FROM players WHERE id = ? AND game_id = ?").get(victimId, gameId);
    if (!victim) throw new Error('Victim not found');
    if (victim.status !== 'alive') throw new Error('Victim is already eliminated');

    const killer = db.prepare(
      "SELECT * FROM players WHERE target_id = ? AND game_id = ? AND status = 'alive'"
    ).get(victimId, gameId);
    if (!killer) throw new Error('No active killer targets this player');
    if (killer.id === victim.id) throw new Error('Killer cannot be victim');

    db.prepare(`INSERT INTO kills (
      game_id, killer_id, victim_id,
      victim_prev_target_id, killer_prev_kill_count,
      victim_prev_status, victim_prev_kill_count,
      killer_prev_pending_claim, victim_prev_pending_claim,
      game_status_before
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      gameId, killer.id, victim.id,
      victim.target_id, killer.kill_count,
      victim.status, victim.kill_count,
      killer.pending_kill_claim, victim.pending_kill_claim,
      game.status
    );

    db.prepare(
      "UPDATE players SET status = 'dead', eliminated_at = strftime('%s','now'), pending_kill_claim = 0 WHERE id = ?"
    ).run(victim.id);

    db.prepare(
      "UPDATE players SET target_id = ?, kill_count = kill_count + 1, pending_kill_claim = 0 WHERE id = ?"
    ).run(victim.target_id, killer.id);

    const aliveCount = db.prepare(
      "SELECT COUNT(*) AS c FROM players WHERE game_id = ? AND status = 'alive'"
    ).get(gameId).c;

    if (aliveCount <= 1) {
      const winner = db.prepare(
        "SELECT id FROM players WHERE game_id = ? AND status = 'alive' LIMIT 1"
      ).get(gameId);
      db.prepare(
        "UPDATE games SET status = 'ended', winner_id = ?, ended_at = strftime('%s','now') WHERE id = ?"
      ).run(winner ? winner.id : null, gameId);
    }
  });
  txn();
}

function undoLastKill(gameId) {
  const last = db.prepare(
    "SELECT * FROM kills WHERE game_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1"
  ).get(gameId);
  if (!last) throw new Error('No kill to undo');

  const txn = db.transaction(() => {
    db.prepare(
      "UPDATE players SET status = ?, kill_count = ?, eliminated_at = NULL, pending_kill_claim = ?, target_id = ? WHERE id = ?"
    ).run(
      last.victim_prev_status,
      last.victim_prev_kill_count,
      last.victim_prev_pending_claim,
      last.victim_prev_target_id,
      last.victim_id
    );

    db.prepare(
      "UPDATE players SET target_id = ?, kill_count = ?, pending_kill_claim = ? WHERE id = ?"
    ).run(
      last.victim_id,
      last.killer_prev_kill_count,
      last.killer_prev_pending_claim,
      last.killer_id
    );

    db.prepare("UPDATE kills SET undone = 1 WHERE id = ?").run(last.id);

    db.prepare(
      "UPDATE games SET status = ?, winner_id = NULL, ended_at = NULL WHERE id = ?"
    ).run(last.game_status_before, gameId);
  });
  txn();
}

function reassignTarget(gameId, playerId, newTargetId) {
  const player = db.prepare("SELECT * FROM players WHERE id = ? AND game_id = ?").get(playerId, gameId);
  const target = db.prepare("SELECT * FROM players WHERE id = ? AND game_id = ?").get(newTargetId, gameId);
  if (!player) throw new Error('Player not found');
  if (!target) throw new Error('Target not found');
  if (player.status !== 'alive') throw new Error('Player is not alive');
  if (target.status !== 'alive') throw new Error('Target is not alive');
  if (player.id === target.id) throw new Error('Player cannot target self');
  db.prepare("UPDATE players SET target_id = ? WHERE id = ?").run(newTargetId, playerId);
}

function claimKill(playerId) {
  db.prepare("UPDATE players SET pending_kill_claim = 1 WHERE id = ? AND status = 'alive'").run(playerId);
}

function dismissClaim(gameId, playerId) {
  db.prepare("UPDATE players SET pending_kill_claim = 0 WHERE id = ? AND game_id = ?").run(playerId, gameId);
}

function getGameStatus(gameId) {
  const game = db.prepare("SELECT * FROM games WHERE id = ?").get(gameId);
  if (!game) return null;
  const players = listPlayers(gameId);
  const byId = new Map(players.map(p => [p.id, p]));
  const decorated = players.map(p => ({
    id: p.id,
    name: p.name,
    pin: p.pin,
    status: p.status,
    killCount: p.kill_count,
    pendingClaim: !!p.pending_kill_claim,
    targetId: p.target_id,
    targetName: p.target_id && byId.get(p.target_id) ? byId.get(p.target_id).name : null
  }));
  let winnerName = null;
  if (game.winner_id && byId.get(game.winner_id)) winnerName = byId.get(game.winner_id).name;
  return {
    game: {
      id: game.id,
      name: game.name,
      weapon: game.weapon,
      status: game.status,
      winnerId: game.winner_id,
      winnerName
    },
    players: decorated
  };
}

function getPlayerView(playerId) {
  const player = db.prepare("SELECT * FROM players WHERE id = ?").get(playerId);
  if (!player) return null;
  const game = db.prepare("SELECT * FROM games WHERE id = ?").get(player.game_id);
  if (!game) return null;

  let target = null;
  if (player.target_id) {
    target = db.prepare("SELECT name FROM players WHERE id = ?").get(player.target_id);
  }
  let winnerName = null;
  if (game.winner_id) {
    const w = db.prepare("SELECT name FROM players WHERE id = ?").get(game.winner_id);
    if (w) winnerName = w.name;
  }
  const showTarget = player.status === 'alive' && game.status === 'active' && target;
  const targetFirstName = showTarget ? target.name.trim().split(/\s+/)[0] : null;

  return {
    name: player.name,
    status: player.status,
    killCount: player.kill_count,
    pendingClaim: !!player.pending_kill_claim,
    targetFirstName,
    weapon: game.weapon || '',
    gameName: game.name,
    gameStatus: game.status,
    isWinner: !!(game.winner_id && game.winner_id === player.id),
    winnerName
  };
}

module.exports = {
  db,
  getCurrentGame,
  createGame,
  archiveCurrentGame,
  listPlayers,
  getPlayer,
  getPlayerByPin,
  addPlayer,
  removePlayer,
  startGame,
  confirmKill,
  undoLastKill,
  reassignTarget,
  claimKill,
  dismissClaim,
  getGameStatus,
  getPlayerView
};
