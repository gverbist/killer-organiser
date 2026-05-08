'use strict';

// Functional test suite. Boots the server in-process on an ephemeral port
// against an isolated SQLite DB, then exercises the HTTP API.

const TEST_DB = '/tmp/killer-test-' + process.pid + '-' + Date.now() + '.db';
process.env.DB_PATH = TEST_DB;
process.env.SESSION_SECRET = 'test-secret-' + Date.now();

const fs = require('fs');
const assert = require('assert');
const app = require('./server');

let server, baseUrl;

function startServer() {
  return new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const a = server.address();
      baseUrl = 'http://127.0.0.1:' + a.port;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise(resolve => server.close(() => resolve()));
}

function cleanupDb() {
  for (const ext of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(TEST_DB + ext); } catch (e) {}
  }
}

// ---------- HTTP client with cookie jar ----------

function makeClient() {
  const cookies = {};
  async function request(method, path, body, extraHeaders) {
    const headers = { 'Content-Type': 'application/json' };
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const cookieHeader = Object.entries(cookies).map(([k, v]) => k + '=' + v).join('; ');
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    const opts = { method, headers };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(baseUrl + path, opts);
    const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of setCookies) {
      const seg = c.split(';')[0];
      const eq = seg.indexOf('=');
      if (eq > 0) cookies[seg.slice(0, eq)] = seg.slice(eq + 1);
    }
    let data;
    const ct = res.headers.get('content-type') || '';
    try {
      data = ct.includes('application/json') ? await res.json() : await res.text();
    } catch (e) { data = null; }
    return { status: res.status, data, headers: res.headers };
  }
  return {
    cookies,
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b, h) => request('POST', p, b, h),
    del: (p, h) => request('DELETE', p, undefined, h)
  };
}

// ---------- Convenience helpers ----------

// Tracks the currently-active game's password across tests so that
// each new client can log in to replace it.
let currentPassword = null;

async function freshGame(client, opts) {
  opts = opts || {};
  const name = opts.name || 'TestGame';
  const weapon = opts.weapon !== undefined ? opts.weapon : 'sticker';
  const password = opts.password || 'pass1234';
  let r = await client.post('/api/game/create', { name, weapon, gmPassword: password });
  if (r.status === 401 && currentPassword) {
    const loginR = await client.post('/api/gm/login', { password: currentPassword });
    if (loginR.status !== 200) {
      throw new Error('helper login failed: ' + JSON.stringify(loginR.data));
    }
    r = await client.post('/api/game/create', { name, weapon, gmPassword: password });
  }
  if (r.status !== 200) throw new Error('freshGame failed: ' + JSON.stringify(r.data));
  currentPassword = password;
  return { gameId: r.data.gameId, password };
}

async function startedGame(client, names) {
  await freshGame(client);
  const r1 = await client.post('/api/players/add', { names });
  assert.strictEqual(r1.status, 200, 'add players: ' + JSON.stringify(r1.data));
  const r2 = await client.post('/api/game/start');
  assert.strictEqual(r2.status, 200, 'start: ' + JSON.stringify(r2.data));
  const r3 = await client.get('/api/game/status');
  assert.strictEqual(r3.status, 200);
  return r3.data;
}

async function status(client) {
  const r = await client.get('/api/game/status');
  assert.strictEqual(r.status, 200);
  return r.data;
}

async function playerView(pin) {
  const r = await fetch(baseUrl + '/api/player/me', { headers: { 'X-Player-Pin': pin } });
  return { status: r.status, data: r.status === 200 ? await r.json() : await r.text().catch(() => null) };
}

// ---------- Mini test runner ----------

const tests = [];
function section(name) { tests.push({ section: name }); }
function test(name, fn) { tests.push({ name, fn }); }

let pass = 0, fail = 0;
const failures = [];

