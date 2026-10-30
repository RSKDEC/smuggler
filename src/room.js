const crypto = require('crypto');
const { PROMPTS, CONTRABAND } = require('./words');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const POINTS = { catch: 100, sneak: 50, decoy: 50, favorite: 100 };
const MIN_ANSWER = 10;
const MAX_ANSWER = 200;
const SLOTS = 'ABCDEFGHIJ';
// Must match the palette/disguise lists in public/avatar.js.
const AVATAR_COLORS = 10;
const AVATAR_DISGUISES = 6;
// A wrong word needs at least this many picks to earn its author the decoy bonus.
const DECOY_MIN_PICKS = 2;

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
    this.settings = { rounds: 5, writeSeconds: 120, huntSeconds: 100, revealSeconds: 10 };
    this.timer = null;
    this.deadline = null;
    this.duration = null;
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
    this.results = null;
    this.favorite = null;
    this.revealIdx = 0;
    this.usedPrompts = new Set();
    this.usedWords = new Set();
    for (const p of this.players.values()) {
      Object.assign(p, { score: 0, lastScore: 0, caught: 0, sneaked: 0, loved: 0, rerolls: 1 });
    }
  }

  touch() {
    this.lastActive = Date.now();
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
    this.duration = null;
  }

  setTimer(seconds, fn) {
    this.clearTimer();
    this.deadline = Date.now() + seconds * 1000;
    this.duration = seconds;
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
      this.onChange();
    }, seconds * 1000);
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

  // ---------- players ----------

  get vipId() {
    const all = [...this.players.values()];
    const vip = all.find((p) => p.connected) || all[0];
    return vip ? vip.id : null;
  }

  connected() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  join(name, playerId) {
    if (playerId && this.players.has(playerId)) return { player: this.players.get(playerId) };

    name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 14);
    if (!name) return { error: 'Enter a name' };

    const existing = [...this.players.values()].find((p) => norm(p.name) === norm(name));
    if (existing) {
      // Same name on a new device: let them take over a dropped seat.
      if (!existing.connected) return { player: existing };
      return { error: 'That name is taken' };
    }
    if (this.players.size >= MAX_PLAYERS) return { error: 'Room is full' };

    const taken = new Set([...this.players.values()].map((p) => p.avatar.color));
    const color = [...Array(AVATAR_COLORS).keys()].find((c) => !taken.has(c)) ?? 0;
    const player = {
      id: crypto.randomUUID(), name, connected: true, socketId: null,
      avatar: { color, disguise: Math.floor(Math.random() * AVATAR_DISGUISES) },
      score: 0, lastScore: 0, caught: 0, sneaked: 0, loved: 0, rerolls: 1,
    };
    this.players.set(player.id, player);
    // Late joiners can still write this round.
    if (this.phase === 'write') this.deal(player);
    return { player };
  }

  setAvatar(p, color, disguise) {
    if (!Number.isInteger(color) || color < 0 || color >= AVATAR_COLORS) return 'Bad color';
    if (!Number.isInteger(disguise) || disguise < 0 || disguise >= AVATAR_DISGUISES) return 'Bad disguise';
    const clash = [...this.players.values()].some((x) => x !== p && x.avatar.color === color);
    if (clash) return 'Someone already has that color';
    p.avatar = { color, disguise };
    return null;
  }

  canStart() {
    if (this.players.size < MIN_PLAYERS) return `Need at least ${MIN_PLAYERS} players`;
    return null;
  }

  // ---------- actions ----------

  hostAction(action) {
    this.touch();
    switch (action) {
      case 'start': return this.start();
      case 'next': return this.next();
      case 'skip': return this.skip();
      case 'playAgain': return this.playAgain();
    }
    return null;
  }

  playerAction(playerId, msg) {
    this.touch();
    const p = this.players.get(playerId);
    if (!p) return 'Not in this room';
    const isVip = p.id === this.vipId;
    switch (msg.type) {
      case 'start': return isVip ? this.start() : 'Only the VIP can start';
      case 'next': return isVip ? this.next() : 'Only the VIP can continue';
      case 'playAgain': return isVip ? this.playAgain() : 'Only the VIP can restart';
      case 'avatar': return this.setAvatar(p, msg.color, msg.disguise);
      case 'reroll': return this.reroll(p);
      case 'answer': return this.answer(p, msg.text);
      case 'guess': return this.guess(p, msg.slot, msg.idx);
      case 'heart': return this.heart(p, msg.slot);
      default: return 'Unknown action';
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

  // Host can cut the current timer short.
  skip() {
    if (this.phase === 'write') this.beginHunt();
    else if (this.phase === 'hunt') this.reveal();
    else if (this.phase === 'reveal') this.advanceReveal();
  }

  // ---------- write ----------

  deal(p) {
    this.entries.set(p.id, { word: this.draw(CONTRABAND, this.usedWords), text: null, tokens: null, slot: null });
  }

  startRound() {
    this.round++;
    this.prompt = this.draw(PROMPTS, this.usedPrompts);
    this.entries = new Map();
    this.guesses = new Map();
    this.hearts = new Map();
    this.results = null;
    this.favorite = null;
    this.revealIdx = 0;
    for (const p of this.players.values()) {
      p.lastScore = p.score;
      this.deal(p);
    }
    this.phase = 'write';
    this.setTimer(this.settings.writeSeconds, () => this.beginHunt());
  }

  reroll(p) {
    if (this.phase !== 'write') return 'You can only swap your word while writing';
    const e = this.entries.get(p.id);
    if (!e || e.text) return 'Already submitted';
    if (p.rerolls <= 0) return 'No swaps left this game';
    p.rerolls--;
    e.word = this.draw(CONTRABAND, this.usedWords);
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
    if (!tokens.some((tok) => tok.w && isWord(tok.t, e.word))) {
      return `You have to smuggle in "${e.word}"!`;
    }
    e.text = text;
    e.tokens = tokens;

    const waiting = this.connected().filter((x) => this.entries.get(x.id) && !this.entries.get(x.id).text);
    if (!waiting.length) this.beginHunt();
    return null;
  }

  // ---------- hunt ----------

  beginHunt() {
    if (this.phase !== 'write') return;
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
    this.setTimer(this.settings.huntSeconds, () => this.reveal());
  }

  entryBySlot(slot) {
    const id = this.order.find((x) => this.entries.get(x).slot === slot);
    return id ? { id, entry: this.entries.get(id) } : null;
  }

  guess(p, slot, idx) {
    if (this.phase !== 'hunt') return 'Hunting is over';
    const found = this.entryBySlot(slot);
    if (!found) return 'Unknown answer';
    if (found.id === p.id) return "That's your own answer!";
    const tok = found.entry.tokens[idx];
    if (!Number.isInteger(idx) || !tok || !tok.w) return 'Tap a word';
    const mine = this.guesses.get(p.id) || {};
    mine[slot] = idx;
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

  // Each player owes one pick per other answer, plus one heart.
  huntTodo(p) {
    const others = this.order.filter((id) => id !== p.id);
    if (!others.length) return { done: 0, total: 0 };
    const mine = this.guesses.get(p.id) || {};
    const picks = others.filter((id) => mine[this.entries.get(id).slot] !== undefined).length;
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

    const heartCounts = {};
    for (const slot of this.hearts.values()) heartCounts[slot] = (heartCounts[slot] || 0) + 1;

    this.results = this.order.map((authorId) => {
      const e = this.entries.get(authorId);
      const pickers = {};
      const catchers = [];
      for (const [voterId, mine] of this.guesses) {
        const idx = mine[e.slot];
        if (idx === undefined || voterId === authorId) continue;
        (pickers[idx] = pickers[idx] || []).push(voterId);
        if (isWord(e.tokens[idx].t, e.word)) catchers.push(voterId);
      }
      const fooled = [...this.hunters].filter((id) => id !== authorId && !catchers.includes(id) && this.players.has(id));

      // Decoy: the most-picked wrong word, if enough people fell for it.
      let decoy = null;
      for (const [idx, ids] of Object.entries(pickers)) {
        const tok = e.tokens[idx];
        if (isWord(tok.t, e.word) || ids.length < DECOY_MIN_PICKS) continue;
        if (!decoy || ids.length > decoy.count) decoy = { word: tok.t, count: ids.length };
      }

      for (const id of catchers) {
        const c = this.players.get(id);
        if (c) { c.score += POINTS.catch; c.caught++; }
      }
      const author = this.players.get(authorId);
      if (author) {
        author.score += POINTS.sneak * fooled.length + (decoy ? POINTS.decoy : 0);
        author.sneaked += fooled.length;
      }
      return { authorId, slot: e.slot, word: e.word, pickers, catchers, fooled, decoy, hearts: heartCounts[e.slot] || 0 };
    });

    // Crowd favorite: the most-hearted answer(s).
    const maxHearts = Math.max(0, ...this.results.map((r) => r.hearts));
    if (maxHearts > 0) {
      const winners = this.results.filter((r) => r.hearts === maxHearts);
      for (const r of winners) {
        const a = this.players.get(r.authorId);
        if (a) { a.score += POINTS.favorite; a.loved++; }
      }
      this.favorite = { slots: winners.map((r) => r.slot), hearts: maxHearts };
    }

    if (skipToScores || !this.results.length) {
      this.phase = 'scores';
      return;
    }
    this.phase = 'reveal';
    this.revealIdx = 0;
    this.setTimer(this.settings.revealSeconds, () => this.advanceReveal());
  }

  advanceReveal() {
    if (this.phase !== 'reveal') return;
    if (this.revealIdx + 1 >= this.results.length) {
      this.clearTimer();
      this.phase = 'scores';
      return;
    }
    this.revealIdx++;
    this.setTimer(this.settings.revealSeconds, () => this.advanceReveal());
  }

  // ---------- views ----------

  name(id) {
    return this.players.get(id)?.name || '?';
  }

  leaderboard() {
    return [...this.players.values()]
      .map((p) => ({ name: p.name, avatar: p.avatar, score: p.score, delta: p.score - p.lastScore }))
      .sort((a, b) => b.score - a.score);
  }

  awards() {
    const all = [...this.players.values()];
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
        word: r.word,
        text: e.text,
        tokens: e.tokens,
        pins,
        catchers: r.catchers.map((id) => this.name(id)),
        fooled: r.fooled.length,
        decoy: r.decoy,
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
      prompt: this.prompt,
      deadline: this.deadline,
      duration: this.duration,
      now: Date.now(),
      canStart: this.canStart(),
      points: POINTS,
      limits: { min: MIN_ANSWER, max: MAX_ANSWER, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS },
      players: [...this.players.values()].map((p) => {
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
        return { slot: e.slot, tokens: e.tokens };
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
    if (!p) return null;
    const v = this.baseView();
    v.me = { id: p.id, name: p.name, score: p.score, vip: p.id === this.vipId, rerolls: p.rerolls, avatar: p.avatar };
    const e = this.entries.get(p.id);
    if (e && this.phase !== 'lobby') {
      v.mine = { word: e.word, text: e.text, slot: e.slot };
    }
    if (this.phase === 'hunt') {
      v.myGuesses = this.guesses.get(p.id) || {};
      v.myHeart = this.hearts.get(p.id) || null;
    }
    if ((this.phase === 'reveal' || this.phase === 'scores') && this.results) {
      const guesses = this.guesses.get(p.id) || {};
      const own = this.results.find((r) => r.authorId === p.id);
      v.myRound = {
        delta: p.score - p.lastScore,
        caught: this.results.filter((r) => r.catchers.includes(p.id)).map((r) => ({ author: this.name(r.authorId), word: r.word })),
        missed: this.results
          .filter((r) => r.authorId !== p.id && !r.catchers.includes(p.id))
          .map((r) => ({ author: this.name(r.authorId), word: r.word, guessed: guesses[r.slot] !== undefined })),
        mine: own
          ? {
              fooled: own.fooled.length,
              caughtBy: own.catchers.map((id) => this.name(id)),
              decoy: own.decoy,
              hearts: own.hearts,
              favorite: !!this.favorite?.slots.includes(own.slot),
            }
          : null,
      };
    }
    return v;
  }
}

module.exports = { Room, tokenize, isWord };
