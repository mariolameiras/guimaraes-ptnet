'use strict';
// Gera um GIF com o texto "#guimaraes" a rodar 360 graus sobre si mesmo
// (rotação em Y com perspectiva e sombreamento) — muito típico de 1998-2001.
// As frames são renderizadas no Chrome headless e montadas com ffmpeg.
//
//   node tools/make-spinner.js  ->  img/guimaraes-spin.gif

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const W = 280;
const H = 100;
const FRAMES = 36; // 10 graus por frame
const FPS = 18;
const PORT = 9397;
const OUT = path.join(__dirname, '..', 'img', 'guimaraes-spin.gif');
const FRAME_DIR = path.join(os.tmpdir(), `spin-frames-${Date.now()}`);

const TEXT = '#guimaraes';

// ---------------------------------------------------------------------------
// projecção 3D: cada letra é um plano vertical em x, rodado em torno do eixo Y

function buildFrame(angle) {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const FOCAL = 620;
  const Z0 = 300;
  const charW = 19;
  const totalW = TEXT.length * charW;
  const parts = [];

  for (let i = 0; i < TEXT.length; i++) {
    const ch = TEXT[i];
    const x0 = i * charW - totalW / 2;
    const x1 = x0 + charW - 2;
    const xc = (x0 + x1) / 2;

    // profundidade do centro da letra após rotação
    const zc = xc * sin;
    const scale = FOCAL / (FOCAL + Z0 + zc);
    const xc2 = xc * cos;

    // letras de costa (cos < 0) ficam mais escuras — efeito de volume
    const facing = Math.cos(rad + Math.atan2(xc, Z0 + 0.001));
    const shade = Math.max(0.45, Math.min(1, 0.72 + 0.38 * facing));
    const bright = Math.round(255 * shade);

    const px = W / 2 + xc2 * scale;
    const size = Math.max(8, 34 * scale);

    parts.push(
      `<span style="left:${px.toFixed(2)}px;font-size:${size.toFixed(2)}px;color:rgb(${bright},${Math.round(bright * 0.62)},${Math.round(bright * 0.36)})">${ch === ' ' ? '&nbsp;' : ch}</span>`
    );
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// página com todas as frames empilhadas

const framesHtml = [];
for (let f = 0; f < FRAMES; f++) {
  framesHtml.push(
    `<div class="frame" id="fr${f}" style="top:${f * H}px"><div class="word">${buildFrame((f * 360) / FRAMES)}</div></div>`
  );
}

const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${W}px; height:${H * FRAMES}px; overflow:hidden; background:#000; }
  .frame {
    position:absolute; left:0; width:${W}px; height:${H}px;
    display:flex; align-items:center; justify-content:center;
    background: radial-gradient(ellipse 70% 80% at 50% 50%, #0e1a33 0%, #060a14 75%);
    overflow:hidden;
  }
  .word { position:relative; width:${W}px; height:${H}px; }
  .word span {
    position:absolute; top:50%; transform:translate(-50%,-50%);
    font-family:'Liberation Sans','DejaVu Sans',Arial,sans-serif;
    font-weight:bold; font-style:italic;
    text-shadow: 0 0 10px rgba(255,150,60,.45), 0 2px 2px rgba(0,0,0,.8);
    white-space:nowrap;
  }
</style></head><body>
${framesHtml.join('\n')}
</body></html>`;

// ---------------------------------------------------------------------------
// PNG helpers

function crc32(buf) {
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePNG(file, rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

function readPNG(buf) {
  let o = 8;
  let idat = [];
  let w = 0;
  let h = 0;
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IHDR') {
      w = buf.readUInt32BE(o + 8);
      h = buf.readUInt32BE(o + 12);
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(o + 8, o + 8 + len));
    }
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 3 + 1;
  const rgb = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(w * 3);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * stride];
    const line = Buffer.from(raw.subarray(y * stride + 1, (y + 1) * stride));
    if (filter === 1) {
      for (let i = 3; i < line.length; i++) line[i] = (line[i] + line[i - 3]) & 0xff;
    } else if (filter === 2) {
      for (let i = 0; i < line.length; i++) line[i] = (line[i] + prev[i]) & 0xff;
    } else if (filter === 3) {
      for (let i = 0; i < line.length; i++) {
        const left = i >= 3 ? line[i - 3] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
    } else if (filter === 4) {
      for (let i = 0; i < line.length; i++) {
        const a = i >= 3 ? line[i - 3] : 0;
        const b = prev[i];
        const c = i >= 3 ? prev[i - 3] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pr) & 0xff;
      }
    }
    line.copy(rgb, y * w * 3);
    prev = line;
  }
  return { rgb, w, h };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: 'ignore' });
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(cmd + ' exit ' + code))));
  });

(async () => {
  const tmp = path.join(os.tmpdir(), `spin-${Date.now()}.html`);
  fs.writeFileSync(tmp, page);
  fs.mkdirSync(FRAME_DIR, { recursive: true });

  const chrome = spawn('google-chrome-stable', [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=${os.tmpdir()}/spin-profile-${Date.now()}`,
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
  const pg = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
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
  await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H * FRAMES, deviceScaleFactor: 1, mobile: false });
  await cmd('Page.navigate', { url: 'file://' + tmp });
  await sleep(1200);

  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  const { rgb, w, h } = readPNG(Buffer.from(shot.result.data, 'base64'));
  console.log('captura:', w + 'x' + h);
  if (w !== W || h !== H * FRAMES) throw new Error('dimensões inesperadas');

  for (let f = 0; f < FRAMES; f++) {
    const out = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) {
      const src = (f * H + y) * W * 3;
      rgb.copy(out, y * W * 3, src, src + W * 3);
    }
    writePNG(path.join(FRAME_DIR, `f_${String(f).padStart(2, '0')}.png`), out, W, H);
  }

  await run('ffmpeg', [
    '-y', '-framerate', String(FPS),
    '-i', path.join(FRAME_DIR, 'f_%02d.png'),
    '-vf', 'split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=none',
    '-loop', '0',
    OUT,
  ]);
  console.log('wrote', OUT, `${W}x${H}, ${FRAMES} frames @ ${FPS}fps`);

  ws.close();
  chrome.kill('SIGKILL');
  fs.unlinkSync(tmp);
  process.exit(0);
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
