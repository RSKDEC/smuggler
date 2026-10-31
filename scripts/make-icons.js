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

const outputs = [
  ['favicon-32.png', 32, svg],
  ['icon-192.png', 192, svg],
  ['icon-512.png', 512, svg],
  ['apple-touch-icon.png', 180, square],
  ['maskable-512.png', 512, square],
];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [file, size, source] of outputs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
    await page.screenshot({ path: path.join(pub, 'icons', file), omitBackground: true });
    console.log('wrote', file);
  }
  await browser.close();
})();