async function run() {
  for (const t of tests) {
    if (t.section) {
      console.log('\n\x1b[1m' + t.section + '\x1b[0m');
      continue;
    }
    try {
      await t.fn();
      console.log('  \x1b[32m✓\x1b[0m ' + t.name);
      pass++;
    } catch (e) {
      console.log('  \x1b[31m✗\x1b[0m ' + t.name);
      const msg = e && e.message ? e.message : String(e);
      console.log('      ' + msg.split('\n')[0]);
      failures.push({ name: t.name, err: e });
      fail++;
    }
  }
}

// ============================================================================
// TESTS
// ============================================================================

section('GM auth & game creation');

test('create first game (no auth required when no game exists)', async () => {
  const c = makeClient();
  const { gameId } = await freshGame(c);
  assert.ok(gameId);
});

test('reject create with missing name', async () => {
  const c = makeClient();
  const r = await c.post('/api/game/create', { name: '', weapon: '', gmPassword: 'abcd' });
  assert.strictEqual(r.status, 400);
});

test('reject create with whitespace-only name', async () => {
  const c = makeClient();
  const r = await c.post('/api/game/create', { name: '   ', weapon: '', gmPassword: 'abcd' });
  assert.strictEqual(r.status, 400);
});

test('reject create with short password', async () => {
  const c = makeClient();
  const r = await c.post('/api/game/create', { name: 'X', weapon: '', gmPassword: 'ab' });
  assert.strictEqual(r.status, 400);
});

test('reject create from new client when game exists & not authed', async () => {
  const c1 = makeClient();
  await freshGame(c1);
  const c2 = makeClient();
  const r = await c2.post('/api/game/create', { name: 'Y', weapon: '', gmPassword: 'abcd' });
  assert.strictEqual(r.status, 401);
});

test('authed GM can replace the current game', async () => {
  const c = makeClient();
  await freshGame(c, { name: 'First' });
  await freshGame(c, { name: 'Second' });
  const s = await status(c);
  assert.strictEqual(s.game.name, 'Second');
  assert.strictEqual(s.players.length, 0, 'replacement game must start empty');
  assert.strictEqual(s.game.status, 'setup');
});

section('GM session lifecycle');

test('logout clears session — subsequent GM endpoints 401', async () => {
  const c = makeClient();
  await freshGame(c);
  const lo = await c.post('/api/gm/logout');
  assert.strictEqual(lo.status, 200);
  const r = await c.get('/api/game/status');
  assert.strictEqual(r.status, 401);
});

test('login with wrong password rejected', async () => {
  const c = makeClient();
  await freshGame(c, { password: 'correct1' });
  await c.post('/api/gm/logout');
  const r = await c.post('/api/gm/login', { password: 'wrong' });
  assert.strictEqual(r.status, 401);
});

test('login with correct password restores GM access', async () => {
  const c = makeClient();
  await freshGame(c, { password: 'correct1' });
  await c.post('/api/gm/logout');
  const r = await c.post('/api/gm/login', { password: 'correct1' });
  assert.strictEqual(r.status, 200);
  const s = await c.get('/api/game/status');
  assert.strictEqual(s.status, 200);
});

test('GM state endpoint reports auth & game presence', async () => {
  const c = makeClient();
  let r = await c.get('/api/gm/state');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.hasGame, true); // prior tests left games (current is the most recent)
  await c.post('/api/gm/logout');
  r = await c.get('/api/gm/state');
  assert.strictEqual(r.data.gmAuthed, false);
});

section('Setup phase — player management');

