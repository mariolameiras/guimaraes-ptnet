'use strict';
// Gera badges 88x31 clássicos (estilo 1998-2001) renderizados no Chrome headless.
// Os badges são empilhados verticalmente a partir de (0,0); captura-se o viewport
// inteiro (sem clip, que é instável) e corta-se cada badge em Node.
//
//   node tools/make-badges.js  ->  public/img/badge-*.png

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const PORT = 9392;
const DSF = 4; // 88x31 -> 352x124 por badge
const OUT_DIR = path.join(__dirname, '..', 'img');

// Cada badge: html do interior + regras CSS completas.
const badges = [
  {
    id: 'netnow',
    html: `<div class="l">N</div><div class="r"><span class="s">Netscape</span><span class="b">NOW!</span></div>`,
    css: `background:#000; border-color:#444;
      .l { width:26px; height:100%; background:linear-gradient(180deg,#2b6bd4,#0a2f7a); color:#fff; font-size:22px; font-weight:bold; display:flex; align-items:center; justify-content:center; }
      .r { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; height:100%; }
      .s { color:#9fc4ff; font-size:8px; }
      .b { color:#fff; font-size:13px; font-weight:bold; letter-spacing:1px; }`,
  },
  {
    id: 'ie5',
    html: `<span class="s">Internet Explorer</span><span class="b">5.0</span>`,
    css: `background:linear-gradient(180deg,#3b7de0,#0a2a6e); border-color:#6ba4ff;
      .s { color:#dce9ff; font-size:7.5px; }
      .b { color:#fff; font-size:14px; font-weight:bold; font-style:italic; }`,
  },
  {
    id: 'notepad',
    html: `<span class="s">Made with</span><span class="b">Notepad</span>`,
    css: `background:#fff; border-color:#000;
      .s { color:#333; font-size:8px; }
      .b { color:#0033aa; font-size:13px; font-weight:bold; }`,
  },
  {
    id: 'view800',
    html: `<span class="s">Best Viewed</span><span class="b">800 x 600</span>`,
    css: `background:linear-gradient(180deg,#1a2340,#0a0f1e); border-color:#3a4a75;
      .s { color:#8fa3cc; font-size:8px; letter-spacing:1px; }
      .b { color:#e8d9b0; font-size:13px; font-weight:bold; }`,
  },
  {
    id: 'y2k',
    html: `<span class="s">compliant</span><span class="b">Y2K</span>`,
    css: `background:#000; border-color:#c9a90a;
      .s { color:#c9a90a; font-size:8px; letter-spacing:2px; }
      .b { color:#ffe14d; font-size:16px; font-weight:bold; font-style:italic; }`,
  },
  {
    id: 'winamp',
    html: `<span class="s">it really whips</span><span class="b">Winamp</span>`,
    css: `background:linear-gradient(180deg,#2a2a2a,#000); border-color:#777;
      .s { color:#9fb98f; font-size:6.5px; font-style:italic; }
      .b { color:#ff9c2a; font-size:14px; font-weight:bold; letter-spacing:.5px; }`,
  },
  {
    id: 'ptnet',
    html: `<span class="s">IRC Network</span><span class="b">PTnet</span>`,
    css: `background:linear-gradient(180deg,#0c2a6e,#061540); border-color:#3a6ac0;
      .s { color:#9fc4ff; font-size:8px; letter-spacing:1px; }
      .b { color:#fff; font-size:15px; font-weight:bold; font-style:italic; }`,
  },
  {
    id: 'janta',
    html: `<span class="s">#guimaraes</span><span class="b">12&ordf; JANTA</span>`,
    css: `background:linear-gradient(180deg,#1a2340,#0a0f1e); border-color:#c9a95a;
      .s { color:#c9b26a; font-size:8px; }
      .b { color:#ffe9b3; font-size:12px; font-weight:bold; letter-spacing:1px; }`,
  },
];

// converte ".classe { ... }" em "#b-<id> .classe { ... }"
function scoped(id, css) {
  return css.replace(/(^|\n)\s*\.\w+\s*\{/g, (m) => m.replace(/\.(?=\w+\s*\{)/, `#b-${id} .`));
}

const BW = 88;
const BH = 31;
const TOTAL_H = BH * badges.length;

const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${BW}px; height:${TOTAL_H}px; overflow:hidden; }
  body { background:#0a0a0a; font-family:'Liberation Sans','DejaVu Sans',Arial,sans-serif; }
  .badge {
    width:${BW}px; height:${BH}px; border:1px solid #555; overflow:hidden;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    gap:1px; color:#fff; line-height:1;
  }
  .badge .s { display:block; }
  .badge .b { display:block; }
  ${badges.map((b) => `#b-${b.id} { ${scoped(b.id, b.css)} }`).join('\n')}
</style></head><body>
${badges.map((b, i) => `<div class="badge" id="b-${b.id}" style="position:absolute;left:0;top:${i * BH}px">${b.html}</div>`).join('\n')}
</body></html>`;

// ---------------------------------------------------------------------------
// PNG: leitura (assumindo filtros simples) + escrita

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
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

// lê um PNG truecolor não-interlaçado e devolve RGB + dimensões
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

(async () => {
  const tmp = path.join(os.tmpdir(), `badges-${Date.now()}.html`);
  fs.writeFileSync(tmp, page);

  const chrome = spawn('google-chrome-stable', [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--user-data-dir=${os.tmpdir()}/badge-chrome-profile-${Date.now()}`,
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
  await cmd('Emulation.setDeviceMetricsOverride', { width: BW, height: TOTAL_H, deviceScaleFactor: DSF, mobile: false });
  await cmd('Page.navigate', { url: 'file://' + tmp });
  await sleep(1000);

  // screenshot completa do viewport (sem clip)
  const shot = await cmd('Page.captureScreenshot', { format: 'png' });
  const full = Buffer.from(shot.result.data, 'base64');
  const { rgb, w, h } = readPNG(full);
  console.log('captura:', w + 'x' + h, '(esperado', BW * DSF + 'x' + TOTAL_H * DSF + ')');
  if (w !== BW * DSF || h !== TOTAL_H * DSF) throw new Error('dimensões inesperadas');

  // apaga badges antigos que já não são usados
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.startsWith('badge-') && !badges.some((b) => `badge-${b.id}.png` === f)) {
      fs.unlinkSync(path.join(OUT_DIR, f));
      console.log('removed', f);
    }
  }

  // corta cada badge
  const sliceH = BH * DSF;
  for (let i = 0; i < badges.length; i++) {
    const out = Buffer.alloc(BW * DSF * sliceH * 3);
    for (let y = 0; y < sliceH; y++) {
      const src = (i * sliceH + y) * (BW * DSF) * 3;
      rgb.copy(out, y * (BW * DSF) * 3, src, src + BW * DSF * 3);
    }
    const file = path.join(OUT_DIR, `badge-${badges[i].id}.png`);
    writePNG(file, out, BW * DSF, sliceH);
    console.log('badge', badges[i].id);
  }

  ws.close();
  chrome.kill('SIGKILL');
  fs.unlinkSync(tmp);
  process.exit(0);
})().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
