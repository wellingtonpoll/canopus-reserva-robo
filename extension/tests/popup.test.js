/**
 * @jest-environment jsdom
 *
 * Testes do popup via jsdom + carregamento da popup.html (estrutura) + popup.js (handlers).
 * Foco em funções puras e setters de DOM, não em integração completa.
 */

const fs = require('fs');
const path = require('path');

const POPUP_HTML_PATH = path.resolve(__dirname, '..', 'popup.html');
const POPUP_JS_PATH = path.resolve(__dirname, '..', 'popup.js');
const POPUP_HTML = fs.readFileSync(POPUP_HTML_PATH, 'utf8');
const POPUP_JS = fs.readFileSync(POPUP_JS_PATH, 'utf8');

function setupPopupDom() {
  // Extrai body do popup.html
  const bodyMatch = POPUP_HTML.match(/<body[^>]*>([\s\S]*?)<\/body>/);
  document.body.innerHTML = bodyMatch ? bodyMatch[1] : '';
  // body data-tab
  const dataTabMatch = POPUP_HTML.match(/<body data-tab="([^"]+)"/);
  if (dataTabMatch) document.body.setAttribute('data-tab', dataTabMatch[1]);

  // Mock chrome com getters pra retornar dados sample
  const localStore = {};
  const sessStore = {};
  window.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === 'string') return { [keys]: localStore[keys] };
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) out[k] = localStore[k];
            return out;
          }
          return { ...localStore };
        },
        set: async (obj) => { Object.assign(localStore, obj); },
        remove: async () => {},
        clear: async () => { for (const k of Object.keys(localStore)) delete localStore[k]; }
      },
      session: {
        get: async (keys) => {
          if (typeof keys === 'string') return { [keys]: sessStore[keys] };
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) out[k] = sessStore[k];
            return out;
          }
          return { ...sessStore };
        },
        set: async (obj) => { Object.assign(sessStore, obj); },
        remove: async () => {},
        clear: async () => { for (const k of Object.keys(sessStore)) delete sessStore[k]; }
      },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener: () => {} },
      getManifest: () => ({ version: '1.1.0' })
    },
    tabs: {
      query: async () => [],
      sendMessage: async () => ({ ok: true }),
      update: async () => {}
    },
    windows: { update: async () => {} },
    alarms: { clearAll: async () => {} },
    scripting: { executeScript: async () => [] }
  };

  // Stub Chart pra inicializarChartsHistorico não crashar
  window.Chart = class {
    constructor() { this.data = { datasets: [{ data: [] }] }; }
    update() {}
    destroy() {}
  };

  // Mock URL.createObjectURL/revokeObjectURL pra exportarCsv não crashar
  if (!global.URL.createObjectURL) global.URL.createObjectURL = () => 'blob:fake';
  if (!global.URL.revokeObjectURL) global.URL.revokeObjectURL = () => {};

  // Indirect eval pra rodar popup.js no escopo global do Node (vs escopo do módulo).
  // Function declarations e var ficam acessíveis via globalThis depois.
  (0, eval)(POPUP_JS);

  // popup.js usa `const`/`let` que NÃO viram global mesmo com indirect eval.
  // Pra expor pros testes, popup.js precisa fazer atribuições explícitas em window.
  // Como atalho: re-eval com prefixo que mapeia funções pra globals.
  // (Hack: registrar funções declaradas como function statements via lookup.)
  // Function declarations em indirect eval VIRAM global no browser/jsdom. Confirmar.

  return { localStore, sessStore };
}

describe('popup.js — setDirty / setRunningState (Fix 14 T2)', () => {

  test('setDirty(true) muda atributo data-dirty do saveBtn', () => {
    setupPopupDom();
    const saveBtn = document.getElementById('saveBtn');
    expect(saveBtn.getAttribute('data-dirty')).toBe('false');
    setDirty(true);
    expect(saveBtn.getAttribute('data-dirty')).toBe('true');
    setDirty(false);
    expect(saveBtn.getAttribute('data-dirty')).toBe('false');
  });

  test('setRunningState(true): pill MONITORANDO + botão Start disabled', () => {
    setupPopupDom();
    setRunningState(true);
    expect(document.getElementById('statusText').textContent).toBe('MONITORANDO');
    expect(document.getElementById('startBtn').disabled).toBe(true);
    expect(document.getElementById('stopBtn').disabled).toBe(false);
    expect(document.getElementById('logsBadge').getAttribute('data-state')).toBe('monitorando');
  });

  test('setRunningState(false): pill PARADO + botão Stop disabled', () => {
    setupPopupDom();
    setRunningState(true);
    setRunningState(false);
    expect(document.getElementById('statusText').textContent).toBe('PARADO');
    expect(document.getElementById('startBtn').disabled).toBe(false);
    expect(document.getElementById('stopBtn').disabled).toBe(true);
  });
});

