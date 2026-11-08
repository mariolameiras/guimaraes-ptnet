'use strict';
// Gera badges 88x31 autênticos (estilo 1998-2001) como GIFs ANIMADOS.
// As frames são renderizadas no Chrome headless com a fonte bitmap 'Misc Fixed'
// a 13px (nítida), empilhadas numa página, cortadas em Node e montadas com ffmpeg.
//
//   node tools/make-badges.js  ->  img/badge-*.gif

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const BW = 88;
const BH = 31;
const PORT = 9392;
const OUT_DIR = path.join(__dirname, '..', 'img');
const FRAME_DIR = path.join(os.tmpdir(), `badge-frames-${Date.now()}`);

// ---------------------------------------------------------------------------
// definição dos badges: cada frame é uma função do índice -> html interno

const badges = [
  {
    id: 'netnow',
    fps: 2,
    css: `background:#000;
      .nbox { width:22px; height:100%; background:linear-gradient(180deg,#2b6bd4,#0a2f7a); color:#fff; display:flex; align-items:center; justify-content:center; }
      .ntxt { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; }
      .ns { color:#9fc4ff; }
      .now { color:${'${NOW}'}; }`,
    frames: [
      { NOW: '#ffe14d' },
      { NOW: '#443a10' },
    ],
    html: (f) => `<div class="nbox">N</div><div class="ntxt"><div class="ns">Netscape</div><div class="now">NOW!</div></div>`,
  },
  {
    id: 'ie5',
    fps: 8,
    css: `background:linear-gradient(180deg,#3b7de0,#0a2a6e);
      .txt { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; height:100%; color:#fff; }
      .shine { position:absolute; top:-2px; bottom:-2px; width:14px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent); transform:skewX(-18deg); }`,
    frames: [
      { X: -18 },
      { X: 22 },
      { X: 62 },
      { X: 96 },
    ],
    html: (f) => `<div class="txt"><div>Internet</div><div>Explorer 5</div></div><div class="shine" style="left:${f.X}px"></div>`,
  },
  {
    id: 'notepad',
    fps: 2,
    css: `background:#fff; color:#000;
      .txt { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; height:100%; }
      .np { color:#0033aa; }
      .cur { color:#000; }`,
    frames: [
      { CUR: '_' },
      { CUR: '\u00a0' },
    ],
    html: (f) => `<div class="txt"><div>Made with</div><div class="np">Notepad<span class="cur">${f.CUR}</span></div></div>`,
  },
  {
    id: 'view800',
    fps: 4,
    css: `background:#101a2e;
      .txt { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; height:100%; }
      .l1 { color:#8fa3cc; }
      .l2 { color:#e8d9b0; }
      .scan { position:absolute; left:0; right:0; height:1px; background:rgba(180,220,255,.5); }`,
    frames: [
      { Y: 3 },
      { Y: 14 },
      { Y: 25 },
    ],
    html: (f) => `<div class="txt"><div class="l1">Best viewed</div><div class="l2">800x600</div></div><div class="scan" style="top:${f.Y}px"></div>`,
  },
  {
    id: 'y2k',
    fps: 2,
    css: `background:#000;
      .txt { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; height:100%; }
      .y2k { color:${'${Y2K}'}; }
      .comp { color:#c9a90a; }`,
    frames: [
      { Y2K: '#ffe14d' },
      { Y2K: '#4a3f0a' },
    ],
    html: (f) => `<div class="txt"><div class="y2k">Y2K</div><div class="comp">COMPLIANT</div></div>`,
  },
  {
    id: 'winamp',
    fps: 8,
    css: `background:#000;
      .txt { color:#ff9c2a; height:100%; display:flex; align-items:center; padding-left:5px; }
      .eq { position:absolute; right:5px; top:4px; bottom:4px; width:34px; display:flex; align-items:flex-end; gap:2px; }
      .bar { width:5px; background:linear-gradient(180deg,#c8f09a,#3fae5a); }`,
    frames: [
      { B: [7, 12, 5, 9] },
      { B: [11, 6, 13, 7] },
      { B: [14, 9, 4, 12] },
      { B: [8, 13, 7, 5] },
      { B: [5, 10, 14, 8] },
      { B: [12, 7, 9, 13] },
    ],
    html: (f) => `<div class="txt">Winamp</div><div class="eq">${f.B.map((h) => `<div class="bar" style="height:${h}px"></div>`).join('')}</div>`,
  },
  {
    id: 'ptnet',
    fps: 6,
    css: `background:linear-gradient(180deg,#0c2a6e,#061540);
      .txt { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; height:100%; color:#fff; }
      .l2 { color:#9fc4ff; }
      .shine { position:absolute; top:-2px; bottom:-2px; width:14px; background:linear-gradient(90deg,transparent,rgba(255,255,255,.4),transparent); transform:skewX(-18deg); }`,
    frames: [
      { X: -18 },
      { X: 22 },
      { X: 62 },
      { X: 96 },
    ],
    html: (f) => `<div class="txt"><div>PTnet</div><div class="l2">IRC Network</div></div><div class="shine" style="left:${f.X}px"></div>`,
  },
  {
    id: 'janta',
    fps: 2,
    css: `background:linear-gradient(180deg,#1a2340,#0a0f1e);
      .txt { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; height:100%; }
      .l1 { color:#c9b26a; }
      .l2 { color:${'${J2}'}; }
      .star { position:absolute; top:3px; right:4px; width:4px; height:4px; background:${'${ST}'}; }`,
    frames: [
      { J2: '#ffe9b3', ST: '#ffe14d' },
      { J2: '#e8d9b0', ST: 'transparent' },
    ],
    html: (f) => `<div class="txt"><div class="l1">#guimaraes</div><div class="l2">12a JANTA</div></div><div class="star"></div>`,
  },
];

