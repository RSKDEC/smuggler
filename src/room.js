const crypto = require('crypto');
const { PROMPTS, CONTRABAND } = require('./words');

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const POINTS_CATCH = 100;
const POINTS_SNEAK = 50;
const MIN_ANSWER = 10;
const MAX_ANSWER = 200;
const SLOTS = 'ABCDEFGHIJ';

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
    this.settings = { rounds: 5, writeSeconds: 120, huntSeconds: 90, revealSeconds: 9 };
    this.timer = null;
    this.deadline = null;
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
    this.hunters = new Set();
    this.results = null;
    this.revealIdx = 0;
    this.usedPrompts = new Set();
    this.usedWords = new Set();
    for (const p of this.players.values()) {
      p.score = 0;
      p.lastScore = 0;
      p.caught = 0;
      p.sneaked = 0;
      p.rerolls = 1;
    }
  }

  touch() {
    this.lastActive = Date.now();
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
  }

  setTimer(seconds, fn) {
    this.clearTimer();
    this.deadline = Date.now() + seconds * 1000;
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

    const player = {
      id: crypto.randomUUID(), name, connected: true, socketId: null,
      score: 0, lastScore: 0, caught: 0, sneaked: 0, rerolls: 1,
    };
    this.players.set(player.id, player);
    // Late joiners can still write this round.
    if (this.phase === 'write') this.deal(player);
    return { player };
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
      case 'reroll': return this.reroll(p);
      case 'answer': return this.answer(p, msg.text);
      case 'guess': return this.guess(p, msg.slot, msg.idx);
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
    this.results = null;
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
    if (this.allGuessed()) this.reveal();
    return null;
  }

  huntProgress() {
    let done = 0;
    let total = 0;
    for (const p of this.connected()) {
      const mine = this.guesses.get(p.id) || {};
      for (const id of this.order) {
        if (id === p.id) continue;
        total++;
        if (mine[this.entries.get(id).slot] !== undefined) done++;
      }
    }
    return { done, total };
  }

  allGuessed() {
    const { done, total } = this.huntProgress();
    return total > 0 && done === total;
  }

  // ---------- reveal & scoring ----------

  reveal(skipToScores = false) {
    if (this.phase !== 'hunt' && this.phase !== 'write') return;
    this.clearTimer();
    this.results = this.order.map((authorId) => {
      const e = this.entries.get(authorId);
      const picks = {};
      const catchers = [];
      for (const [voterId, mine] of this.guesses) {
        const idx = mine[e.slot];
        if (idx === undefined || voterId === authorId) continue;
        picks[idx] = (picks[idx] || 0) + 1;
        if (isWord(e.tokens[idx].t, e.word)) catchers.push(voterId);
      }
      const fooled = [...this.hunters].filter((id) => id !== authorId && !catchers.includes(id) && this.players.has(id));
      for (const id of catchers) {
        const c = this.players.get(id);
        if (c) { c.score += POINTS_CATCH; c.caught++; }
      }
      const author = this.players.get(authorId);
      if (author) {
        author.score += POINTS_SNEAK * fooled.length;
        author.sneaked += fooled.length;
      }
      return { authorId, slot: e.slot, word: e.word, picks, catchers, fooled };
    });
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
      .map((p) => ({ name: p.name, score: p.score, delta: p.score - p.lastScore, caught: p.caught, sneaked: p.sneaked }))
      .sort((a, b) => b.score - a.score);
  }

  awards() {
    const all = [...this.players.values()];
    const best = (key) => {
      const max = Math.max(0, ...all.map((p) => p[key]));
      return max > 0 ? { names: all.filter((p) => p[key] === max).map((p) => p.name), value: max } : null;
    };
    return { smuggler: best('sneaked'), bloodhound: best('caught') };
  }

  publicResults() {
    return this.results.map((r) => {
      const e = this.entries.get(r.authorId);
      return {
        slot: r.slot,
        author: this.name(r.authorId),
        word: r.word,
        text: e.text,
        tokens: e.tokens,
        picks: r.picks,
        catchers: r.catchers.map((id) => this.name(id)),
        fooled: r.fooled.length,
      };
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
      now: Date.now(),
      canStart: this.canStart(),
      points: { catch: POINTS_CATCH, sneak: POINTS_SNEAK },
      limits: { min: MIN_ANSWER, max: MAX_ANSWER, minPlayers: MIN_PLAYERS, maxPlayers: MAX_PLAYERS },
      players: [...this.players.values()].map((p) => ({
        name: p.name,
        score: p.score,
        connected: p.connected,
        vip: p.id === vip,
        done: this.phase === 'write' ? !!this.entries.get(p.id)?.text : undefined,
      })),
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
    if (this.phase === 'scores' || this.phase === 'end') v.leaderboard = this.leaderboard();
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
    v.me = { id: p.id, name: p.name, score: p.score, vip: p.id === this.vipId, rerolls: p.rerolls };
    const e = this.entries.get(p.id);
    if (e && this.phase !== 'lobby') {
      v.mine = { word: e.word, text: e.text, slot: e.slot };
    }
    if (this.phase === 'hunt') v.myGuesses = this.guesses.get(p.id) || {};
    if ((this.phase === 'reveal' || this.phase === 'scores') && this.results) {
      const guesses = this.guesses.get(p.id) || {};
      const own = this.results.find((r) => r.authorId === p.id);
      v.myRound = {
        delta: p.score - p.lastScore,
        caught: this.results.filter((r) => r.catchers.includes(p.id)).map((r) => ({ author: this.name(r.authorId), word: r.word })),
        missed: this.results
          .filter((r) => r.authorId !== p.id && !r.catchers.includes(p.id))
          .map((r) => ({ author: this.name(r.authorId), word: r.word, guessed: guesses[r.slot] !== undefined })),
        mine: own ? { fooled: own.fooled.length, caughtBy: own.catchers.map((id) => this.name(id)) } : null,
      };
    }
    return v;
  }
}

module.exports = { Room, tokenize, isWord };