describe('popup.js — addLog (Fix 14 T2)', () => {

  test('addLog adiciona linha com cor por kind (erro vermelho)', () => {
    setupPopupDom();
    addLog('❌ Erro grave aqui');
    const lines = document.querySelectorAll('.log-line');
    expect(lines.length).toBe(1);
    expect(lines[0].querySelector('.log-error')).toBeTruthy();
  });

  test('addLog: sucesso de reserva usa log-vaga (verde negrito)', () => {
    setupPopupDom();
    addLog('🎉 Reservado! Cota: 9876');
    expect(document.querySelector('.log-vaga')).toBeTruthy();
  });

  test('addLog: cap em MAX_LOGS=500 — descarta antigos', () => {
    setupPopupDom();
    for (let i = 0; i < 510; i++) addLog(`linha ${i}`);
    const logs = document.getElementById('logs');
    expect(logs.childElementCount).toBeLessThanOrEqual(500);
  });

  test('addLog: HTML escape evita XSS', () => {
    setupPopupDom();
    addLog('<script>alert("xss")</script>');
    const lines = document.querySelectorAll('.log-line');
    // jsdom: o innerHTML do escapado contém &lt;script&gt; (não tag real)
    expect(lines[0].innerHTML).not.toContain('<script>');
    expect(lines[0].innerHTML).toContain('&lt;script&gt;');
  });
});

describe('popup.js — atualizarMetricas + setActiveTab (Fix 14 T2)', () => {

  test('setActiveTab muda body data-tab + aria-selected', () => {
    setupPopupDom();
    setActiveTab('historico');
    expect(document.body.getAttribute('data-tab')).toBe('historico');
    const btn = document.querySelector('button[data-tab="historico"]');
    expect(btn.getAttribute('aria-selected')).toBe('true');
  });

  test('registrarUltimoErro: popula DOM + mostra wrap', () => {
    setupPopupDom();
    registrarUltimoErro('❌ Falha XYZ');
    const wrap = document.getElementById('metricErroWrap');
    const valor = document.getElementById('metricErro');
    expect(wrap.hidden).toBe(false);
    expect(valor.textContent).toContain('Falha XYZ');
    expect(valor.textContent).not.toContain('❌');
  });

  test('atualizarMetricas: lê metricasDia do storage.local', async () => {
    const { localStore } = setupPopupDom();
    const dia = new Date().toLocaleDateString('en-CA');
    localStore.metricasDia = { [dia]: { ciclos: 5, reservas: 2, consultas: 30, rateLimits: 1 } };
    await atualizarMetricas();
    expect(document.getElementById('metricCiclos').textContent).toBe('5');
    expect(document.getElementById('metricReservas').textContent).toBe('2');
    expect(document.getElementById('dashConsultas').textContent).toBe('30');
  });

  test('atualizarMetricas: restaura ultimoErro de storage.session (Fix 14 U1)', async () => {
    const { sessStore } = setupPopupDom();
    sessStore.ultimoErro = { texto: 'Erro persistido', t: Date.now() };
    await atualizarMetricas();
    expect(document.getElementById('metricErro').textContent).toContain('Erro persistido');
    expect(document.getElementById('metricErroWrap').hidden).toBe(false);
  });
});

describe('popup.js — helpers (Fix 14 T2)', () => {

  test('ultimosDias(N) retorna N strings YYYY-MM-DD em ordem cronológica', () => {
    setupPopupDom();
    const dias = ultimosDias(7);
    expect(dias).toHaveLength(7);
    expect(dias[6]).toBe(new Date().toLocaleDateString('en-CA'));
    // Ordem crescente
    for (let i = 1; i < dias.length; i++) {
      expect(dias[i] >= dias[i-1]).toBe(true);
    }
  });

  test('labelCurto: converte YYYY-MM-DD em DD/MM', () => {
    setupPopupDom();
    expect(labelCurto('2026-05-21')).toBe('21/05');
  });
});