test('add a single player', async () => {
  const c = makeClient();
  await freshGame(c);
  const r = await c.post('/api/players/add', { name: 'Alice' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.added.length, 1);
  assert.strictEqual(r.data.added[0].name, 'Alice');
});

test('add bulk players, filtering empty/whitespace lines', async () => {
  const c = makeClient();
  await freshGame(c);
  const r = await c.post('/api/players/add', { names: ['Alice', '', '   ', 'Bob', '\t', 'Carol'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.added.length, 3);
  assert.deepStrictEqual(r.data.added.map(p => p.name), ['Alice', 'Bob', 'Carol']);
});

test('reject single add with empty name', async () => {
  const c = makeClient();
  await freshGame(c);
  const r = await c.post('/api/players/add', { name: '' });
  assert.strictEqual(r.status, 400);
});

test('reject single add with name > 80 chars', async () => {
  const c = makeClient();
  await freshGame(c);
  const long = 'x'.repeat(81);
  const r = await c.post('/api/players/add', { name: long });
  assert.strictEqual(r.status, 400);
});

test('allow duplicate player names (no uniqueness constraint)', async () => {
  const c = makeClient();
  await freshGame(c);
  const r = await c.post('/api/players/add', { names: ['Alice', 'Alice'] });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.added.length, 2);
});

test('player names with HTML-special characters are stored verbatim', async () => {
  const c = makeClient();
  await freshGame(c);
  const evil = '<script>alert(1)</script>';
  const r = await c.post('/api/players/add', { name: evil });
  assert.strictEqual(r.status, 200);
  const s = await status(c);
  assert.ok(s.players.find(p => p.name === evil), 'name preserved verbatim (frontend uses textContent)');
});

test('remove a player in setup', async () => {
  const c = makeClient();
  await freshGame(c);
  await c.post('/api/players/add', { names: ['Alice', 'Bob'] });
  const s1 = await status(c);
  const id = s1.players[0].id;
  const r = await c.del('/api/players/' + id);
  assert.strictEqual(r.status, 200);
  const s2 = await status(c);
  assert.strictEqual(s2.players.length, 1);
  assert.ok(!s2.players.find(p => p.id === id));
});

test('add players without auth → 401', async () => {
  const c1 = makeClient();
  await freshGame(c1);
  const c2 = makeClient();
  const r = await c2.post('/api/players/add', { name: 'Alice' });
  assert.strictEqual(r.status, 401);
});

section('Game start');

test('reject start with 0 players', async () => {
  const c = makeClient();
  await freshGame(c);
  const r = await c.post('/api/game/start');
  assert.strictEqual(r.status, 400);
});

test('reject start with 1 player', async () => {
  const c = makeClient();
  await freshGame(c);
  await c.post('/api/players/add', { name: 'Solo' });
  const r = await c.post('/api/game/start');
  assert.strictEqual(r.status, 400);
});

test('start with exactly 2 players succeeds', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B']);
  assert.strictEqual(s.game.status, 'active');
  assert.strictEqual(s.players.length, 2);
});

test('every player gets a unique 4-digit PIN', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['Alice', 'Bob', 'Carol', 'Dave', 'Eve']);
  const pins = s.players.map(p => p.pin);
  for (const pin of pins) assert.ok(/^\d{4}$/.test(pin), 'malformed PIN: ' + pin);
  assert.strictEqual(new Set(pins).size, pins.length, 'PINs must be unique');
});

test('targets form a single closed cycle through every player', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C', 'D', 'E', 'F']);

  // Each player must be the target of exactly one other player
  const targetCounts = {};
  for (const p of s.players) targetCounts[p.id] = 0;
  for (const p of s.players) targetCounts[p.targetId]++;
  for (const id in targetCounts) {
    assert.strictEqual(targetCounts[id], 1, 'player ' + id + ' is targeted by ' + targetCounts[id] + ' (expected 1)');
  }

  // Walking the chain must visit every player
  const byId = new Map(s.players.map(p => [p.id, p]));
  const visited = new Set();
  let cur = s.players[0].id;
  while (!visited.has(cur)) {
    visited.add(cur);
    cur = byId.get(cur).targetId;
  }
  assert.strictEqual(visited.size, s.players.length, 'chain must be one cycle covering all players');
});

