/*
 * Persistência do histórico do canal no Firebase Realtime Database.
 *
 * Usa a REST API (fetch) em vez do SDK — menos código, sem dependências.
 * Interface compatível com o IRCServer:
 *
 *   var store = IRCHistoryStoreFirebase.open({ databaseURL: '...', channel: '#guimaraes' });
 *   new IRCServer({ store: store })
 *
 *   store.load()            -> Promise<Map<canal, entries[]>>
 *   store.append(canal, e)  -> void (assíncrono, nunca bloqueia o chat)
 *
 * Com cache local (localStorage) para arranque instantâneo e modo offline.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IRCHistoryStoreFirebase = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CACHE_PREFIX = 'janta12-fb-cache:';

  function readCache(channel) {
    try {
      var raw = localStorage.getItem(CACHE_PREFIX + channel);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function writeCache(channel, entries) {
    try {
      localStorage.setItem(CACHE_PREFIX + channel, JSON.stringify(entries.slice(-500)));
    } catch (e) {
      /* quota cheia — ignora */
    }
  }

  /**
   * @param {{databaseURL: string, channel?: string, limit?: number}} opts
   */
  function open(opts) {
    opts = opts || {};
    var base = String(opts.databaseURL || '').replace(/\/+$/, '');
    var limit = opts.limit || 500;
    var channel = opts.channel || '#guimaraes';
    var path = 'channels/' + channel.replace(/^#/, '') + '/messages';
    var url = base + '/' + path + '.json';
    var queue = Promise.resolve();
    var local = readCache(channel);

    return {
      // devolve Map<canal, entries[]> com as últimas `limit` linhas
      load: function () {
        // sem orderBy: o Firebase devolve tudo; ordenamos por ts em JS
        // (evita exigir um índice .indexOn nas regras)
        var req = fetch(url)
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then(function (data) {
            if (!data) return [];
            // o Firebase devolve um objecto {pushId: entry}
            return Object.keys(data)
              .map(function (k) {
                return data[k];
              })
              .filter(function (e) {
                return e && typeof e.ts === 'number';
              })
              .sort(function (a, b) {
                return a.ts - b.ts;
              })
              .slice(-limit);
          });

        return req.then(
          function (entries) {
            local = entries;
            writeCache(channel, entries);
            var m = new Map();
            m.set(channel, entries);
            return m;
          },
          function () {
            // sem rede / sem permissão: usa a cache local
            var m = new Map();
            if (local.length) m.set(channel, local);
            return m;
          }
        );
      },

      // grava uma linha; falhas não afectam o chat
      append: function (ch, entry) {
        local.push(entry);
        if (local.length > limit) local = local.slice(-limit);
        writeCache(channel, local);

        queue = queue
          .then(function () {
            return fetch(url.replace(/\.json$/, '.json'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                ts: entry.ts,
                nick: String(entry.nick || '').slice(0, 16),
                kind: String(entry.kind || 'msg'),
                text: String(entry.text || '').slice(0, 450),
              }),
            });
          })
          .catch(function () {
            /* silencioso: o histórico local continua */
          });
      },

      // apaga tudo (só funciona se as regras permitirem; para testes)
      clear: function () {
        local = [];
        writeCache(channel, []);
        return fetch(url, { method: 'DELETE' }).catch(function () {});
      },
    };
  }

  return { open: open };
});
