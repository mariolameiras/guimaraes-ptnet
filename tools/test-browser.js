// Headless-Chrome smoke test over the DevTools protocol (no npm deps).
//   node tools/test-browser.js [url] [outfile]
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const URL_ = process.argv[2] || 'http://localhost:8099/';
const OUT = process.argv[3] || '/tmp/opencode/site.png';
const PORT = 9333;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(
    'google-chrome-stable',
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1440,3400',
      '--user-data-dir=/tmp/opencode/chrome-profile',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let targets;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (targets.length) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
    }
  });
  const cmd = (method, params = {}) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expr) => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  };
  const type = (value) =>
    evaluate(`(() => {
      const i = document.getElementById('mirc-input');
      i.value = ${JSON.stringify(value)};
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);

  await cmd('Runtime.enable');
  await cmd('Log.enable');
  await cmd('Page.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cmd('Page.navigate', { url: URL_ });
  await sleep(4000);

  // 1. estado inicial: entra sozinho no #guimaraes
  const info = await evaluate(`(() => {
    const lines = [...document.querySelectorAll('#mirc-text div')].map(e => e.textContent);
    return {
      guestNick: document.getElementById('nick-input').value,
      hasHostLookup: lines.some(l => l.includes('Looking up your hostname')),
      hasWelcome: lines.some(l => l.includes('Welcome to the PTnet Internet Relay Chat Network')),
      hasMOTD: lines.some(l => l.includes('End of /MOTD command')),
      autoJoined: document.getElementById('chan-count').textContent,
      topicShown: lines.some(l => l.includes('bem vindo ao #guimaraes - 12a janta 2026')),
      botOp: document.getElementById('mirc-nicks').textContent.includes('@BotDoJantar'),
      menuIframe: !!document.querySelector('.menu-col iframe'),
      badges: [...document.querySelectorAll('.badges img')].map(i => i.naturalWidth > 0),
      banner: (() => { const i = document.querySelector('.site-head img'); return i ? i.naturalWidth + 'x' + i.naturalHeight : 'missing'; })(),
      sections: [...document.querySelectorAll('.sec')].map(s => s.id),
    };
  })()`);
  console.log('INITIAL:', JSON.stringify(info, null, 1));

  // 2. muda o nick — a lista de nicks tem de actualizar-se
  await type('/nick ze_guimaraes');
  await sleep(400);

  const nickChanged = await evaluate(`(() => ({
    nick: document.getElementById('nick-input').value,
    nicklistHasNew: document.getElementById('mirc-nicks').textContent.includes('ze_guimaraes'),
    nicklistHasOld: document.getElementById('mirc-nicks').textContent.includes('guest'),
  })())`);
  console.log('NICK CHANGED:', JSON.stringify(nickChanged));

  // 3. dá op a si próprio — o @ tem de aparecer na lista
  await type('!op ze_guimaraes');
  await sleep(400);

  const opGiven = await evaluate(`(() => ({
    nicklist: document.getElementById('mirc-nicks').textContent,
    hasOpMarker: document.getElementById('mirc-nicks').textContent.includes('@ze_guimaraes'),
  }))()`.replace(/@ze_guimaraes'/, "'@ze_guimaraes'"));
  console.log('OP GIVEN:', JSON.stringify(opGiven));

  // 4. fala e usa comandos do bot
  await type('ola malta!');
  await sleep(300);
  await type('!slap BotDoJantar');
  await sleep(400);

  // 5. muda o tópico
  await type('/topic bem vindo ao #guimaraes - 12a janta 2026');
  await sleep(400);

  const after = await evaluate(`(() => {
    const lines = [...document.querySelectorAll('#mirc-text div')].map(e => e.textContent);
    return {
      myMsg: lines.some(l => l.includes('ola malta!')),
      slap: lines.some(l => l.includes('dá') && l.includes('BotDoJantar')),
      lastLines: lines.slice(-6),
    };
  })()`);
  console.log('AFTER:', JSON.stringify(after, null, 1));

  // 5. layout + screenshot full-page
  const layout = await evaluate(`(() => {
    const de = document.documentElement;
    const q = s => document.querySelector(s).getBoundingClientRect();
    return {
      scrollW: de.scrollWidth,
      vw: innerWidth,
      menuW: Math.round(q('.menu-col').width),
      mainW: Math.round(q('.main').width),
      chatW: Math.round(q('.mirc').width),
      overflow: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > de.clientWidth + 1 && !e.closest('.marquee')).length,
      sections: [...document.querySelectorAll('.sec')].map(s => s.id),
    };
  })()`);
  console.log('LAYOUT:', JSON.stringify(layout));

  const metrics = await cmd('Page.getLayoutMetrics');
  const h = Math.ceil(metrics.result.cssContentSize.height);
  await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const shot = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot:', OUT, h + 'px tall');

  console.log('errors:', errors.length ? errors : 'none');
  ws.close();
  chrome.kill('SIGKILL');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => {
  console.error('FAILED', e);
  process.exit(1);
});