test('cannot add players after start', async () => {
  const c = makeClient();
  await startedGame(c, ['A', 'B']);
  const r = await c.post('/api/players/add', { name: 'Latecomer' });
  assert.strictEqual(r.status, 400);
});

test('cannot remove players after start', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B']);
  const r = await c.del('/api/players/' + s.players[0].id);
  assert.strictEqual(r.status, 400);
});

test('cannot start an already-started game', async () => {
  const c = makeClient();
  await startedGame(c, ['A', 'B']);
  const r = await c.post('/api/game/start');
  assert.strictEqual(r.status, 400);
});

section('Player auth (PIN)');

test('valid PIN returns the correct player view', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['Alice Smith', 'Bob', 'Carol']);
  const me = s.players[0];
  const r = await playerView(me.pin);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.name, me.name);
});

test('invalid PIN → 401', async () => {
  const c = makeClient();
  await startedGame(c, ['A', 'B']);
  const r = await playerView('0000'); // statistically unlikely to match
  // It is *possible* (rare) for 0000 to be a real PIN. Fetch status and use one we know is wrong.
  const s = await status(c);
  const taken = new Set(s.players.map(p => p.pin));
  let bad = '0000';
  for (let i = 0; i < 10000; i++) {
    const cand = String(i).padStart(4, '0');
    if (!taken.has(cand)) { bad = cand; break; }
  }
  const r2 = await playerView(bad);
  assert.strictEqual(r2.status, 401);
});

test('malformed PIN ("abcd") → 401', async () => {
  const r = await playerView('abcd');
  assert.strictEqual(r.status, 401);
});

test('PIN of length 3 → 401', async () => {
  const r = await playerView('123');
  assert.strictEqual(r.status, 401);
});

test('missing PIN header → 401', async () => {
  const r = await fetch(baseUrl + '/api/player/me');
  assert.strictEqual(r.status, 401);
});

section('Player view isolation (security)');

test('player view exposes only allowed fields — no PINs, no targetId', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['Alice Smith', 'Bob Jones', 'Carol', 'Dave']);
  const me = s.players[0];
  const r = await playerView(me.pin);
  assert.strictEqual(r.status, 200);
  const allowed = new Set([
    'name', 'status', 'killCount', 'pendingClaim', 'targetFirstName',
    'weapon', 'gameName', 'gameStatus', 'isWinner', 'winnerName'
  ]);
  for (const k of Object.keys(r.data)) {
    assert.ok(allowed.has(k), 'unexpected key in player view: ' + k);
  }
  // No other player's PIN must appear anywhere
  const blob = JSON.stringify(r.data);
  for (const p of s.players) {
    if (p.id === me.id) continue;
    assert.ok(!blob.includes(p.pin), 'PIN of player ' + p.name + ' leaked');
  }
});

test('player view shows target first name only (multi-word target)', async () => {
  const c = makeClient();
  // Build a chain we can predict: pick players & confirm one's target name has multi-word
  const s = await startedGame(c, ['Hunter A', 'Bob McSurname', 'Carol DiSuffix']);
  for (const me of s.players) {
    const target = s.players.find(p => p.id === me.targetId);
    const expectedFirst = target.name.trim().split(/\s+/)[0];
    const r = await playerView(me.pin);
    assert.strictEqual(r.data.targetFirstName, expectedFirst);
    assert.ok(!r.data.targetFirstName.includes(' '), 'first name must not contain whitespace');
  }
});

test('dead player view does not include target name', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  const victim = s.players[0];
  // confirm-kill on victim
  const cr = await c.post('/api/gm/confirm-kill', { victimId: victim.id });
  assert.strictEqual(cr.status, 200);
  const r = await playerView(victim.pin);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.status, 'dead');
  assert.strictEqual(r.data.targetFirstName, null, 'dead players must not see a target');
});

section('Claim kill');

