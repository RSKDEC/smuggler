const socket = io();
const app = document.getElementById('app');
const clock = makeClock();
const HOST_KEY = 'smuggler-host';
let state = null;
let qr = null;
let lastHtml = '';
const seen = new Set();
let revealTimers = [];
let animatedScores = '';

const saved = () => { try { return sessionStorage.getItem(HOST_KEY); } catch { return null; } };
const save = (code) => { try { sessionStorage.setItem(HOST_KEY, code); } catch {} };

const joinUrl = (code) => `${location.origin}/play?room=${code}`;

// On a Chromecast (cast.html) the TV waits for a phone to say which room to show.
const CAST = !!window.SMUGGLER_CAST;
let castCode;
if (CAST) document.body.classList.add('cast');

function onRoom(res) {
  save(res.code);
  if (window.onSmugglerRoom) window.onSmugglerRoom(res.code);
  socket.emit('host:qr', { url: joinUrl(res.code) }, (r) => {
    qr = r.dataUrl || null;
    render();
  });
}

function connectRoom() {
  if (CAST && castCode === undefined) return;
  const code = CAST ? castCode : saved();
  if (code) {
    socket.emit('host:resume', { code }, (res) => (res.error ? socket.emit('host:create', null, onRoom) : onRoom(res)));
  } else {
    socket.emit('host:create', null, onRoom);
  }
}

socket.on('connect', connectRoom);

// Called by cast-receiver.js: show this room, or a new one when code is null.
window.smugglerShow = (code) => {
  if (code && state && state.code === code) return window.onSmugglerRoom && window.onSmugglerRoom(code);
  castCode = code || null;
  if (code) save(code);
  if (socket.connected) connectRoom();
};

// Chromecasts allow audio without a click.
if (CAST) setTimeout(() => { if (sound.unlock()) setTimeout(() => { syncMusic(); render(); }, 300); }, 0);

socket.on('host:state', (s) => {
  const prev = state;
  state = s;
  clock.sync(s);
  cues(prev, s);
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

// Any click on the TV page unlocks audio (browsers require a gesture).
document.addEventListener('click', () => {
  if (!sound.ready() && sound.unlock()) setTimeout(() => { syncMusic(); render(); }, 50);
});

app.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const a = btn.dataset.act;
  if (a === 'newRoom') newRoom();
  else if (a === 'sound') {
    if (sound.ready()) sound.setEnabled(!sound.enabled);
    render();
  } else act(a);
});

// ---------------- sound cues ----------------

function syncMusic() {
  if (!state) return;
  sound.music(!state.paused && ['lobby', 'write', 'hunt', 'scores'].includes(state.phase));
}

function cues(prev, s) {
  syncMusic();
  const fresh = s.players.filter((p) => !seen.has(p.name));
  if (prev && fresh.length && s.phase === 'lobby') sound.play('pop');

  const doneCount = (st) => st.players.filter((p) => p.done).length;
  if (prev && prev.phase === s.phase && (s.phase === 'write' || s.phase === 'hunt') && doneCount(s) > doneCount(prev)) {
    sound.play('blip');
  }
  if (!prev || prev.phase !== s.phase) {
    if (s.phase === 'write' || s.phase === 'hunt') sound.play('whoosh');
    if (s.phase === 'scores') sound.play('chime');
    if (s.phase === 'end') sound.play('fanfare');
  }
  if (s.phase === 'reveal' && (!prev || prev.phase !== 'reveal' || prev.revealIdx !== s.revealIdx)) {
    revealCues(s.results[s.revealIdx]);
  }
}

// Timings match the CSS animation delays in .xray (see style.css).
function revealCues(r) {
  revealTimers.forEach(clearTimeout);
  const at = (ms, fn) => revealTimers.push(setTimeout(fn, ms));
  sound.play('scan');
  Object.values(r.pins).flat().forEach((_, i) => at(1800 + i * 120, () => sound.play('pin')));
  at(2000, () => sound.play('drumroll', 1.1));
  at(3600, () => sound.play(r.words.some((w) => w.catchers.length) ? 'busted' : 'cleared'));
}

