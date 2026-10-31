// Renders public/icon.svg into the PNG icons browsers, phones and the web app
// manifest need. Run after editing the SVG: `node scripts/make-icons.js`
// (needs Playwright with Chromium available; it isn't a project dependency).
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const pub = path.join(__dirname, '..', 'public');
const svg = fs.readFileSync(path.join(pub, 'icon.svg'), 'utf8');

// Square, full-bleed background for platforms that apply their own mask, with the
// art shrunk into the maskable safe zone.
const square = svg
  .replace(/ rx="112"/g, '')
  .replace('<g id="art" transform="', '<g id="art" transform="translate(256 270) scale(.8) translate(-256 -270) ');

const tvRes = path.join(__dirname, '..', 'android-tv', 'app', 'src', 'main');

// Google TV home-screen tile (320x180 at xhdpi): mascot plus wordmark.
const art = svg.match(/<g id="art"[\s\S]*<\/g>\s*<\/svg>/)[0].replace(/<\/svg>$/, '');
const banner = `<div style="width:320px;height:180px;display:flex;align-items:center;gap:8px;padding:0 14px 0 12px;justify-content:center;box-sizing:border-box;
  background:radial-gradient(circle at 30% 40%,#ffd166,#ffb703 55%,#f08a00);font-family:'Bungee',sans-serif;position:relative;overflow:hidden">
  <div style="position:absolute;inset:0;background:repeating-linear-gradient(135deg,rgba(255,255,255,.1) 0 16px,transparent 16px 32px)"></div>
  <svg viewBox="40 70 400 420" width="112" height="118" style="position:relative;flex:none">${art}</svg>
  <div style="position:relative;font-size:26px;color:#2a1d14;letter-spacing:.5px;line-height:1;white-space:nowrap">SMUG<span style="color:#e63946">G</span>LER</div>
</div>`;
const fontCss = '<link href="https://fonts.googleapis.com/css2?family=Bungee&display=swap" rel="stylesheet">';

const outputs = [
  ['favicon-32.png', 32, svg],
  ['icon-192.png', 192, svg],
  ['icon-512.png', 512, svg],
  ['apple-touch-icon.png', 180, square],
  ['maskable-512.png', 512, square],
  [path.join(tvRes, 'res', 'mipmap-xxxhdpi', 'ic_launcher.png'), 192, svg],
  [path.join(tvRes, 'assets', 'icon.png'), 256, svg],
  [path.join(tvRes, 'res', 'drawable-xhdpi', 'banner.png'), [320, 180, 1], banner],
  [path.join(tvRes, 'res', 'drawable-xxxhdpi', 'banner.png'), [320, 180, 2], banner],
];

(async () => {
  const browser = await chromium.launch();
  for (const [file, size, source] of outputs) {
    const [w, h, scale] = Array.isArray(size) ? size : [size, size, 1];
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
    const isBanner = Array.isArray(size);
    await page.setContent(isBanner
      ? `${fontCss}<style>html,body{margin:0}</style>${source}`
      : `<style>html,body{margin:0;background:transparent}svg{display:block;width:${w}px;height:${h}px}</style>${source}`);
    if (isBanner) await page.evaluate(() => document.fonts.ready);
    const out = path.isAbsolute(file) ? file : path.join(pub, 'icons', file);
    await page.screenshot({ path: out, omitBackground: !isBanner });
    await page.close();
    console.log('wrote', path.relative(path.join(__dirname, '..'), out));
  }
  await browser.close();
})();
