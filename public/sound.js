// All sound is synthesized with Web Audio, so there are no audio files to ship.
// Browsers only allow audio after a user gesture; call sound.unlock() from one.
const sound = (() => {
  const KEY = 'smuggler-sound';
  let ctx = null;
  let master = null;
  let musicGain = null;
  let enabled = true;
  let musicOn = false;
  let musicTimer = null;
  let nextBeat = 0;
  let beat = 0;
  try { enabled = localStorage.getItem(KEY) !== 'off'; } catch {}

  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = enabled ? 0.8 : 0;
      master.connect(ctx.destination);
      musicGain = ctx.createGain();
      musicGain.gain.value = 0.22;
      musicGain.connect(master);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }

  const ready = () => ctx && ctx.state === 'running';

  function tone({ freq = 440, type = 'sine', dur = 0.2, vol = 0.3, at = 0, slide = null, dest = null }) {
    if (!ready()) return;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest || master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function noise({ dur = 0.2, vol = 0.3, at = 0, filter = 1200, type = 'lowpass', dest = null }) {
    if (!ready()) return;
    const t = ctx.currentTime + at;
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = filter;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(dest || master);
    src.start(t);
  }

  const sfx = {
    pop: () => { tone({ freq: 520, slide: 900, dur: 0.12, vol: 0.25, type: 'triangle' }); },
    blip: () => { tone({ freq: 880, dur: 0.08, vol: 0.15, type: 'square' }); },
    tick: () => { tone({ freq: 1500, dur: 0.04, vol: 0.12, type: 'square' }); },
    whoosh: () => { noise({ dur: 0.45, vol: 0.25, filter: 900, type: 'bandpass' }); },
    scan: () => {
      tone({ freq: 220, slide: 660, dur: 1.5, vol: 0.08, type: 'sawtooth' });
      for (let i = 0; i < 6; i++) tone({ freq: 1200, dur: 0.05, vol: 0.08, type: 'square', at: i * 0.25 });
    },
    pin: () => { tone({ freq: 700 + Math.random() * 300, dur: 0.07, vol: 0.12, type: 'triangle' }); },
    drumroll: (len = 1) => {
      const n = Math.floor(len / 0.045);
      for (let i = 0; i < n; i++) noise({ dur: 0.05, vol: 0.06 + 0.12 * (i / n), filter: 2500, at: i * 0.045 });
    },
    stamp: () => {
      tone({ freq: 140, slide: 45, dur: 0.35, vol: 0.6 });
      noise({ dur: 0.18, vol: 0.5, filter: 600 });
    },
    busted: () => {
      sfx.stamp();
      for (let i = 0; i < 4; i++) tone({ freq: i % 2 ? 660 : 880, dur: 0.16, vol: 0.13, type: 'square', at: 0.15 + i * 0.17 });
    },
    cleared: () => {
      sfx.stamp();
      [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.3, vol: 0.14, type: 'triangle', at: 0.15 + i * 0.09 }));
    },
    chime: () => { [784, 1175].forEach((f, i) => tone({ freq: f, dur: 0.35, vol: 0.15, type: 'sine', at: i * 0.08 })); },
    fanfare: () => {
      [[523, 0], [659, 0.15], [784, 0.3], [1047, 0.45], [784, 0.65], [1047, 0.8]]
        .forEach(([f, at]) => tone({ freq: f, dur: at > 0.7 ? 0.7 : 0.2, vol: 0.18, type: 'triangle', at }));
    },
  };

  // Original sneaky loop: walking bass in D minor with a muted off-beat hat.
  const BASS = [146.8, 0, 174.6, 146.8, 196, 0, 174.6, 164.8, 146.8, 0, 220, 196, 174.6, 0, 164.8, 138.6];
  const STEP = 0.19;

  function schedule() {
    if (!ready()) return;
    while (nextBeat < ctx.currentTime + 0.4) {
      const at = nextBeat - ctx.currentTime;
      const f = BASS[beat % BASS.length];
      if (f) tone({ freq: f, type: 'triangle', dur: STEP * 0.9, vol: 0.5, at, dest: musicGain });
      if (beat % 2 === 1) noise({ dur: 0.04, vol: 0.12, filter: 7000, type: 'highpass', at, dest: musicGain });
      if (beat % 8 === 0) tone({ freq: 55, slide: 40, dur: 0.18, vol: 0.5, at, dest: musicGain });
      nextBeat += STEP;
      beat++;
    }
  }

  function music(on) {
    if (on === musicOn) return;
    musicOn = on;
    clearInterval(musicTimer);
    if (on && ctx) {
      nextBeat = ctx.currentTime + 0.05;
      musicTimer = setInterval(schedule, 100);
    }
  }

  function setEnabled(on) {
    enabled = on;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {}
    if (master) master.gain.value = on ? 0.8 : 0;
  }

  return {
    unlock,
    ready,
    music,
    play: (name, ...args) => sfx[name] && sfx[name](...args),
    get enabled() { return enabled; },
    setEnabled,
  };
})();