let lastTick = null;
setInterval(() => {
  const s = clock.remaining();
  if (state && (state.phase === 'write' || state.phase === 'hunt') && s != null && s <= 10 && s > 0 && s !== lastTick) {
    sound.play('tick');
  }
  lastTick = s;
}, 200);

// ---------------- render helpers ----------------

const avatarOf = (name) => state.players.find((p) => p.name === name)?.avatar;

function header() {
  const phase = {
    lobby: 'Lobby', write: 'Smuggling', hunt: 'Inspection', reveal: 'Busted?', scores: 'Scores', end: 'Final scores',
  }[state.phase];
  const round = state.round && state.phase !== 'lobby' ? ` · Round ${state.round}/${state.totalRounds}` : '';
  const finale = state.finale && state.phase !== 'end' ? ' · <b class="hot">🔥 Finale ×2</b>' : '';
  const soundBtn = sound.ready()
    ? `<button class="ghost soundbtn" data-act="sound">${sound.enabled ? '🔊' : '🔇'}</button>`
    : '<button class="ghost soundbtn hint" data-act="sound">🔈 Click to enable sound</button>';
  const fuse = state.deadline ? '<div class="fuse"><div class="fuse-bar" data-fuse><span class="spark"></span></div></div>' : '';
  return `
    <div class="tv-top">
      <div class="logo">Smug<span class="x">g</span>ler</div>
      <div class="info">${phase}${round}${finale} · Room <b class="amber">${esc(state.code)}</b></div>
      <div class="top-right">${soundBtn}<div class="timer" data-timer></div></div>
    </div>
    ${fuse}
    ${state.paused ? '<div class="paused-overlay"><div class="paused-card">⏸ Paused<small>The ♛ VIP can resume from their phone</small></div></div>' : ''}`;
}

// Pause/skip for laptop hosts; on a cast TV the VIP's phone has the same controls.
function controls(main = '') {
  const pause = state.paused
    ? '<button data-act="resume" class="primary">▶ Resume</button>'
    : '<button data-act="pause" class="ghost">⏸ Pause</button>';
  const timed = ['write', 'hunt', 'reveal'].includes(state.phase);
  return `<div class="tv-actions">${main}${timed ? pause : ''}${timed && state.phase !== 'reveal' ? '<button data-act="skip" class="ghost">Skip timer</button>' : ''}</div>`;
}

function settingsLine() {
  const st = state.settings;
  const pace = { relaxed: 'Relaxed', normal: 'Normal', quick: 'Quick' }[st.pace];
  return [
    `📦 ${esc(state.packs[st.pack])}`, `${st.rounds} rounds`, `⏱ ${pace} pace`,
    st.finale ? '🔥 Double Contraband finale' : '', st.wanted ? '💰 Most Wanted' : '',
  ].filter(Boolean).join(' · ');
}

function suspects({ showDone = false, enter = false, small = false } = {}) {
  if (!state.players.length) return '<div class="queue-empty muted">Waiting for smugglers to arrive…</div>';
  const html = state.players.map((p, i) => {
    const isNew = enter && !seen.has(p.name);
    const done = showDone && p.done;
    return `
      <div class="suspect ${p.connected ? '' : 'off'} ${isNew ? 'enter' : ''} ${showDone && !done ? 'busy' : ''}" style="--i:${i}">
        ${avatarSvg(p.avatar, { mood: done ? 'smug' : undefined })}
        ${done ? '<span class="ready-stamp">Ready</span>' : ''}
        <div class="nametag">${p.vip ? '♛ ' : ''}${esc(p.name)}</div>
      </div>`;
  }).join('');
  return `<div class="queue ${small ? 'small' : ''}">${html}</div>`;
}

