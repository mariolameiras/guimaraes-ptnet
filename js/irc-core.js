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
  constructor() {
    this.clients = new Set();
    this.msgCount = 0;
    this.startedAt = now();
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

    if (client.nick) {
      this.toChannel(key, `:${BOT_NICK}!bot@${BOT_HOST} PRIVMSG ${channel} :*** ${client.nick} (${client.user}@${client.host}) entrou no canal ${channel}`);
    }
  }

  part(client, channel, reason) {
    const key = String(channel || '').toLowerCase();
    if (!client.channels.has(key)) return;
    client.channels.delete(key);
    const why = reason ? ` (${cleanText(reason)})` : '';
    this.toChannel(key, `:${this.prefix(client)} PART ${channel}${why ? ' :' + cleanText(reason) : ''}`);
    this.send(client, `:${this.prefix(client)} PART ${channel}${why ? ' :' + cleanText(reason) : ''}`);
    this.toChannel(key, `:${BOT_NICK}!bot@${BOT_HOST} PRIVMSG ${channel} :*** ${client.nick} (${client.user}@${client.host}) saiu do canal ${channel}${why}`);
  }

  quit(client, reason) {
    if (!client.alive) return;
    client.alive = false;
    const channels = [...client.channels];
    client.channels.clear();
    this.clients.delete(client);
    if (client.registered) {
      const why = ` (${cleanText(reason || 'Client Quit')})`;
      for (const ch of channels) {
        this.toChannel(ch, `:${this.prefix(client)} QUIT :${cleanText(reason || 'Client Quit')}`);
        this.toChannel(ch, `:${BOT_NICK}!bot@${BOT_HOST} PRIVMSG ${ch} :*** ${client.nick} (${client.user}@${client.host}) saiu do canal ${ch}${why}`);
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
    const list = this.members(key).map((c) => c.nick);
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
      // Channel modes are cosmetic in this clone: we only echo them back.
      const modes = params.slice(1).join(' ');
      if (modes) this.toChannel(key, `:${this.prefix(client)} MODE ${target} ${modes}`);
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

    if (text.startsWith('!')) this.botCommand(client, target, text);
  }

  // -- the bot --------------------------------------------------------------

  say(channel, text) {
    this.toChannel(channel, `:${BOT_NICK}!bot@${BOT_HOST} PRIVMSG ${channel} :${text}`);
  }

  action(channel, text) {
    this.toChannel(channel, `:${BOT_NICK}!bot@${BOT_HOST} PRIVMSG ${channel} :\x01ACTION ${text}\x01`);
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

    switch (cmd) {
      case '!help':
        reply('Comandos: !slap <nick> | !op <nick> | !voice <nick> | !jantar | !ptnet | !lag');
        break;

      case '!slap': {
        const victim = targetNick || client.nick;
        const things = ['um bacalhau', 'uma tripa de Guimarães', 'um teclado de 1998', 'um disquete de 1.44MB', 'o CD do Windows 98', 'um modem de 56k'];
        const thing = things[Math.floor(Math.random() * things.length)];
        if (!channel) {
          reply(`* ${client.nick} dá ${thing} a ${victim}. (entra num canal primeiro, ó pá)`);
          break;
        }
        this.action(channel, `* ${client.nick} dá ${thing} a ${victim}`);
        break;
      }

      case '!op': {
        const who = targetNick || client.nick;
        if (!channel) {
          reply(`* ${who} agora tem @ (op). Parabéns, não podes fazer nada com isso.`);
          break;
        }
        this.action(channel, `* ${who} agora tem @ (op) em ${channel}`);
        this.toChannel(channel, `:${BOT_NICK}!bot@${BOT_HOST} MODE ${channel} +o ${who}`);
        break;
      }

      case '!voice': {
        const who = targetNick || client.nick;
        if (!channel) {
          reply(`* ${who} agora tem + (voice). Fala à vontade.`);
          break;
        }
        this.action(channel, `* ${who} agora tem + (voice) em ${channel}`);
        this.toChannel(channel, `:${BOT_NICK}!bot@${BOT_HOST} MODE ${channel} +v ${who}`);
        break;
      }

      case '!jantar':
        reply('12ª Janta do #guimaraes da PTNET — 19 de Dezembro de 1998, Restaurante Ninho do Falcão, Guimarães. Traz apetite e modem.');
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
