/*
 * Persistência do histórico do canal em IndexedDB (modo P2P / GitHub Pages).
 *
 * O browser anfitrião guarda as linhas do #guimaraes localmente, por isso o
 * histórico sobrevive a recarregar a página, fechar o separador e reiniciar
 * o browser. Não é partilhado entre dispositivos — para isso é preciso um
 * servidor (ver server/history-store.js).
 *
 *   var store = IRCHistoryStore.open({ db: 'janta12', limit: 500 });
 *   new IRCServer({ store: store })
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IRCHistoryStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DB_NAME = 'janta12-irc';
  var DB_VERSION = 1;
  var STORE = 'history';

  function openDB(name) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          os.createIndex('channel', 'channel', { unique: false });
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
  }

  function txDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        reject(tx.error);
      };
      tx.onabort = function () {
        reject(tx.error);
      };
    });
  }

  /**
   * @param {{db?: string, limit?: number}} opts
   * @returns {{load: function(): Promise<Map>, append: function(string, object): void}}
   */
  function open(opts) {
    opts = opts || {};
    var limit = opts.limit || 500;
    var dbp = null;
    var queue = Promise.resolve(); // escritas em série
    var counts = {};

    function db() {
      if (!dbp) dbp = openDB(opts.db || DB_NAME);
      return dbp;
    }

    return {
      // devolve Map<canal, entries[]> com as últimas `limit` linhas por canal
      load: function () {
        return db().then(function (d) {
          return new Promise(function (resolve, reject) {
            var tx = d.transaction(STORE, 'readonly');
            var os = tx.objectStore(STORE);
            var out = new Map();
            var req = os.openCursor();
            req.onsuccess = function () {
              var cur = req.result;
              if (!cur) return;
              var v = cur.value;
              if (!out.has(v.channel)) out.set(v.channel, []);
              out.get(v.channel).push(v.entry);
              cur.continue();
            };
            tx.oncomplete = function () {
              out.forEach(function (arr, k) {
                if (arr.length > limit) out.set(k, arr.slice(-limit));
                counts[k] = out.get(k).length;
              });
              resolve(out);
            };
            tx.onerror = function () {
              reject(tx.error);
            };
          });
        });
      },

      // grava uma linha; quando passa do limite, apaga as mais antigas
      append: function (channel, entry) {
        queue = queue
          .then(function () {
            return db();
          })
          .then(function (d) {
            var tx = d.transaction(STORE, 'readwrite');
            var os = tx.objectStore(STORE);
            os.add({ channel: channel, entry: entry });
            counts[channel] = (counts[channel] || 0) + 1;
            if (counts[channel] > limit + 20) {
              // poda: apaga as ~20 mais antigas deste canal
              var idx = os.index('channel');
              var req = idx.openCursor(IDBKeyRange.only(channel));
              var deleted = 0;
              req.onsuccess = function () {
                var cur = req.result;
                if (cur && deleted < 20) {
                  cur.delete();
                  deleted++;
                  cur.continue();
                }
              };
              counts[channel] -= 20;
            }
            return txDone(tx);
          })
          .catch(function () {
            /* se o IndexedDB falhar, o chat continua a funcionar */
          });
      },

      // apaga tudo (útil para testes)
      clear: function () {
        return db().then(function (d) {
          var tx = d.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).clear();
          counts = {};
          return txDone(tx);
        });
      },
    };
  }

  return { open: open };
});
