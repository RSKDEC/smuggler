const socket = io();
const app = document.getElementById('app');
const clock = makeClock();
const HOST_KEY = 'smuggler-host';
let state = null;
let qr = null;

const saved = () => { try { return sessionStorage.getItem(HOST_KEY); } catch { return null; } };
const save = (code) => { try { sessionStorage.setItem(HOST_KEY, code); } catch {} };

const joinUrl = (code) => `${location.origin}/play?room=${code}`;

function onRoom(res) {
  save(res.code);
  socket.emit('host:qr', { url: joinUrl(res.code) }, (r) => {
    qr = r.dataUrl || null;
    render();
  });
}

socket.on('connect', () => {
  const code = saved();
  if (code) {
    socket.emit('host:resume', { code }, (res) => (res.error ? socket.emit('host:create', null, onRoom) : onRoom(res)));
  } else {
    socket.emit('host:create', null, onRoom);
  }
});

socket.on('host:state', (s) => {
  state = s;
  clock.sync(s);
  render();
});

function act(action) {
  socket.emit('host:action', { action }, (res) => res && res.error && alert(res.error));
}

function newRoom() {
  if (!confirm('Start a brand-new room? Everyone will need to rejoin.')) return;
  try { sessionStorage.removeItem(HOST_KEY); } catch {}
  socket.emit('host:create', null, onRoom);
}

app.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'newRoom') newRoom();
  else act(btn.dataset.act);
});

// ---------------- render ----------------

function header() {
  const phase = {
    lobby: 'Lobby', write: 'Smuggling', hunt: 'Inspection', reveal: 'Busted?', scores: 'Scores', end: 'Final scores',
  }[state.phase];
  const round = state.round && state.phase !== 'lobby' ? ` · Round ${state.round}/${state.totalRounds}` : '';
  return `
    <div class="tv-top">
      <div class="logo">Smug<span class="x">g</span>ler</div>
      <div class="info">${phase}${round} · Room <b class="amber">${esc(state.code)}</b></div>
      <div class="timer" data-timer></div>
    </div>`;
}

function people(showDone) {
  if (!state.players.length) return '<span class="muted">Waiting for players…</span>';
  return `<div class="people">${state.players.map((p) => `
    <div class="person ${p.connected ? '' : 'off'} ${showDone && p.done ? 'done' : ''}">
      ${showDone && p.done ? '<span class="check">✅</span>' : ''}
      ${p.vip ? '<span class="crown">♛</span> ' : ''}${esc(p.name)}
    </div>`).join('')}</div>`;
}

function lobby() {
  const { minPlayers, maxPlayers } = state.limits;
  return `
    ${header()}
    <div class="lobby">
      <div class="joinbox">
        <div class="muted">Join on your phone</div>
        <div class="code">${esc(state.code)}</div>
        ${qr ? `<img src="${qr}" alt="QR code to join">` : ''}
        <div class="url muted">${esc(joinUrl(state.code))}</div>
      </div>
      <div class="roomlist">
        <h2>Smugglers (${state.players.length}/${maxPlayers})</h2>
        ${people(false)}
      </div>
      <div class="howto">
        <b class="amber">How to play.</b> Everyone answers the same prompt, but each of you gets a secret
        <span class="tag" style="font-size:1.1vw">contraband</span> word you must sneak into your answer.
        <ol>
          <li><b>Smuggle:</b> write an answer that hides your word so naturally nobody notices it.</li>
          <li><b>Inspect:</b> read everyone's answers and tap the word you think each person smuggled.</li>
          <li><b>Score:</b> +${state.points.catch} for every word you catch, +${state.points.sneak} for every player your word slips past.</li>
        </ol>
        Pro tip: throw in a few weird decoy words so they tap the wrong one. ${minPlayers}–${maxPlayers} players. ♛ = VIP, who starts the game from their phone.
      </div>
    </div>
    <div class="tv-actions">
      <button data-act="start" class="primary" ${state.canStart ? 'disabled' : ''}>Start game</button>
      <button data-act="newRoom" class="ghost">New room</button>
    </div>
    ${state.canStart ? `<p class="sub">${esc(state.canStart)}</p>` : ''}`;
}

function writeScreen() {
  const done = state.players.filter((p) => p.done).length;
  return `
    ${header()}
    <div class="prompt">${esc(state.prompt)}</div>
    <div class="sub">Check your phone for your secret contraband word and smuggle it into your answer 🤫 · ${done}/${state.players.length} done</div>
    <div class="roomlist">${people(true)}</div>
    <div class="tv-actions"><button data-act="skip" class="ghost">Skip timer</button></div>`;
}

