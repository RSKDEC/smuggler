const socket = io();
const app = document.getElementById('app');
const clock = makeClock();
const params = new URLSearchParams(location.search);
const SESSION_KEY = 'smuggler-player';

let state = null;
let error = '';
let lastPhaseKey = '';
let hostOpen = false;

const loadSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } };
const saveSession = (s) => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} };
const buzz = (pattern) => navigator.vibrate && navigator.vibrate(pattern);

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
    if (s.phase === 'write' || s.phase === 'hunt') buzz(120);
    if (s.phase === 'scores' && s.myRound) {
      if (s.myRound.mine && s.myRound.mine.caughtBy.length) buzz([60, 60, 60, 60, 200]);
      else if (s.myRound.delta > 0) buzz([40, 40, 40]);
    }
  }
  render();
});

socket.on('player:kicked', () => {
  state = null;
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  app.innerHTML = '<div class="panel center"><h2>You were removed</h2><p class="muted">The VIP removed you from this game.</p></div>';
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
      <span class="who">${avatarSvg(state.me.avatar)}<b>${state.me.vip ? '♛ ' : ''}${esc(state.me.name)}</b></span>
      <span class="pts">${state.me.score}</span>
    </div>`;
}

const timer = () => '<div class="fuse"><div class="fuse-bar" data-fuse><span class="spark"></span></div></div><div class="timer" data-timer></div>';

function roster(showDone) {
  return `<div class="roster">${state.players.map((p) => `
    <span class="chip ${p.connected ? '' : 'off'} ${showDone && p.done ? 'done' : ''}">${avatarSvg(p.avatar)}${p.vip ? '♛ ' : ''}${esc(p.name)}</span>`).join('')}</div>`;
}

const PACES = [['relaxed', 'Relaxed'], ['normal', 'Normal'], ['quick', 'Quick']];

function settingsPanel() {
  const st = state.settings;
  const seg = (key, options) => `<div class="seg">${options.map(([v, label]) => `
    <button class="${st[key] === v ? 'on' : ''}" data-setting="${key}" data-value="${v}">${label}</button>`).join('')}</div>`;
  const toggle = (key, label) => `<div class="toggle"><span>${label}</span>
    <button class="${st[key] ? 'on' : ''}" data-setting="${key}" data-value="${st[key] ? '' : '1'}">${st[key] ? 'On' : 'Off'}</button></div>`;
  return `
    <details class="panel hostbox" open>
      <summary>♛ Game settings</summary>
      <div class="setting"><label>Word pack</label>${seg('pack', Object.entries(state.packs))}</div>
      <div class="setting"><label>Rounds</label>${seg('rounds', state.roundChoices.map((r) => [r, String(r)]))}</div>
      <div class="setting"><label>Pace</label>${seg('pace', PACES)}</div>
      ${toggle('finale', '🔥 Double Contraband finale')}
      ${toggle('wanted', '💰 Most Wanted bounty')}
    </details>`;
}

function kickList() {
  const others = state.players.filter((p) => p.name !== state.me.name);
  if (!others.length) return '';
  return `<div class="setting"><label>Remove a player</label>${others.map((p) => `
    <div class="kickrow"><span>${esc(p.name)}${p.connected ? '' : ' <span class="muted">(offline)</span>'}</span>
    <button class="ghost" data-kick="${esc(p.name)}">Remove</button></div>`).join('')}</div>`;
}

// The TV can't be clicked once it's cast, so the VIP runs the show from here.
function hostControls() {
  if (!state.me.vip) return '';
  const timed = ['write', 'hunt', 'reveal'].includes(state.phase);
  const buttons = timed ? `<div class="seg">
      ${state.paused ? '<button class="primary" data-act="resume">▶ Resume</button>' : '<button data-act="pause">⏸ Pause</button>'}
      <button data-act="skip">⏭ Skip timer</button>
    </div>` : '';
  return `<details class="panel hostbox ctl" ${hostOpen || state.paused ? 'open' : ''}>
      <summary>♛ Host controls</summary>
      ${buttons}
      ${kickList()}
    </details>`;
}

function banners() {
  let html = '';
  if (state.paused) html += '<div class="paused">⏸ Game paused</div>';
  if (state.finale && (state.phase === 'write' || state.phase === 'hunt')) {
    html += `<div class="finale">🔥 Finale: two words each, points ×${state.multiplier}</div>`;
  }
  return html;
}

function lobbyScreen() {
  const me = state.me.avatar;
  const taken = new Set(state.players.filter((p) => p.name !== state.me.name).map((p) => p.avatar.color));
  return `${bar()}
    <div class="panel center">
      <div class="me-avatar">${avatarSvg(me)}</div>
      <h2>Pick your disguise</h2>
      <div class="swatches">${AVATAR_COLORS.map((c, i) => `
        <button class="swatch ${i === me.color ? 'on' : ''}" style="--c:${c}" data-color="${i}" ${taken.has(i) ? 'disabled' : ''} aria-label="Color ${i + 1}"></button>`).join('')}
      </div>
      <div class="disguises">${DISGUISES.map((d, i) => `
        <button class="dz ${i === me.disguise ? 'on' : ''}" data-disguise="${i}">${avatarSvg({ color: me.color, disguise: i })}<span>${d}</span></button>`).join('')}
      </div>
      <div class="err">${esc(error)}</div>
    </div>
    <div class="panel">${roster(false)}</div>
    ${state.me.vip
      ? `${settingsPanel()}
         <button class="primary big" data-act="start" ${state.canStart ? 'disabled' : ''}>Everybody's in. Start!</button>
         ${state.canStart ? `<p class="center muted">${esc(state.canStart)}</p>` : ''}
         ${hostControls()}`
      : '<p class="center muted">Waiting for the ♛ VIP to start the game…</p>'}`;
}

function writeScreen() {
  const m = state.mine;
  if (!m) {
    return `${bar()}${timer()}${banners()}<div class="panel center"><h2>Hang tight</h2><p class="muted">You joined mid-round. You'll play next round!</p></div>${hostControls()}`;
  }
  if (m.text) {
    return `${bar()}${timer()}${banners()}
      <div class="panel">
        <h2>Smuggled! 🕶️</h2>
        <div class="paper">${esc(m.text)}</div>
        <p class="muted center" style="margin:0">Waiting for the others…</p>
        ${roster(true)}
      </div>
      ${hostControls()}`;
  }
  const { min, max } = state.limits;
  const two = m.words.length > 1;
  const wanted = state.me.wanted
    ? `<div class="wantedme"><b>💰 You're Most Wanted!</b><br>Your answer is marked on the TV. Catchers earn a +${state.points.bounty * state.multiplier} bounty, so hide it well.</div>`
    : '';
  const swaps = m.words.map((w, i) => `
    <button class="ghost" data-reroll="${i}" ${state.me.rerolls > 0 ? '' : 'disabled'}>Swap${two ? ` “${esc(w)}”` : ''} (${state.me.rerolls})</button>`).join('');
  return `${bar()}${timer()}${banners()}
    ${wanted}
    <div class="panel">
      <div class="prompt">${esc(state.prompt)}</div>
      <div class="contraband">
        <div class="muted">Your secret contraband${two ? ' (both words!)' : ''}</div>
        <div class="tags">${m.words.map((w) => `<span class="tag">${esc(w)}</span>`).join('')}</div>
      </div>
      <form id="answerform" style="display:flex;flex-direction:column;gap:10px">
        <textarea id="answer" maxlength="${max}" placeholder="Hide ${m.words.map((w) => `&quot;${esc(w)}&quot;`).join(' and ')} in your answer…"></textarea>
        <div class="row2"><span id="has" class="no"></span><span id="count" class="muted">0/${max}</span></div>
        <div class="err">${esc(error)}</div>
        <button class="primary big" type="submit">Smuggle it in</button>
      </form>
      <div class="row2">
        <span class="muted">Hard word? One swap per game.</span>
        <span>${swaps}</span>
      </div>
      <p class="muted" style="margin:0;font-size:.9rem">Tip: sprinkle in other odd words as decoys. If 2+ players fall for one, you get +${state.points.decoy}. Min ${min} characters.</p>
    </div>
    ${hostControls()}`;
}

