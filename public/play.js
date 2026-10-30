const socket = io();
const app = document.getElementById('app');
const clock = makeClock();
const params = new URLSearchParams(location.search);
const SESSION_KEY = 'smuggler-player';

let state = null;
let error = '';
let lastPhaseKey = '';

const loadSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } };
const saveSession = (s) => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} };

// ---------------- connection ----------------

socket.on('connect', () => {
  const s = loadSession();
  const urlRoom = (params.get('room') || '').toUpperCase();
  if (s && s.playerId && (!urlRoom || urlRoom === s.code)) {
    socket.emit('player:join', { code: s.code, playerId: s.playerId }, (res) => {
      if (res.error) { state = null; renderJoin(); }
    });
  } else if (!state) {
    renderJoin();
  }
});

socket.on('player:state', (s) => {
  if (!s) return;
  state = s;
  clock.sync(s);
  const key = `${s.phase}:${s.round}`;
  if (key !== lastPhaseKey) {
    error = '';
    lastPhaseKey = key;
    if (navigator.vibrate && (s.phase === 'write' || s.phase === 'hunt')) navigator.vibrate(120);
  }
  render();
});

socket.on('player:replaced', () => {
  state = null;
  app.innerHTML = '<div class="panel center"><h2>Opened on another device</h2><p class="muted">This seat is now being used somewhere else.</p></div>';
});

function act(msg) {
  socket.emit('player:action', msg, (res) => {
    error = (res && res.error) || '';
    render();
  });
}

// ---------------- join ----------------

function renderJoin(msg = '') {
  const s = loadSession();
  const room = (params.get('room') || (s && s.code) || '').toUpperCase();
  app.innerHTML = `
    <h1 class="logo">Smug<span class="x">g</span>ler</h1>
    <form class="panel" id="join">
      <label>Room code<input id="code" maxlength="4" autocapitalize="characters" autocomplete="off" value="${esc(room)}" placeholder="ABCD"></label>
      <label>Your name<input id="name" maxlength="14" autocomplete="nickname" value="${esc((s && s.name) || '')}" placeholder="Name"></label>
      <div class="err">${esc(msg)}</div>
      <button class="primary big" type="submit">Join</button>
    </form>`;
  document.getElementById(room ? 'name' : 'code').focus();
  document.getElementById('join').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = document.getElementById('code').value.trim().toUpperCase();
    const name = document.getElementById('name').value.trim();
    socket.emit('player:join', { code, name }, (res) => {
      if (res.error) return renderJoin(res.error);
      saveSession({ code: res.code, playerId: res.playerId, name });
    });
  });
}

// ---------------- screens ----------------

function bar() {
  return `
    <div class="bar">
      <span><b>${state.me.vip ? '♛ ' : ''}${esc(state.me.name)}</b></span>
      <span class="pts">${state.me.score}</span>
    </div>`;
}

const timer = () => '<div class="timer" data-timer></div>';

function roster(showDone) {
  return `<div class="roster">${state.players.map((p) => `
    <span class="chip ${p.connected ? '' : 'off'} ${showDone && p.done ? 'done' : ''}">${p.vip ? '♛ ' : ''}${esc(p.name)}</span>`).join('')}</div>`;
}

function lobbyScreen() {
  return `${bar()}
    <div class="panel center">
      <h2>You're in!</h2>
      <p class="muted" style="margin:0">Watch the TV for the rules. You'll get your secret word when the game starts.</p>
    </div>
    <div class="panel">${roster(false)}</div>
    ${state.me.vip
      ? `<button class="primary big" data-act="start" ${state.canStart ? 'disabled' : ''}>Everybody's in. Start!</button>
         ${state.canStart ? `<p class="center muted">${esc(state.canStart)}</p>` : ''}`
      : '<p class="center muted">Waiting for the ♛ VIP to start the game…</p>'}`;
}

function writeScreen() {
  const m = state.mine;
  if (!m) {
    return `${bar()}${timer()}<div class="panel center"><h2>Hang tight</h2><p class="muted">You joined mid-round. You'll play next round!</p></div>`;
  }
  if (m.text) {
    return `${bar()}${timer()}
      <div class="panel">
        <h2>Smuggled! 🕶️</h2>
        <div class="paper">${esc(m.text)}</div>
        <p class="muted center" style="margin:0">Waiting for the others…</p>
        ${roster(true)}
      </div>`;
  }
  const { min, max } = state.limits;
  return `${bar()}${timer()}
    <div class="panel">
      <div class="prompt">${esc(state.prompt)}</div>
      <div class="contraband">
        <div class="muted">Your secret contraband</div>
        <div><span class="tag">${esc(m.word)}</span></div>
      </div>
      <form id="answerform" style="display:flex;flex-direction:column;gap:10px">
        <textarea id="answer" maxlength="${max}" placeholder="Hide &quot;${esc(m.word)}&quot; in your answer…"></textarea>
        <div class="row2"><span id="has" class="no">✗ missing "${esc(m.word)}"</span><span id="count" class="muted">0/${max}</span></div>
        <div class="err">${esc(error)}</div>
        <button class="primary big" type="submit">Smuggle it in</button>
      </form>
      <div class="row2">
        <span class="muted">Hard word? Swap it once per game.</span>
        <button class="ghost" data-act="reroll" ${state.me.rerolls > 0 ? '' : 'disabled'}>Swap (${state.me.rerolls})</button>
      </div>
      <p class="muted" style="margin:0;font-size:.9rem">Tip: sprinkle in other odd words as decoys. Min ${min} characters.</p>
    </div>`;
}

