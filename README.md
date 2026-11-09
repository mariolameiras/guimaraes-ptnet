# 12ª Janta do #guimaraes da PTnet

Site da 12ª janta do canal `#guimaraes` da PTnet, com estética **ano 2000** — e um
**clone do mIRC embebido** que funciona em dois modos, sem precisar de servidor para
nada se for publicado num site estático (GitHub Pages incluído).

## Como correr

### Modo servidor (local, recomendado para desenvolvimento)

```bash
node server/index.js          # http://localhost:8080
node server/index.js 3000     # outra porta
```

O cliente liga-se por WebSocket ao servidor IRC próprio e tudo funciona como
esperado. Sem dependências (Node ≥ 18).

### Modo P2P (GitHub Pages, sem servidor)

Quando não há servidor WebSocket (p. ex. no GitHub Pages), o cliente muda
sozinho para **modo P2P por WebRTC (PeerJS)**:

- O primeiro visitante a abrir a página torna-se **anfitrião** e corre o
  servidor IRC embebido no próprio browser (`js/irc-core.js`).
- Os restantes ligam-se directamente ao anfitrião por data channels.
- Se o anfitrião sair, outro visitante **assume o lugar automaticamente**.
- Só aparecem pessoas reais com a página aberta — sem dados inventados.

O núcleo IRC (`js/irc-core.js`) é isomórfico: o mesmo código corre no servidor
Node e no browser do anfitrião. O texto de ligação reproduz a sequência real da
PTnet (capturada de `irc.ptnet.org`): *Looking up your hostname*, MOTD, aviso do
NickServ, etc.

## O site

- **Banner** (`img/banner.png`): gerado por `tools/make-banner.js` renderizando
  HTML/CSS no Chrome headless — título com gradiente, glow, lens flare, grelha
  tech. Regenerar: `node tools/make-banner.js`.
- **Badges 88×31** (`img/badge-*.png`): 8 botões clássicos da época (Netscape
  Now!, IE 5, Made with Notepad, 800×600, Y2K, Winamp, PTnet, #guimaraes).
  Gerar: `node tools/make-badges.js`.
- **Menu lateral em iframe** (`menu.html`): navegação, pessoas online reais,
  botão para o chat, lista de comandos, webring.
- Estrutura com cabeça e pés: banner no topo, secções largas (A Janta, Links),
  **chat no fim**, rodapé com badges.
- Marquee, relógio, popup "tens 1 nova mensagem", easter egg (código Konami).

## O mIRC clone

- Entra como **guestXXXX** e entra automaticamente no **#guimaraes**.
- Texto de ligação ao estilo PTnet + MOTD.
- Tópico: `bem vindo ao #guimaraes - 12a janta 2026` — **mudável com `/topic`**.
- **@BotDoJantar** é operador do canal e anuncia entradas/saídas.
- Contador de **pessoas online agora** (lista do canal, actualizada em tempo real).
- Mudar de nick com `/nick` (campo na barra de estado ou comando) — a lista de
  nicks actualiza-se de imediato.
- Comandos do bot: `!slap <nick>`, `!op <nick>`, `!voice <nick>` (aplicam o
  `@`/`+` na lista), `!jantar`, `!ptnet`, `!lag`, `!help`.
- Comandos de cliente: `/join`, `/part`, `/nick`, `/me`, `/msg`, `/names`,
  `/who`, `/whois`, `/list`, `/topic`, `/clear`, `/quit`, `/help`.
- Histórico com seta para cima, som opcional, minimizar a janela.

## Histórico persistente (Firebase)

O histórico do `#guimaraes` é guardado no **Firebase Realtime Database**, por isso
sobrevive a todos saírem, a recarregar a página e a mudar de anfitrião.

- Configuração: `js/firebase-config.js` (a `apiKey` é pública por design)
- Store: `js/history-store-firebase.js` (REST, sem SDK)
- Reserva: se o Firebase falhar, cai para IndexedDB (`js/history-store.js`)
- No servidor Node: `server/history-store.js` grava em `data/history.json`

### Regras de segurança (aplicar na consola)

Firebase Console → Realtime Database → **Rules** → colar → **Publish**:

```json
{
  "rules": {
    "channels": {
      "$channel": {
        "messages": {
          "$msg": {
            ".read": true,
            ".write": "!data.exists() && newData.hasChildren(['ts','nick','kind'])",
            ".validate": "newData.child('ts').isNumber() && newData.child('nick').isString() && newData.child('nick').val().length <= 16 && newData.child('text').isString() && newData.child('text').val().length <= 450"
          }
        }
      }
    }
  }
}
```

Leitura pública, escrita só de mensagens novas (não se apaga nem altera o passado).

## GitHub Pages

O site estático vive na raiz do repositório (`index.html`, `menu.html`,
`css/`, `js/`, `img/`). No GitHub Pages o chat entra em modo P2P —
[experimenta](https://mariolameiras.github.io/guimaraes-ptnet/).

Nota: o servidor de sinalização PeerJS (`0.peerjs.com`) e a biblioteca
(unpkg.com) são carregados apenas quando o WebSocket próprio não responde.

## Estrutura

```
index.html            a página (cabeça, corpo com menu iframe, pés)
menu.html             conteúdo do menu lateral (iframe)
css/style.css         estilos da página
css/menu.css          estilos do menu
js/irc-core.js        núcleo IRC isomórfico (Node + browser)
js/irc-client.js      o clone do mIRC (WS + fallback P2P)
js/site.js            relógio, popup, easter egg
img/banner.png        banner gerado
img/badge-*.png       badges 88×31 gerados
server/index.js        servidor Node (HTTP estático + WebSocket)
tools/make-banner.js  gerador do banner (Chrome headless)
tools/make-badges.js  gerador dos badges (Chrome headless)
tools/test-irc.js      teste de integração do protocolo
tools/test-browser.js  smoke test em Chrome headless + screenshots
```


## Testes

```bash
node server/index.js 8099 &
node tools/test-irc.js
node tools/test-browser.js http://localhost:8099/ /tmp/site.png
```

Para testar o modo P2P sem servidor: `python3 -m http.server 8098` na raiz e
abre `http://localhost:8098/` em dois browsers.

> `!op` e `!voice` são decorativos — não dão poderes reais no IRC.
