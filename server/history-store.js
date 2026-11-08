'use strict';
// Store de histórico em ficheiro JSON, para o servidor Node.
// Interface compatível com o IRCServer: load() / append().
//
//   const store = createFileStore('data/history.json');
//   new IRCServer({ store })
//
// As escritas são agrupadas (debounce) para não martelar o disco.

const fs = require('node:fs');
const path = require('node:path');

function createFileStore(file, opts) {
  opts = opts || {};
  const limit = opts.limit || 500;
  const flushMs = opts.flushMs || 1000;
  let data = {}; // { '#guimaraes': [entries] }
  let timer = null;
  let dirty = false;

  function flush() {
    timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file); // escrita atómica
    } catch (e) {
      console.error('[history] falha ao gravar:', e.message);
    }
  }

  function schedule() {
    dirty = true;
    if (!timer) timer = setTimeout(flush, flushMs);
  }

  return {
    load() {
      try {
        if (fs.existsSync(file)) {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
          const m = new Map();
          for (const k of Object.keys(raw)) {
            if (Array.isArray(raw[k])) m.set(k, raw[k].slice(-limit));
          }
          data = raw;
          return m;
        }
      } catch (e) {
        console.error('[history] ficheiro ilegível:', e.message);
      }
      return new Map();
    },

    append(channel, entry) {
      if (!data[channel]) data[channel] = [];
      data[channel].push(entry);
      if (data[channel].length > limit) data[channel].splice(0, data[channel].length - limit);
      schedule();
    },

    // garante que tudo é escrito antes de sair
    close() {
      if (timer) clearTimeout(timer);
      flush();
    },
  };
}

module.exports = { createFileStore };