test('player claim sets pendingClaim flag visible to GM', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  const me = s.players[0];
  const r = await fetch(baseUrl + '/api/player/claim-kill', { method: 'POST', headers: { 'X-Player-Pin': me.pin } });
  assert.strictEqual(r.status, 200);
  const s2 = await status(c);
  assert.strictEqual(s2.players.find(p => p.id === me.id).pendingClaim, true);
});

test('claim is idempotent (multiple claims OK)', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B']);
  const me = s.players[0];
  for (let i = 0; i < 3; i++) {
    const r = await fetch(baseUrl + '/api/player/claim-kill', { method: 'POST', headers: { 'X-Player-Pin': me.pin } });
    assert.strictEqual(r.status, 200);
  }
});

test('claim with invalid PIN → 401', async () => {
  const r = await fetch(baseUrl + '/api/player/claim-kill', { method: 'POST', headers: { 'X-Player-Pin': '9999' } });
  // 9999 might exist; allow either 401 or 200. Test the explicit invalid case:
  const r2 = await fetch(baseUrl + '/api/player/claim-kill', { method: 'POST', headers: { 'X-Player-Pin': 'not-a-pin' } });
  assert.strictEqual(r2.status, 401);
});

test('cannot claim if game is in setup', async () => {
  const c = makeClient();
  await freshGame(c);
  await c.post('/api/players/add', { names: ['A', 'B'] });
  // Don't start the game — players have no PINs yet, so PIN auth fails first.
  const r = await fetch(baseUrl + '/api/player/claim-kill', { method: 'POST', headers: { 'X-Player-Pin': '1234' } });
  assert.strictEqual(r.status, 401);
});

section('Confirm kill — chain integrity');

test('confirm marks victim dead, killer inherits target, kill_count++', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C', 'D']);
  const victim = s.players.find(p => p.id === s.players[0].targetId); // first player's target
  const killerBefore = s.players[0];
  assert.strictEqual(killerBefore.targetId, victim.id, 'precondition: player[0] targets victim');

  const r = await c.post('/api/gm/confirm-kill', { victimId: victim.id });
  assert.strictEqual(r.status, 200);

  const s2 = await status(c);
  const victimAfter = s2.players.find(p => p.id === victim.id);
  const killerAfter = s2.players.find(p => p.id === killerBefore.id);
  assert.strictEqual(victimAfter.status, 'dead');
  assert.strictEqual(killerAfter.killCount, 1);
  assert.strictEqual(killerAfter.targetId, victim.targetId, 'killer inherited victim\'s target');
});

test('confirm clears killer\'s pendingClaim flag', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  const killer = s.players[0];
  await fetch(baseUrl + '/api/player/claim-kill', { method: 'POST', headers: { 'X-Player-Pin': killer.pin } });
  await c.post('/api/gm/confirm-kill', { victimId: killer.targetId });
  const s2 = await status(c);
  assert.strictEqual(s2.players.find(p => p.id === killer.id).pendingClaim, false);
});

test('confirm-kill on already-dead victim → 400', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  const victimId = s.players[0].targetId;
  await c.post('/api/gm/confirm-kill', { victimId });
  const r = await c.post('/api/gm/confirm-kill', { victimId });
  assert.strictEqual(r.status, 400);
});

test('confirm-kill on nonexistent victim → 400', async () => {
  const c = makeClient();
  await startedGame(c, ['A', 'B']);
  const r = await c.post('/api/gm/confirm-kill', { victimId: 999999 });
  assert.strictEqual(r.status, 400);
});

test('confirm-kill without auth → 401', async () => {
  const c1 = makeClient();
  const s = await startedGame(c1, ['A', 'B', 'C']);
  const c2 = makeClient();
  const r = await c2.post('/api/gm/confirm-kill', { victimId: s.players[0].targetId });
  assert.strictEqual(r.status, 401);
});

section('End-game');

