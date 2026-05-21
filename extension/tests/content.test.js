/**
 * @jest-environment jsdom
 *
 * Testes do content-script via jsdom + injection do arquivo num ambiente DOM real.
 * Estratégia: troca DEBUG=false por true pra expor helpers via window.__canopusRobo,
 * executa o IIFE no global window, testa funções diretamente.
 */

const fs = require('fs');
const path = require('path');

const CONTENT_JS_PATH = path.resolve(__dirname, '..', 'content.js');
const CONTENT_JS_SOURCE = fs.readFileSync(CONTENT_JS_PATH, 'utf8')
  .replace('const DEBUG = false;', 'const DEBUG = true;');

let messageListeners;

function setupDom(html = '<body></body>') {
  document.body.innerHTML = html.replace(/<\/?body[^>]*>/g, '');
  messageListeners = [];
  window.chrome = {
    runtime: {
      sendMessage: () => Promise.resolve(),
      onMessage: { addListener: (fn) => messageListeners.push(fn) }
    }
  };
  // jsdom retorna 0 em getBoundingClientRect — força > 50 pra isVisivel + detectarTurnstileInterativo passarem
  HTMLElement.prototype.getBoundingClientRect = function() {
    if (this.hidden || (this.style && this.style.display === 'none')) {
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
    return { width: 200, height: 80, top: 0, left: 0, right: 200, bottom: 80 };
  };
  // Reset window.turnstile entre testes
  delete window.turnstile;
  // Limpa __canopusRobo se setado em teste anterior
  delete window.__canopusRobo;
  // Executa content.js no contexto
  eval(CONTENT_JS_SOURCE);
}

describe('content.js — DOM helpers (Fix 14 T1)', () => {

  test('tryCandidato: tipo selector — encontra button visível', () => {
    setupDom('<button class="alvo">Click</button>');
    const el = window.__canopusRobo.tryCandidato({ tipo: 'selector', sel: 'button.alvo' });
    expect(el).not.toBeNull();
    expect(el.tagName.toLowerCase()).toBe('button');
  });

  test('tryCandidato: tipo text — match exato case insensitive', () => {
    setupDom('<button>Nova Reserva</button><button>Cancelar</button>');
    const el = window.__canopusRobo.tryCandidato({ tipo: 'text', tag: 'button', text: 'nova reserva', exato: true });
    expect(el).not.toBeNull();
    expect(el.textContent).toBe('Nova Reserva');
  });

  test('tryCandidato: tipo text — match partial', () => {
    setupDom('<button>Confirmar Nova Reserva Agora</button>');
    const el = window.__canopusRobo.tryCandidato({ tipo: 'text', tag: 'button', text: 'Nova Reserva' });
    expect(el).not.toBeNull();
  });

  test('tryCandidato: tipo predicate — função custom', () => {
    setupDom('<a>006650 IMÓVEIS</a><a>008100 AUTO</a>');
    const el = window.__canopusRobo.tryCandidato({
      tipo: 'predicate',
      all: 'a',
      fn: (e) => e.textContent.includes('006650')
    });
    expect(el).not.toBeNull();
    expect(el.textContent).toContain('006650');
  });

  test('snapshotInterativos: cap em 40 + retorna estrutura', () => {
    const buttons = Array.from({ length: 50 }, (_, i) => `<button>btn${i}</button>`).join('');
    setupDom(buttons);
    const snap = window.__canopusRobo.snapshotInterativos(document);
    expect(Array.isArray(snap)).toBe(true);
    expect(snap.length).toBeLessThanOrEqual(40);
    expect(snap[0]).toEqual(expect.objectContaining({ tag: 'button', text: expect.any(String) }));
  });

  test('getTurnstileToken: lê input cf-turnstile-response quando turnstile global ausente', () => {
    setupDom('<input name="cf-turnstile-response" value="TOKEN_ABC" />');
    expect(window.__canopusRobo.getTurnstileToken()).toBe('TOKEN_ABC');
  });

  test('getTurnstileToken: prefere window.turnstile.getResponse() se disponível', () => {
    setupDom('<input name="cf-turnstile-response" value="INPUT_TOKEN" />');
    window.turnstile = { getResponse: () => 'WINDOW_TOKEN' };
    expect(window.__canopusRobo.getTurnstileToken()).toBe('WINDOW_TOKEN');
  });

  test('detectarTurnstileInterativo: false sem iframe', () => {
    setupDom('<div id="modal"></div>');
    const modal = document.getElementById('modal');
    expect(window.__canopusRobo.detectarTurnstileInterativo(modal)).toBe(false);
  });

  test('detectarTurnstileInterativo: true com iframe cloudflare visível', () => {
    setupDom('<div id="modal"><iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js"></iframe></div>');
    const modal = document.getElementById('modal');
    expect(window.__canopusRobo.detectarTurnstileInterativo(modal)).toBe(true);
  });
});

describe('content.js — message handlers (Fix 14 T1)', () => {

  test('ping retorna { ok: true, alive: true }', () => {
    setupDom();
    expect(messageListeners.length).toBeGreaterThan(0);
    const responses = [];
    messageListeners[0]({ action: 'ping' }, {}, (resp) => responses.push(resp));
    expect(responses[0]).toEqual({ ok: true, alive: true });
  });

  test('ignora messages sem action', () => {
    setupDom();
    const result = messageListeners[0]({}, {}, () => {});
    expect(result).toBe(false);
  });

  test('ignora actions desconhecidas', () => {
    setupDom();
    const result = messageListeners[0]({ action: 'foo' }, {}, () => {});
    expect(result).toBe(false);
  });
});
