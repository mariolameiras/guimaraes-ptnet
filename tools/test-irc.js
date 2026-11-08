// Integration test: two WebSocket clients exercising the IRC clone.
//   node tools/test-irc.js   (expects the server on :8099)
const assert = require('node:assert');

const URL = process.env.WS_URL || 'ws://localhost:8099/ws';

function client(name) {
  const ws = new WebSocket(URL);
  const lines = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    for (const l of String(ev.data).split('\n')) {
      if (!l.trim()) continue;
      lines.push(l);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].re.test(l)) {
          waiters[i].resolve(l);
          waiters.splice(i, 1);
        }
      }
    }
  });
  const api = {
    name,
    ws,
    lines,
    send: (l) => ws.send(l),
    wait(re, ms = 2000) {
      const found = lines.find((l) => re.test(l));
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { re, resolve };
        waiters.push(w);
        setTimeout(() => {
          const idx = waiters.indexOf(w);
          if (idx !== -1) {
            waiters.splice(idx, 1);
            reject(new Error(`${name}: timeout waiting for ${re}`));
          }
        }, ms);
      });
    },
    open: () =>
      new Promise((res) => {
        if (ws.readyState === 1) return res();
        ws.addEventListener('open', res, { once: true });
      }),
    close: () => ws.close(),
  };
  return api;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const a = client('a');
  const b = client('b');
  await Promise.all([a.open(), b.open()]);

  // sequência de ligação PTnet
  await a.wait(/\*\*\* Looking up your hostname/);
  a.send('NICK alice');
  a.send('USER web 0 * :Alice');
  await a.wait(/ 001 alice :Welcome to the PTnet Internet Relay Chat Network /);
  await a.wait(/ 376 alice :End of \/MOTD command\./);
  await a.wait(/MODE alice :\+i/);
  await a.wait(/NickServ.*Acesso a alice autorizado por nao estar registado/);
  console.log('ok: PTnet connect sequence (NOTICE/001/MOTD/MODE/NickServ)');

  b.send('NICK bob');
  b.send('USER web 0 * :Bob');
  await b.wait(/ 001 bob /);
  console.log('ok: second client registered');

  // join
  a.send('JOIN #guimaraes');
  await a.wait(/ 332 alice #guimaraes :bem vindo ao #guimaraes - 12a janta 2026/);
  await a.wait(/ 353 alice = #guimaraes :@BotDoJantar alice/);
  await a.wait(/ 366 alice #guimaraes /);
  console.log('ok: join + topic + @BotDoJantar in names');

  b.send('JOIN #guimaraes');
  await b.wait(/ 366 bob #guimaraes /);
  await a.wait(/:bob!~web@dialup-ptnet JOIN #guimaraes/);
  console.log('ok: join é evento de sistema (sem mensagem do bot)');

  // mensagem
  a.send('PRIVMSG #guimaraes :ola malta');
  const got = await b.wait(/PRIVMSG #guimaraes :ola malta/);
  assert.ok(got.startsWith(':alice!'));
  console.log('ok: message delivered');

  // comandos do bot
  a.send('PRIVMSG #guimaraes :!slap bob');
  await b.wait(/ACTION \* alice dá .* a bob/);
  a.send('PRIVMSG #guimaraes :!op bob');
  await b.wait(/ACTION \* bob agora tem @ \(op\) em #guimaraes/);
  await b.wait(/BotDoJantar.*MODE #guimaraes \+o bob/);
  a.send('PRIVMSG #guimaraes :!voice bob');
  await b.wait(/ACTION \* bob agora tem \+ \(voice\) em #guimaraes/);
  await b.wait(/BotDoJantar.*MODE #guimaraes \+v bob/);
  a.send('PRIVMSG #guimaraes :!op eu');
  await b.wait(/ACTION \* alice agora tem @ \(op\) em #guimaraes/);
  console.log('ok: !slap / !op / !voice (+ MODE broadcast)');

  // quem entra depois vê os modos @/+ no NAMES (como no IRC real)
  const d = client('d');
  await d.open();
  d.send('NICK diana');
  d.send('USER web 0 * :D');
  await d.wait(/ 001 diana /);
  d.send('JOIN #guimaraes');
  const names353 = await d.wait(/ 353 diana = #guimaraes :/);
  assert.ok(/@BotDoJantar @?alice/.test(names353), 'alice deve ter @: ' + names353);
  assert.ok(/@bob|\+bob/.test(names353), 'bob deve ter @ ou +: ' + names353);
  console.log('ok: novos utilizadores vêem os modos no NAMES:', names353.split('353 diana = #guimaraes :')[1]);

  // histórico: diana deve ver as mensagens anteriores com @time
  const histNotice = await d.wait(/NOTICE diana :\*\*\* Hist/);
  assert.ok(histNotice.includes('Histórico'), 'aviso de histórico');
  const histLine = await d.wait(/@time=\d{4}-\d{2}-\d{2}T.*PRIVMSG #guimaraes :ola malta/);
  assert.ok(histLine.startsWith('@time='), 'linha de histórico com tag server-time');
  const histSlap = await d.wait(/@time=.*ACTION \* alice dá .* a bob/);
  assert.ok(histSlap.startsWith('@time='), 'acção no histórico com tag');
  console.log('ok: replay do histórico com timestamps (@time)');
  d.close();

  // mudança de tópico
  a.send('TOPIC #guimaraes :bem vindo ao #guimaraes - 12a janta 2026 (confirmem!)');
  await b.wait(/TOPIC #guimaraes :bem vindo ao #guimaraes - 12a janta 2026 \(confirmem!\)/);
  a.send('TOPIC #guimaraes :bem vindo ao #guimaraes - 12a janta 2026');
  await b.wait(/TOPIC #guimaraes :bem vindo ao #guimaraes - 12a janta 2026$/);
  console.log('ok: /topic changeable');

  // mudança de nick
  a.send('NICK alice2');
  await b.wait(/:alice!.* NICK :alice2/);
  console.log('ok: nick change');

  // part
  a.send('PART #guimaraes');
  await b.wait(/:alice2!~web@dialup-ptnet PART #guimaraes/);
  console.log('ok: part é evento de sistema');

  // nick duplicado rejeitado
  const c = client('c');
  await c.open();
  c.send('NICK bob');
  c.send('USER web 0 * :C');
  await c.wait(/ 433 \* bob :Nickname is already in use/);
  console.log('ok: duplicate nick rejected');

  // canal inexistente
  c.send('NICK carol');
  c.send('USER web 0 * :Carol');
  await c.wait(/ 001 carol /);
  c.send('JOIN #portugal');
  await c.wait(/ 403 carol #portugal :No such channel/);
  console.log('ok: #portugal does not exist (only #guimaraes)');

  // quit notice
  c.send('JOIN #guimaraes');
  await c.wait(/ 366 carol #guimaraes /);
  c.close();
  await b.wait(/:carol!~web@dialup-ptnet QUIT :/);
  console.log('ok: quit é evento de sistema');

  // stats
  const stats = await (await fetch('http://localhost:8099/healthz')).json();
  console.log('ok: healthz online =', stats.online);
  assert.ok(stats.online >= 2);
  const gui = stats.channels.find((ch) => ch.name === '#guimaraes');
  assert.ok(gui && gui.nicks.includes('bob'), 'bob should be in #guimaraes nicks');
  console.log('ok: /online exposes real nicks:', gui.nicks.join(', '));

  [a, b].forEach((x) => x.close());
  await sleep(200);
  console.log('\nALL TESTS PASSED');
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
