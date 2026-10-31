// End-to-end smoke test: one TV + four phones play a full game over real sockets.
const assert = require('assert');
const { io } = require('socket.io-client');
const { server } = require('../server');
const { tokenize, isWord } = require('../src/room');

const call = (sock, ev, data) => new Promise((res) => sock.emit(ev, data, res));
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

// Resolve with the host's current state if it already matches, else wait for one that does.
let hostState = null;
const waiters = new Set();
function onHostState(st) {
  hostState = st;
  for (const w of waiters) if (w.pred(st)) { waiters.delete(w); w.res(st); }
}
const waitHost = (pred) => new Promise((res) => {
  if (hostState && pred(hostState)) return res(hostState);
  waiters.add({ pred, res });
});

// Unit checks on word matching.
assert.ok(isWord('Pelicans', 'pelican'));
assert.ok(isWord("pelican's", 'pelican'));
assert.ok(!isWord('pelicanish', 'pelican'));
assert.deepStrictEqual(tokenize('Hi, you!').map((t) => t.w), [true, false, true, false]);

server.listen(0, async () => {
  const url = `http://localhost:${server.address().port}`;
  const open = () => io(url, { forceNew: true, transports: ['websocket'] });
  const latest = new Map();

  try {
    const host = open();
    host.on('host:state', onHostState);
    const { code } = await call(host, 'host:create');

    const names = ['Ana', 'Ben', 'Cy', 'Dee'];
    const phones = [];
    for (const name of names) {
      const s = open();
      s.on('player:state', (st) => latest.set(name, st));
      const res = await call(s, 'player:join', { code, name });
      assert.ok(res.playerId, res.error);
      phones.push({ name, s });
    }
    const vip = phones[0].s;
    const act = (i, msg) => call(phones[i].s, 'player:action', msg);
    await waitHost((st) => st.players.length === 4 && st.canStart === null);

    // Characters: unique colors are enforced.
    const colors = hostState.players.map((p) => p.avatar.color);
    assert.strictEqual(new Set(colors).size, 4, 'players start with distinct colors');
    assert.ok((await act(1, { type: 'avatar', color: colors[0], disguise: 1 })).error, 'color clash rejected');
    assert.strictEqual((await act(1, { type: 'avatar', color: 9, disguise: 3 })).error, null);

    // Settings: VIP only, validated.
    assert.ok((await act(1, { type: 'settings', settings: { rounds: 3 } })).error, 'only VIP changes settings');
    assert.ok((await act(0, { type: 'settings', settings: { rounds: 4 } })).error, 'bad round count rejected');
    assert.strictEqual((await act(0, { type: 'settings', settings: { rounds: 3, pace: 'quick', pack: 'family' } })).error, null);
    await waitHost((st) => st.settings.rounds === 3 && st.settings.pack === 'family');

    assert.ok((await act(1, { type: 'start' })).error, 'only VIP starts');
    assert.strictEqual((await call(vip, 'player:action', { type: 'start' })).error, null);
    const first = await waitHost((st) => st.phase === 'write');
    assert.strictEqual(first.totalRounds, 3);
    assert.strictEqual(first.duration, Math.round(120 * 0.7), 'quick pace shortens the timer');

    // Pause and resume.
    assert.strictEqual((await act(0, { type: 'pause' })).error, null);
    await waitHost((st) => st.paused && st.deadline === null);
    assert.strictEqual((await act(0, { type: 'resume' })).error, null);
    await waitHost((st) => !st.paused && st.deadline);

    for (let round = 1; round <= first.totalRounds; round++) {
      await tick();
      const before = new Map(names.map((n) => [n, latest.get(n).me.score]));
      const finale = round === first.totalRounds;
      const m = finale ? 2 : 1;
      assert.strictEqual(latest.get('Ana').mine.words.length, finale ? 2 : 1);
      if (round > 1) assert.deepStrictEqual(hostState.wanted, ['Ana'], 'leader is Most Wanted');

      // Reroll works once per game.
      if (round === 1) {
        const old = latest.get('Ana').mine.words[0];
        assert.strictEqual((await act(0, { type: 'reroll' })).error, null);
        await tick();
        assert.notStrictEqual(latest.get('Ana').mine.words[0], old);
        assert.ok((await act(0, { type: 'reroll' })).error, 'second reroll refused');
      }

      const words = new Map();
      for (const p of phones) {
        const ws = latest.get(p.name).mine.words;
        words.set(p.name, ws);
        if (round === 1) {
          const bad = await call(p.s, 'player:action', { type: 'answer', text: 'This answer has nothing hidden in it.' });
          assert.ok(bad.error, 'answer without the word is rejected');
        }
        const text = `Honestly the best thing about it is the ${ws.map((w) => `${w}s`).join(' and ')} and the shiny decoy buttons.`;
        assert.strictEqual((await call(p.s, 'player:action', { type: 'answer', text })).error, null);
      }
      const hunt = await waitHost((st) => st.phase === 'hunt' && st.round === round);
      assert.strictEqual(hunt.answers.length, 4);
      assert.strictEqual(hunt.answers[0].words, undefined, 'TV must not leak words');
      await tick();

      // Ana always catches every word; everyone else falls for "decoy" (and "shiny" in the finale).
      // Everyone hearts Ben's answer except Ben, who hearts Ana's.
      const slotOf = new Map(names.map((n) => [n, latest.get(n).mine.slot]));
      for (const p of phones) {
        const fav = p.name === 'Ben' ? slotOf.get('Ana') : slotOf.get('Ben');
        assert.ok((await call(p.s, 'player:action', { type: 'heart', slot: slotOf.get(p.name) })).error, 'cannot heart own answer');
        assert.strictEqual((await call(p.s, 'player:action', { type: 'heart', slot: fav })).error, null);
        for (const a of hunt.answers) {
          if (a.slot === slotOf.get(p.name)) continue;
          const author = names.find((n) => slotOf.get(n) === a.slot);
          const targets = p.name === 'Ana' ? words.get(author) : ['decoy', 'shiny'].slice(0, a.picks);
          for (const target of targets) {
            const idx = a.tokens.findIndex((t) => t.w && (target === 'decoy' || target === 'shiny' ? t.t === target : isWord(t.t, target)));
            assert.strictEqual((await call(p.s, 'player:action', { type: 'guess', slot: a.slot, idx })).error, null);
          }
        }
        if (latest.get(p.name).phase === 'hunt') {
          const own = await call(p.s, 'player:action', { type: 'guess', slot: slotOf.get(p.name), idx: 0 });
          assert.ok(own.error, 'cannot guess own answer');
        }
      }

      await waitHost((st) => st.phase === 'reveal');
      // Step through the reveal from the TV.
      const scores = waitHost((st) => st.phase === 'scores' && st.round === round);
      for (let i = 0; i < 4 && hostState.phase === 'reveal'; i++) {
        await call(host, 'host:action', { action: 'next' });
      }
      await scores;
      await tick();

      // Per word (w words per answer, points × m):
      // Ana catches 3 answers' words (+100 each), fools 3 on her own words (+50 each), decoy fooled 3 (+50).
      // Ben/Cy/Dee fool 2 per word (+50 each), decoy fooled 2 (+50). Ben is crowd favorite (+100).
      const w = finale ? 2 : 1;
      const gain = (n) => latest.get(n).me.score - before.get(n);
      assert.strictEqual(gain('Ana'), m * (3 * w * 100 + 3 * w * 50 + 50));
      assert.strictEqual(gain('Ben'), m * (2 * w * 50 + 50 + 100));
      for (const n of ['Cy', 'Dee']) assert.strictEqual(gain(n), m * (2 * w * 50 + 50));
      assert.strictEqual(hostState.favorites[0].author, 'Ben');
      if (round === first.totalRounds - 1) assert.ok(hostState.finaleNext, 'finale is announced');

      const nextPhase = finale ? 'end' : 'write';
      const waiting = waitHost((st) => st.phase === nextPhase && (nextPhase === 'end' || st.round === round + 1));
      assert.strictEqual((await call(vip, 'player:action', { type: 'next' })).error, null);
      await waiting;
    }

    const end = hostState;
    assert.strictEqual(end.leaderboard[0].name, 'Ana');
    assert.deepStrictEqual(end.awards.bloodhound.names, ['Ana']);
    assert.deepStrictEqual(end.awards.favorite.names, ['Ben']);
    assert.strictEqual((await call(host, 'host:action', { action: 'playAgain' })).error, null);

    // Removing a player: VIP only, and the removed phone is told.
    const eve = open();
    const kicked = new Promise((res) => eve.on('player:kicked', res));
    await call(eve, 'player:join', { code, name: 'Eve' });
    await waitHost((st) => st.players.some((p) => p.name === 'Eve'));
    assert.ok((await act(1, { type: 'kick', name: 'Eve' })).error, 'only VIP can remove players');
    assert.strictEqual((await act(0, { type: 'kick', name: 'Eve' })).error, null);
    await kicked;
    await waitHost((st) => !st.players.some((p) => p.name === 'Eve'));

    console.log('✓ smoke test passed: full game with settings, pause, finale, Most Wanted and kick');
    process.exit(0);
  } catch (e) {
    console.error('✗ smoke test failed:', e);
    process.exit(1);
  }
});
