/* Site da 12ª Janta do #guimaraes — scripts (estética 2000). */
(function () {
  'use strict';

  var $ = function (id) {
    return document.getElementById(id);
  };

  function pad(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  // -------------------------------------------------------------------------
  // relógio da barra superior

  function tick() {
    var c = $('clock');
    if (c) {
      var d = new Date();
      c.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
  }
  tick();
  setInterval(tick, 1000);

  // -------------------------------------------------------------------------
  // popup "tens 1 nova mensagem" — porque em 2000 era assim

  (function popup() {
    var pop = $('popup');
    if (!pop) return;
    var text = $('popup-text');
    var close = function () {
      pop.hidden = true;
    };
    $('popup-close').addEventListener('click', close);
    $('popup-ok').addEventListener('click', close);

    var messages = [
      'Tens 1 nova mensagem no ICQ!',
      'O teu modem desligou-se sozinho. Outra vez.',
      'A tua ligação vai ser cortada em 5 minutos.',
      'Nova versão do Winamp disponível! Descarregar 2.1 MB?',
    ];

    setTimeout(function () {
      text.textContent = messages[Math.floor(Math.random() * messages.length)];
      pop.hidden = false;
    }, 12000);
  })();

  // -------------------------------------------------------------------------
  // título a piscar no separador, como manda a tradição

  (function titleBlink() {
    var base = document.title;
    var on = true;
    setInterval(function () {
      document.title = on ? base : '>>> NOVO! >>> ' + base;
      on = !on;
    }, 1400);
  })();

  // -------------------------------------------------------------------------
  // easter egg: Konami code

  (function konami() {
    var code = [38, 38, 40, 40, 37, 39, 37, 39, 66, 65];
    var pos = 0;
    document.addEventListener('keydown', function (e) {
      if (e.keyCode === code[pos]) {
        pos++;
        if (pos === code.length) {
          pos = 0;
          alert(
            'Parabéns! Encontraste o código secreto.\n\n' +
              'Ganhaste 1 (um) modem de 56k imaginário e o direito de dizer\n' +
              '"eu já estava no #guimaraes antes de ser fixe".\n\n' +
              '— O pessoal do #guimaraes'
          );
        }
      } else {
        pos = e.keyCode === code[0] ? 1 : 0;
      }
    });
  })();
})();