function tokensHtml(tokens, opts = {}) {
  return tokens.map((tok, i) => {
    if (!tok.w) return esc(tok.t);
    if (opts.word && isWord(tok.t, opts.word)) return `<span class="tok-hit">${esc(tok.t)}</span>`;
    const n = opts.picks && opts.picks[i];
    if (n) return `<span class="tok-pick">${esc(tok.t)}<sup>${n}</sup></span>`;
    return esc(tok.t);
  }).join('');
}

function huntScreen() {
  const { done, total } = state.progress;
  return `
    ${header()}
    <div class="prompt small">${esc(state.prompt)}</div>
    <div class="answers">${state.answers.map((a) => `
      <div class="paper"><span class="slot">${a.slot}</span>${tokensHtml(a.tokens)}</div>`).join('')}
    </div>
    <div class="progressline">On your phones: tap the smuggled word in every answer · ${done}/${total} picks in</div>
    <div class="tv-actions"><button data-act="skip" class="ghost">Skip timer</button></div>`;
}

function revealScreen() {
  const r = state.results[state.revealIdx];
  const nobody = r.catchers.length === 0;
  return `
    ${header()}
    <div class="prompt small">${esc(state.prompt)}</div>
    <div class="spotlight">
      <div class="paper"><span class="slot">${r.slot}</span>${tokensHtml(r.tokens, { word: r.word, picks: r.picks })}</div>
      <div class="verdict"><span>Smuggled by <b>${esc(r.author)}</b></span><span class="tag">${esc(r.word)}</span></div>
      <div class="verdict-line">
        ${nobody
          ? `🕶️ Nobody caught it! It slipped past <b>${r.fooled}</b> ${r.fooled === 1 ? 'player' : 'players'} (+${r.fooled * state.points.sneak})`
          : `🚨 Caught by <b>${r.catchers.map(esc).join(', ')}</b> (+${state.points.catch} each)${r.fooled ? ` · slipped past ${r.fooled} (+${r.fooled * state.points.sneak} to ${esc(r.author)})` : ''}`}
      </div>
      <div class="dots">${state.results.map((_, i) => `<span class="${i <= state.revealIdx ? 'on' : ''}"></span>`).join('')}</div>
    </div>
    <div class="tv-actions"><button data-act="next" class="primary">Next</button></div>`;
}

function board(showDelta) {
  return `<div class="board">${state.leaderboard.map((p, i) => `
    <div class="row ${i === 0 && p.score > 0 ? 'first' : ''}" style="animation-delay:${i * 60}ms">
      <span class="rank">${i + 1}</span>
      <span>${esc(p.name)}</span>
      <span class="delta">${showDelta && p.delta ? `+${p.delta}` : ''}</span>
      <span class="pts">${p.score}</span>
    </div>`).join('')}</div>`;
}

function scoresScreen() {
  const last = state.round >= state.totalRounds;
  return `
    ${header()}
    ${board(true)}
    <div class="tv-actions"><button data-act="next" class="primary">${last ? 'Final results' : 'Next round'}</button></div>`;
}

function awardHtml(title, a, unit) {
  if (!a) return '';
  return `<div class="award"><div class="title">${title}</div><div class="who">${a.names.map(esc).join(' & ')}</div><div class="muted">${a.value} ${unit}</div></div>`;
}

function endScreen() {
  const top = state.leaderboard[0];
  const tied = state.leaderboard.filter((p) => p.score === top.score).map((p) => p.name);
  return `
    ${header()}
    <div class="winner">${tied.length > 1 ? `Tie: ${tied.map(esc).join(' & ')}` : `${esc(top.name)} wins!`}</div>
    <div class="awards">
      ${awardHtml('🕶️ Master Smuggler', state.awards.smuggler, 'players fooled')}
      ${awardHtml('🐕 Bloodhound', state.awards.bloodhound, 'words caught')}
    </div>
    ${board(false)}
    <div class="tv-actions"><button data-act="playAgain" class="primary">Play again</button></div>`;
}

const screens = { lobby, write: writeScreen, hunt: huntScreen, reveal: revealScreen, scores: scoresScreen, end: endScreen };

function render() {
  if (state) app.innerHTML = screens[state.phase]();
}

startTimerLoop(clock);
