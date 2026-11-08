/* Cliente IRC embutido — liga à PTnet como guestXXXX.
   Janela única ao estilo status window do mIRC: primeiro o texto de ligação,
   depois as sugestões (/nick, /join #guimaraes), e só então o canal. */
(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };

  var els = {
    text: $('mirc-text'),
    nicks: $('mirc-nicks'),
    input: $('mirc-input'),
    send: $('mirc-send'),
    nickInput: $('nick-input'),
    title: $('mirc-title'),
    online: $('online-count'),
    chanCount: $('chan-count'),
    netStatus: $('net-status'),
    netDot: $('net-dot'),
    lag: $('lag-panel'),
    mirc: $('mirc-win'),
    sound: $('mirc-sound'),
  };

  var WS_URL = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  var CHANNEL = '#guimaraes';
  var BOT_NICK = 'BotDoJantar';

  var state = {
    connected: false,
    registered: false,
    nick: '',
    channel: null, // { name, topic, names: [{nick, op, voice, me}] }
    retry: 0,
    soundOn: false,
    lastPing: 0,
    pingTimer: null,
  };

  // ---------------------------------------------------------------------
  // utilidades

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function timestamp(when) {
    var d = when || new Date();
    var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
    if (!when) return hm;
    // mensagens de outro dia mostram a data também (histórico)
    var today = new Date();
    if (d.getDate() === today.getDate() && d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear()) {
      return hm;
    }
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + ' ' + hm;
  }

  function guestNick() {
    return 'guest' + String(Math.floor(1000 + Math.random() * 9000));
  }

  function beep(kind) {
    if (!state.soundOn) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = beep.ctx || (beep.ctx = new Ctx());
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = kind === 'out' ? 320 : kind === 'msg' ? 880 : 660;
      g.gain.value = 0.04;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + (kind === 'msg' ? 0.05 : 0.12));
    } catch (e) {
      /* sem áudio, paciência */
    }
  }

  // ---------------------------------------------------------------------
  // buffer de texto

  function line(html, cls) {
    var d = document.createElement('div');
    if (cls) d.className = cls;
    d.innerHTML = '<span class="timestamp">[' + timestamp() + '] </span>' + html;
    var atBottom = els.text.scrollTop + els.text.clientHeight >= els.text.scrollHeight - 24;
    els.text.appendChild(d);
    while (els.text.childNodes.length > 400) els.text.removeChild(els.text.firstChild);
    if (atBottom) els.text.scrollTop = els.text.scrollHeight;
  }

  function sys(text) {
    line('<span class="sys">' + esc(text) + '</span>');
  }

  function err(text) {
    line('<span class="error">' + esc(text) + '</span>');
  }

  // ---------------------------------------------------------------------
  // lista de nicks

  function renderNicks() {
    els.nicks.innerHTML = '';
    var ch = state.channel;
    if (!ch) {
      var empty = document.createElement('div');
      empty.style.color = '#9a9a9a';
      empty.style.fontSize = '10px';
      empty.textContent = '(não estás em nenhum canal)';
      els.nicks.appendChild(empty);
      return;
    }
    var names = ch.names.slice().sort(function (a, b) {
      var ra = a.op ? 0 : a.voice ? 1 : 2;
      var rb = b.op ? 0 : b.voice ? 1 : 2;
      if (ra !== rb) return ra - rb;
      return a.nick.toLowerCase().localeCompare(b.nick.toLowerCase());
    });
    var header = document.createElement('div');
    header.style.color = '#808080';
    header.style.fontSize = '10px';
    var people = names.filter(function (n) {
      return n.nick !== BOT_NICK;
    });
    header.textContent = people.length + (people.length === 1 ? ' pessoa' : ' pessoas') + ' aqui';
    els.nicks.appendChild(header);
    // contador global (pessoas na página = pessoas no canal, entra automático)
    els.online.textContent = people.length;
    syncMenu(people.length, people.map(function (n) { return n.nick; }));
    names.forEach(function (n) {
      var d = document.createElement('div');
      d.textContent = (n.op ? '@' : n.voice ? '+' : '') + n.nick;
      if (n.op) d.className = 'op';
      else if (n.voice) d.className = 'voice';
      if (n.me) d.className += ' me';
      d.title = n.nick + (n.op ? ' (operador)' : n.voice ? ' (voice)' : '');
      d.ondblclick = function () {
        var v = els.input.value;
        els.input.value = v && !/\s$/.test(v) ? v + ' ' + n.nick : v + n.nick;
        els.input.focus();
      };
      els.nicks.appendChild(d);
    });
  }

  function upsertName(nick, flags) {
    var ch = state.channel;
    if (!ch) return;
    var found = null;
    for (var i = 0; i < ch.names.length; i++) {
      if (ch.names[i].nick.toLowerCase() === nick.toLowerCase()) {
        found = ch.names[i];
        break;
      }
    }
    if (!found) {
      found = { nick: nick, op: false, voice: false, me: false };
      ch.names.push(found);
    }
    if (flags) {
      if (flags.op !== undefined) found.op = flags.op;
      if (flags.voice !== undefined) found.voice = flags.voice;
    }
    found.me = nick.toLowerCase() === state.nick.toLowerCase();
  }

  function removeName(nick) {
    var ch = state.channel;
    if (!ch) return;
    ch.names = ch.names.filter(function (n) {
      return n.nick.toLowerCase() !== nick.toLowerCase();
    });
  }

  function renameName(from, to) {
    var ch = state.channel;
    if (!ch) return;
    for (var i = 0; i < ch.names.length; i++) {
      if (ch.names[i].nick.toLowerCase() === from.toLowerCase()) {
        ch.names[i].nick = to;
        ch.names[i].me = to.toLowerCase() === state.nick.toLowerCase();
      }
    }
  }

  // ---------------------------------------------------------------------
  // estado

  function updateStatus() {
    var ch = state.channel;
    els.chanCount.textContent = ch ? ch.name + ': ' + ch.names.length : 'sem canal';
    els.title.textContent =
      'mIRC — ' + (ch ? ch.name : 'Status') + ' — PTnet';
    els.nickInput.value = state.nick || '';
  }

  function setOnlineStatus(text, ok) {
    els.netStatus.textContent = text;
    els.netDot.className = 'online-dot' + (ok ? '' : ' off');
  }

  // ---------------------------------------------------------------------
  // transporte: WebSocket do nosso servidor (local) ou P2P (GitHub Pages)
  //
  // No GitHub Pages não há servidor — o primeiro visitante a abrir a página
  // torna-se anfitrião e corre o servidor IRC embebido (js/irc-core.js);
  // os restantes ligam-se directamente por WebRTC data channels (PeerJS).

  var transport = { kind: null, send: function () {} };
  var PEER_ROOM = 'janta12-guimaraes-ptnet';
  // registo de diagnóstico (window.__p2pLog)
  function plog(msg) {
    (window.__p2pLog ||= []).push(new Date().toISOString().slice(11, 19) + ' ' + msg);
  }

  function sendRaw(raw) {
    transport.send(raw);
  }

  function onTransportData(data) {
    String(data)
      .split('\n')
      .forEach(function (l) {
        if (l.trim()) handleLine(l.trim());
      });
  }

  function registerWithServer() {
    state.connected = true;
    state.retry = 0;
    state.nick = guestNick();
    transport.send('NICK ' + state.nick);
    transport.send('USER web 0 * :Web User');
    startPing();
  }

  // -- 1) tenta o WebSocket do nosso servidor ------------------------------

  function tryWS() {
    setOnlineStatus('a ligar...', false);
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) {}
      startP2P();
    }, 2500);
    var ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (e) {
      clearTimeout(timer);
      startP2P();
      return;
    }
    ws.onopen = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.kind = 'ws';
      transport.send = function (l) {
        if (ws.readyState === 1) ws.send(l);
      };
      ws.onmessage = function (ev) {
        onTransportData(ev.data);
      };
      ws.onclose = function () {
        state.connected = false;
        state.registered = false;
        stopPing();
        setOnlineStatus('desligado — a reconectar...', false);
        setTimeout(tryWS, 1500);
      };
      registerWithServer();
    };
    ws.onclose = function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      startP2P();
    };
    ws.onerror = function () {};
  }

  // -- 2) modo P2P -----------------------------------------------------------

  function loadPeerJS(cb) {
    if (window.Peer) return cb();
    var s = document.createElement('script');
    s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    s.onload = cb;
    s.onerror = function () {
      err('*** N&atilde;o foi poss&iacute;vel carregar o m&oacute;dulo P2P. Sem chat por agora.');
    };
    document.head.appendChild(s);
  }

  function startP2P() {
    loadPeerJS(function () {
      if (!window.Peer) return;
      setOnlineStatus('a ligar (p2p)...', false);
      tryHost();
    });
  }

  function makeWsLike() {
    return {
      readyState: 1,
      _l: {},
      on: function (ev, fn) {
        (this._l[ev] ||= []).push(fn);
      },
      emit: function (ev, d) {
        (this._l[ev] || []).forEach(function (f) {
          f(d);
        });
      },
      send: function () {},
      close: function () {
        this.readyState = 3;
      },
    };
  }

  function tryHost() {
    plog('tryHost: a tentar ser anfitrião');
    var peer = new Peer(PEER_ROOM, { debug: 0 });
    var settled = false;
    peer.on('open', function () {
      if (settled) return;
      settled = true;
      plog('tryHost: sou o anfitrião');
      becomeHost(peer);
    });
    peer.on('error', function (e) {
      if (settled) return;
      settled = true;
      plog('tryHost: erro ' + (e && e.type));
      try { peer.destroy(); } catch (e2) {}
      if (e && e.type === 'unavailable-id') {
        becomeClient(); // já há anfitrião — liga-te a ele
      } else {
        setTimeout(startP2P, 3000); // signaling indisponível — tenta de novo
      }
    });
  }

  function becomeHost(peer) {
    transport.kind = 'p2p-host';
    plog('becomeHost: servidor IRC embebido a arrancar');
    var irc = new window.IRCCore.IRCServer();

    // o meu próprio cliente liga por loopback ao servidor embebido
    var a = makeWsLike(); // lado do servidor
    var b = makeWsLike(); // lado do cliente
    a.send = function (d) {
      setTimeout(function () {
        b.emit('message', d);
      }, 0);
    };
    b.send = function (d) {
      setTimeout(function () {
        a.emit('message', d);
      }, 0);
    };
    irc.addConnection(a);
    // o meu cliente recebe as linhas do servidor embebido pelo loopback
    b.on('message', function (d) {
      onTransportData(d);
    });
    transport.send = function (l) {
      b.send(l);
    };

    // outros visitantes ligam-se por data channel
    peer.on('connection', function (conn) {
      plog('becomeHost: alguém se está a ligar');
      var ws = makeWsLike();
      ws.send = function (d) {
        try { conn.send(String(d)); } catch (e) {}
      };
      ws.close = function () {
        ws.readyState = 3;
        try { conn.close(); } catch (e) {}
      };
      // só integra no servidor IRC quando o canal está de facto aberto
      // (enviar antes do 'open' quebra a negociação WebRTC)
      conn.on('open', function () {
        plog('becomeHost: canal aberto');
        irc.addConnection(ws);
      });
      conn.on('data', function (d) {
        ws.emit('message', String(d));
      });
      conn.on('close', function () {
        ws.emit('close');
      });
      conn.on('error', function () {
        ws.emit('close');
      });
    });
    peer.on('disconnected', function () {
      plog('becomeHost: signaling caiu — a religar');
      try { peer.reconnect(); } catch (e) {}
    });
    peer.on('error', function (e) {
      plog('becomeHost: erro do peer ' + (e && e.type));
    });

    sys('*** [modo p2p] és o anfitri&atilde;o do canal. Se sa&iacute;res, outro visitante toma o lugar.');
    registerWithServer();
  }

  function becomeClient() {
    plog('becomeClient: a ligar ao anfitrião');
    var peer = new Peer({ debug: 0 });
    peer.on('open', function () {
      plog('becomeClient: peer aberto, a conectar');
      var conn = peer.connect(PEER_ROOM, { reliable: true });
      var opened = false;
      conn.on('open', function () {
        opened = true;
        plog('becomeClient: data channel aberto');
        transport.kind = 'p2p-client';
        transport.send = function (l) {
          try { conn.send(l); } catch (e) {}
        };
        registerWithServer();
      });
      conn.on('data', function (d) {
        onTransportData(d);
      });
      conn.on('close', function () {
        plog('becomeClient: canal fechado');
        state.connected = false;
        state.registered = false;
        stopPing();
        setOnlineStatus('anfitri&atilde;o saiu — a reconectar...', false);
        try { peer.destroy(); } catch (e) {}
        // tenta de novo: alguém (talvez tu) assume o lugar de anfitrião
        setTimeout(startP2P, 1200 + Math.floor(Math.random() * 1800));
      });
      conn.on('error', function (e) {
        plog('becomeClient: erro no canal ' + (e && e.type));
      });
      setTimeout(function () {
        if (!opened) {
          plog('becomeClient: timeout do canal');
          try { peer.destroy(); } catch (e) {}
          startP2P();
        }
      }, 8000);
    });
    peer.on('error', function (e) {
      plog('becomeClient: erro do peer ' + (e && e.type));
      if (e && e.type === 'peer-unavailable') {
        try { peer.destroy(); } catch (e2) {}
        setTimeout(startP2P, 800); // o anfitrião desapareceu — tenta ser tu
      }
    });
  }

  function startPing() {
    stopPing();
    state.pingTimer = setInterval(function () {
      state.lastPing = Date.now();
      sendRaw('PING ' + state.lastPing);
    }, 5000);
  }

  function stopPing() {
    if (state.pingTimer) clearInterval(state.pingTimer);
    state.pingTimer = null;
  }

  // ---------------------------------------------------------------------
  // sugestões depois do MOTD

  function showHelp() {
    line('<span class="sys">*** Est&aacute;s ligado &agrave; PTnet como <b>' + esc(state.nick) + '</b>.</span>');
    line('<span class="sys">*** Sugest&atilde;o: muda o teu nick com <b>/nick oTeuNick</b></span>');
    line('<span class="sys">*** Depois entra no canal da janta com <b>/join #guimaraes</b></span>');
    line('<span class="sys">*** Comandos: /join /part /nick /me /msg /topic /whois /names /list /clear /quit</span>');
    line('<span class="sys">*** Comandos do bot: !slap &lt;nick&gt; &nbsp;!op &lt;nick&gt; &nbsp;!voice &lt;nick&gt; &nbsp;!jantar &nbsp;!help</span>');
  }

  // ---------------------------------------------------------------------
  // protocolo

  function handleLine(raw) {
    // tags IRCv3 (@time=...) — usadas no replay do histórico
    var when = null;
    if (raw.charAt(0) === '@') {
      var tagSp = raw.indexOf(' ');
      var tags = raw.slice(1, tagSp);
      raw = raw.slice(tagSp + 1);
      var tm = tags.match(/time=([^;\s]+)/);
      if (tm) {
        var d = new Date(tm[1]);
        if (!isNaN(d.getTime())) when = d;
      }
    }
    var prefix = null;
    var rest = raw;
    if (rest.charAt(0) === ':') {
      var sp = rest.indexOf(' ');
      prefix = rest.slice(1, sp);
      rest = rest.slice(sp + 1);
    }
    var params = [];
    while (rest.length) {
      if (rest.charAt(0) === ':') {
        params.push(rest.slice(1));
        break;
      }
      var i = rest.indexOf(' ');
      if (i === -1) {
        params.push(rest);
        break;
      }
      params.push(rest.slice(0, i));
      rest = rest.slice(i + 1).replace(/^ +/, '');
    }
    var cmd = (params.shift() || '').toUpperCase();
    var nick = prefix ? prefix.split('!')[0] : '';
    var userhost = prefix ? (prefix.split('!')[1] || '') : '';
    var tail = params[params.length - 1] || '';

    switch (cmd) {
      case 'PONG':
        var sent = Number(params[1]);
        if (sent) {
          els.lag.textContent = 'Lag: ' + Math.max(1, Date.now() - sent) + 'ms';
        }
        break;

      // ---- sequência de ligação PTnet ----
      case 'NOTICE':
        line('<span class="sys">-' + esc(nick || 'PTnet') + '- ' + esc(tail) + '</span>');
        break;

      case '001':
        state.registered = true;
        state.nick = params[0];
        setOnlineStatus('ligado', true);
        line('<span class="motd">' + esc(tail) + '</span>');
        updateStatus();
        renderNicks();
        // entra logo no canal da janta
        sendRaw('JOIN ' + CHANNEL);
        break;

      case '002':
      case '003':
      case '004':
      case '251':
      case '252':
      case '254':
      case '255':
      case '265':
      case '266':
        line('<span class="motd">' + esc(tail) + '</span>');
        break;

      case '005':
        line('<span class="motd">' + esc(params.join(' ')) + '</span>');
        break;

      case '375':
        line('<span class="motd">' + esc(tail) + '</span>');
        break;

      case '372':
        line('<span class="motd">' + esc(tail.replace(/^- /, '')) + '</span>');
        break;

      case '376':
        line('<span class="motd">' + esc(tail) + '</span>');
        showHelp();
        break;

      case 'MODE':
        var modeTarget = params[0];
        if (modeTarget.toLowerCase() === state.nick.toLowerCase()) {
          line('<span class="sys">*** Modos de utilizador: ' + esc(params.slice(1).join(' ')) + '</span>');
        } else if (state.channel && modeTarget.toLowerCase() === state.channel.name.toLowerCase()) {
          // aplica +o/+v/-o/-v à lista de nicks
          var modes = params[1] || '';
          var modeArgs = params.slice(2);
          var sign = '+';
          var argIdx = 0;
          for (var mi = 0; mi < modes.length; mi++) {
            var mc = modes.charAt(mi);
            if (mc === '+' || mc === '-') {
              sign = mc;
            } else if (mc === 'o' || mc === 'v') {
              var who = modeArgs[argIdx++];
              if (who) {
                upsertName(who, mc === 'o' ? { op: sign === '+' } : { voice: sign === '+' });
                line(
                  '<span class="sys">*** ' + esc(nick) + ' ' +
                  (sign === '+' ? 'd&aacute;' : 'retira') + ' ' +
                  (mc === 'o' ? 'op (@)' : 'voice (+)') + ' a ' + esc(who) + '</span>'
                );
              }
            }
          }
          renderNicks();
        }
        break;

      // ---- canal ----
      case 'JOIN':
        var isMe = nick.toLowerCase() === state.nick.toLowerCase();
        if (isMe) {
          state.channel = { name: params[0], topic: '', names: [], unread: 0 };
          line('<span class="sys">*** Agora falas em ' + esc(params[0]) + '</span>');
        } else {
          upsertName(nick);
          line(
            '<span class="sys">*** ' + esc(nick) + ' (' + esc(userhost) + ') entrou no canal ' + esc(params[0]) + '</span>',
            null,
            when
          );
          beep('join');
        }
        renderNicks();
        updateStatus();
        break;

      case '332':
        if (state.channel) {
          state.channel.topic = tail;
          line('<span class="sys">*** O t&oacute;pico de ' + esc(params[1]) + ' &eacute;: ' + esc(tail) + '</span>');
        }
        break;

      case '333':
        break;

      case '353':
        if (state.channel) {
          tail.split(' ').filter(Boolean).forEach(function (n) {
            var op = n.charAt(0) === '@';
            var voice = n.charAt(0) === '+';
            var clean = op || voice ? n.slice(1) : n;
            upsertName(clean, { op: op, voice: voice });
          });
          renderNicks();
          updateStatus();
        }
        break;

      case '366':
        break;

      case 'PART':
      case 'QUIT':
        if (nick.toLowerCase() === state.nick.toLowerCase()) {
          if (cmd === 'PART') line('<span class="sys">*** Sa&iacute;ste do canal ' + esc(params[0]) + '</span>');
          state.channel = null;
        } else if (state.channel) {
          removeName(nick);
          if (cmd === 'PART') {
            line(
              '<span class="sys">*** ' + esc(nick) + ' (' + esc(userhost) + ') saiu do canal ' + esc(params[0]) +
              (params[1] ? ' (' + esc(params[1]) + ')' : '') + '</span>',
              null,
              when
            );
          } else {
            line(
              '<span class="sys">*** ' + esc(nick) + ' (' + esc(userhost) + ') saiu da PTnet' +
              (tail ? ' (' + esc(tail) + ')' : '') + '</span>',
              null,
              when
            );
          }
          beep('out');
        }
        renderNicks();
        updateStatus();
        break;

      case 'NICK':
        var newNick = params[0];
        var nickIsMe = nick.toLowerCase() === state.nick.toLowerCase();
        if (nickIsMe) state.nick = newNick;
        // actualiza a entrada na lista de nicks (a tua e a dos outros)
        renameName(nick, newNick);
        if (nickIsMe) {
          line('<span class="sys">*** Agora &eacute;s conhecido como ' + esc(newNick) + '</span>');
        } else {
          line('<span class="sys">*** ' + esc(nick) + ' agora chama-se ' + esc(newNick) + '</span>', null, when);
        }
        renderNicks();
        updateStatus();
        break;

      case 'PRIVMSG':
        var target = params[0];
        var msg = params[1] || '';
        var isAction = msg.charAt(0) === '\x01' && msg.slice(1, 7) === 'ACTION';
        if (isAction) {
          var act = msg.slice(7).replace(/\x01$/, '').trim();
          line('<span class="action">* ' + esc(nick) + ' ' + esc(act) + '</span>', null, when);
        } else {
          var cls = nick === BOT_NICK ? 'bot' : '';
          line('<span class="nick">' + esc(nick) + '</span>: ' + esc(msg), cls, when);
        }
        if (nick.toLowerCase() !== state.nick.toLowerCase() && !when) beep('msg');
        break;

      case 'TOPIC':
        if (state.channel) {
          state.channel.topic = params[1] || '';
          line('<span class="sys">*** ' + esc(nick) + ' mudou o t&oacute;pico: ' + esc(params[1] || '') + '</span>');
        }
        break;

      // ---- queries de informação ----
      case '352':
        line('<span class="whois">' + esc(params.slice(1).join(' ')) + '</span>');
        break;

      case '311':
      case '312':
      case '319':
      case '315':
      case '318':
      case '321':
      case '322':
      case '323':
        line('<span class="whois">' + esc(params.slice(1).join(' ')) + '</span>');
        break;

      case '401':
      case '403':
      case '404':
      case '421':
      case '432':
      case '433':
      case '451':
        err('*** ' + params.slice(1).join(' '));
        break;

      default:
        break;
    }
  }

  // ---------------------------------------------------------------------
  // entrada

  function submit() {
    var value = els.input.value.trim();
    if (!value) return;
    els.input.value = '';
    els.input._histPos = undefined;

    var hist = (els.input._hist ||= []);
    hist.push(value);
    if (hist.length > 50) hist.shift();

    if (value.charAt(0) === '/') {
      runCommand(value.slice(1));
      return;
    }
    if (!state.channel) {
      err('*** N&atilde;o est&aacute;s em nenhum canal. Entra com /join ' + CHANNEL);
      return;
    }
    sendRaw('PRIVMSG ' + state.channel.name + ' :' + value);
  }

  function runCommand(cmdline) {
    var parts = cmdline.split(/\s+/);
    var cmd = parts.shift().toLowerCase();
    var arg = parts.join(' ');
    var ch = state.channel ? state.channel.name : CHANNEL;

    switch (cmd) {
      case 'join':
        if (!arg) return sys('*** Uso: /join #canal');
        sendRaw('JOIN ' + arg);
        break;
      case 'part':
        sendRaw('PART ' + (arg || ch));
        break;
      case 'nick':
        if (!arg) return sys('*** Uso: /nick novoNick');
        sendRaw('NICK ' + arg);
        break;
      case 'me':
        if (!arg) return sys('*** Uso: /me acção');
        if (!state.channel) return err('*** N&atilde;o est&aacute;s em nenhum canal.');
        sendRaw('PRIVMSG ' + ch + ' :\x01ACTION ' + arg + '\x01');
        break;
      case 'msg':
        var m = arg.match(/^(\S+)\s+(.+)$/);
        if (!m) return sys('*** Uso: /msg <nick> <mensagem>');
        sendRaw('PRIVMSG ' + m[1] + ' :' + m[2]);
        break;
      case 'names':
        sendRaw('NAMES ' + (arg || ch));
        break;
      case 'who':
        sendRaw('WHO ' + (arg || ch));
        break;
      case 'whois':
        if (!arg) return sys('*** Uso: /whois <nick>');
        sendRaw('WHOIS ' + arg);
        break;
      case 'list':
        sendRaw('LIST');
        break;
      case 'topic':
        if (!state.channel) return err('*** N&atilde;o est&aacute;s em nenhum canal.');
        sendRaw('TOPIC ' + ch + (arg ? ' :' + arg : ''));
        break;
      case 'quit':
      case 'exit':
        sendRaw('QUIT :' + (arg || 'Saiu do mIRC'));
        break;
      case 'clear':
        els.text.innerHTML = '';
        break;
      case 'away':
        sys('*** N&atilde;o h&aacute; away. Est&aacute;s sempre aqui.');
        break;
      case 'help':
        sys('*** Comandos: /join #canal  /part  /nick <nick>  /me <ac&ccedil;&atilde;o>  /msg <nick> <msg>');
        sys('*** /names  /who  /whois <nick>  /list  /topic [texto]  /clear  /quit');
        sys('*** Bot: !slap <nick>  !op <nick>  !voice <nick>  !jantar  !lag  !help');
        break;
      case 'slap':
      case 'op':
      case 'voice':
        if (!state.channel) return err('*** N&atilde;o est&aacute;s em nenhum canal.');
        sendRaw('PRIVMSG ' + ch + ' :!' + cmd + (arg ? ' ' + arg : ''));
        break;
      default:
        err('*** Comando desconhecido: /' + cmd + '  (escreve /help)');
    }
  }

  // ---------------------------------------------------------------------
  // UI

  els.input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'ArrowUp') {
      var hist = (els.input._hist ||= []);
      if (!hist.length) return;
      e.preventDefault();
      els.input._histPos = els.input._histPos === undefined ? hist.length - 1 : Math.max(0, els.input._histPos - 1);
      els.input.value = hist[els.input._histPos] || '';
    }
  });

  els.send.addEventListener('click', submit);

  els.nickInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var n = els.nickInput.value.trim();
      if (n) sendRaw('NICK ' + n);
      els.input.focus();
    }
  });
  els.nickInput.addEventListener('blur', function () {
    els.nickInput.value = state.nick;
  });

  document.querySelectorAll('[data-cmd]').forEach(function (el) {
    el.addEventListener('click', function () {
      var cmd = el.getAttribute('data-cmd');
      if (cmd.charAt(0) === '/') {
        runCommand(cmd.slice(1));
        return;
      }
      els.input.value = cmd + (cmd === '!help' || cmd === '!jantar' || cmd === '!lag' ? '' : ' ');
      els.input.focus();
    });
  });

  els.sound.addEventListener('click', function () {
    state.soundOn = !state.soundOn;
    els.sound.classList.toggle('on', state.soundOn);
    els.sound.textContent = state.soundOn ? '\u266A som ON' : '\u266A som';
  });

  // mostrar/esconder a lista de nicks (útil em mobile)
  var nickToggle = $('mirc-nicktoggle');
  if (nickToggle) {
    nickToggle.addEventListener('click', function () {
      els.mirc.classList.toggle('show-nicks');
    });
  }

  // fullscreen em mobile: tocar na janela (ou no botão maximizar) abre o chat
  // em ecrã inteiro, com o input sempre visível acima do teclado
  var isMobile = function () {
    return window.matchMedia('(max-width: 720px)').matches;
  };
  var fsOpen = false;

  function toggleFs(force) {
    var want = force !== undefined ? force : !fsOpen;
    if (want === fsOpen) return;
    fsOpen = want;
    els.mirc.classList.toggle('fs', fsOpen);
    document.body.classList.toggle('fs-open', fsOpen);
    if (fsOpen) {
      els.text.scrollTop = els.text.scrollHeight;
      setTimeout(function () {
        els.input.focus();
      }, 80);
    }
  }

  var maxBtn = $('mirc-max');
  if (maxBtn) {
    maxBtn.addEventListener('click', function () {
      toggleFs();
    });
  }

  var titlebar = $('mirc-titlebar');
  if (titlebar) {
    titlebar.addEventListener('click', function (e) {
      if (!isMobile()) return;
      if (e.target.closest('button')) return; // os botões tratam-se a si próprios
      toggleFs();
    });
  }

  $('mirc-close').addEventListener('click', function () {
    if (fsOpen) {
      toggleFs(false);
      return;
    }
    sys('*** O mIRC fica aberto. Algu&eacute;m tem de tomar conta do canal.');
  });

  $('mirc-min').addEventListener('click', function () {
    els.mirc.classList.toggle('hidden-body');
  });

  // sincroniza o contador e nicks com o menu lateral (iframe, mesma origem)
  function syncMenu(count, nicks) {
    try {
      var f = document.querySelector('.menu-col iframe');
      var doc = f && f.contentDocument;
      if (!doc || !doc.body) return;
      var o = doc.getElementById('menu-online');
      if (o) {
        var s = String(Math.max(0, count | 0));
        while (s.length < 3) s = '0' + s;
        if (o.dataset.v !== s) {
          o.dataset.v = s;
          o.innerHTML = s.split('').map(function (d) { return '<i>' + d + '</i>'; }).join('');
        }
      }
      var n = doc.getElementById('menu-nicks');
      if (n) {
        n.innerHTML = nicks.length
          ? nicks.map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('')
          : '<em>(ningu&eacute;m no canal)</em>';
      }
    } catch (e) {
      /* iframe de outra origem — ignora */
    }
  }

  // ---------------------------------------------------------------------
  // arranque

  tryWS();

  window.__mirc = { state: state, sendRaw: sendRaw };
})();
