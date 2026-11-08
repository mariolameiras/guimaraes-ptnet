'use strict';
// Gera um tile de fundo típico de 1998 (48x48, repetível), para as laterais.
//   node tools/make-tile.js  ->  img/tile.gif

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const S = 48;
const OUT = path.join(__dirname, '..', 'img', 'tile.gif');

// paleta de 8 cores (GIF)
const PALETTE = [
  [10, 15, 30], // 0 fundo
  [16, 23, 44], // 1 grelha
  [26, 36, 66], // 2 realce da grelha
  [201, 169, 90], // 3 dourado
  [232, 121, 90], // 4 cobre
  [58, 82, 130], // 5 azul
  [120, 150, 200], // 6 azul claro
  [40, 52, 86], // 7 linha
];

const idx = new Uint8Array(S * S); // 0 por omissão

function set(x, y, v) {
  idx[(y % S) * S + (x % S)] = v;
}

// padrão diagonal subtil (linhas de 45 graus, como os fundos de 2000)
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if ((x + y) % 8 === 0) idx[y * S + x] = 1;
  }
}

// grelha a cada 16px, com cruzetas nas intersecções
for (let i = 0; i < S; i += 16) {
  for (let j = 0; j < S; j++) {
    idx[j * S + i] = 2;
    idx[i * S + j] = 2;
  }
  for (let k = -1; k <= 1; k++) {
    set(i + k, 0, 6);
    set(0, i + k, 6);
    set(i + k, 16, 6);
    set(16, i + k, 6);
    set(i + k, 32, 6);
    set(32, i + k, 6);
  }
}

// estrelas douradas e de cobre
const stars = [
  [8, 8, 3],
  [40, 24, 5],
  [24, 40, 4],
  [4, 34, 6],
  [34, 6, 3],
];
for (const [x, y, c] of stars) {
  set(x, y, c);
  set(x + 1, y, 2);
  set(x, y + 1, 2);
}

// ---------------------------------------------------------------------------
// GIF (LZW) mínimo

function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let dict = new Map();
  const out = [];
  let cur = 0;
  let curBits = 0;

  function emit(code, size) {
    cur |= code << curBits;
    curBits += size;
    while (curBits >= 8) {
      out.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
    }
  }

  emit(clearCode, codeSize);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    if (dict.has(key)) {
      prefix = dict.get(key);
    } else {
      emit(prefix, codeSize);
      if (nextCode < 4096) {
        dict.set(key, nextCode++);
        if (nextCode - 1 === 1 << codeSize && codeSize < 12) codeSize++;
      } else {
        emit(clearCode, codeSize);
        dict = new Map();
        codeSize = minCodeSize + 1;
        nextCode = eoiCode + 1;
      }
      prefix = k;
    }
  }
  emit(prefix, codeSize);
  emit(eoiCode, codeSize);
  if (curBits > 0) out.push(cur & 0xff);
  return Buffer.from(out);
}

function buildGIF() {
  const parts = [];
  // header + logical screen descriptor (paleta global de 8 cores => 8*3 bytes)
  const hdr = Buffer.alloc(13);
  hdr.write('GIF89a', 0, 'ascii');
  hdr.writeUInt16LE(S, 6);
  hdr.writeUInt16LE(S, 8);
  hdr[10] = 0x80 | 0x02; // global colour table, 2^(2+1)=8 cores
  hdr[11] = 0; // background
  hdr[12] = 0; // aspect
  parts.push(hdr);
  const pal = Buffer.alloc(8 * 3);
  PALETTE.forEach((c, i) => {
    pal[i * 3] = c[0];
    pal[i * 3 + 1] = c[1];
    pal[i * 3 + 2] = c[2];
  });
  parts.push(pal);

  // image descriptor
  const img = Buffer.alloc(10);
  img[0] = 0x2c;
  img.writeUInt16LE(0, 1);
  img.writeUInt16LE(0, 3);
  img.writeUInt16LE(S, 5);
  img.writeUInt16LE(S, 7);
  img[9] = 0;
  parts.push(img);

  // dados LZW
  const data = lzwEncode(idx, 3);
  const blocks = [];
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, i + 255);
    blocks.push(Buffer.from([chunk.length]), chunk);
  }
  blocks.push(Buffer.from([0]));
  parts.push(Buffer.from([3]), ...blocks); // minCodeSize = 3
  parts.push(Buffer.from([0x3b])); // trailer
  return Buffer.concat(parts);
}

fs.writeFileSync(OUT, buildGIF());
console.log('wrote', OUT, `${S}x${S}`);
