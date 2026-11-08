/*
 * N&uacute;cleo do servidor IRC da 12&ordf; Janta do #guimaraes &mdash; isom&oacute;rfico.
 * Corre em Node (server/index.js) e no browser (modo P2P do GitHub Pages):
 * o mesmo c&oacute;digo, o mesmo protocolo, o mesmo @BotDoJantar.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IRCCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
// Tiny IRC-ish server speaking the classic RFC1459 subset over WebSockets.
// Enough to make an mIRC 5.x client feel at home: NICK/USER/JOIN/PART/PRIVMSG/
// NOTICE/WHO/NAMES/MODE/TOPIC/PING/QUIT + a few fun bot commands.


const CHANNELS = {
  '#guimaraes': {
    topic: 'bem vindo ao #guimaraes - 12a janta 2026',
  },
};

const BOT_NICK = 'BotDoJantar';
const SERVER_NAME = 'vimeu.ptnet.org';
const BOT_HOST = SERVER_NAME;
const NETWORK = 'PTnet';
const MAX_NICK = 16;
const MAX_LINE = 450;

// ---------------------------------------------------------------------------
// helpers

function sanitizeNick(nick) {
  return String(nick || '').replace(/[^A-Za-z0-9_\-\[\]\\`^{}|]/g, '').slice(0, MAX_NICK);
}

function validNick(nick) {
  return /^[A-Za-z_\[\]\\`^{}|][A-Za-z0-9_\-\[\]\\`^{}|]*$/.test(nick) && nick.length <= MAX_NICK;
}

function cleanText(text) {
  return String(text || '')
    .replace(/[\r\n\0]/g, ' ')
    .replace(/\x01/g, '')
    .slice(0, MAX_LINE);
}

function now() {
  return Date.now();
}

function randomId() {
  // funciona em Node e no browser
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    var a = new Uint8Array(8);
    crypto.getRandomValues(a);
    var s = '';
    for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    return s;
  }
  return String(Math.random()).slice(2) + String(Math.random()).slice(2);
}

// ---------------------------------------------------------------------------
// Server

class IRCServer {
  constructor(opts) {
    opts = opts || {};
    this.clients = new Set();
    this.msgCount = 0;
    this.startedAt = now();
    // modos por canal: '#guimaraes' -> Map<nickLower, {op, voice}>
    this.channelModes = new Map();
    // histórico por canal: '#guimaraes' -> [{ts, nick, kind, text}]
    this.history = new Map();
    // quantas linhas se guardam (as últimas) e quantas se mostram a quem entra
    this.historyLimit = opts.historyLimit || 500;
    this.replayLimit = opts.replayLimit || 50;
    // store opcional para persistir: { load() -> Promise<Map>, append(key, entry) }
    this.store = opts.store || null;
    this.ready = this.store
      ? Promise.resolve(this.store.load()).then(
          (loaded) => {
            if (loaded && loaded.forEach) {
              loaded.forEach((entries, key) => {
                if (Array.isArray(entries) && entries.length) this.history.set(key, entries.slice(-this.historyLimit));
              });
            }
          },
          () => {}
        )
      : Promise.resolve();
  }

  // -- modos de canal ---------------------------------------------------------

  modesOf(key, nick) {
    if (!this.channelModes.has(key)) this.channelModes.set(key, new Map());
    const m = this.channelModes.get(key);
    const k = String(nick).toLowerCase();
    if (!m.has(k)) m.set(k, { op: false, voice: false });
    return m.get(k);
  }

  dropModes(key, nick) {
    const m = this.channelModes.get(key);
    if (m) m.delete(String(nick).toLowerCase());
  }

  moveModes(key, from, to) {
    const m = this.channelModes.get(key);
    if (!m) return;
    const fk = String(from).toLowerCase();
    if (m.has(fk)) {
      const v = m.get(fk);
      m.delete(fk);
      m.set(String(to).toLowerCase(), v);
    }
  }

  // aplica +o/+v/-o/-v e anuncia a toda a gente (como um ircd real)
  applyMode(channel, prefix, sign, letter, nick) {
    const key = String(channel).toLowerCase();
    const st = this.modesOf(key, nick);
    if (letter === 'o') st.op = sign === '+';
    if (letter === 'v') st.voice = sign === '+';
    this.toChannel(key, `:${prefix} MODE ${channel} ${sign}${letter} ${nick}`);
  }

  // -- histórico -------------------------------------------------------------

  record(key, entry) {
    if (!this.history.has(key)) this.history.set(key, []);
    const h = this.history.get(key);
    h.push(entry);
    if (h.length > this.historyLimit) h.splice(0, h.length - this.historyLimit);
    // persiste (sem bloquear o envio das mensagens)
    if (this.store) {
      try {
        this.store.append(key, entry);
      } catch (e) {
        /* a persistência nunca pode partir o chat */
      }
    }
  }

  // -- connection lifecycle -------------------------------------------------

  addConnection(ws) {
    const client = {
      id: randomId(),
      ws,
      nick: null,
      user: '~web',
      realname: '',
      host: 'dialup-ptnet',
      channels: new Set(),
      modes: new Set(), // global user modes, e.g. 'i'
      registered: false,
      lastMsg: 0,
      msgWindow: [],
      alive: true,
    };
    this.clients.add(client);

    ws.on('message', (data) => {
      try {
        if (typeof process !== 'undefined' && process.env && process.env.IRC_DEBUG) console.error('[recv]', JSON.stringify(String(data)));
        this.handleRaw(client, String(data));
      } catch (err) {
        console.error('[irc] handler error:', err);
      }
    });
    ws.on('close', () => this.quit(client, 'Quit'));
    ws.on('error', () => this.quit(client, 'Quit'));

    // Sequência de ligação ao estilo PTnet (capturada do servidor real).
    this.send(client, `:${SERVER_NAME} NOTICE * :*** Looking up your hostname`);
    this.send(client, `:${SERVER_NAME} NOTICE * :*** Checking Ident`);
    this.send(client, `:${SERVER_NAME} NOTICE * :*** Found your hostname`);
    this.send(client, `:${SERVER_NAME} NOTICE * :*** No Ident response`);
    return client;
  }

  // -- low level send -------------------------------------------------------

  send(client, line) {
    if (!client.alive) return;
    try {
      client.ws.send(line);
    } catch {
      /* socket already gone */
    }
  }

  toChannel(channel, line, except) {
    for (const c of this.clients) {
      if (c !== except && c.channels.has(channel)) this.send(c, line);
    }
  }

  members(channel) {
    return [...this.clients].filter((c) => c.channels.has(channel) && c.registered);
  }

  findNick(nick) {
    const lower = String(nick).toLowerCase();
    return [...this.clients].find((c) => c.nick && c.nick.toLowerCase() === lower) || null;
  }

  prefix(client) {
    return `${client.nick}!${client.user}@${client.host}`;
  }

  // -- parsing --------------------------------------------------------------

  handleRaw(client, raw) {
    raw = raw.trim();
    if (!raw) return;

    // Minimal IRC parsing: optional prefix, command, params, trailing param.
    let rest = raw;
    const params = [];
    if (rest.startsWith(':')) {
      const sp = rest.indexOf(' ');
      rest = sp === -1 ? '' : rest.slice(sp + 1).trim();
    }
    while (rest.length) {
      if (rest.startsWith(':')) {
        params.push(rest.slice(1));
        break;
      }
      const sp = rest.indexOf(' ');
      if (sp === -1) {
        params.push(rest);
        break;
      }
      params.push(rest.slice(0, sp));
      rest = rest.slice(sp + 1).trim();
    }
    const cmd = (params.shift() || '').toUpperCase();
    if (!cmd) return;

    if (!client.registered && !['NICK', 'USER', 'PASS', 'PING', 'QUIT', 'CAP', 'WEBIRC', 'JOIN'].includes(cmd)) {
      this.send(client, `:${SERVER_NAME} 451 * :You have not registered`);
      return;
    }

    switch (cmd) {
      case 'CAP':
        // We ignore capabilities; clients using CAP LS still get a sane answer.
        if (params[0] === 'LS') this.send(client, `:${SERVER_NAME} CAP * LS :`);
        else if (params[0] === 'REQ') this.send(client, `:${SERVER_NAME} CAP * NAK :${params[1] || ''}`);
        break;
      case 'NICK':
        this.setNick(client, params[0]);
        break;
      case 'USER':
        client.user = '~' + (String(params[0] || 'web').replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 12) || 'web');
        client.realname = params[3] || params[0] || 'web';
        this.tryRegister(client);
        break;
      case 'PING':
        this.send(client, `:${SERVER_NAME} PONG ${BOT_HOST} :${params[0] || ''}`);
        break;
      case 'JOIN':
        for (const ch of String(params[0] || '').split(',')) this.join(client, ch.trim());
        break;
      case 'PART':
        for (const ch of String(params[0] || '').split(',')) this.part(client, ch.trim(), params[1]);
        break;
      case 'PRIVMSG':
        this.privmsg(client, params[0], params[1]);
        break;
      case 'NOTICE':
        // Notices from clients are ignored (bots don't answer notices).
        break;
      case 'MODE':
        this.mode(client, params);
        break;
      case 'TOPIC':
        this.topic(client, params[0], params[1]);
        break;
      case 'NAMES':
        this.names(client, params[0]);
        break;
      case 'WHO':
        this.who(client, params[0]);
        break;
      case 'WHOIS':
        this.whois(client, params[0]);
        break;
      case 'LIST':
        this.list(client);
        break;
      case 'QUIT':
        this.quit(client, params[0] || 'Client Quit');
        break;
      default:
        this.send(client, `:${SERVER_NAME} 421 ${client.nick || '*'} ${cmd} :Unknown command`);
    }
  }

  // -- registration ---------------------------------------------------------

  setNick(client, requested) {
    const nick = sanitizeNick(requested);
    if (!nick || !validNick(nick)) {
      this.send(client, `:${SERVER_NAME} 432 ${client.nick || '*'} ${requested || ''} :Erroneous nickname`);
      return;
    }
    if (nick.toLowerCase() === BOT_NICK.toLowerCase()) {
      this.send(client, `:${SERVER_NAME} 433 ${client.nick || '*'} ${nick} :Nickname is already in use`);
      return;
    }
    const existing = this.findNick(nick);
    if (existing && existing !== client) {
      this.send(client, `:${SERVER_NAME} 433 ${client.nick || '*'} ${nick} :Nickname is already in use`);
      return;
    }
    const old = client.nick;
    client.nick = nick;
    if (old) {
      const line = `:${old}!${client.user}@${client.host} NICK :${nick}`;
      for (const c of this.clients) {
        if (c === client || c.channels.size === 0) continue;
        if ([...c.channels].some((ch) => client.channels.has(ch))) this.send(c, line);
      }
      this.send(client, line);
      // os modos @/+ acompanham o nick
      for (const key of Object.keys(CHANNELS)) this.moveModes(key, old, nick);
    }
    this.tryRegister(client);
  }

  tryRegister(client) {
    if (client.registered || !client.nick || !client.user) return;
    client.registered = true;
    const nick = client.nick;
    const prefix = this.prefix(client);
    const online = [...this.clients].filter((c) => c.registered).length;
    const maxSeen = Math.max(online, this.maxSeen || (this.maxSeen = online));
    this.maxSeen = Math.max(this.maxSeen, online);

    this.send(client, `:${SERVER_NAME} 001 ${nick} :Welcome to the ${NETWORK} Internet Relay Chat Network ${prefix}`);
    this.send(client, `:${SERVER_NAME} 002 ${nick} :Your host is ${SERVER_NAME}[0.0.0.0/6667], running version ptnet-2.0.3/hybrid-8.2.30`);
    this.send(client, `:${SERVER_NAME} 003 ${nick} :This server was created Dec 19 2026 at 20:00:00`);
    this.send(client, `:${SERVER_NAME} 004 ${nick} ${SERVER_NAME} ptnet-2.0.3/hybrid-8.2.30 DFGHXRSWabcdefijklnopqrsuwy bchiklmnoprstuveI bkloveI`);
    this.send(client, `:${SERVER_NAME} 005 ${nick} CASEMAPPING=ascii KICKLEN=180 MODES=6 PREFIX=(ov)@+ STATUSMSG=@+ NICKLEN=16 NETWORK=${NETWORK} MAXTARGETS=4 :are supported by this server`);
    this.send(client, `:${SERVER_NAME} 005 ${nick} CHANTYPES=# CHANLIMIT=#:30 CHANNELLEN=50 TOPICLEN=300 WATCH=50 KNOCK SAFELIST :are supported by this server`);
    this.send(client, `:${SERVER_NAME} 251 ${nick} :There are ${online} users and 0 invisible on 1 servers`);
    this.send(client, `:${SERVER_NAME} 252 ${nick} 0 :IRC Operators online`);
    this.send(client, `:${SERVER_NAME} 254 ${nick} ${Object.keys(CHANNELS).length} :channels formed`);
    this.send(client, `:${SERVER_NAME} 255 ${nick} :I have ${online} clients and 0 servers`);
    this.send(client, `:${SERVER_NAME} 265 ${nick} :Current local users: ${online}  Max: ${maxSeen}`);
    this.send(client, `:${SERVER_NAME} 266 ${nick} :Current global users: ${online}  Max: ${maxSeen}`);
    this.send(client, `:${SERVER_NAME} 375 ${nick} :- ${SERVER_NAME} Message of the Day - `);
    this.send(client, `:${SERVER_NAME} 372 ${nick} :-  Bem-vindo 'a ${NETWORK}!                      ${SERVER_NAME.toUpperCase()}`);
    this.send(client, `:${SERVER_NAME} 372 ${nick} :-  Homepage: https://www.PTnet.org/         IRC-Admin: megabytes`);
    this.send(client, `:${SERVER_NAME} 372 ${nick} :-  E-mail: suporte@PTnet.org`);
    this.send(client, `:${SERVER_NAME} 372 ${nick} :- `);
    this.send(client, `:${SERVER_NAME} 372 ${nick} :-  12.a JANTA DO #GUIMARAES`);
    this.send(client, `:${SERVER_NAME} 372 ${nick} :-  19 de Dezembro de 2026 - Restaurante O Pinguim, Guimaraes`);
    this.send(client, `:${SERVER_NAME} 372 ${nick} :- `);
    this.send(client, `:${SERVER_NAME} 372 ${nick} :-  O canal oficial da janta e' o #guimaraes. Para entrar:`);
    this.send(client, `:${SERVER_NAME} 372 ${nick} :-    /join #guimaraes`);
    this.send(client, `:${SERVER_NAME} 372 ${nick} :- `);
    this.send(client, `:${SERVER_NAME} 376 ${nick} :End of /MOTD command.`);
    this.send(client, `:${prefix} MODE ${nick} :+i`);
    this.send(client, `:NickServ!services@services.${SERVER_NAME.split('.').slice(1).join('.')} NOTICE ${nick} :Acesso a ${nick} autorizado por nao estar registado. Podes mudar de nick com /nick oTeuNick.`);
  }

  // -- channels -------------------------------------------------------------

  join(client, channel) {
    if (!channel) return;
    const key = channel.toLowerCase();
    if (!CHANNELS[key]) {
      this.send(client, `:${SERVER_NAME} 403 ${client.nick} ${channel} :No such channel`);
      return;
    }
    if (client.channels.has(key)) return;

    client.channels.add(key);
    this.toChannel(key, `:${this.prefix(client)} JOIN ${channel}`, client);
    this.send(client, `:${this.prefix(client)} JOIN ${channel}`);
    this.send(client, `:${SERVER_NAME} 332 ${client.nick} ${channel} :${CHANNELS[key].topic}`);
    this.send(client, `:${SERVER_NAME} 333 ${client.nick} ${channel} ${BOT_NICK}!bot@${BOT_HOST} ${Math.floor(this.startedAt / 1000)}`);
    this.send(client, `:${SERVER_NAME} MODE ${channel} +nt`);
    this.names(client, channel);

    // histórico real do canal (com timestamps, ao estilo IRCv3 server-time)
    const allHist = this.history.get(key) || [];
    const hist = allHist.slice(-this.replayLimit);
    if (hist.length) {
      const total = allHist.length;
      const older = total > hist.length ? ` (de ${total} guardadas)` : '';
      this.send(client, `:${SERVER_NAME} NOTICE ${client.nick} :*** Hist\u00f3rico do ${channel} \u2014 \u00faltimas ${hist.length} linha${hist.length === 1 ? '' : 's'}${older}`);
      for (const h of hist) {
        const tag = `@time=${new Date(h.ts).toISOString()}`;
        const uh = `${h.nick}!${h.user || '~web'}@${h.host || 'dialup-ptnet'}`;
        if (h.kind === 'action') {
          this.send(client, `${tag} :${h.nick}!hist@${BOT_HOST} PRIVMSG ${channel} :\u0001ACTION ${h.text}\u0001`);
        } else if (h.kind === 'join') {
          this.send(client, `${tag} :${uh} JOIN ${channel}`);
        } else if (h.kind === 'part') {
          this.send(client, `${tag} :${uh} PART ${channel}${h.text ? ' :' + h.text : ''}`);
        } else if (h.kind === 'quit') {
          this.send(client, `${tag} :${uh} QUIT :${h.text || 'Quit'}`);
        } else {
          this.send(client, `${tag} :${h.nick}!hist@${BOT_HOST} PRIVMSG ${channel} :${h.text}`);
        }
      }
      this.send(client, `:${SERVER_NAME} NOTICE ${client.nick} :*** Fim do hist\u00f3rico \u2014 mensagens novas a seguir`);
    }

    this.record(key, { ts: now(), nick: client.nick, user: client.user, host: client.host, kind: 'join', text: '' });
  }

  part(client, channel, reason) {
    const key = String(channel || '').toLowerCase();
    if (!client.channels.has(key)) return;
    client.channels.delete(key);
    this.dropModes(key, client.nick);
    const clean = reason ? cleanText(reason) : '';
    this.toChannel(key, `:${this.prefix(client)} PART ${channel}${clean ? ' :' + clean : ''}`);
    this.send(client, `:${this.prefix(client)} PART ${channel}${clean ? ' :' + clean : ''}`);
    this.record(key, { ts: now(), nick: client.nick, user: client.user, host: client.host, kind: 'part', text: clean });
  }

  quit(client, reason) {
    if (!client.alive) return;
    client.alive = false;
    const channels = [...client.channels];
    client.channels.clear();
    this.clients.delete(client);
    if (client.registered) {
      const clean = cleanText(reason || 'Client Quit');
      for (const ch of channels) {
        this.dropModes(ch, client.nick);
        this.toChannel(ch, `:${this.prefix(client)} QUIT :${clean}`);
        this.record(ch, { ts: now(), nick: client.nick, user: client.user, host: client.host, kind: 'quit', text: clean });
      }
    }
    try {
      client.ws.close();
    } catch {
      /* ignore */
    }
  }

  names(client, channel) {
    const key = String(channel || '').toLowerCase();
    if (!CHANNELS[key]) return;
    // prefixos @/+ vindos do estado real do canal (visíveis a todos, como no IRC)
    const list = this.members(key).map((c) => {
      const st = this.modesOf(key, c.nick);
      return (st.op ? '@' : st.voice ? '+' : '') + c.nick;
    });
    // o BotDoJantar é operador do canal — aparece com @ como manda a tradição.
    this.send(client, `:${SERVER_NAME} 353 ${client.nick} = ${channel} :@${BOT_NICK} ${list.join(' ')}`);
    this.send(client, `:${SERVER_NAME} 366 ${client.nick} ${channel} :End of /NAMES list.`);
  }

  who(client, channel) {
    const key = String(channel || '').toLowerCase();
    if (!CHANNELS[key]) return;
    for (const m of this.members(key)) {
      this.send(client, `:${SERVER_NAME} 352 ${client.nick} ${channel} ${m.user} ${m.host} ${BOT_HOST} ${m.nick} H :0 ${m.realname || m.nick}`);
    }
    this.send(client, `:${SERVER_NAME} 315 ${client.nick} ${channel} :End of /WHO list.`);
  }

  whois(client, nick) {
    const target = this.findNick(sanitizeNick(nick));
    if (!target) {
      this.send(client, `:${SERVER_NAME} 401 ${client.nick} ${nick} :No such nick/channel`);
      return;
    }
    this.send(client, `:${SERVER_NAME} 311 ${client.nick} ${target.nick} ${target.user} ${target.host} * :${target.realname || target.nick}`);
    this.send(client, `:${SERVER_NAME} 312 ${client.nick} ${target.nick} ${BOT_HOST} :PTnet Internet Relay Chat Network`);
    this.send(client, `:${SERVER_NAME} 319 ${client.nick} ${target.nick} :${[...target.channels].join(' ')}`);
    this.send(client, `:${SERVER_NAME} 318 ${client.nick} ${target.nick} :End of /WHOIS list.`);
  }

  list(client) {
    this.send(client, `:${SERVER_NAME} 321 ${client.nick} Channel :Users Name`);
    for (const ch of Object.keys(CHANNELS)) {
      this.send(client, `:${SERVER_NAME} 322 ${client.nick} ${ch} ${this.members(ch).length} :${CHANNELS[ch].topic}`);
    }
    this.send(client, `:${SERVER_NAME} 323 ${client.nick} :End of /LIST`);
  }

  topic(client, channel, text) {
    const key = String(channel || '').toLowerCase();
    if (!CHANNELS[key]) return;
    if (text === undefined) {
      this.send(client, `:${SERVER_NAME} 332 ${client.nick} ${channel} :${CHANNELS[key].topic}`);
      return;
    }
    CHANNELS[key].topic = cleanText(text);
    this.toChannel(key, `:${this.prefix(client)} TOPIC ${channel} :${CHANNELS[key].topic}`);
  }

  mode(client, params) {
    const target = params[0] || '';
    if (!target) return;
    const key = target.toLowerCase();
    if (CHANNELS[key]) {
      const modes = params[1] || '';
      if (!modes) return;
      // aplica +o/+v/-o/-v de verdade; outros modos são ecoados
      const args = params.slice(2);
      let sign = '+';
      let argIdx = 0;
      let simple = '';
      for (const ch of modes) {
        if (ch === '+' || ch === '-') {
          if (simple) {
            this.toChannel(key, `:${this.prefix(client)} MODE ${target} ${simple}`);
            simple = '';
          }
          sign = ch;
          continue;
        }
        if (ch === 'o' || ch === 'v') {
          const nick = sanitizeNick(args[argIdx++] || '');
          if (!nick) continue;
          this.applyMode(target, this.prefix(client), sign, ch, nick);
        } else {
          simple += (simple ? '' : sign) + ch;
        }
      }
      if (simple) this.toChannel(key, `:${this.prefix(client)} MODE ${target} ${simple}`);
      return;
    }
    this.send(client, `:${SERVER_NAME} 221 ${client.nick} +`);
  }

  // -- messaging ------------------------------------------------------------

  privmsg(client, target, text) {
    if (!target) return;
    text = cleanText(text);
    if (!text) return;

    // Very light flood protection: 8 lines per 5 seconds.
    const t = now();
    client.msgWindow = client.msgWindow.filter((ts) => t - ts < 5000);
    if (client.msgWindow.length >= 8) {
      this.send(client, `:${SERVER_NAME} NOTICE ${client.nick} :*** Flood detectado. Calma, isto não é o ICQ.`);
      return;
    }
    client.msgWindow.push(t);
    client.lastMsg = t;

    if (target.toLowerCase() === BOT_NICK.toLowerCase()) {
      this.botCommand(client, null, text);
      return;
    }

    const key = target.toLowerCase();
    if (!CHANNELS[key]) {
      this.send(client, `:${SERVER_NAME} 401 ${client.nick} ${target} :No such nick/channel`);
      return;
    }
    if (!client.channels.has(key)) {
      this.send(client, `:${SERVER_NAME} 404 ${client.nick} ${target} :Cannot send to channel`);
      return;
    }

    this.toChannel(key, `:${this.prefix(client)} PRIVMSG ${target} :${text}`, client);
    this.send(client, `:${this.prefix(client)} PRIVMSG ${target} :${text}`);
    // grava no histórico real do canal (para quem entrar depois)
    const isAction = text.startsWith('\x01ACTION ');
    this.record(key, {
      ts: t,
      nick: client.nick,
      kind: isAction ? 'action' : 'msg',
      text: isAction ? text.replace(/^\x01ACTION /, '').replace(/\x01$/, '') : text,
    });

    if (text.startsWith('!')) this.botCommand(client, target, text);
  }

  // -- the bot --------------------------------------------------------------

  say(channel, text) {
    const key = channel.toLowerCase();
    this.toChannel(key, `:${BOT_NICK}!bot@${BOT_HOST} PRIVMSG ${channel} :${text}`);
    this.record(key, { ts: now(), nick: BOT_NICK, kind: 'msg', text });
  }

  action(channel, text) {
    const key = channel.toLowerCase();
    this.toChannel(key, `:${BOT_NICK}!bot@${BOT_HOST} PRIVMSG ${channel} :\x01ACTION ${text}\x01`);
    this.record(key, { ts: now(), nick: BOT_NICK, kind: 'action', text });
  }

  botCommand(client, channel, text) {
    const [rawCmd, ...args] = text.trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    let targetNick = sanitizeNick(args[0] || '');
    // "eu" / "me" / "mim" referem-se a quem escreveu.
    if (/^(eu|me|mim|self)$/i.test(targetNick)) targetNick = client.nick;
    const where = channel || client.nick;

    const reply = (msg) => {
      if (channel) this.say(channel, msg);
      else this.send(client, `:${BOT_NICK}!bot@${BOT_HOST} NOTICE ${client.nick} :${msg}`);
    };

    // Só se pode aplicar comandos a quem está mesmo no canal.
    // (o bot conta como existente; nicks inventados são recusados)
    const inChannel = (nick) => {
      if (!channel) return false;
      if (nick.toLowerCase() === BOT_NICK.toLowerCase()) return true;
      return this.members(channel.toLowerCase()).some(
        (c) => c.nick && c.nick.toLowerCase() === nick.toLowerCase()
      );
    };

    // valida o alvo dos comandos que precisam de um; devolve o nick ou null
    const requireTarget = () => {
      if (!channel) {
        reply('Entra primeiro no canal com /join #guimaraes.');
        return null;
      }
      if (!targetNick) {
        reply('Diz a quem: ' + cmd + ' <nick>. Escreve /names para ver quem está aqui.');
        return null;
      }
      if (!inChannel(targetNick)) {
        reply('Não há nenhum ' + targetNick + ' no canal. Escreve /names para ver quem está aqui.');
        return null;
      }
      return targetNick;
    };

    switch (cmd) {
      case '!help':
        reply('Comandos: !slap <nick> | !op <nick> | !voice <nick> | !jantar | !ptnet | !lag');
        break;

      case '!slap': {
        const victim = requireTarget();
        if (!victim) break;
        const things = ['um bacalhau', 'uma tripa de Guimarães', 'um teclado de 1998', 'um disquete de 1.44MB', 'o CD do Windows 98', 'um modem de 56k'];
        const thing = things[Math.floor(Math.random() * things.length)];
        this.action(channel, `* ${client.nick} dá ${thing} a ${victim}`);
        break;
      }

      case '!op': {
        const who = requireTarget();
        if (!who) break;
        this.action(channel, `* ${who} agora tem @ (op) em ${channel}`);
        this.applyMode(channel, `${BOT_NICK}!bot@${BOT_HOST}`, '+', 'o', who);
        break;
      }

      case '!voice': {
        const who = requireTarget();
        if (!who) break;
        this.action(channel, `* ${who} agora tem + (voice) em ${channel}`);
        this.applyMode(channel, `${BOT_NICK}!bot@${BOT_HOST}`, '+', 'v', who);
        break;
      }

      case '!jantar':
        reply('12ª Janta do #guimaraes da PTNET — 19 de Dezembro de 2026, Restaurante O Pinguim, Guimarães. Traz apetite e modem.');
        break;

      case '!ptnet':
        reply('PTNET: a internet portuguesa em 56k, com o telefone ocupado a partir das 22h.');
        break;

      case '!lag':
        reply(`Ping: ${Math.floor(180 + Math.random() * 900)}ms (modem de 56k, é o que temos).`);
        break;

      default:
        reply(`Comando desconhecido: ${cmd}. Escreve !help.`);
    }
  }

  // -- stats ----------------------------------------------------------------

  stats() {
    return {
      online: [...this.clients].filter((c) => c.registered).length,
      channels: Object.keys(CHANNELS).map((ch) => ({
        name: ch,
        users: this.members(ch).length,
        nicks: this.members(ch).map((m) => m.nick),
        topic: CHANNELS[ch].topic,
      })),
      uptime: Math.floor((now() - this.startedAt) / 1000),
    };
  }
}

return { IRCServer: IRCServer, CHANNELS: CHANNELS, BOT_NICK: BOT_NICK, SERVER_NAME: SERVER_NAME };

});