function lobby() {
  const { minPlayers, maxPlayers } = state.limits;
  const p = state.points;
  return `
    ${header()}
    <div class="lobby">
      <div class="joinbox">
        <div class="muted">Join on your phone</div>
        <div class="code">${esc(state.code)}</div>
        ${qr ? `<img src="${qr}" alt="QR code to join">` : ''}
        <div class="url muted">${esc(joinUrl(state.code))}</div>
      </div>
      <div class="gate">
        <div class="gate-sign"><span>Customs</span><span class="dot">●</span><span>Arrivals</span><span class="count">${state.players.length}/${maxPlayers}</span></div>
        ${suspects({ enter: true })}
      </div>
      <div class="howto">
        <div class="step"><div class="num">1</div><div><b>Smuggle</b><br>Answer the prompt and hide your secret <span class="tag sm">contraband</span> word in it.</div></div>
        <div class="step"><div class="num">2</div><div><b>Inspect</b><br>Tap the word you think each player smuggled. ❤️ your favorite answer.</div></div>
        <div class="step"><div class="num">3</div><div><b>Score</b><br>+${p.catch} per catch · +${p.sneak} per player you fool · +${p.decoy} if your decoy fools 2+ · +${p.favorite} crowd favorite</div></div>
      </div>
    </div>
    <div class="tv-actions">
      <button data-act="start" class="primary" ${state.canStart ? 'disabled' : ''}>Start game</button>
      <button data-act="newRoom" class="ghost">New room</button>
    </div>
    <p class="sub">${settingsLine()}</p>
    <p class="sub">${state.canStart ? esc(state.canStart) : `${minPlayers}–${maxPlayers} players · ♛ VIP picks settings and starts from their phone`}</p>`;
}

function writeScreen() {
  const done = state.players.filter((p) => p.done).length;
  return `
    ${header()}
    ${state.finale ? `<div class="finale-banner">🔥 Final round: Double Contraband! Two secret words each, all points ×${state.multiplier}</div>` : ''}
    <div class="prompt">${esc(state.prompt)}</div>
    <div class="sub">Check your phone for your secret contraband 🤫 · <b class="amber">${done}/${state.players.length}</b> smuggled</div>
    ${suspects({ showDone: true })}
    ${wantedPosters()}
    ${controls()}`;
}

function wantedPosters() {
  if (!state.wanted.length) return '';
  const bounty = state.points.bounty * state.multiplier;
  return `<div class="posters">${state.wanted.map((n) => `
    <div class="poster">
      <div class="poster-title">Wanted</div>
      ${avatarSvg(avatarOf(n), { mood: 'smug' })}
      <div class="poster-name">${esc(n)}</div>
      <div class="poster-bounty">Bounty +${bounty} per catch</div>
    </div>`).join('')}</div>`;
}

function huntScreen() {
  const { done, total } = state.progress;
  return `
    ${header()}
    <div class="prompt small">${esc(state.prompt)}</div>
    <div class="answers">${state.answers.map((a, i) => `
      <div class="paper ${a.wanted ? 'is-wanted' : ''}" style="--i:${i}"><span class="slot">${a.slot}</span>${a.wanted ? '<span class="wanted-badge">💰 Wanted</span>' : ''}${a.tokens.map((t) => esc(t.t)).join('')}</div>`).join('')}
    </div>
    <div class="progressline">On your phones: tap the ${state.finale ? '<b class="hot">two</b> smuggled words' : 'smuggled word'} in every answer, then ❤️ your favorite · ${done}/${total}</div>
    ${suspects({ showDone: true, small: true })}
    ${controls()}`;
}

function revealTokens(r) {
  let pinNo = 0;
  return r.tokens.map((tok, i) => {
    if (!tok.w) return esc(tok.t);
    const names = r.pins[i] || [];
    const hit = r.words.some((w) => isWord(tok.t, w.word));
    const pins = names.map((n) => `<span class="pin" style="--k:${pinNo++}">${avatarSvg(avatarOf(n))}</span>`).join('');
    const cls = hit ? 'tok hit' : names.length ? 'tok picked' : 'tok';
    return `<span class="${cls}">${esc(tok.t)}${pins ? `<span class="pins">${pins}</span>` : ''}</span>`;
  }).join('');
}

