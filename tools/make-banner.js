'use strict';
// Gera o banner do site renderizando HTML/CSS no Chrome headless (Device Scale 2x).
// Efeito "Photoshop 6": texto com gradiente chrome, glow, reflexo, lens flare,
// grelha tech e grão. Resultado: public/img/banner.png
//
//   node tools/make-banner.js

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DSF = 2;
const PORT = 9391;

// Duas variantes: desktop (1600x380) e mobile (800x300, texto maior em proporção).
const VARIANTS = [
  {
    out: path.join(__dirname, '..', 'img', 'banner.png'),
    w: 1600,
    h: 380,
    title: 128,
    titleBlur: 26,
    sub: 58,
    subBlur: 16,
    meta: 17,
    tag: 15,
    tagTop: 40,
    pad: 26,
    grid: 48,
    flareX: 248,
    flareY: 92,
    flareSize: 260,
    showMeta: true,
    stars: 26,
  },
  {
    out: path.join(__dirname, '..', 'img', 'banner-mobile.png'),
    w: 800,
    h: 300,
    title: 88,
    titleBlur: 18,
    sub: 42,
    subBlur: 12,
    meta: 14,
    tag: 12,
    tagTop: 28,
    pad: 18,
    grid: 32,
    flareX: 124,
    flareY: 70,
    flareSize: 180,
    showMeta: false,
    stars: 16,
  },
];