function huntScreen() {
  const guesses = state.myGuesses;
  const others = state.answers.filter((a) => a.slot !== state.mine?.slot);
  const picked = others.filter((a) => (guesses[a.slot] || []).length === a.picks).length;
  const allDone = picked === others.length && state.myHeart;
  const cards = state.answers.map((a) => {
    if (a.slot === state.mine?.slot) {
      return `<div class="paper mine"><span class="slot">${a.slot}</span>${a.tokens.map((t) => esc(t.t)).join('')}<div class="hint">Your answer</div></div>`;
    }
    const sel = guesses[a.slot] || [];
    const loved = state.myHeart === a.slot;
    const body = a.tokens.map((t, i) => (t.w
      ? `<span class="w ${sel.includes(i) ? 'sel' : ''}" data-slot="${a.slot}" data-idx="${i}">${esc(t.t)}</span>`
      : esc(t.t))).join('');
    const need = a.picks - sel.length;
    const hint = need > 0 ? `<div class="hint">Tap ${a.picks > 1 ? `${need} more smuggled ${need === 1 ? 'word' : 'words'}` : 'the smuggled word'}</div>` : '';
    return `<div class="paper ${a.wanted ? 'is-wanted' : ''}"><span class="slot">${a.slot}</span>
      ${a.wanted ? '<span class="wanted-badge">💰 Wanted</span>' : ''}
      <button class="heart ${loved ? 'on' : ''}" data-heart="${a.slot}" aria-label="Favorite">${loved ? '❤️' : '🤍'}</button>
      ${body}${hint}</div>`;
  }).join('');
  return `${bar()}${timer()}${banners()}
    <div class="row2"><h2>Inspection</h2><span class="${allDone ? 'ok' : 'muted'}">${picked}/${others.length} marked · ${state.myHeart ? '❤️' : '🤍'}</span></div>
    <div class="err">${esc(error)}</div>
    <div class="hunt-list">${cards}</div>
    <p class="center muted">${state.myHeart ? 'Tap a word again to unpick it. You can change picks until time runs out.' : 'Tap 🤍 on your favorite answer. Funniest one wins +' + state.points.favorite + '.'}</p>
    ${hostControls()}`;
}

