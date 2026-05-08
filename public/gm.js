(function () {
  'use strict';

  const app = document.getElementById('app');

  const state = {
    initialLoad: true,
    hasGame: false,
    gmAuthed: false,
    game: null,
    players: [],
    error: '',
    info: '',
    confirmingKillFor: null,
    reassigningFor: null,
    confirmingNewGame: false,
    pollTimer: null
  };

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') {
          node.addEventListener(k.slice(2), attrs[k]);
        } else if (k === 'disabled' && attrs[k]) node.disabled = true;
        else if (k === 'type' || k === 'placeholder' || k === 'value' || k === 'name' ||
                 k === 'id' || k === 'maxlength' || k === 'inputmode' || k === 'autocomplete' ||
                 k === 'min' || k === 'max') {
          node.setAttribute(k, attrs[k]);
        } else if (attrs[k] !== false && attrs[k] !== null && attrs[k] !== undefined) {
          node.setAttribute(k, attrs[k]);
        }
      }
    }
    if (children) {
      const list = Array.isArray(children) ? children : [children];
      for (const c of list) {
        if (c === null || c === undefined || c === false) continue;
        if (typeof c === 'string') node.appendChild(document.createTextNode(c));
        else node.appendChild(c);
      }
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      const err = new Error(data.error || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function setError(msg) { state.error = msg || ''; render(); }
  function setInfo(msg) { state.info = msg || ''; render(); }

  async function refresh() {
    try {
      const stateResp = await api('GET', '/api/gm/state');
      state.hasGame = stateResp.hasGame;
      state.gmAuthed = stateResp.gmAuthed;
      if (state.hasGame && state.gmAuthed) {
        const status = await api('GET', '/api/game/status');
        state.game = status.game;
        state.players = status.players || [];
      } else {
        state.game = null;
        state.players = [];
      }
    } catch (e) {
      if (e.status === 401) {
        state.gmAuthed = false;
        state.game = null;
        state.players = [];
      } else {
        state.error = e.message;
      }
    }
    state.initialLoad = false;
    render();
    schedulePoll();
  }

  function schedulePoll() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.confirmingNewGame) return;
    if (state.gmAuthed && state.game && state.game.status === 'active') {
      state.pollTimer = setTimeout(refresh, 8000);
    }
  }

  // ---------- Views ----------

  function viewLoading() {
    return el('div', { class: 'loading-overlay' }, [
      el('span', { class: 'spinner' }),
      ' Loading...'
    ]);
  }

  function header(subtitle) {
    return el('div', { class: 'card' }, [
      el('h1', { text: 'Killer Organiser' }),
      el('div', { class: 'muted', text: subtitle || 'GM Panel' })
    ]);
  }

  function errorBanner() {
    if (!state.error) return null;
    return el('div', { class: 'error', text: state.error });
  }
  function infoBanner() {
    if (!state.info) return null;
    return el('div', { class: 'success', text: state.info });
  }

  function viewCreateGame(replacing) {
    let nameInput, weaponInput, passInput, btn;
    const errSlot = el('div');

    async function submit() {
      state.error = '';
      const name = nameInput.value.trim();
      const weapon = weaponInput.value.trim();
      const password = passInput.value;
      if (!name) { setError('Game name required'); return; }
      if (password.length < 4) { setError('GM password must be at least 4 characters'); return; }
      btn.disabled = true;
      const original = btn.textContent;
      clear(btn); btn.appendChild(el('span', { class: 'spinner' })); btn.appendChild(document.createTextNode(' Creating...'));
      try {
        await api('POST', '/api/game/create', { name, weapon, gmPassword: password });
        state.info = 'Game created.';
        state.confirmingNewGame = false;
        await refresh();
      } catch (e) {
        setError(e.message);
        btn.disabled = false;
        btn.textContent = original;
      }
    }

    nameInput = el('input', { type: 'text', placeholder: 'e.g. Office Killers Spring', maxlength: '80', autocomplete: 'off' });
    weaponInput = el('input', { type: 'text', placeholder: 'e.g. paper sticker on back', maxlength: '120', autocomplete: 'off' });
    passInput = el('input', { type: 'password', placeholder: 'min 4 characters', autocomplete: 'new-password' });
    btn = el('button', {
      class: replacing ? 'danger' : '',
      onclick: submit,
      text: replacing ? 'Reset & create new game' : 'Create game'
    });

    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    passInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

    const currentName = state.game ? state.game.name : null;
    const noticeMsg = replacing
      ? 'This archives "' + (currentName || 'the current game') + '" and starts a fresh game. Players, kills and PINs from the current game will no longer be active.'
      : null;

    return el('div', { class: 'card' }, [
      el('h2', { text: replacing ? 'Start a new game' : 'Create your first game' }),
      noticeMsg ? el('div', { class: 'notice', text: noticeMsg }) : null,
      errSlot,
      el('div', { class: 'field' }, [el('label', { text: 'Game name' }), nameInput]),
      el('div', { class: 'field' }, [el('label', { text: 'Kill method (optional)' }), weaponInput]),
      el('div', { class: 'field' }, [el('label', { text: 'GM password' }), passInput]),
      el('div', { class: 'row' }, [
        btn,
        replacing ? el('button', { class: 'ghost', onclick: () => { state.confirmingNewGame = false; render(); }, text: 'Cancel' }) : null
      ])
    ]);
  }

  function viewLogin() {
    let passInput, btn;
    async function submit() {
      state.error = '';
      const password = passInput.value;
      if (!password) { setError('Password required'); return; }
      btn.disabled = true;
      try {
        await api('POST', '/api/gm/login', { password });
        await refresh();
      } catch (e) {
        setError(e.message);
        btn.disabled = false;
      }
    }
    passInput = el('input', { type: 'password', placeholder: 'GM password', autocomplete: 'current-password' });
    btn = el('button', { onclick: submit, text: 'Log in' });
    passInput.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    setTimeout(() => passInput.focus(), 50);

    return el('div', { class: 'card' }, [
      el('h2', { text: 'GM login' }),
      el('div', { class: 'muted', text: 'A game is in progress. Enter the GM password.' }),
      el('div', { class: 'field', style: 'margin-top: 0.75rem' }, [
        el('label', { text: 'Password' }),
        passInput
      ]),
      btn
    ]);
  }

  function viewSetup() {
    const game = state.game;
    let singleInput, bulkInput, addBtn, bulkBtn, startBtn;

    async function addOne() {
      const name = singleInput.value.trim();
      if (!name) return;
      try {
        await api('POST', '/api/players/add', { name });
        singleInput.value = '';
        await refresh();
        setTimeout(() => { const i = document.getElementById('single-add'); if (i) i.focus(); }, 0);
      } catch (e) { setError(e.message); }
    }

    async function addBulk() {
      const text = bulkInput.value;
      const names = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (!names.length) return;
      try {
        await api('POST', '/api/players/add', { names });
        bulkInput.value = '';
        await refresh();
      } catch (e) { setError(e.message); }
    }

    async function remove(id) {
      try {
        await api('DELETE', '/api/players/' + id);
        await refresh();
      } catch (e) { setError(e.message); }
    }

    async function startGame() {
      if (state.players.length < 2) { setError('Need at least 2 players'); return; }
      startBtn.disabled = true;
      try {
        await api('POST', '/api/game/start');
        await refresh();
      } catch (e) {
        setError(e.message);
        startBtn.disabled = false;
      }
    }

    async function logout() {
      try { await api('POST', '/api/gm/logout'); } catch (e) {}
      await refresh();
    }

    singleInput = el('input', { id: 'single-add', type: 'text', placeholder: 'Player name', maxlength: '80', autocomplete: 'off' });
    singleInput.addEventListener('keydown', e => { if (e.key === 'Enter') addOne(); });
    addBtn = el('button', { onclick: addOne, text: 'Add' });

    bulkInput = el('textarea', { placeholder: 'One name per line', maxlength: '4000' });
    bulkBtn = el('button', { class: 'subtle', onclick: addBulk, text: 'Add all' });

    startBtn = el('button', {
      onclick: startGame,
      disabled: state.players.length < 2,
      text: state.players.length < 2 ? 'Need ≥2 players' : 'Start game (' + state.players.length + ' players)'
    });

    const playerListEl = el('ul', { class: 'player-list' });
    if (state.players.length === 0) {
      playerListEl.appendChild(el('li', { class: 'muted', text: 'No players yet.' }));
    } else {
      state.players.forEach(p => {
        playerListEl.appendChild(el('li', {}, [
          el('div', { class: 'player-row' }, [
            el('span', { class: 'player-name', text: p.name }),
            el('button', { class: 'ghost small', onclick: () => remove(p.id), text: 'Remove' })
          ])
        ]));
      });
    }

    return [
      el('div', { class: 'card' }, [
        el('div', { class: 'row between' }, [
          el('div', {}, [
            el('h2', { text: game.name }),
            game.weapon ? el('div', { class: 'muted', text: 'Method: ' + game.weapon }) : null
          ]),
          el('div', { class: 'row' }, [
            el('button', { class: 'ghost small', onclick: () => { state.confirmingNewGame = true; render(); }, text: 'Reset game' }),
            el('button', { class: 'ghost small', onclick: logout, text: 'Log out' })
          ])
        ]),
        el('div', { class: 'notice', text: 'Setup mode — add players, then start the game.' })
      ]),
      el('div', { class: 'gm-grid' }, [
        el('div', { class: 'card' }, [
          el('h3', { text: 'Add players' }),
          el('div', { class: 'field' }, [
            el('label', { text: 'Single player' }),
            el('div', { class: 'row' }, [singleInput, addBtn])
          ]),
          el('div', { class: 'field' }, [
            el('label', { text: 'Bulk paste (one per line)' }),
            bulkInput,
            el('div', { style: 'margin-top: 0.5rem' }, [bulkBtn])
          ])
        ]),
        el('div', { class: 'card' }, [
          el('h3', { text: 'Players (' + state.players.length + ')' }),
          playerListEl,
          el('div', { style: 'margin-top: 1rem' }, [startBtn])
        ])
      ])
    ];
  }

  function buildReassignSelect(player) {
    const select = el('select');
    state.players
      .filter(p => p.status === 'alive' && p.id !== player.id)
      .forEach(p => {
        const opt = el('option', { value: String(p.id), text: p.name });
        if (player.targetId === p.id) opt.selected = true;
        select.appendChild(opt);
      });
    return select;
  }

  function viewActive() {
    const game = state.game;
    const aliveCount = state.players.filter(p => p.status === 'alive').length;
    const totalCount = state.players.length;
    const pendingClaims = state.players.filter(p => p.status === 'alive' && p.pendingClaim);

    async function confirmKill(victimId) {
      try {
        await api('POST', '/api/gm/confirm-kill', { victimId });
        state.confirmingKillFor = null;
        await refresh();
      } catch (e) { setError(e.message); state.confirmingKillFor = null; render(); }
    }

    async function undo() {
      try {
        await api('POST', '/api/gm/undo-kill');
        state.info = 'Last kill undone.';
        await refresh();
      } catch (e) { setError(e.message); }
    }

    async function reassign(playerId, newTargetId) {
      try {
        await api('POST', '/api/gm/reassign', { playerId, newTargetId });
        state.reassigningFor = null;
        await refresh();
      } catch (e) { setError(e.message); }
    }

    async function dismissClaim(playerId) {
      try {
        await api('POST', '/api/gm/dismiss-claim', { playerId });
        await refresh();
      } catch (e) { setError(e.message); }
    }

    async function logout() {
      try { await api('POST', '/api/gm/logout'); } catch (e) {}
      await refresh();
    }

    const playerListEl = el('ul', { class: 'player-list' });
    state.players.forEach(p => {
      const li = el('li');
      const top = el('div', { class: 'player-row' }, [
        el('span', { class: 'player-name', text: p.name }),
        el('span', { class: 'badge ' + p.status, text: p.status })
      ]);
      li.appendChild(top);

      const meta = el('div', { class: 'target-info' });
      if (p.status === 'alive' && p.targetName) {
        meta.appendChild(document.createTextNode('Target: '));
        meta.appendChild(el('strong', { text: p.targetName }));
        meta.appendChild(document.createTextNode(' · '));
      }
      meta.appendChild(el('span', { class: 'kill-count', text: 'Kills: ' + p.killCount }));
      if (p.status === 'alive' && p.pendingClaim) {
        const claim = el('span', { class: 'badge pending', text: 'Claims a kill' });
        meta.appendChild(document.createTextNode(' '));
        meta.appendChild(claim);
      }
      li.appendChild(meta);

      if (p.status === 'alive') {
        const isClaim = !!p.pendingClaim && !!p.targetId;
        const claimVictimId = isClaim ? p.targetId : p.id;
        const claimVictimName = isClaim ? (p.targetName || 'target') : p.name;
        const triggerLabel = isClaim ? 'Confirm claim' : 'Confirm kill';
        const confirmMsg = isClaim
          ? 'Confirm: ' + p.name + ' killed ' + claimVictimName + '?'
          : 'Confirm: ' + p.name + ' was killed?';
        const confirmBtnLabel = isClaim ? ('Yes, eliminate ' + claimVictimName) : 'Yes, eliminate';

        const actions = el('div', { class: 'player-actions' });
        if (state.confirmingKillFor === p.id) {
          const stage = el('div', { class: 'confirm-stage' });
          stage.appendChild(el('div', { class: 'notice', text: confirmMsg }));
          const row = el('div', { class: 'row' }, [
            el('button', { class: 'danger', onclick: () => confirmKill(claimVictimId), text: confirmBtnLabel }),
            el('button', { class: 'ghost', onclick: () => { state.confirmingKillFor = null; render(); }, text: 'Cancel' })
          ]);
          stage.appendChild(row);
          actions.appendChild(stage);
        } else if (state.reassigningFor === p.id) {
          const select = buildReassignSelect(p);
          const stage = el('div', { class: 'confirm-stage reassign-row' });
          stage.appendChild(el('div', { class: 'muted', style: 'margin-bottom: 0.4rem', text: 'Reassign target for ' + p.name }));
          stage.appendChild(el('div', { class: 'row' }, [
            select,
            el('button', { onclick: () => {
              const v = parseInt(select.value, 10);
              if (!Number.isFinite(v)) { setError('Pick a target'); return; }
              reassign(p.id, v);
            }, text: 'Save' }),
            el('button', { class: 'ghost', onclick: () => { state.reassigningFor = null; render(); }, text: 'Cancel' })
          ]));
          actions.appendChild(stage);
        } else {
          actions.appendChild(el('button', {
            class: 'danger small',
            onclick: () => { state.confirmingKillFor = p.id; state.reassigningFor = null; render(); },
            text: triggerLabel
          }));
          if (isClaim) {
            actions.appendChild(el('button', {
              class: 'ghost small',
              onclick: () => dismissClaim(p.id),
              text: 'Dismiss claim'
            }));
          }
          if (state.players.filter(x => x.status === 'alive' && x.id !== p.id).length > 0) {
            actions.appendChild(el('button', {
              class: 'ghost small',
              onclick: () => { state.reassigningFor = p.id; state.confirmingKillFor = null; render(); },
              text: 'Reassign'
            }));
          }
        }
        li.appendChild(actions);
      }

      playerListEl.appendChild(li);
    });

    const pinListEl = el('ul', { class: 'pin-list' });
    state.players.forEach(p => {
      pinListEl.appendChild(el('li', {}, [
        el('span', { text: p.name }),
        el('span', { class: 'pin', text: p.pin || '----' })
      ]));
    });

    return [
      el('div', { class: 'card no-print' }, [
        el('div', { class: 'row between' }, [
          el('div', {}, [
            el('h2', { text: game.name }),
            game.weapon ? el('div', { class: 'muted', text: 'Method: ' + game.weapon }) : null,
            el('div', { class: 'muted', text: aliveCount + ' / ' + totalCount + ' alive' })
          ]),
          el('div', { class: 'row' }, [
            el('button', { class: 'ghost small', onclick: () => { state.confirmingNewGame = true; render(); }, text: 'Reset game' }),
            el('button', { class: 'ghost small', onclick: logout, text: 'Log out' })
          ])
        ]),
        pendingClaims.length > 0
          ? el('div', { class: 'notice', text: pendingClaims.length + ' pending kill claim' + (pendingClaims.length === 1 ? '' : 's') })
          : null
      ]),
      el('div', { class: 'gm-grid' }, [
        el('div', { class: 'card' }, [
          el('h3', { text: 'Players' }),
          playerListEl,
          el('div', { class: 'row no-print', style: 'margin-top: 0.75rem' }, [
            el('button', { class: 'subtle', onclick: undo, text: 'Undo last kill' })
          ])
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'row between' }, [
            el('h3', { text: 'PINs (share with players)' }),
            el('button', { class: 'ghost small no-print', onclick: () => window.print(), text: 'Print' })
          ]),
          el('div', { class: 'muted no-print', style: 'margin-bottom: 0.5rem', text: 'Players sign in at this URL with their 4-digit PIN.' }),
          pinListEl
        ])
      ])
    ];
  }

  function viewEnded() {
    const game = state.game;
    const sorted = state.players.slice().sort((a, b) => b.killCount - a.killCount || a.name.localeCompare(b.name));
    const winner = state.players.find(p => p.id === game.winnerId);

    async function logout() {
      try { await api('POST', '/api/gm/logout'); } catch (e) {}
      await refresh();
    }

    const board = el('ol', { class: 'leaderboard' });
    sorted.forEach((p, i) => {
      const li = el('li', {}, [
        el('span', { text: (i + 1) + '. ' + p.name + (p.id === game.winnerId ? ' 🏆' : '') }),
        el('span', { class: 'kill-count', text: p.killCount + ' kills' })
      ]);
      board.appendChild(li);
    });

    return [
      el('div', { class: 'card banner win' }, [
        el('div', { class: 'muted', text: 'Game over' }),
        el('div', { class: 'big', text: winner ? '🏆 ' + winner.name + ' wins!' : 'No winner' }),
        winner ? el('div', { class: 'muted', text: winner.killCount + ' kill' + (winner.killCount === 1 ? '' : 's') }) : null
      ]),
      el('div', { class: 'card' }, [
        el('h3', { text: 'Final standings — ' + game.name }),
        board
      ]),
      el('div', { class: 'card' }, [
        el('div', { class: 'row' }, [
          el('button', { onclick: () => { state.confirmingNewGame = true; render(); }, text: 'Reset / New game' }),
          el('button', { class: 'ghost', onclick: logout, text: 'Log out' })
        ])
      ])
    ];
  }

  // ---------- Top-level render ----------

  function render() {
    clear(app);
    app.className = 'app' + ((state.gmAuthed && state.game) ? ' wide' : '');

    if (state.initialLoad) {
      app.appendChild(viewLoading());
      return;
    }

    const stack = el('div');

    if (!state.hasGame) {
      stack.appendChild(header('Create your first game'));
      const err = errorBanner(); if (err) stack.appendChild(err);
      stack.appendChild(viewCreateGame(false));
    } else if (!state.gmAuthed) {
      stack.appendChild(header('GM login'));
      const err = errorBanner(); if (err) stack.appendChild(err);
      stack.appendChild(viewLogin());
    } else if (state.confirmingNewGame) {
      stack.appendChild(header('Start a new game'));
      const err = errorBanner(); if (err) stack.appendChild(err);
      stack.appendChild(viewCreateGame(true));
    } else if (state.game.status === 'setup') {
      stack.appendChild(header('Setup'));
      const err = errorBanner(); if (err) stack.appendChild(err);
      const info = infoBanner(); if (info) stack.appendChild(info);
      const v = viewSetup();
      v.forEach(n => n && stack.appendChild(n));
    } else if (state.game.status === 'active') {
      stack.appendChild(header('Live game'));
      const err = errorBanner(); if (err) stack.appendChild(err);
      const info = infoBanner(); if (info) stack.appendChild(info);
      const v = viewActive();
      v.forEach(n => n && stack.appendChild(n));
    } else if (state.game.status === 'ended') {
      stack.appendChild(header('Game over'));
      const err = errorBanner(); if (err) stack.appendChild(err);
      const v = viewEnded();
      v.forEach(n => n && stack.appendChild(n));
    }

    app.appendChild(stack);

    if (state.info) {
      setTimeout(() => { state.info = ''; const cur = document.querySelector('.success'); if (cur) cur.remove(); }, 3000);
    }
  }

  refresh();
})();