function revealScreen() {
  const r = state.results[state.revealIdx];
  const m = state.multiplier;
  const busted = r.words.some((w) => w.catchers.length);
  const catchPts = (state.points.catch + (r.wanted ? state.points.bounty : 0)) * m;
  const lines = r.words.map((w) => {
    const tag = r.words.length > 1 ? `<span class="tag sm">${esc(w.word)}</span> ` : '';
    const sneak = w.fooled ? `<span class="pts">+${w.fooled * state.points.sneak * m} to ${esc(r.author)}</span>` : '';
    if (w.catchers.length) {
      return `🚨 ${tag}Caught by <b>${w.catchers.map(esc).join(', ')}</b> <span class="pts">+${catchPts} each${r.wanted ? ' 💰' : ''}</span>${w.fooled ? ` · slipped past ${w.fooled} ${sneak}` : ''}`;
    }
    return `🕶️ ${tag}Nobody caught it! Slipped past <b>${w.fooled}</b> ${sneak}`;
  });
  if (r.wanted && busted) lines.push(`💰 ${esc(r.author)} was Most Wanted: catchers earn a +${state.points.bounty * m} bounty`);
  if (r.decoy) lines.push(`🎭 Perfect decoy: <b>“${esc(r.decoy.word)}”</b> fooled ${r.decoy.count} <span class="pts">+${state.points.decoy * m}</span>`);
  return `
    ${header()}
    <div class="prompt small">${esc(state.prompt)}</div>
    <div class="spotlight" data-key="${state.round}-${state.revealIdx}">
      <div class="xray paper">
        <span class="slot">${r.slot}</span>
        <div class="xray-text">${revealTokens(r)}</div>
        <div class="beam"></div>
        <div class="bigstamp ${busted ? 'busted' : 'cleared'}">${busted ? 'Busted' : 'Cleared'}</div>
      </div>
      <div class="culprit">
        ${avatarSvg(avatarOf(r.author), { mood: busted ? 'busted' : 'smug' })}
        <div>Smuggled by <b>${esc(r.author)}</b>${r.wanted ? ' <span class="wanted-badge inline">💰 Wanted</span>' : ''}<br>${r.words.map((w) => `<span class="tag">${esc(w.word)}</span>`).join(' ')}</div>
      </div>
      <div class="verdicts">${lines.map((l) => `<div class="verdict-line">${l}</div>`).join('')}</div>
      <div class="dots">${state.results.map((_, i) => `<span class="${i < state.revealIdx ? 'on' : i === state.revealIdx ? 'now' : ''}"></span>`).join('')}</div>
    </div>
    ${controls('<button data-act="next" class="primary">Next</button>')}`;
}

function rowHtml(p, i, { from, showDelta, deltaShown = false }) {
  return `
    <div class="row ${i === 0 ? 'first' : ''}" data-name="${esc(p.name)}" style="--i:${i}">
      <span class="rank">${i + 1}</span>
      ${avatarSvg(p.avatar)}
      <span class="nm">${esc(p.name)}</span>
      <span class="delta ${deltaShown ? 'show' : ''}">${showDelta && p.delta ? `+${p.delta}` : ''}</span>
      <span class="pts" data-from="${from}" data-to="${p.score}">${from}</span>
    </div>`;
}

function scoresScreen() {
  const last = state.round >= state.totalRounds;
  const key = `scores:${state.round}`;
  const done = animatedScores === key;
  // Before the animation, show last round's order and totals; it then slides into the new order.
  const rows = done
    ? state.leaderboard
    : state.leaderboard.slice().sort((a, b) => (b.score - b.delta) - (a.score - a.delta));
  const fav = (state.favorites || []).map((f) => `
    <div class="favorite">
      <div class="fav-head">❤️ Crowd favorite <span class="pts">+${state.points.favorite}</span></div>
      <div class="paper">${esc(f.text)}</div>
      <div class="fav-by">${avatarSvg(avatarOf(f.author), { mood: 'smug' })}<b>${esc(f.author)}</b> · ${f.hearts} ❤️</div>
    </div>`).join('');
  return `
    ${header()}
    <div class="scores-wrap">
      ${fav ? `<div class="favs">${fav}</div>` : ''}
      <div class="board" data-key="${key}">${rows.map((p, i) => rowHtml(p, i, { from: done ? p.score : p.score - p.delta, showDelta: true, deltaShown: done })).join('')}</div>
    </div>
    ${state.finaleNext ? '<div class="finale-banner">🔥 Up next: the Double Contraband finale. Two words each, all points ×2!</div>' : ''}
    <div class="tv-actions"><button data-act="next" class="primary">${last ? 'Final results' : 'Next round'}</button></div>`;
}