function revealScreen() {
  return `${bar()}
    <div class="panel center">
      <div class="me-avatar">${avatarSvg(state.me.avatar)}</div>
      <h2>Eyes on the TV</h2>
      <p class="muted" style="margin:0">The smugglers are being unmasked…</p>
    </div>
    ${banners()}
    ${state.me.vip ? `<button class="ghost big" data-act="next" ${state.paused ? 'disabled' : ''}>Next answer</button>${hostControls()}` : ''}`;
}

function scoresScreen() {
  const r = state.myRound;
  const last = state.round >= state.totalRounds;
  const p = state.points;
  let summary = '';
  if (r) {
    const items = [];
    if (r.mine) {
      items.push(r.mine.caughtBy.length
        ? `<div class="item bad">Your word was caught by ${r.mine.caughtBy.map(esc).join(', ')}${r.mine.fooled ? `, but it slipped past ${r.mine.fooled}` : ''}.</div>`
        : `<div class="item good">Nobody caught your word! It slipped past ${r.mine.fooled}.</div>`);
      if (r.mine.decoy) items.push(`<div class="item good">🎭 Your decoy “${esc(r.mine.decoy.word)}” fooled ${r.mine.decoy.count} (+${p.decoy})</div>`);
      if (r.mine.favorite) items.push(`<div class="item good">❤️ Crowd favorite with ${r.mine.hearts} hearts (+${p.favorite})</div>`);
      else if (r.mine.hearts) items.push(`<div class="item">❤️ Your answer got ${r.mine.hearts} ${r.mine.hearts === 1 ? 'heart' : 'hearts'}</div>`);
    }
    r.caught.forEach((c) => items.push(`<div class="item good">You caught ${esc(c.author)}'s <span class="tag">${esc(c.word)}</span>${c.wanted ? ' 💰 bounty!' : ''}</div>`));
    r.missed.forEach((c) => items.push(`<div class="item bad">${esc(c.author)} slipped <span class="tag">${esc(c.word)}</span> past you</div>`));
    summary = `<div class="panel"><h2>This round: <span class="amber">+${r.delta}</span></h2>${items.join('')}</div>`;
  }
  const rank = state.leaderboard.findIndex((x) => x.name === state.me.name) + 1;
  return `${bar()}
    <div class="panel center"><h2>You're #${rank} of ${state.leaderboard.length}</h2></div>
    ${summary}
    ${state.finaleNext ? '<div class="finale">🔥 Next up: Double Contraband finale!</div>' : ''}
    ${state.me.vip
      ? `<button class="primary big" data-act="next">${last ? 'Final results' : 'Next round'}</button>${hostControls()}`
      : '<p class="center muted">The ♛ VIP will start the next round.</p>'}`;
}