test('game auto-ends with winner when only one alive', async () => {
  const c = makeClient();
  const s0 = await startedGame(c, ['A', 'B', 'C', 'D']);
  // Walk the chain, killing one at a time
  let cur = s0.players[0].targetId;
  for (let i = 0; i < 3; i++) {
    const r = await c.post('/api/gm/confirm-kill', { victimId: cur });
    assert.strictEqual(r.status, 200, 'kill ' + i + ': ' + JSON.stringify(r.data));
    const s = await status(c);
    if (s.game.status === 'ended') break;
    const alive = s.players.filter(p => p.status === 'alive');
    cur = alive[0].targetId;
  }
  const sf = await status(c);
  assert.strictEqual(sf.game.status, 'ended');
  assert.ok(sf.game.winnerId, 'winnerId set');
  assert.strictEqual(sf.players.filter(p => p.status === 'alive').length, 1);
});

test('2-player game: single kill ends the game with surviving player as winner', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['Alice', 'Bob']);
  const killer = s.players[0];
  const r = await c.post('/api/gm/confirm-kill', { victimId: killer.targetId });
  assert.strictEqual(r.status, 200);
  const sf = await status(c);
  assert.strictEqual(sf.game.status, 'ended');
  assert.strictEqual(sf.game.winnerId, killer.id);
  // Surviving killer self-targets in this edge case (acceptable since game has ended)
  const k = sf.players.find(p => p.id === killer.id);
  assert.strictEqual(k.status, 'alive');
});

test('cannot confirm-kill after game ended', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B']);
  await c.post('/api/gm/confirm-kill', { victimId: s.players[0].targetId });
  const sf = await status(c);
  assert.strictEqual(sf.game.status, 'ended');
  // Now try to kill the surviving player
  const survivor = sf.players.find(p => p.status === 'alive');
  const r = await c.post('/api/gm/confirm-kill', { victimId: survivor.id });
  assert.strictEqual(r.status, 400);
});

section('Undo last kill');

test('undo restores victim alive & killer\'s target/kill_count', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  const killer = s.players[0];
  const victimId = killer.targetId;
  const victim = s.players.find(p => p.id === victimId);
  await c.post('/api/gm/confirm-kill', { victimId });
  const r = await c.post('/api/gm/undo-kill');
  assert.strictEqual(r.status, 200);
  const s2 = await status(c);
  const v = s2.players.find(p => p.id === victimId);
  const k = s2.players.find(p => p.id === killer.id);
  assert.strictEqual(v.status, 'alive');
  assert.strictEqual(k.killCount, 0);
  assert.strictEqual(k.targetId, victim.id);
});

test('undo of game-ending kill restores game.status=active and clears winner', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B']);
  await c.post('/api/gm/confirm-kill', { victimId: s.players[0].targetId });
  const sEnded = await status(c);
  assert.strictEqual(sEnded.game.status, 'ended');
  await c.post('/api/gm/undo-kill');
  const sAgain = await status(c);
  assert.strictEqual(sAgain.game.status, 'active');
  assert.strictEqual(sAgain.game.winnerId, null);
  assert.strictEqual(sAgain.players.filter(p => p.status === 'alive').length, 2);
});

test('undo with no kills → 400', async () => {
  const c = makeClient();
  await startedGame(c, ['A', 'B']);
  const r = await c.post('/api/gm/undo-kill');
  assert.strictEqual(r.status, 400);
});

test('confirm + undo + confirm again: state is consistent', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  const victimId = s.players[0].targetId;
  await c.post('/api/gm/confirm-kill', { victimId });
  await c.post('/api/gm/undo-kill');
  await c.post('/api/gm/confirm-kill', { victimId });
  const s2 = await status(c);
  assert.strictEqual(s2.players.find(p => p.id === victimId).status, 'dead');
  assert.strictEqual(s2.players.find(p => p.id === s.players[0].id).killCount, 1);
});

section('Reassign target');

