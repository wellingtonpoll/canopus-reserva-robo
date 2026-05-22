// Visual check do popup.html da extensão Canopus Robô.
//
// Abre popup.html localmente no Chromium headless com chrome.* APIs mockadas,
// navega pelas 3 tabs (Operações, Histórico, Configurações), tira screenshot
// de cada estado relevante. Útil pra validar layout/CSS sem precisar instalar
// extensão no Chrome real.
//
// Uso: node tests/visual-check.js
// Output: tests/visual/<timestamp>/{01-operacoes.png, 02-operacoes-dashboard.png, 03-historico.png, 04-config.png}

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const POPUP_HTML = 'file://' + path.resolve(__dirname, '..', 'extension', 'popup.html');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = path.join(__dirname, 'visual', TIMESTAMP);
const LATEST_DIR = path.join(__dirname, 'visual', 'latest');

// Gera 30 dias de métricas sample pra gráficos não ficarem vazios
function gerarMetricasSample() {
  const md = {};
  const mh = {};
  const hoje = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    const dia = d.toISOString().slice(0, 10);
    const consultas = Math.floor(50 + Math.random() * 200);
    const reservas = Math.floor(consultas * (0.05 + Math.random() * 0.4));
    const rateLimits = Math.floor(consultas * Math.random() * 0.3);
    md[dia] = {
      ciclos: Math.floor(consultas / 5),
      consultas,
      reservas,
      rateLimits
    };
  }
  // Métricas horárias do hoje
  const hojeStr = hoje.toISOString().slice(0, 10);
  for (let h = 0; h < hoje.getHours() + 1; h++) {
    mh[hojeStr + '-' + String(h).padStart(2, '0')] = {
      ciclos: Math.floor(Math.random() * 12),
      reservas: Math.floor(Math.random() * 3)
    };
  }
  return { metricasDia: md, metricasHoras: mh };
}

