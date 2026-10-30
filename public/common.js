// Shared helpers for the TV and phone clients.
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Mirrors isWord() in src/room.js: plurals and possessives count.
function isWord(token, word) {
  const a = String(token).trim().toLowerCase().replace(/'s?$/, '');
  return a === word || a === `${word}s` || a === `${word}es`;
}

function containsWord(text, word) {
  return (text.match(/[A-Za-z][A-Za-z']*/g) || []).some((t) => isWord(t, word));
}

// Server sends `now` with each state so countdowns survive clock drift between devices.
function makeClock() {
  let offset = 0;
  let deadline = null;
  return {
    sync(state) {
      offset = Date.now() - state.now;
      deadline = state.deadline;
    },
    remaining() {
      if (!deadline) return null;
      return Math.max(0, Math.ceil((deadline - (Date.now() - offset)) / 1000));
    },
  };
}

function startTimerLoop(clock) {
  setInterval(() => {
    const s = clock.remaining();
    document.querySelectorAll('[data-timer]').forEach((el) => {
      el.textContent = s == null ? '' : s;
      el.classList.toggle('urgent', s != null && s <= 10);
    });
  }, 250);
}