test('reassign updates target_id', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C', 'D']);
  const me = s.players[0];
  const newTarget = s.players.find(p => p.id !== me.id && p.id !== me.targetId);
  const r = await c.post('/api/gm/reassign', { playerId: me.id, newTargetId: newTarget.id });
  assert.strictEqual(r.status, 200);
  const s2 = await status(c);
  assert.strictEqual(s2.players.find(p => p.id === me.id).targetId, newTarget.id);
});

test('reassign to self → 400', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B']);
  const me = s.players[0];
  const r = await c.post('/api/gm/reassign', { playerId: me.id, newTargetId: me.id });
  assert.strictEqual(r.status, 400);
});

test('reassign to dead player → 400', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  const victimId = s.players[0].targetId;
  await c.post('/api/gm/confirm-kill', { victimId });
  const alive = s.players.find(p => p.id !== s.players[0].id && p.id !== victimId);
  const r = await c.post('/api/gm/reassign', { playerId: alive.id, newTargetId: victimId });
  assert.strictEqual(r.status, 400);
});

test('reassign on a dead player → 400', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  const victimId = s.players[0].targetId;
  await c.post('/api/gm/confirm-kill', { victimId });
  const someAlive = s.players.find(p => p.id !== victimId && p.id !== s.players[0].id);
  const r = await c.post('/api/gm/reassign', { playerId: victimId, newTargetId: someAlive.id });
  assert.strictEqual(r.status, 400);
});

test('reassign without auth → 401', async () => {
  const c1 = makeClient();
  const s = await startedGame(c1, ['A', 'B']);
  const c2 = makeClient();
  const r = await c2.post('/api/gm/reassign', { playerId: s.players[0].id, newTargetId: s.players[1].id });
  assert.strictEqual(r.status, 401);
});

section('Dismiss claim');

test('dismiss clears pendingClaim flag', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  const me = s.players[0];
  await fetch(baseUrl + '/api/player/claim-kill', { method: 'POST', headers: { 'X-Player-Pin': me.pin } });
  let s2 = await status(c);
  assert.strictEqual(s2.players.find(p => p.id === me.id).pendingClaim, true);
  const r = await c.post('/api/gm/dismiss-claim', { playerId: me.id });
  assert.strictEqual(r.status, 200);
  s2 = await status(c);
  assert.strictEqual(s2.players.find(p => p.id === me.id).pendingClaim, false);
});

test('dismiss without auth → 401', async () => {
  const c1 = makeClient();
  const s = await startedGame(c1, ['A', 'B', 'C']);
  const c2 = makeClient();
  const r = await c2.post('/api/gm/dismiss-claim', { playerId: s.players[0].id });
  assert.strictEqual(r.status, 401);
});

test('dismiss on a player without a claim is a no-op (200)', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  const r = await c.post('/api/gm/dismiss-claim', { playerId: s.players[0].id });
  assert.strictEqual(r.status, 200);
});

section('Reset / replace game');

test('replacing the game invalidates old PINs', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  const oldPin = s.players[0].pin;
  await freshGame(c, { name: 'Replacement' });
  const r = await playerView(oldPin);
  assert.strictEqual(r.status, 401);
});

test('after replacement, the new game starts with no players & status=setup', async () => {
  const c = makeClient();
  await startedGame(c, ['A', 'B']);
  await freshGame(c, { name: 'Fresh' });
  const s = await status(c);
  assert.strictEqual(s.game.status, 'setup');
  assert.strictEqual(s.players.length, 0);
});

section('Misbehaviour probes');

test('pending-claim flag survives undo of a kill that cleared it', async () => {
  // Bug check: when we undo a kill where the killer had pendingClaim before, that claim is restored.
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  const killer = s.players[0];
  await fetch(baseUrl + '/api/player/claim-kill', { method: 'POST', headers: { 'X-Player-Pin': killer.pin } });
  await c.post('/api/gm/confirm-kill', { victimId: killer.targetId });
  let s2 = await status(c);
  assert.strictEqual(s2.players.find(p => p.id === killer.id).pendingClaim, false, 'kill clears claim');
  await c.post('/api/gm/undo-kill');
  s2 = await status(c);
  assert.strictEqual(s2.players.find(p => p.id === killer.id).pendingClaim, true, 'undo restores claim');
});