const CHROME_MOCK = `
  const __sample = ${JSON.stringify(gerarMetricasSample())};
  const __localStore = {
    USUARIO: '12345',
    SENHA: 'senha-teste',
    GRUPOS_CONFIG: '009113:3,009114:2',
    DELAY_MIN: 7,
    DELAY_MAX: 12,
    TELEGRAM_TOKEN: '1234567890:ABC',
    TELEGRAM_CHAT_ID: '-100123456789',
    MODO_TESTE: false,
    TELEMETRIA_LIGADA: false,
    metricasDia: __sample.metricasDia,
    metricasHoras: __sample.metricasHoras,
    telemetria_buffer: []
  };
  const __sessionStore = {
    isRunning: false,
    currentMin: 7,
    currentMax: 12,
    circuitAberto: null,
    activeTab: 'operacoes'
  };
  const __runtimeListeners = [];
  window.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === 'string') return { [keys]: __localStore[keys] };
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) out[k] = __localStore[k];
            return out;
          }
          return { ...__localStore };
        },
        set: async (obj) => { Object.assign(__localStore, obj); },
        remove: async () => {},
        clear: async () => {}
      },
      session: {
        get: async (keys) => {
          if (typeof keys === 'string') return { [keys]: __sessionStore[keys] };
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) out[k] = __sessionStore[k];
            return out;
          }
          return { ...__sessionStore };
        },
        set: async (obj) => { Object.assign(__sessionStore, obj); },
        remove: async () => {},
        clear: async () => {}
      },
      onChanged: { addListener: () => {} }
    },
    runtime: {
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener: (fn) => { __runtimeListeners.push(fn); } },
      getManifest: () => ({ version: '1.0.1' })
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://parceiros.consorciocanopus.com.br/apps/reservas' }],
      sendMessage: async () => ({ ok: true }),
      update: async () => {}
    },
    windows: { update: async () => {} },
    alarms: { clearAll: async () => {} },
    scripting: { executeScript: async () => [] }
  };

  // Injeta logs sample após DOM pronto pra mostrar visual real
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      const logs = document.getElementById('logs');
      if (!logs) return;
      const sample = [
        ['✅ Configurações salvas', 'log-success'],
        ['🚀 Monitoramento iniciado', 'log-warn'],
        ['✅ Login realizado com sucesso!', 'log-success'],
        ['📦 32 grupos consultados', 'log-info'],
        ['🔍 Buscando por cotas: 009113, 009114, 009115...', 'log-warn'],
        ['🍀 Cota 009113 encontrada para o usuário 12345', 'log-success'],
        ['🎉 Reservado! Grupo: 009113 Cota: 9876', 'log-vaga'],
        ['💥 Nenhuma cota disponível no momento...', 'log-info'],
        ['⚠️ Rate limit detectado → delay ajustado para 14-24s', 'log-warn']
      ];
      const time = '10:45:01';
      sample.forEach(([text, cls]) => {
        const line = document.createElement('div');
        line.className = 'log-line';
        line.innerHTML = '<span class="log-time">' + time + '</span><span class="' + cls + '">' + text + '</span>';
        logs.appendChild(line);
      });
    }, 100);
  });
`;

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 400, height: 800 },
    deviceScaleFactor: 2
  });
  await context.addInitScript(CHROME_MOCK);

  const page = await context.newPage();
  page.on('pageerror', err => console.error('[pageerror]', err.message));
  page.on('console', msg => {
    if (msg.type() === 'error') console.error('[console.error]', msg.text());
  });

  await page.goto(POPUP_HTML);
  await page.waitForLoadState('domcontentloaded');

  // Fix 14 T3: espera elementos críticos em vez de timeout fixo
  await page.waitForSelector('.log-line', { timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => {
    return document.querySelectorAll('.metric-chip-value').length >= 4;
  }, { timeout: 5000 }).catch(() => {});

  console.log('→ Operações (default)');
  await page.screenshot({ path: path.join(OUT_DIR, '01-operacoes.png'), fullPage: true });

  console.log('→ Operações com Dashboard aberto');
  await page.click('.dashboard-summary');
  await page.waitForFunction(() => {
    const panel = document.querySelector('.dashboard-panel');
    return panel && panel.hasAttribute('open');
  }, { timeout: 3000 }).catch(() => {});
  await page.screenshot({ path: path.join(OUT_DIR, '02-operacoes-dashboard-aberto.png'), fullPage: true });
  await page.click('.dashboard-summary');

  console.log('→ Histórico');
  await page.click('button[data-tab="historico"]');
  await page.waitForFunction(() => {
    return document.body.getAttribute('data-tab') === 'historico';
  }, { timeout: 3000 }).catch(() => {});
  // Aguarda Chart.js renderizar canvas
  await page.waitForFunction(() => {
    const c = document.getElementById('chartConsultas');
    return c && c.getBoundingClientRect().height > 0;
  }, { timeout: 5000 }).catch(() => {});
  await page.screenshot({ path: path.join(OUT_DIR, '03-historico.png'), fullPage: true });

  console.log('→ Configurações');
  await page.click('button[data-tab="config"]');
  await page.waitForFunction(() => {
    return document.body.getAttribute('data-tab') === 'config';
  }, { timeout: 3000 }).catch(() => {});
  await page.screenshot({ path: path.join(OUT_DIR, '04-config.png'), fullPage: true });

  // Opção D Lote A: screenshots adicionais em viewport pequeno (notebook ~768px)
  // pra validar @media (max-height: 720px) compact mode
  console.log('→ Compact: Operações (notebook 360×620)');
  await page.setViewportSize({ width: 360, height: 620 });
  await page.evaluate(() => document.body.setAttribute('data-tab', 'operacoes'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '05-operacoes-compact.png'), fullPage: false });
  console.log('→ Compact: Configurações (notebook 360×620)');
  await page.evaluate(() => document.body.setAttribute('data-tab', 'config'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT_DIR, '06-config-compact.png'), fullPage: false });

  await browser.close();

  // Atualiza symlink/copia latest
  try {
    if (fs.existsSync(LATEST_DIR)) fs.rmSync(LATEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(LATEST_DIR, { recursive: true });
    for (const f of fs.readdirSync(OUT_DIR)) {
      fs.copyFileSync(path.join(OUT_DIR, f), path.join(LATEST_DIR, f));
    }
  } catch (e) { /* ignore */ }

  console.log('\n✓ Screenshots em:', OUT_DIR);
  console.log('✓ Latest em:', LATEST_DIR);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