function makeHTML(c) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${c.w}px; height: ${c.h}px; overflow: hidden; }
  body {
    font-family: 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif;
    background:
      radial-gradient(ellipse 60% 55% at 50% 42%, rgba(64, 108, 190, 0.34), transparent 70%),
      radial-gradient(ellipse 90% 70% at 50% 110%, rgba(20, 40, 90, 0.55), transparent 70%),
      linear-gradient(180deg, #0c1526 0%, #0a1120 55%, #060a14 100%);
    position: relative;
  }

  /* grelha tech */
  .grid {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(rgba(110, 150, 220, 0.055) 1px, transparent 1px),
      linear-gradient(90deg, rgba(110, 150, 220, 0.055) 1px, transparent 1px);
    background-size: ${c.grid}px ${c.grid}px;
    -webkit-mask-image: radial-gradient(ellipse 70% 80% at 50% 45%, #000 30%, transparent 75%);
    mask-image: radial-gradient(ellipse 70% 80% at 50% 45%, #000 30%, transparent 75%);
  }

  /* estrelas / poeira */
  .stars { position: absolute; inset: 0; }
  .stars i { position: absolute; width: 2px; height: 2px; border-radius: 50%; background: #cfe0ff; opacity: .5; }

  /* linhas decorativas */
  .rule-top, .rule-bottom {
    position: absolute; left: 8%; right: 8%; height: 1px;
    background: linear-gradient(90deg, transparent, rgba(214, 178, 96, .5) 20%, rgba(214, 178, 96, .85) 50%, rgba(214, 178, 96, .5) 80%, transparent);
  }
  .rule-top { top: ${c.pad}px; }
  .rule-bottom { bottom: ${c.pad}px; }

  .tag {
    position: absolute; top: ${c.tagTop}px; left: 8%;
    font-size: ${c.tag}px; font-weight: bold; letter-spacing: 6px;
    color: #d6b260;
  }
  .tag small { color: #7d8aa8; font-weight: normal; letter-spacing: 3px; }

  .stage { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }

  /* ---------- título chrome ---------- */
  .title-wrap { position: relative; }

  .title-glow {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: ${c.title}px; font-weight: bold; font-style: italic;
    letter-spacing: 4px; text-transform: uppercase;
    color: rgba(96, 150, 255, 0.4);
    filter: blur(${c.titleBlur}px);
  }

  .title {
    position: relative;
    font-size: ${c.title}px; font-weight: bold; font-style: italic;
    letter-spacing: 4px; text-transform: uppercase;
    background: linear-gradient(
      180deg,
      #ffffff 0%,
      #eaf3ff 20%,
      #c2daf7 42%,
      #8fbcec 62%,
      #b8d5f4 82%,
      #f2f8ff 100%
    );
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(0 5px 3px rgba(0, 0, 0, 0.7));
  }

  /* ---------- subtítulo cobre ---------- */
  .sub {
    margin-top: 14px;
    position: relative;
    font-size: ${c.sub}px; font-weight: bold;
    letter-spacing: 8px; text-transform: uppercase;
    background: linear-gradient(180deg, #ffe9dc 0%, #f5b899 40%, #e8795a 70%, #f7c9ac 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(0 4px 2px rgba(0, 0, 0, 0.65));
  }
  .sub-glow {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    color: rgba(232, 121, 90, 0.35);
    filter: blur(${c.subBlur}px);
  }

  .meta {
    margin-top: 16px;
    font-size: ${c.meta}px; letter-spacing: 4px;
    color: #9fb0d0; text-transform: uppercase;
  }
  .meta b { color: #e8d9b0; font-weight: bold; letter-spacing: 4px; }

  /* ---------- lens flare ---------- */
  .flare { position: absolute; inset: 0; pointer-events: none; }
  .flare .core {
    position: absolute; left: ${c.flareX}px; top: ${c.flareY}px;
    width: ${c.flareSize}px; height: ${c.flareSize}px; border-radius: 50%;
    background: radial-gradient(circle, rgba(255,252,235,.95) 0%, rgba(255,240,200,.35) 18%, transparent 55%);
    transform: translate(-50%, -50%);
  }
  .flare .streak {
    position: absolute; left: 0; right: 0; top: ${c.flareY}px; height: 3px;
    background: linear-gradient(90deg, transparent, rgba(255,250,220,.5) 30%, rgba(255,250,220,.75) 50%, rgba(255,250,220,.5) 70%, transparent);
    filter: blur(.5px);
  }

  /* vinheta + grão */
  .vignette {
    position: absolute; inset: 0;
    background: radial-gradient(ellipse 120% 100% at 50% 45%, transparent 55%, rgba(2,4,10,.55) 100%);
  }
</style></head>
<body>
  <div class="grid"></div>
  <div class="stars">
    ${Array.from({ length: c.stars }, () => {
      const x = Math.round(Math.random() * (c.w - 4));
      const y = Math.round(Math.random() * (c.h - 4));
      const o = (0.25 + Math.random() * 0.45).toFixed(2);
      return `<i style="left:${x}px;top:${y}px;opacity:${o}"></i>`;
    }).join('\n    ')}
  </div>
  <div class="rule-top"></div>
  <div class="rule-bottom"></div>
  <div class="tag">PTNET <small>&mdash; IRC NETWORK</small></div>

  <div class="stage">
    <div class="title-wrap">
      <div class="title-glow">12&ordf; Janta</div>
      <div class="title">12&ordf; Janta</div>
    </div>
    <div style="position:relative">
      <div class="sub-glow">do #guimaraes</div>
      <div class="sub">do #guimaraes</div>
    </div>
    ${c.showMeta ? '<div class="meta"><b>19 de Dezembro de 2026</b> &nbsp;&middot;&nbsp; Restaurante O Pinguim &nbsp;&middot;&nbsp; Guimar&atilde;es</div>' : ''}
  </div>

  <div class="flare">
    <div class="core"></div>
    <div class="streak"></div>
  </div>
  <div class="vignette"></div>
</body></html>`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn('google-chrome-stable', [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=${os.tmpdir()}/banner-chrome-profile`,
    'about:blank',
  ], { stdio: 'ignore' });

  let targets;
  for (let i = 0; i < 60; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (targets.length) break;
    } catch { /* a subir */ }
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const cmd = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await cmd('Page.enable');
  for (const c of VARIANTS) {
    const tmp = path.join(os.tmpdir(), `banner-${c.w}x${c.h}-${Date.now()}.html`);
    fs.writeFileSync(tmp, makeHTML(c));
    await cmd('Emulation.setDeviceMetricsOverride', { width: c.w, height: c.h, deviceScaleFactor: DSF, mobile: false });
    await cmd('Page.navigate', { url: 'file://' + tmp });
    // espera as fontes e gradientes assentarem
    await sleep(1200);

    const shot = await cmd('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(c.out), { recursive: true });
    fs.writeFileSync(c.out, Buffer.from(shot.result.data, 'base64'));
    console.log('wrote', c.out, `${c.w}x${c.h} @${DSF}x`);
    fs.unlinkSync(tmp);
  }

  ws.close();
  chrome.kill('SIGKILL');
  process.exit(0);
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