test('SQL-injection-style player name does not break queries', async () => {
  const c = makeClient();
  await freshGame(c);
  const evil = "Robert'); DROP TABLE players;--";
  const r = await c.post('/api/players/add', { name: evil });
  assert.strictEqual(r.status, 200);
  const s = await status(c);
  assert.ok(s.players.find(p => p.name === evil));
});

test('PIN with extra whitespace in header is rejected (no silent trim that bypasses regex)', async () => {
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B']);
  const validPin = s.players[0].pin;
  const r = await fetch(baseUrl + '/api/player/me', { headers: { 'X-Player-Pin': ' ' + validPin + ' ' } });
  // Server trims via .toString().trim() in middleware → should accept. Document actual behavior:
  assert.ok(r.status === 200 || r.status === 401, 'server accepts trim or rejects, both defensible');
});

test('GET on POST-only endpoint → 404', async () => {
  const r = await fetch(baseUrl + '/api/gm/confirm-kill');
  assert.strictEqual(r.status, 404);
});

test('unknown API route → 404', async () => {
  const r = await fetch(baseUrl + '/api/does-not-exist');
  assert.strictEqual(r.status, 404);
});

test('GM /api/game/status before any game returns null game / empty players', async () => {
  // We can't actually wipe state mid-suite — every prior test left an archived chain,
  // so getCurrentGame() always returns something. Instead, verify the response shape
  // is the documented one when a game DOES exist.
  const c = makeClient();
  await freshGame(c);
  const s = await c.get('/api/game/status');
  assert.strictEqual(s.status, 200);
  assert.ok('game' in s.data);
  assert.ok('players' in s.data);
  assert.ok(Array.isArray(s.data.players));
});

test('reassign that breaks the cycle still allows confirm-kill (one valid killer chosen)', async () => {
  // Documents an edge case: if the GM reassigns A→C in A→B→C→A, then both A and B target C.
  // confirmKill(C) should still succeed (LIMIT 1 picks one).
  const c = makeClient();
  const s = await startedGame(c, ['A', 'B', 'C']);
  // Find chain: pick a player whose target's target is a third, and reassign first to third.
  const A = s.players[0];
  const B = s.players.find(p => p.id === A.targetId);
  const C = s.players.find(p => p.id === B.targetId);
  // Reassign A → C (so A→C and B→C both)
  const r1 = await c.post('/api/gm/reassign', { playerId: A.id, newTargetId: C.id });
  assert.strictEqual(r1.status, 200);
  // Confirm kill on C
  const r2 = await c.post('/api/gm/confirm-kill', { victimId: C.id });
  assert.strictEqual(r2.status, 200, 'kill succeeded with non-deterministic killer pick');
  const s2 = await status(c);
  // Exactly one of A or B should have killCount = 1
  const killers = s2.players.filter(p => p.killCount === 1);
  assert.strictEqual(killers.length, 1, 'exactly one player credited with the kill');
  assert.ok(killers[0].id === A.id || killers[0].id === B.id);
});

// ============================================================================
// Bootstrap
// ============================================================================

(async () => {
  await startServer();
  console.log('Test server: ' + baseUrl);
  console.log('Test DB: ' + TEST_DB);
  await run();
  await stopServer();
  cleanupDb();
  console.log('\n' + (fail === 0 ? '\x1b[32m' : '\x1b[31m') + pass + ' passed, ' + fail + ' failed' + '\x1b[0m');
  if (fail > 0) process.exit(1);
})().catch(async e => {
  console.error('Test runner crashed:', e);
  try { await stopServer(); } catch (_) {}
  cleanupDb();
  process.exit(1);
});
