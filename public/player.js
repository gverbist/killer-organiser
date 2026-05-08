(function () {
  'use strict';

  const app = document.getElementById('app');
  const STORAGE_KEY = 'killer.pin';

  const state = {
    initialLoad: true,
    pin: localStorage.getItem(STORAGE_KEY) || '',
    view: null,
    error: '',
    pollTimer: null,
    confirmingClaim: false
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
                 k === 'pattern' || k === 'min' || k === 'max') {
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
    if (state.pin) opts.headers['X-Player-Pin'] = state.pin;
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

  function clearPin() {
    state.pin = '';
    state.view = null;
    localStorage.removeItem(STORAGE_KEY);
  }

  async function refresh() {
    if (!state.pin) {
      state.initialLoad = false;
      render();
      schedulePoll();
      return;
    }
    try {
      state.view = await api('GET', '/api/player/me');
      state.error = '';
    } catch (e) {
      if (e.status === 401 || e.status === 404) {
        clearPin();
        state.error = 'Session expired or PIN invalid. Please re-enter.';
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
    if (state.pin && state.view) {
      state.pollTimer = setTimeout(refresh, 15000);
    }
  }

  // ---------- Views ----------

  function viewLoading() {
    return el('div', { class: 'loading-overlay' }, [
      el('span', { class: 'spinner' }),
      ' Loading...'
    ]);
  }

  function viewPinEntry() {
    let input, btn;

    async function submit() {
      const pin = (input.value || '').trim();
      if (!/^\d{4}$/.test(pin)) { setError('PIN must be 4 digits'); return; }
      btn.disabled = true;
      const original = btn.textContent;
      clear(btn); btn.appendChild(el('span', { class: 'spinner' })); btn.appendChild(document.createTextNode(' Checking...'));
      state.pin = pin;
      localStorage.setItem(STORAGE_KEY, pin);
      try {
        state.view = await api('GET', '/api/player/me');
        state.error = '';
        render();
        schedulePoll();
      } catch (e) {
        clearPin();
        setError(e.message || 'Invalid PIN');
        btn.disabled = false;
        btn.textContent = original;
      }
    }

    input = el('input', {
      class: 'pin-input',
      type: 'tel',
      inputmode: 'numeric',
      pattern: '[0-9]*',
      maxlength: '4',
      placeholder: '••••',
      autocomplete: 'one-time-code'
    });
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 4);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    btn = el('button', { onclick: submit, text: 'Enter' });
    setTimeout(() => input.focus(), 50);

    return el('div', { class: 'card pin-entry' }, [
      el('h1', { text: 'KILLER' }),
      el('div', { class: 'muted', text: 'Enter your 4-digit PIN' }),
      el('div', { class: 'field', style: 'margin-top: 1rem' }, [input]),
      btn
    ]);
  }

  function viewActivePlayer() {
    const v = state.view;

    async function claim() {
      try {
        await api('POST', '/api/player/claim-kill');
        state.confirmingClaim = false;
        await refresh();
      } catch (e) { setError(e.message); state.confirmingClaim = false; render(); }
    }

    function logout() {
      clearPin();
      state.error = '';
      render();
    }

    const items = [];

    items.push(el('div', { class: 'card' }, [
      el('div', { class: 'row between' }, [
        el('div', {}, [
          el('div', { class: 'muted', text: 'Logged in as' }),
          el('div', { class: 'player-name', style: 'font-size: 1.2rem', text: v.name })
        ]),
        el('button', { class: 'ghost small', onclick: logout, text: 'Sign out' })
      ])
    ]));

    if (v.pendingClaim) {
      items.push(el('div', { class: 'card' }, [
        el('div', { class: 'notice', text: 'Kill claim sent. Waiting for the GM to confirm...' }),
        el('div', { class: 'target-display' }, [
          el('div', { class: 'label', text: 'Your target' }),
          el('div', { class: 'target-name', text: v.targetFirstName || '—' }),
          v.weapon ? el('div', { class: 'weapon', text: 'Method: ' + v.weapon }) : null
        ])
      ]));
    } else {
      items.push(el('div', { class: 'card' }, [
        el('div', { class: 'target-display' }, [
          el('div', { class: 'label', text: 'Your target' }),
          el('div', { class: 'target-name', text: v.targetFirstName || '—' }),
          v.weapon ? el('div', { class: 'weapon', text: 'Method: ' + v.weapon }) : null
        ])
      ]));

      const actionCard = el('div', { class: 'card' });
      if (state.confirmingClaim) {
        actionCard.appendChild(el('div', { class: 'notice', text: 'Confirm: did you kill ' + (v.targetFirstName || 'your target') + '?' }));
        actionCard.appendChild(el('div', { class: 'row' }, [
          el('button', { class: 'danger', onclick: claim, text: 'Yes, I made the kill' }),
          el('button', { class: 'ghost', onclick: () => { state.confirmingClaim = false; render(); }, text: 'Cancel' })
        ]));
      } else {
        actionCard.appendChild(el('button', {
          onclick: () => { state.confirmingClaim = true; render(); },
          text: 'I made a kill'
        }));
      }
      items.push(actionCard);
    }

    items.push(el('div', { class: 'card' }, [
      el('div', { class: 'row between' }, [
        el('span', { class: 'muted', text: 'Your kills' }),
        el('span', { class: 'kill-count', text: String(v.killCount) })
      ])
    ]));

    return items;
  }

  function viewDead() {
    const v = state.view;
    function logout() { clearPin(); state.error = ''; render(); }
    return [
      el('div', { class: 'card banner dead' }, [
        el('div', { class: 'big', text: '☠ Eliminated' }),
        el('div', { class: 'muted', text: 'You have been killed. Better luck next time.' }),
        el('div', { style: 'margin-top: 0.5rem' }, [
          el('span', { class: 'kill-count', text: 'Kills: ' + v.killCount })
        ])
      ]),
      el('div', { class: 'card center' }, [
        el('button', { class: 'ghost', onclick: logout, text: 'Sign out' })
      ])
    ];
  }

  function viewGameEnded() {
    const v = state.view;
    function logout() { clearPin(); state.error = ''; render(); }
    if (v.isWinner) {
      return [
        el('div', { class: 'card banner win' }, [
          el('div', { class: 'muted', text: 'Last one standing' }),
          el('div', { class: 'big', text: '🏆 You won!' }),
          el('div', { class: 'muted', text: v.killCount + ' kill' + (v.killCount === 1 ? '' : 's') })
        ]),
        el('div', { class: 'card center' }, [
          el('button', { class: 'ghost', onclick: logout, text: 'Sign out' })
        ])
      ];
    }
    return [
      el('div', { class: 'card banner' }, [
        el('div', { class: 'big', text: 'Game over' }),
        v.winnerName ? el('div', { class: 'muted', text: 'Winner: ' + v.winnerName }) : null,
        el('div', { class: 'muted', style: 'margin-top: 0.5rem', text: 'Your kills: ' + v.killCount })
      ]),
      el('div', { class: 'card center' }, [
        el('button', { class: 'ghost', onclick: logout, text: 'Sign out' })
      ])
    ];
  }

  function viewSetupWaiting() {
    const v = state.view;
    function logout() { clearPin(); state.error = ''; render(); }
    return [
      el('div', { class: 'card center' }, [
        el('h2', { text: 'Hi, ' + v.name }),
        el('div', { class: 'notice', text: 'The game has not started yet. Hold tight — your target will appear when the GM starts the game.' }),
        el('div', { style: 'margin-top: 1rem' }, [
          el('button', { class: 'ghost', onclick: logout, text: 'Sign out' })
        ])
      ])
    ];
  }

  // ---------- Top-level render ----------

  function render() {
    clear(app);

    if (state.initialLoad) {
      app.appendChild(viewLoading());
      return;
    }

    const stack = el('div');

    if (!state.pin || !state.view) {
      if (state.error) stack.appendChild(el('div', { class: 'error', text: state.error }));
      stack.appendChild(viewPinEntry());
      app.appendChild(stack);
      return;
    }

    if (state.error) stack.appendChild(el('div', { class: 'error', text: state.error }));

    let nodes;
    if (state.view.gameStatus === 'setup') {
      nodes = viewSetupWaiting();
    } else if (state.view.gameStatus === 'ended') {
      nodes = viewGameEnded();
    } else if (state.view.status === 'dead') {
      nodes = viewDead();
    } else {
      nodes = viewActivePlayer();
    }
    nodes.forEach(n => n && stack.appendChild(n));
    app.appendChild(stack);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.pin) refresh();
  });

  refresh();
})();