// FLIP: slide rows from last round's order into the new one while totals count up.
function animateScores() {
  const board = app.querySelector('.board');
  if (!board || animatedScores === board.dataset.key) return;
  const key = board.dataset.key;
  setTimeout(() => {
    if (app.querySelector('.board') !== board) return;
    animatedScores = key;
    const rows = [...board.children];
    const before = new Map(rows.map((r) => [r.dataset.name, r.getBoundingClientRect().top]));
    state.leaderboard.forEach((p) => {
      const r = rows.find((x) => x.dataset.name === p.name);
      if (r) board.appendChild(r);
    });
    [...board.children].forEach((r, i) => {
      r.querySelector('.rank').textContent = i + 1;
      r.classList.toggle('first', i === 0);
      r.style.transition = 'none';
      r.style.transform = `translateY(${before.get(r.dataset.name) - r.getBoundingClientRect().top}px)`;
      r.querySelector('.delta').classList.add('show');
    });
    requestAnimationFrame(() => requestAnimationFrame(() => {
      [...board.children].forEach((r) => {
        r.style.transition = 'transform 1s cubic-bezier(.2,.8,.2,1)';
        r.style.transform = '';
      });
    }));
    board.querySelectorAll('.pts').forEach((el) => {
      const from = Number(el.dataset.from);
      const to = Number(el.dataset.to);
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 1100);
        el.textContent = Math.round(from + (to - from) * (1 - (1 - k) ** 3));
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    sound.play('drumroll', 0.9);
    setTimeout(() => sound.play('chime'), 1000);
    // Keep the cached markup in sync so the next state update re-renders in final order.
    lastHtml = '';
  }, state.favorites ? 2600 : 900);
}

function confetti() {
  return `<div class="confetti">${Array.from({ length: 40 }, (_, i) => `<i style="--x:${Math.random() * 100}vw;--d:${(Math.random() * 3).toFixed(2)}s;--c:${AVATAR_COLORS[i % AVATAR_COLORS.length]};--r:${Math.floor(Math.random() * 360)}deg"></i>`).join('')}</div>`;
}

function awardHtml(title, a, unit) {
  if (!a) return '';
  return `<div class="award">
    <div class="award-avatars">${a.names.slice(0, 3).map((n) => avatarSvg(avatarOf(n), { mood: 'smug' })).join('')}</div>
    <div>
      <div class="title">${title}</div>
      <div class="who">${a.names.map(esc).join(' & ')}</div>
      <div class="muted">${a.value} ${a.value === 1 ? unit.replace(/s\b/, '') : unit}</div>
    </div>
  </div>`;
}

function endScreen() {
  const top = state.leaderboard[0];
  const winners = state.leaderboard.filter((p) => p.score === top.score);
  return `
    ${header()}
    ${confetti()}
    <div class="endgrid">
      <div class="endleft">
        <div class="podium">
          <div class="winner-avatars">${winners.map((w) => avatarSvg(w.avatar, { mood: 'smug' })).join('')}</div>
          <div class="winner">${winners.length > 1 ? `Tie: ${winners.map((w) => esc(w.name)).join(' & ')}` : `${esc(top.name)} wins!`}</div>
        </div>
        <div class="awards">
          ${awardHtml('🕶️ Master Smuggler', state.awards.smuggler, 'players fooled')}
          ${awardHtml('🐕 Bloodhound', state.awards.bloodhound, 'words caught')}
          ${awardHtml('❤️ Crowd Favorite', state.awards.favorite, 'rounds won')}
        </div>
      </div>
      <div class="board final">${state.leaderboard.map((p, i) => rowHtml(p, i, { from: p.score, showDelta: false })).join('')}</div>
    </div>
    <div class="tv-actions"><button data-act="playAgain" class="primary">Play again</button></div>`;
}

const screens = { lobby, write: writeScreen, hunt: huntScreen, reveal: revealScreen, scores: scoresScreen, end: endScreen };

// Only touch the DOM when the markup actually changed, so animations aren't restarted.
function render() {
  if (!state) return;
  const html = screens[state.phase]();
  state.players.forEach((p) => seen.add(p.name));
  if (html !== lastHtml) {
    app.innerHTML = html;
    lastHtml = html;
  }
  if (state.phase === 'scores') animateScores();
}

startTimerLoop(clock);