function huntScreen() {
  const guesses = state.myGuesses;
  const others = state.answers.filter((a) => a.slot !== state.mine?.slot);
  const done = others.filter((a) => guesses[a.slot] !== undefined).length;
  const cards = state.answers.map((a) => {
    if (a.slot === state.mine?.slot) {
      return `<div class="paper mine"><span class="slot">${a.slot}</span>${a.tokens.map((t) => esc(t.t)).join('')}<div class="hint">Your answer</div></div>`;
    }
    const sel = guesses[a.slot];
    const body = a.tokens.map((t, i) => (t.w
      ? `<span class="w ${sel === i ? 'sel' : ''}" data-slot="${a.slot}" data-idx="${i}">${esc(t.t)}</span>`
      : esc(t.t))).join('');
    return `<div class="paper"><span class="slot">${a.slot}</span>${body}${sel === undefined ? '<div class="hint">Tap the smuggled word</div>' : ''}</div>`;
  }).join('');
  return `${bar()}${timer()}
    <div class="row2"><h2>Inspection</h2><span class="${done === others.length ? 'ok' : 'muted'}">${done}/${others.length} marked</span></div>
    <div class="err">${esc(error)}</div>
    <div class="hunt-list">${cards}</div>
    <p class="center muted">You can change a pick until time runs out.</p>`;
}

function revealScreen() {
  return `${bar()}
    <div class="panel center">
      <h1>👀</h1>
      <h2>Eyes on the TV</h2>
      <p class="muted" style="margin:0">The smugglers are being unmasked…</p>
    </div>
    ${state.me.vip ? '<button class="ghost big" data-act="next">Next answer</button>' : ''}`;
}

function scoresScreen() {
  const r = state.myRound;
  const last = state.round >= state.totalRounds;
  let summary = '';
  if (r) {
    const items = [];
    if (r.mine) {
      items.push(r.mine.caughtBy.length
        ? `<div class="item bad">Your word was caught by ${r.mine.caughtBy.map(esc).join(', ')}${r.mine.fooled ? `, but it slipped past ${r.mine.fooled}` : ''}.</div>`
        : `<div class="item good">Nobody caught your word! It slipped past ${r.mine.fooled}.</div>`);
    }
    r.caught.forEach((c) => items.push(`<div class="item good">You caught ${esc(c.author)}'s <span class="tag">${esc(c.word)}</span></div>`));
    r.missed.forEach((c) => items.push(`<div class="item bad">${esc(c.author)} slipped <span class="tag">${esc(c.word)}</span> past you${c.guessed ? '' : ' (no pick)'}</div>`));
    summary = `<div class="panel"><h2>This round: <span class="amber">+${r.delta}</span></h2>${items.join('')}</div>`;
  }
  const rank = state.leaderboard.findIndex((p) => p.name === state.me.name) + 1;
  return `${bar()}
    <div class="panel center"><h2>You're #${rank} of ${state.leaderboard.length}</h2></div>
    ${summary}
    ${state.me.vip
      ? `<button class="primary big" data-act="next">${last ? 'Final results' : 'Next round'}</button>`
      : '<p class="center muted">The ♛ VIP will start the next round.</p>'}`;
}

function endScreen() {
  const rank = state.leaderboard.findIndex((p) => p.name === state.me.name) + 1;
  const award = (a, title) => (a && a.names.includes(state.me.name) ? `<div class="item good">You won <b>${title}</b>!</div>` : '');
  return `${bar()}
    <div class="panel center">
      <h1>${rank === 1 ? 'You win! 🏆' : `#${rank}`}</h1>
      <p class="muted" style="margin:0">${state.me.score} points</p>
      ${award(state.awards.smuggler, '🕶️ Master Smuggler')}${award(state.awards.bloodhound, '🐕 Bloodhound')}
    </div>
    ${state.me.vip ? '<button class="primary big" data-act="playAgain">Play again</button>' : '<p class="center muted">Waiting for the ♛ VIP…</p>'}`;
}

const screens = { lobby: lobbyScreen, write: writeScreen, hunt: huntScreen, reveal: revealScreen, scores: scoresScreen, end: endScreen };

function updateAnswerMeta() {
  const ta = document.getElementById('answer');
  if (!ta || !state.mine) return;
  const ok = containsWord(ta.value, state.mine.word);
  const has = document.getElementById('has');
  has.className = ok ? 'ok' : 'no';
  has.textContent = ok ? `✓ "${state.mine.word}" smuggled in` : `✗ missing "${state.mine.word}"`;
  document.getElementById('count').textContent = `${ta.value.length}/${state.limits.max}`;
}

function render() {
  if (!state) return;
  // Keep a half-written answer (and the cursor) across re-renders.
  const ta = document.getElementById('answer');
  const draft = ta ? { value: ta.value, focused: document.activeElement === ta, start: ta.selectionStart, end: ta.selectionEnd } : null;
  const scrollY = window.scrollY;

  app.innerHTML = screens[state.phase]();

  const newTa = document.getElementById('answer');
  if (newTa) {
    if (draft) {
      newTa.value = draft.value;
      if (draft.focused) {
        newTa.focus();
        newTa.setSelectionRange(draft.start, draft.end);
      }
    }
    newTa.addEventListener('input', updateAnswerMeta);
    updateAnswerMeta();
    document.getElementById('answerform').addEventListener('submit', (e) => {
      e.preventDefault();
      act({ type: 'answer', text: newTa.value });
    });
  }
  if (state.phase === 'hunt') window.scrollTo(0, scrollY);
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-slot]');
  if (!el) return;
  if (el.dataset.act) act({ type: el.dataset.act });
  else act({ type: 'guess', slot: el.dataset.slot, idx: Number(el.dataset.idx) });
});

startTimerLoop(clock);
