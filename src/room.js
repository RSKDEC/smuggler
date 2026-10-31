const crypto = require('crypto');
const { PACKS } = require('./words');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const POINTS = { catch: 100, sneak: 50, decoy: 50, favorite: 100, bounty: 50 };
const MIN_ANSWER = 10;
const MAX_ANSWER = 220;
const SLOTS = 'ABCDEFGHIJ';
// Must match the palette/disguise lists in public/avatar.js.
const AVATAR_COLORS = 10;
const AVATAR_DISGUISES = 6;
// A wrong word needs at least this many picks to earn its author the decoy bonus.
const DECOY_MIN_PICKS = 2;
const BASE_SECONDS = { write: 120, hunt: 100, reveal: 10 };
const PACES = { relaxed: 1.5, normal: 1, quick: 0.7 };
const ROUND_CHOICES = [3, 5, 7];

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const norm = (s) => String(s || '').trim().toLowerCase();

// Split text into word and non-word pieces so phones can make each word tappable.
function tokenize(text) {
  return text
    .split(/([A-Za-z][A-Za-z']*)/)
    .filter((t) => t !== '')
    .map((t) => ({ t, w: /^[A-Za-z]/.test(t) }));
}

// Plurals and possessives of the contraband word count as the word itself.
function isWord(token, word) {
  const a = norm(token).replace(/'s?$/, '');
  return a === word || a === `${word}s` || a === `${word}es`;
}

class Room {
  constructor(code, onChange) {
    this.code = code;
    this.onChange = onChange;
    this.players = new Map();
    this.hostSockets = new Set();
    this.settings = { rounds: 5, pace: 'normal', pack: 'classic', finale: true, wanted: true };
    this.timer = null;
    this.timerFn = null;
    this.deadline = null;
    this.duration = null;
    this.paused = null;
    this.lastActive = Date.now();
    this.reset();
  }

  reset() {
    this.clearTimer();
    this.phase = 'lobby';
    this.round = 0;
    this.prompt = null;
    this.entries = new Map();
    this.order = [];
    this.guesses = new Map();
    this.hearts = new Map();
    this.hunters = new Set();
    this.wanted = new Set();
    this.results = null;
    this.favorite = null;
    this.revealIdx = 0;
    this.usedPrompts = new Set();
    this.usedWords = new Set();
    // Removed players stay out once the next game starts.
    for (const [id, p] of this.players) if (p.kicked) this.players.delete(id);
    for (const p of this.players.values()) {
      Object.assign(p, { score: 0, lastScore: 0, caught: 0, sneaked: 0, loved: 0, rerolls: 1 });
    }
  }

  touch() {
    this.lastActive = Date.now();
  }

  // ---------- timers (pausable) ----------

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerFn = null;
    this.deadline = null;
    this.duration = null;
    this.paused = null;
  }

  setTimer(seconds, fn, duration = seconds) {
    this.clearTimer();
    this.timerFn = fn;
    this.deadline = Date.now() + seconds * 1000;
    this.duration = duration;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerFn = null;
      fn();
      this.onChange();
    }, seconds * 1000);
  }

  seconds(kind) {
    const base = BASE_SECONDS[kind];
    return kind === 'reveal' ? base : Math.round(base * PACES[this.settings.pace]);
  }

  pause() {
    if (this.paused || !this.timer) return 'Nothing to pause';
    const remaining = Math.max(1000, this.deadline - Date.now());
    const { timerFn: fn, duration } = this;
    clearTimeout(this.timer);
    this.timer = null;
    this.paused = { remaining, fn, duration };
    return null;
  }

  resume() {
    if (!this.paused) return 'Not paused';
    const { remaining, fn, duration } = this.paused;
    this.setTimer(remaining / 1000, fn, duration);
    return null;
  }

  draw(pool, used) {
    let available = pool.filter((w) => !used.has(w));
    if (!available.length) {
      used.clear();
      available = pool.slice();
    }
    const pick = available[Math.floor(Math.random() * available.length)];
    used.add(pick);
    return pick;
  }

  get pack() {
    return PACKS[this.settings.pack] || PACKS.classic;
  }

  isFinale(round = this.round) {
    return this.settings.finale && this.settings.rounds > 1 && round === this.settings.rounds;
  }

  get multiplier() {
    return this.isFinale() ? 2 : 1;
  }

  // ---------- players ----------

  active() {
    return [...this.players.values()].filter((p) => !p.kicked);
  }

  connected() {
    return this.active().filter((p) => p.connected);
  }

  get vipId() {
    const all = this.active();
    const vip = all.find((p) => p.connected) || all[0];
    return vip ? vip.id : null;
  }

  join(name, playerId) {
    if (playerId && this.players.has(playerId)) {
      const p = this.players.get(playerId);
      return p.kicked ? { error: 'You were removed from this game' } : { player: p };
    }

    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 14);
    if (!name) return { error: 'Enter a name' };

    const existing = [...this.players.values()].find((p) => norm(p.name) === norm(name));
    if (existing) {
      if (existing.kicked) return { error: 'That player was removed from this game' };
      // Same name on a new device: let them take over a dropped seat.
      if (!existing.connected) return { player: existing };
      return { error: 'That name is taken' };
    }
    if (this.active().length >= MAX_PLAYERS) return { error: 'Room is full' };

    const taken = new Set(this.active().map((p) => p.avatar.color));
    const color = [...Array(AVATAR_COLORS).keys()].find((c) => !taken.has(c)) ?? 0;
    const player = {
      id: crypto.randomUUID(), name, connected: true, socketId: null, kicked: false,
      avatar: { color, disguise: Math.floor(Math.random() * AVATAR_DISGUISES) },
      score: 0, lastScore: 0, caught: 0, sneaked: 0, loved: 0, rerolls: 1,
    };
    this.players.set(player.id, player);
    // Late joiners can still write this round.
    if (this.phase === 'write') this.deal(player);
    return { player };
  }

  // Returns the removed player (so the server can notify their socket), or an error string.
  kick(name) {
    const p = this.active().find((x) => x.name === name);
    if (!p) return { error: 'No such player' };
    if (this.phase === 'lobby') {
      this.players.delete(p.id);
    } else {
      p.kicked = true;
      p.connected = false;
      if (this.phase === 'write') {
        this.entries.delete(p.id);
        if (this.allWritten()) this.beginHunt();
      } else if (this.phase === 'hunt' && this.allDone()) {
        this.reveal();
      }
    }
    return { player: p };
  }

  setAvatar(p, color, disguise) {
    if (!Number.isInteger(color) || color < 0 || color >= AVATAR_COLORS) return 'Bad color';
    if (!Number.isInteger(disguise) || disguise < 0 || disguise >= AVATAR_DISGUISES) return 'Bad disguise';
    const clash = this.active().some((x) => x !== p && x.avatar.color === color);
    if (clash) return 'Someone already has that color';
    p.avatar = { color, disguise };
    return null;
  }

  setSettings(s = {}) {
    if (this.phase !== 'lobby') return 'Settings can only change in the lobby';
    const next = { ...this.settings };
    if (s.rounds !== undefined) {
      if (!ROUND_CHOICES.includes(s.rounds)) return 'Bad round count';
      next.rounds = s.rounds;
    }
    if (s.pace !== undefined) {
      if (!PACES[s.pace]) return 'Bad pace';
      next.pace = s.pace;
    }
    if (s.pack !== undefined) {
      if (!PACKS[s.pack]) return 'Bad word pack';
      next.pack = s.pack;
    }
    if (s.finale !== undefined) next.finale = !!s.finale;
    if (s.wanted !== undefined) next.wanted = !!s.wanted;
    this.settings = next;
    return null;
  }

  canStart() {
    if (this.active().length < MIN_PLAYERS) return `Need at least ${MIN_PLAYERS} players`;
    return null;
  }

  // ---------- actions ----------

  // Shared by the TV and the VIP's phone (the TV has no input once it's cast).
  control(msg) {
    switch (msg.type) {
      case 'start': return this.start();
      case 'next': return this.next();
      case 'skip': return this.skip();
      case 'playAgain': return this.playAgain();
      case 'pause': return this.pause();
      case 'resume': return this.resume();
      case 'settings': return this.setSettings(msg.settings);
      default: return undefined;
    }
  }

  hostAction(action) {
    this.touch();
    const r = this.control({ type: action });
    return r === undefined ? 'Unknown action' : r;
  }

  playerAction(playerId, msg) {
    this.touch();
    const p = this.players.get(playerId);
    if (!p || p.kicked) return 'Not in this room';
    const isVip = p.id === this.vipId;
    switch (msg.type) {
      case 'avatar': return this.setAvatar(p, msg.color, msg.disguise);
      case 'reroll': return this.reroll(p, msg.which);
      case 'answer': return this.answer(p, msg.text);
      case 'guess': return this.guess(p, msg.slot, msg.idx);
      case 'heart': return this.heart(p, msg.slot);
      default: {
        if (!isVip) return 'Only the ♛ VIP can do that';
        const r = this.control(msg);
        return r === undefined ? 'Unknown action' : r;
      }
    }
  }

  start() {
    if (this.phase !== 'lobby') return 'Game already running';
    const err = this.canStart();
    if (err) return err;
    this.reset();
    this.startRound();
    return null;
  }

  playAgain() {
    if (this.phase !== 'end') return 'Game is not over';
    this.reset();
    return null;
  }

  next() {
    if (this.paused) return 'Game is paused';
    if (this.phase === 'reveal') {
      this.advanceReveal();
      return null;
    }
    if (this.phase !== 'scores') return 'Nothing to continue';
    if (this.round >= this.settings.rounds) this.phase = 'end';
    else if (this.connected().length < MIN_PLAYERS) this.reset();
    else this.startRound();
    return null;
  }

  // Cut the current timer short.
  skip() {
    if (this.paused) this.paused = null;
    if (this.phase === 'write') this.beginHunt();
    else if (this.phase === 'hunt') this.reveal();
    else if (this.phase === 'reveal') this.advanceReveal();
    else return 'Nothing to skip';
    return null;
  }

  // ---------- write ----------

  deal(p) {
    const count = this.isFinale() ? 2 : 1;
    const words = [];
    while (words.length < count) words.push(this.draw(this.pack.words, this.usedWords));
    this.entries.set(p.id, { words, text: null, tokens: null, slot: null });
  }

  startRound() {
    this.round++;
    this.prompt = this.draw(this.pack.prompts, this.usedPrompts);
    this.entries = new Map();
    this.guesses = new Map();
    this.hearts = new Map();
    this.results = null;
    this.favorite = null;
    this.revealIdx = 0;

    // Most Wanted: whoever leads going into the round.
    this.wanted = new Set();
    const top = Math.max(0, ...this.active().map((p) => p.score));
    if (this.settings.wanted && top > 0) {
      this.active().filter((p) => p.score === top).forEach((p) => this.wanted.add(p.id));
    }

    for (const p of this.active()) {
      p.lastScore = p.score;
      this.deal(p);
    }
    this.phase = 'write';
    this.setTimer(this.seconds('write'), () => this.beginHunt());
  }

  reroll(p, which = 0) {
    if (this.phase !== 'write') return 'You can only swap your word while writing';
    const e = this.entries.get(p.id);
    if (!e || e.text) return 'Already submitted';
    if (p.rerolls <= 0) return 'No swaps left this game';
    const i = Number.isInteger(which) && which >= 0 && which < e.words.length ? which : 0;
    p.rerolls--;
    e.words[i] = this.draw(this.pack.words.filter((w) => !e.words.includes(w)), this.usedWords);
    return null;
  }

  answer(p, raw) {
    if (this.phase !== 'write') return 'Writing time is over';
    const e = this.entries.get(p.id);
    if (!e) return 'You joined too late for this round';
    if (e.text) return 'Already submitted';

    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_ANSWER) return 'Write a bit more than that';
    if (text.length > MAX_ANSWER) return `Keep it under ${MAX_ANSWER} characters`;
    const tokens = tokenize(text);
    const missing = e.words.find((w) => !tokens.some((tok) => tok.w && isWord(tok.t, w)));
    if (missing) return `You have to smuggle in "${missing}"!`;
    e.text = text;
    e.tokens = tokens;
    if (this.allWritten()) this.beginHunt();
    return null;
  }

  allWritten() {
    return this.connected().every((x) => !this.entries.get(x.id) || this.entries.get(x.id).text);
  }

  // ---------- hunt ----------

  beginHunt() {
    if (this.phase !== 'write') return;
    this.clearTimer();
    this.order = shuffle([...this.entries.keys()].filter((id) => this.entries.get(id).text));
    this.order.forEach((id, i) => {
      this.entries.get(id).slot = SLOTS[i];
    });
    this.hunters = new Set(this.connected().map((p) => p.id));
    if (this.order.length < 2) {
      // Not enough answers to hunt through; score what there is and move on.
      this.reveal(true);
      return;
    }
    this.phase = 'hunt';
    this.setTimer(this.seconds('hunt'), () => this.reveal());
  }

  entryBySlot(slot) {
    const id = this.order.find((x) => this.entries.get(x).slot === slot);
    return id ? { id, entry: this.entries.get(id) } : null;
  }

  // Tapping a word toggles it. In the finale each answer takes two picks;
  // picking a third drops the oldest.
  guess(p, slot, idx) {
    if (this.phase !== 'hunt') return 'Hunting is over';
    const found = this.entryBySlot(slot);
    if (!found) return 'Unknown answer';
    if (found.id === p.id) return "That's your own answer!";
    const tok = found.entry.tokens[idx];
    if (!Number.isInteger(idx) || !tok || !tok.w) return 'Tap a word';
    const mine = this.guesses.get(p.id) || {};
    let picks = mine[slot] || [];
    if (picks.includes(idx)) picks = picks.filter((x) => x !== idx);
    else {
      picks = [...picks, idx];
      if (picks.length > found.entry.words.length) picks.shift();
    }
    mine[slot] = picks;
    this.guesses.set(p.id, mine);
    this.hunters.add(p.id);
    if (this.allDone()) this.reveal();
    return null;
  }

  heart(p, slot) {
    if (this.phase !== 'hunt') return 'Hunting is over';
    const found = this.entryBySlot(slot);
    if (!found) return 'Unknown answer';
    if (found.id === p.id) return "You can't love your own answer";
    this.hearts.set(p.id, slot);
    if (this.allDone()) this.reveal();
    return null;
  }

  // Each player owes a full set of picks per other answer, plus one heart.
  huntTodo(p) {
    const others = this.order.filter((id) => id !== p.id);
    if (!others.length) return { done: 0, total: 0 };
    const mine = this.guesses.get(p.id) || {};
    const picks = others.filter((id) => {
      const e = this.entries.get(id);
      return (mine[e.slot] || []).length === e.words.length;
    }).length;
    return { done: picks + (this.hearts.has(p.id) ? 1 : 0), total: others.length + 1 };
  }

  huntProgress() {
    let done = 0;
    let total = 0;
    for (const p of this.connected()) {
      const t = this.huntTodo(p);
      done += t.done;
      total += t.total;
    }
    return { done, total };
  }

  allDone() {
    const { done, total } = this.huntProgress();
    return total > 0 && done === total;
  }

  // ---------- reveal & scoring ----------

  reveal(skipToScores = false) {
    if (this.phase !== 'hunt' && this.phase !== 'write') return;
    this.clearTimer();
    const m = this.multiplier;
    const add = (id, pts, stat, n = 1) => {
      const p = this.players.get(id);
      if (!p) return;
      p.score += pts;
      if (stat) p[stat] += n;
    };

    const heartCounts = {};
    for (const slot of this.hearts.values()) heartCounts[slot] = (heartCounts[slot] || 0) + 1;

    this.results = this.order.map((authorId) => {
      const e = this.entries.get(authorId);
      const wanted = this.wanted.has(authorId);
      const others = [...this.hunters].filter((id) => id !== authorId && this.players.has(id));

      const pickers = {};
      for (const [voterId, mine] of this.guesses) {
        if (voterId === authorId) continue;
        for (const idx of mine[e.slot] || []) (pickers[idx] = pickers[idx] || []).push(voterId);
      }

      const words = e.words.map((word) => {
        const catchers = new Set();
        for (const [idx, ids] of Object.entries(pickers)) {
          if (isWord(e.tokens[idx].t, word)) ids.forEach((id) => catchers.add(id));
        }
        const fooled = others.filter((id) => !catchers.has(id)).length;
        for (const id of catchers) add(id, (POINTS.catch + (wanted ? POINTS.bounty : 0)) * m, 'caught');
        add(authorId, POINTS.sneak * fooled * m, 'sneaked', fooled);
        return { word, catchers: [...catchers], fooled };
      });

      // Decoy: the most-picked wrong word, if enough people fell for it.
      let decoy = null;
      for (const [idx, ids] of Object.entries(pickers)) {
        const tok = e.tokens[idx];
        if (e.words.some((w) => isWord(tok.t, w)) || ids.length < DECOY_MIN_PICKS) continue;
        if (!decoy || ids.length > decoy.count) decoy = { word: tok.t, count: ids.length };
      }
      if (decoy) add(authorId, POINTS.decoy * m);

      return { authorId, slot: e.slot, words, pickers, decoy, wanted, hearts: heartCounts[e.slot] || 0 };
    });

    // Crowd favorite: the most-hearted answer(s).
    const maxHearts = Math.max(0, ...this.results.map((r) => r.hearts));
    if (maxHearts > 0) {
      const winners = this.results.filter((r) => r.hearts === maxHearts);
      winners.forEach((r) => add(r.authorId, POINTS.favorite * m, 'loved'));
      this.favorite = { slots: winners.map((r) => r.slot), hearts: maxHearts };
    }

    if (skipToScores || !this.results.length) {
      this.phase = 'scores';
      return;
    }
    this.phase = 'reveal';
    this.revealIdx = 0;
    this.setTimer(this.seconds('reveal'), () => this.advanceReveal());
  }

  advanceReveal() {
    if (this.phase !== 'reveal') return;
    if (this.revealIdx + 1 >= this.results.length) {
      this.clearTimer();
      this.phase = 'scores';
      return;
    }
    this.revealIdx++;
    this.setTimer(this.seconds('reveal'), () => this.advanceReveal());
  }

  // ---------- views ----------

  name(id) {
    return this.players.get(id)?.name || '?';
  }

  leaderboard() {
    return this.active()
      .map((p) => ({ name: p.name, avatar: p.avatar, score: p.score, delta: p.score - p.lastScore }))
      .sort((a, b) => b.score - a.score);
  }

  awards() {
    const all = this.active();
    const best = (key) => {
      const max = Math.max(0, ...all.map((p) => p[key]));
      return max > 0 ? { names: all.filter((p) => p[key] === max).map((p) => p.name), value: max } : null;
    };
    return { smuggler: best('sneaked'), bloodhound: best('caught'), favorite: best('loved') };
  }

  publicResults() {
    return this.results.map((r) => {
      const e = this.entries.get(r.authorId);
      const pins = {};
      for (const [idx, ids] of Object.entries(r.pickers)) pins[idx] = ids.map((id) => this.name(id));
      return {
        slot: r.slot,
        author: this.name(r.authorId),
        words: r.words.map((w) => ({ word: w.word, catchers: w.catchers.map((id) => this.name(id)), fooled: w.fooled })),
        text: e.text,
        tokens: e.tokens,
        pins,
        decoy: r.decoy,
        wanted: r.wanted,
        hearts: r.hearts,
      };
    });
  }

  favorites() {
    if (!this.favorite) return null;
    return this.favorite.slots.map((slot) => {
      const r = this.results.find((x) => x.slot === slot);
      return { slot, author: this.name(r.authorId), text: this.entries.get(r.authorId).text, hearts: r.hearts };
    });
  }

  baseView() {
    const vip = this.vipId;
    const v = {
      code: this.code,
      phase: this.phase,
      round: this.round,
      totalRounds: this.settings.rounds,
      settings: this.settings,
      packs: Object.fromEntries(Object.entries(PACKS).map(([k, p]) => [k, p.name])),
      roundChoices: ROUND_CHOICES,
      finale: this.phase !== 'lobby' && this.isFinale(),
      finaleNext: this.phase === 'scores' && this.isFinale(this.round + 1),
      multiplier: this.multiplier,
      prompt: this.prompt,
      deadline: this.paused ? null : this.deadline,
      duration: this.paused ? this.paused.duration : this.duration,
      paused: !!this.paused,
      now: Date.now(),
      canStart: this.canStart(),
      points: POINTS,
      limits: { min: MIN_ANSWER, max: MAX_ANSWER, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS },
      wanted: [...this.wanted].map((id) => this.name(id)),
      players: this.active().map((p) => {
        let done;
        if (this.phase === 'write') done = !!this.entries.get(p.id)?.text;
        if (this.phase === 'hunt') {
          const t = this.huntTodo(p);
          done = t.total > 0 && t.done === t.total;
        }
        return { name: p.name, avatar: p.avatar, score: p.score, connected: p.connected, vip: p.id === vip, done };
      }),
    };
    if (this.phase === 'hunt' || this.phase === 'reveal') {
      v.answers = this.order.map((id) => {
        const e = this.entries.get(id);
        return { slot: e.slot, tokens: e.tokens, picks: e.words.length, wanted: this.wanted.has(id) };
      });
    }
    if (this.phase === 'hunt') v.progress = this.huntProgress();
    if (this.phase === 'reveal') {
      v.results = this.publicResults();
      v.revealIdx = this.revealIdx;
    }
    if (this.phase === 'scores' || this.phase === 'end') {
      v.leaderboard = this.leaderboard();
      v.favorites = this.phase === 'scores' ? this.favorites() : null;
    }
    if (this.phase === 'end') v.awards = this.awards();
    return v;
  }

  hostView() {
    return this.baseView();
  }

  playerView(playerId) {
    const p = this.players.get(playerId);
    if (!p || p.kicked) return null;
    const v = this.baseView();
    v.me = {
      id: p.id, name: p.name, score: p.score, vip: p.id === this.vipId, rerolls: p.rerolls, avatar: p.avatar,
      wanted: this.wanted.has(p.id),
    };
    const e = this.entries.get(p.id);
    if (e && this.phase !== 'lobby') {
      v.mine = { words: e.words, text: e.text, slot: e.slot };
    }
    if (this.phase === 'hunt') {
      v.myGuesses = this.guesses.get(p.id) || {};
      v.myHeart = this.hearts.get(p.id) || null;
    }
    if ((this.phase === 'reveal' || this.phase === 'scores') && this.results) {
      const own = this.results.find((r) => r.authorId === p.id);
      v.myRound = {
        delta: p.score - p.lastScore,
        caught: [],
        missed: [],
        mine: own
          ? {
              caughtBy: [...new Set(own.words.flatMap((w) => w.catchers))].map((id) => this.name(id)),
              fooled: own.words.reduce((n, w) => n + w.fooled, 0),
              decoy: own.decoy,
              hearts: own.hearts,
              favorite: !!this.favorite?.slots.includes(own.slot),
            }
          : null,
      };
      for (const r of this.results) {
        if (r.authorId === p.id) continue;
        for (const w of r.words) {
          const item = { author: this.name(r.authorId), word: w.word, wanted: r.wanted };
          (w.catchers.includes(p.id) ? v.myRound.caught : v.myRound.missed).push(item);
        }
      }
    }
    return v;
  }
}

module.exports = { Room, tokenize, isWord };
