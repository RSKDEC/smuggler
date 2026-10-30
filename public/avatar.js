// Player characters: a living suitcase in disguise. Drawn as inline SVG so they
// scale crisply on a TV and need no image assets.
const AVATAR_COLORS = [
  '#ffb703', '#e63946', '#2a9d8f', '#4361ee', '#9b5de5',
  '#f15bb5', '#80b918', '#fb8500', '#4cc9f0', '#c9ada7',
];
const DISGUISES = ['Mustache', 'Shades', 'Nose & glasses', 'Fedora', 'Monocle', 'Eyepatch'];

const INK = '#2a1d14';

function avatarFace(mood) {
  const eyes = mood === 'busted'
    ? `<circle cx="38" cy="50" r="9" fill="#fff" stroke="${INK}" stroke-width="2.5"/><circle cx="62" cy="50" r="9" fill="#fff" stroke="${INK}" stroke-width="2.5"/>
       <circle cx="38" cy="50" r="2.6" fill="${INK}"/><circle cx="62" cy="50" r="2.6" fill="${INK}"/>`
    : `<circle cx="38" cy="50" r="8" fill="#fff" stroke="${INK}" stroke-width="2.5"/><circle cx="62" cy="50" r="8" fill="#fff" stroke="${INK}" stroke-width="2.5"/>
       <circle cx="${mood === 'smug' ? 41 : 39}" cy="51" r="3.6" fill="${INK}"/><circle cx="${mood === 'smug' ? 65 : 63}" cy="51" r="3.6" fill="${INK}"/>`;
  const lids = mood === 'smug'
    ? `<path d="M29 46 Q38 40 47 46" fill="${INK}"/><path d="M53 46 Q62 40 71 46" fill="${INK}"/>`
    : '';
  const mouth = {
    busted: `<ellipse cx="50" cy="75" rx="6" ry="7" fill="${INK}"/>
             <path d="M80 34 q4 7 0 10 q-4 -3 0 -10z" fill="#7fd1ff" stroke="${INK}" stroke-width="1.5"/>`,
    smug: `<path d="M40 73 Q54 80 62 69" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>`,
  }[mood] || `<path d="M41 72 Q50 79 59 72" fill="none" stroke="${INK}" stroke-width="3.5" stroke-linecap="round"/>`;
  return eyes + lids + mouth;
}

function avatarDisguise(d, mood) {
  switch (d) {
    case 0: // mustache
      return `<path d="M33 66 Q41 57 50 63 Q59 57 67 66 Q59 69 50 66 Q41 69 33 66Z" fill="${INK}"/>`;
    case 1: // shades
      return mood === 'busted' ? `<path d="M26 34 h22 v9 h-22z M52 34 h22 v9 h-22z" fill="${INK}" transform="rotate(-8 50 38)"/>`
        : `<rect x="27" y="42" width="22" height="15" rx="5" fill="${INK}"/><rect x="51" y="42" width="22" height="15" rx="5" fill="${INK}"/>
           <rect x="47" y="46" width="6" height="3" fill="${INK}"/><path d="M31 46 l6 0" stroke="#fff" stroke-width="2" opacity=".5"/>`;
    case 2: // nose & glasses
      return `<circle cx="38" cy="50" r="11" fill="none" stroke="${INK}" stroke-width="3"/><circle cx="62" cy="50" r="11" fill="none" stroke="${INK}" stroke-width="3"/>
              <path d="M28 37 Q38 31 47 37 M53 37 Q62 31 72 37" stroke="${INK}" stroke-width="4" fill="none" stroke-linecap="round"/>
              <ellipse cx="50" cy="62" rx="7" ry="9" fill="#f4a3a8" stroke="${INK}" stroke-width="2.5"/>`;
    case 3: // fedora
      return `<ellipse cx="50" cy="22" rx="40" ry="6" fill="#3d2c22" stroke="${INK}" stroke-width="3"/>
              <path d="M28 21 Q30 2 50 4 Q70 2 72 21Z" fill="#3d2c22" stroke="${INK}" stroke-width="3"/>
              <rect x="29" y="14" width="42" height="5" fill="#e63946"/>`;
    case 4: // monocle
      return `<circle cx="62" cy="50" r="12" fill="rgba(255,255,255,.25)" stroke="#d4a017" stroke-width="3.5"/>
              <path d="M73 56 Q80 72 74 88" fill="none" stroke="#d4a017" stroke-width="2"/>
              <path d="M53 37 Q62 33 71 37" stroke="${INK}" stroke-width="3.5" fill="none" stroke-linecap="round"/>`;
    case 5: // eyepatch
      return `<path d="M22 34 L80 58" stroke="${INK}" stroke-width="3"/>
              <ellipse cx="38" cy="51" rx="11" ry="10" fill="${INK}"/>`;
    default:
      return '';
  }
}

// avatar: { color, disguise }. mood: 'smug' | 'busted' | undefined.
function avatarSvg(avatar, { mood, cls = '' } = {}) {
  const fill = AVATAR_COLORS[avatar?.color ?? 0] || AVATAR_COLORS[0];
  const d = avatar?.disguise ?? 0;
  return `<svg class="avatar ${cls}" viewBox="0 0 100 112" aria-hidden="true">
    <rect x="35" y="6" width="30" height="18" rx="8" fill="none" stroke="${INK}" stroke-width="6"/>
    <circle cx="27" cy="102" r="7" fill="${INK}"/><circle cx="73" cy="102" r="7" fill="${INK}"/>
    <rect x="10" y="20" width="80" height="78" rx="15" fill="${fill}" stroke="${INK}" stroke-width="4"/>
    <rect x="22" y="20" width="7" height="78" fill="rgba(0,0,0,.14)"/><rect x="71" y="20" width="7" height="78" fill="rgba(0,0,0,.14)"/>
    <rect x="14" y="24" width="72" height="6" rx="3" fill="rgba(255,255,255,.22)"/>
    ${avatarFace(mood)}
    ${avatarDisguise(d, mood)}
  </svg>`;
}