// substitui os placeholders ${VAR} no css pelos valores da frame e emite
// regras com escopo: "#f<i> { base }" + "#f<i> .classe { ... }"
function cssRules(b, f, i) {
  const css = b.css.replace(/\$\{(\w+)\}/g, (m, k) => f[k]);
  const parts = css.split(/(?=\.[\w-]+\s*\{)/);
  const base = parts[0].trim();
  const out = [`#f${i} { top:${i * BH}px; ${base} }`];
  for (let p = 1; p < parts.length; p++) {
    out.push(`#f${i} ${parts[p].trim()}`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// página: todas as frames de todos os badges empilhadas

const allFrames = [];
for (const b of badges) {
  for (let i = 0; i < b.frames.length; i++) {
    allFrames.push({ badge: b, frame: b.frames[i], idx: i });
  }
}

const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${BW}px; height:${allFrames.length * BH}px; overflow:hidden; }
  body { background:#0a0a0a; }
  .badge {
    position:absolute; left:0; width:${BW}px; height:${BH}px; overflow:hidden;
    display:flex; color:#fff; font-family:'Misc Fixed','Fixed',monospace;
    font-size:13px; line-height:13px; white-space:nowrap;
    border:1px solid #000;
    box-shadow: inset 1px 1px 0 rgba(255,255,255,.35), inset -1px -1px 0 rgba(0,0,0,.5);
  }
  .badge .txt, .badge .ntxt { position:relative; }
${allFrames
  .map(
    (af, i) => cssRules(af.badge, af.frame, i)
  )
  .join('\n')}
</style></head><body>
${allFrames.map((af, i) => `<div class="badge" id="f${i}">${af.badge.html(af.frame)}</div>`).join('\n')}
</body></html>`;

// ---------------------------------------------------------------------------
// PNG helpers (leitura com unfilter + escrita)

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
  const tmp = path.join(os.tmpdir(), `badges-${Date.now()}.html`);
  fs.writeFileSync(tmp, page);
  fs.mkdirSync(FRAME_DIR, { recursive: true });

  const chrome = spawn('google-chrome-stable', [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=${os.tmpdir()}/badge-gif-profile-${Date.now()}`,
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
  await cmd('Emulation.setDeviceMetricsOverride', { width: BW, height: allFrames.length * BH, deviceScaleFactor: 1, mobile: false });
  await cmd('Page.navigate', { url: 'file://' + tmp });
  await sleep(1000);

  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  const { rgb, w, h } = readPNG(Buffer.from(shot.result.data, 'base64'));
  console.log('captura:', w + 'x' + h);
  if (w !== BW || h !== allFrames.length * BH) throw new Error('dimensões inesperadas');

  // corta as frames e grava por badge
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const b of badges) {
    let n = 0;
    for (let i = 0; i < allFrames.length; i++) {
      if (allFrames[i].badge !== b) continue;
      const out = Buffer.alloc(BW * BH * 3);
      for (let y = 0; y < BH; y++) {
        const src = (i * BH + y) * BW * 3;
        rgb.copy(out, y * BW * 3, src, src + BW * 3);
      }
      writePNG(path.join(FRAME_DIR, `${b.id}_${String(n).padStart(2, '0')}.png`), out, BW, BH);
      n++;
    }
    // monta o GIF com ffmpeg (paleta exacta, sem dithering — pixel art)
    await run('ffmpeg', [
      '-y', '-framerate', String(b.fps),
      '-i', path.join(FRAME_DIR, `${b.id}_%02d.png`),
      '-vf', 'split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none',
      '-loop', '0',
      path.join(OUT_DIR, `badge-${b.id}.gif`),
    ]);
    console.log('gif badge-' + b.id + '.gif (' + n + ' frames @ ' + b.fps + 'fps)');
  }

  ws.close();
  chrome.kill('SIGKILL');
  fs.unlinkSync(tmp);
  process.exit(0);
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