function endScreen() {
  const rank = state.leaderboard.findIndex((p) => p.name === state.me.name) + 1;
  const award = (a, title) => (a && a.names.includes(state.me.name) ? `<div class="item good">You won <b>${title}</b>!</div>` : '');
  return `${bar()}
    <div class="panel center">
      <div class="me-avatar">${avatarSvg(state.me.avatar, { mood: rank === 1 ? 'smug' : undefined })}</div>
      <h1>${rank === 1 ? 'You win! 🏆' : `#${rank}`}</h1>
      <p class="muted" style="margin:0">${state.me.score} points</p>
      ${award(state.awards.smuggler, '🕶️ Master Smuggler')}${award(state.awards.bloodhound, '🐕 Bloodhound')}${award(state.awards.favorite, '❤️ Crowd Favorite')}
    </div>
    ${state.me.vip ? '<button class="primary big" data-act="playAgain">Play again</button>' : '<p class="center muted">Waiting for the ♛ VIP…</p>'}`;
}

const screens = { lobby: lobbyScreen, write: writeScreen, hunt: huntScreen, reveal: revealScreen, scores: scoresScreen, end: endScreen };

function updateAnswerMeta() {
  const ta = document.getElementById('answer');
  if (!ta || !state.mine) return;
  const missing = state.mine.words.filter((w) => !containsWord(ta.value, w));
  const has = document.getElementById('has');
  has.className = missing.length ? 'no' : 'ok';
  has.textContent = missing.length ? `✗ missing ${missing.map((w) => `"${w}"`).join(' and ')}` : '✓ all smuggled in';
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
  if (state.phase === 'hunt' || state.phase === 'lobby') window.scrollTo(0, scrollY);
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act],[data-slot],[data-heart],[data-color],[data-disguise],[data-setting],[data-kick],[data-reroll]');
  if (!el || el.disabled) return;
  const d = el.dataset;
  if (d.act) act({ type: d.act });
  else if (d.reroll) act({ type: 'reroll', which: Number(d.reroll) });
  else if (d.kick) {
    if (confirm(`Remove ${d.kick} from the game?`)) act({ type: 'kick', name: d.kick });
  } else if (d.setting) {
    const raw = d.value;
    const value = d.setting === 'rounds' ? Number(raw) : d.setting === 'finale' || d.setting === 'wanted' ? raw === '1' : raw;
    act({ type: 'settings', settings: { [d.setting]: value } });
  }
  else if (d.heart) { buzz(30); act({ type: 'heart', slot: d.heart }); }
  else if (d.slot) { buzz(15); act({ type: 'guess', slot: d.slot, idx: Number(d.idx) }); }
  else if (d.color) act({ type: 'avatar', color: Number(d.color), disguise: state.me.avatar.disguise });
  else if (d.disguise) act({ type: 'avatar', color: state.me.avatar.color, disguise: Number(d.disguise) });
});

// Remember whether the VIP left the host controls open across re-renders.
app.addEventListener('toggle', (e) => {
  if (e.target.matches && e.target.matches('details.ctl')) hostOpen = e.target.open;
}, true);

startTimerLoop(clock);
