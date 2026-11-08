'use strict';
// Zero-dependency HTTP + WebSocket server for the 12ª Janta do #guimaraes.
//   node server/index.js [port]
// Serves ./public and speaks a tiny IRC dialect on /ws.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { IRCServer } = require('../js/irc-core.js');
const { createFileStore } = require('./history-store');

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.mid': 'audio/midi',
  '.midi': 'audio/midi',
};

const historyStore = createFileStore(path.join(__dirname, '..', 'data', 'history.json'), { limit: 500 });
const irc = new IRCServer({ store: historyStore, historyLimit: 500, replayLimit: 50 });

// gravar o histórico antes de sair
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    historyStore.close();
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// HTTP

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404</h1><p>Página não encontrada. Volta ao <a href="/">índice</a>.</p>');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/online') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...irc.stats() }));
    return;
  }
  serveStatic(req, res);
});

// ---------------------------------------------------------------------------
// WebSocket (RFC 6455, server side)

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);

  const ws = {
    readyState: 1,
    _listeners: {},
    on(event, fn) {
      (this._listeners[event] ||= []).push(fn);
      return this;
    },
    _emit(event, arg) {
      for (const fn of this._listeners[event] || []) fn(arg);
    },
    send(data) {
      if (this.readyState !== 1) return;
      try {
        socket.write(encodeFrame(data));
      } catch {
        this.close();
      }
    },
    close() {
      if (this.readyState !== 1) return;
      this.readyState = 2;
      try {
        socket.write(encodeFrame(Buffer.alloc(0), 0x8));
      } catch {
        /* ignore */
      }
      socket.end();
      this.readyState = 3;
      this._emit('close');
    },
  };

  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;

  function handleFrame(opcode, payload) {
    if (opcode === 0x8) {
      ws.close();
      return;
    }
    if (opcode === 0x9) {
      try {
        socket.write(encodeFrame(payload, 0xa));
      } catch {
        /* ignore */
      }
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2) {
      fragments = [payload];
      fragmentOpcode = opcode;
    } else if (opcode === 0x0) {
      fragments.push(payload);
    } else {
      return;
    }
    if (fragmentOpcode === 0x1) {
      const total = Buffer.concat(fragments);
      fragments = [];
      if (total.length > MAX_FRAME) {
        ws.close();
        return;
      }
      ws._emit('message', total.toString('utf8'));
    }
  }

  function parse() {
    while (buffer.length >= 2) {
      const b0 = buffer[0];
      const b1 = buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buffer.length < 4) return;
        len = buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) {
          ws.close();
          return;
        }
        len = Number(big);
        offset = 10;
      }
      if (len > MAX_FRAME) {
        ws.close();
        return;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + len) return;

      let payload = buffer.subarray(offset, offset + len);
      if (masked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buffer = buffer.subarray(offset + len);

      if (fin) {
        handleFrame(opcode, payload);
      } else if (opcode === 0x1 || opcode === 0x2) {
        fragments = [payload];
        fragmentOpcode = opcode;
      } else if (opcode === 0x0) {
        fragments.push(payload);
      }
    }
  }

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME * 4) {
      ws.close();
      return;
    }
    parse();
  });
  socket.on('close', () => {
    if (ws.readyState !== 3) {
      ws.readyState = 3;
      ws._emit('close');
    }
  });
  socket.on('error', () => {
    if (ws.readyState !== 3) {
      ws.readyState = 3;
      ws._emit('close');
    }
  });

  irc.addConnection(ws);
}

server.on('upgrade', (req, socket, head) => {
  if (req.url !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    return;
  }
  acceptWebSocket(req, socket, head);
});

server.listen(PORT, HOST, () => {
  console.log(`12ª Janta do #guimaraes — servidor a correr em http://localhost:${PORT}`);
  console.log(`IRC over WebSocket em ws://localhost:${PORT}/ws`);
});
