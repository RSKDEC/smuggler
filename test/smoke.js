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
    await waitHost((st) => st.players.length === 4 && st.canStart === null);

    assert.ok((await call(phones[1].s, 'player:action', { type: 'start' })).error, 'only VIP starts');
    assert.strictEqual((await call(phones[0].s, 'player:action', { type: 'start' })).error, null);
    const first = await waitHost((st) => st.phase === 'write');

    for (let round = 1; round <= first.totalRounds; round++) {
      await tick();
      const before = new Map(names.map((n) => [n, latest.get(n).me.score]));

      // Reroll works once per game.
      if (round === 1) {
        const old = latest.get('Ana').mine.word;
        assert.strictEqual((await call(phones[0].s, 'player:action', { type: 'reroll' })).error, null);
        await tick();
        assert.notStrictEqual(latest.get('Ana').mine.word, old);
        assert.ok((await call(phones[0].s, 'player:action', { type: 'reroll' })).error, 'second reroll refused');
      }

      const words = new Map();
      for (const p of phones) {
        const word = latest.get(p.name).mine.word;
        words.set(p.name, word);
        if (round === 1) {
          const bad = await call(p.s, 'player:action', { type: 'answer', text: 'This answer has nothing hidden in it.' });
          assert.ok(bad.error, 'answer without the word is rejected');
        }
        const text = `Honestly the best thing about it is the ${word}s and the shiny decoy buttons.`;
        assert.strictEqual((await call(p.s, 'player:action', { type: 'answer', text })).error, null);
      }
      const hunt = await waitHost((st) => st.phase === 'hunt' && st.round === round);
      assert.strictEqual(hunt.answers.length, 4);
      assert.strictEqual(hunt.answers[0].word, undefined, 'TV must not leak words');
      await tick();

      // Ana always catches; everyone else picks "decoy". Ben's answer is the one to check.
      const slotOf = new Map(names.map((n) => [n, latest.get(n).mine.slot]));
      for (const p of phones) {
        for (const a of hunt.answers) {
          if (a.slot === slotOf.get(p.name)) continue;
          const author = names.find((n) => slotOf.get(n) === a.slot);
          const target = p.name === 'Ana' ? words.get(author) : 'decoy';
          const idx = a.tokens.findIndex((t) => t.w && (target === 'decoy' ? t.t === 'decoy' : isWord(t.t, target)));
          assert.strictEqual((await call(p.s, 'player:action', { type: 'guess', slot: a.slot, idx })).error, null);
        }
        const own = await call(p.s, 'player:action', { type: 'guess', slot: slotOf.get(p.name), idx: 0 });
        if (latest.get(p.name).phase === 'hunt') assert.ok(own.error, 'cannot guess own answer');
      }

      await waitHost((st) => st.phase === 'reveal');
      // Step through the reveal from the TV.
      const scores = waitHost((st) => st.phase === 'scores' && st.round === round);
      for (let i = 0; i < 4 && hostState.phase === 'reveal'; i++) {
        await call(host, 'host:action', { action: 'next' });
      }
      await scores;
      await tick();

      // Ana: catches 3 (+300); her word fools the other 3 (+150).
      // Others: caught by Ana, fool 2 others (+100); catch nobody.
      const gain = (n) => latest.get(n).me.score - before.get(n);
      assert.strictEqual(gain('Ana'), 450);
      for (const n of ['Ben', 'Cy', 'Dee']) assert.strictEqual(gain(n), 100);

      const nextPhase = round === first.totalRounds ? 'end' : 'write';
      const waiting = waitHost((st) => st.phase === nextPhase && (nextPhase === 'end' || st.round === round + 1));
      assert.strictEqual((await call(phones[0].s, 'player:action', { type: 'next' })).error, null);
      await waiting;
    }

    const end = hostState;
    assert.strictEqual(end.leaderboard[0].name, 'Ana');
    assert.deepStrictEqual(end.awards.bloodhound.names, ['Ana']);
    assert.strictEqual((await call(host, 'host:action', { action: 'playAgain' })).error, null);
    console.log('✓ smoke test passed: full game played with 4 phones');
    process.exit(0);
  } catch (e) {
    console.error('✗ smoke test failed:', e);
    process.exit(1);
  }
});
