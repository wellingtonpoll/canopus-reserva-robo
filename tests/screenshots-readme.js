// Gera screenshots oficiais pra documentação README.
//
// Diferença de visual-check.js: salva em docs/screenshots/ versionado, com
// nomes estáveis (sem timestamp), retina 2x, e gera também GIF do fluxo
// start→reserva→sucesso. PNG recomprimido via ffmpeg.
//
// Uso: node tests/screenshots-readme.js
// Output:
//   docs/screenshots/01-operacoes.png
//   docs/screenshots/02-operacoes-rodando.png
//   docs/screenshots/03-historico.png
//   docs/screenshots/04-config.png
//   docs/screenshots/05-compact-notebook.png
//   docs/screenshots/demo-fluxo.gif

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

const POPUP_HTML = 'file://' + path.resolve(__dirname, '..', 'extension', 'popup.html');
const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'screenshots');
const FRAMES_DIR = path.join(OUT_DIR, '.frames-tmp');

// Gera 30 dias de métricas pra gráficos não ficarem vazios
function gerarMetricasSample() {
  const md = {};
  const mh = {};
  const hoje = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    const dia = d.toLocaleDateString('en-CA');
    const consultas = Math.floor(80 + Math.random() * 250);
    const reservas = Math.floor(consultas * (0.08 + Math.random() * 0.35));
    const rateLimits = Math.floor(consultas * Math.random() * 0.15);
    md[dia] = {
      ciclos: Math.floor(consultas / 4),
      consultas,
      reservas,
      rateLimits
    };
  }
  const hojeStr = hoje.toLocaleDateString('en-CA');
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
    USUARIO: '8158',
    SENHA: 'senha-mascarada',
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
  window.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          if (typeof keys === 'string') return { [keys]: __localStore[keys] };
          if (Array.isArray(keys)) {
            const out = {}; keys.forEach(k => { out[k] = __localStore[k]; }); return out;
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
            const out = {}; keys.forEach(k => { out[k] = __sessionStore[k]; }); return out;
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
      onMessage: { addListener: () => {} },
      getManifest: () => ({ version: '1.3.0' }),
      getURL: (p) => 'chrome-extension://mock-id/' + p
    },
    tabs: {
      query: async () => [{ id: 1, url: 'https://parceiros.consorciocanopus.com.br/apps/reservas' }],
      sendMessage: async () => ({ ok: true }),
      update: async () => {}
    },
    windows: { update: async () => {}, create: async () => ({ id: 1, tabs: [{ id: 2 }] }) },
    alarms: { clearAll: async () => {} },
    scripting: { executeScript: async () => [] },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} }
  };
`;

// Logs realistas pra cada cena
const LOGS_IDLE = [];
const LOGS_RODANDO = [
  ['10:45:01', '🚀 Monitoramento iniciado', 'log-warn'],
  ['10:45:02', '✅ Login realizado com sucesso!', 'log-success'],
  ['10:45:04', '📦 29 grupos consultados', 'log-info'],
  ['10:45:04', '🔍 Buscando por cotas: 009113, 009114...', 'log-warn'],
  ['10:45:05', '🍀 Cota 009113 encontrada para o usuário 8158 em 22/05/2026 10:45:05!', 'log-success'],
  ['10:45:12', '🎉 Reservado! Grupo: 009113 Cota: 9876 Produto: AUTOMÓVEIS', 'log-vaga'],
  ['10:45:12', '✅ Grupo 009113 concluído — 1 reservas feitas', 'log-success'],
  ['10:45:18', '🍀 Cota 009114 encontrada para o usuário 8158 em 22/05/2026 10:45:18!', 'log-success'],
  ['10:45:24', '🎉 Reservado! Grupo: 009114 Cota: 4521 Produto: IMÓVEIS', 'log-vaga'],
  ['10:45:35', '💥 Nenhuma cota disponível no momento...', 'log-info']
];

async function injectLogs(page, logs) {
  await page.evaluate((entries) => {
    const el = document.getElementById('logs');
    if (!el) return;
    el.innerHTML = '';
    entries.forEach(([time, text, cls]) => {
      const line = document.createElement('div');
      line.className = 'log-line';
      line.innerHTML = '<span class="log-time">' + time + '</span><span class="' + cls + '">' + text + '</span>';
      el.appendChild(line);
    });
    el.scrollTop = el.scrollHeight;
  }, logs);
}

async function setRunning(page, running) {
  await page.evaluate((isRun) => {
    const badge = document.getElementById('statusBadge');
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const logsBadge = document.getElementById('logsBadge');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    if (isRun) {
      badge && badge.classList.add('running');
      dot && dot.classList.add('active');
      if (text) text.textContent = 'RODANDO';
      if (logsBadge) { logsBadge.textContent = 'MONITORANDO'; logsBadge.setAttribute('data-state', 'monitorando'); }
      if (startBtn) startBtn.disabled = true;
      if (stopBtn) stopBtn.disabled = false;
    } else {
      badge && badge.classList.remove('running');
      dot && dot.classList.remove('active');
      if (text) text.textContent = 'PARADO';
      if (logsBadge) { logsBadge.textContent = 'PARADO'; logsBadge.setAttribute('data-state', 'parado'); }
      if (startBtn) startBtn.disabled = false;
      if (stopBtn) stopBtn.disabled = true;
    }
  }, running);
}

async function setMetrics(page, ciclos, reservas, portal, rate) {
  await page.evaluate(({ c, r, p, ra }) => {
    const $ = id => document.getElementById(id);
    if ($('metricCiclos')) $('metricCiclos').textContent = c;
    if ($('metricReservas')) $('metricReservas').textContent = r;
    if ($('metricPortal')) {
      $('metricPortal').textContent = p;
      $('metricPortal').setAttribute('data-state', p === 'CONECTA…' || p === 'CONECTADO' ? 'on' : 'off');
    }
    if ($('metricRate')) $('metricRate').textContent = ra;
  }, { c: ciclos, r: reservas, p: portal, ra: rate });
}

// Recomprime PNG via ffmpeg (lossless, alto nível de compressão)
function recompressPNG(filePath) {
  try {
    const tmp = filePath + '.tmp';
    spawnSync('ffmpeg', ['-y', '-i', filePath, '-compression_level', '100', tmp], { stdio: 'ignore' });
    if (fs.existsSync(tmp)) {
      const oldSize = fs.statSync(filePath).size;
      const newSize = fs.statSync(tmp).size;
      if (newSize < oldSize) {
        fs.renameSync(tmp, filePath);
        return { oldSize, newSize };
      } else {
        fs.unlinkSync(tmp);
        return { oldSize, newSize: oldSize };
      }
    }
  } catch (_) {}
  return null;
}

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  // ─── Screenshots desktop retina 2x ──────────────────────────────────────────
  {
    const context = await browser.newContext({
      viewport: { width: 400, height: 820 },
      deviceScaleFactor: 2
    });
    await context.addInitScript(CHROME_MOCK);
    const page = await context.newPage();
    page.on('pageerror', err => console.error('[pageerror]', err.message));

    await page.goto(POPUP_HTML);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => document.querySelectorAll('.metric-chip-value').length >= 4, { timeout: 5000 }).catch(() => {});

    // 01 — Operações idle
    console.log('→ 01-operacoes.png');
    await injectLogs(page, LOGS_IDLE);
    await setRunning(page, false);
    await setMetrics(page, 0, 0, '—', 'OK');
    await page.screenshot({ path: path.join(OUT_DIR, '01-operacoes.png'), fullPage: true });

    // 02 — Operações rodando (logs cheios)
    console.log('→ 02-operacoes-rodando.png');
    await injectLogs(page, LOGS_RODANDO);
    await setRunning(page, true);
    await setMetrics(page, 47, 2, 'CONECTA…', '7-12s');
    await page.screenshot({ path: path.join(OUT_DIR, '02-operacoes-rodando.png'), fullPage: true });

    // 03 — Histórico (Chart.js renderizado)
    console.log('→ 03-historico.png');
    await page.click('button[data-tab="historico"]');
    await page.waitForFunction(() => document.body.getAttribute('data-tab') === 'historico', { timeout: 3000 }).catch(() => {});
    await page.waitForFunction(() => {
      const c = document.getElementById('chartConsultas');
      return c && c.getBoundingClientRect().height > 0;
    }, { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT_DIR, '03-historico.png'), fullPage: true });

    // 04 — Configurações
    console.log('→ 04-config.png');
    await page.click('button[data-tab="config"]');
    await page.waitForFunction(() => document.body.getAttribute('data-tab') === 'config', { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, '04-config.png'), fullPage: true });

    await context.close();
  }

  // ─── Screenshot compact notebook (360x620 retina) ───────────────────────────
  {
    const context = await browser.newContext({
      viewport: { width: 360, height: 620 },
      deviceScaleFactor: 2
    });
    await context.addInitScript(CHROME_MOCK);
    const page = await context.newPage();
    await page.goto(POPUP_HTML);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(400);

    console.log('→ 05-compact-notebook.png');
    await injectLogs(page, LOGS_RODANDO);
    await setRunning(page, true);
    await setMetrics(page, 47, 2, 'CONECTA…', '7-12s');
    await page.screenshot({ path: path.join(OUT_DIR, '05-compact-notebook.png'), fullPage: false });

    await context.close();
  }

  // ─── GIF do fluxo start→reserva→sucesso ─────────────────────────────────────
  {
    console.log('→ demo-fluxo.gif (gerando frames...)');
    const context = await browser.newContext({
      viewport: { width: 400, height: 820 },
      deviceScaleFactor: 1
    });
    await context.addInitScript(CHROME_MOCK);
    const page = await context.newPage();
    await page.goto(POPUP_HTML);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => document.querySelectorAll('.metric-chip-value').length >= 4, { timeout: 5000 }).catch(() => {});

    let frameIdx = 0;
    const snap = async (holdMs = 800) => {
      const file = path.join(FRAMES_DIR, `frame-${String(frameIdx).padStart(4, '0')}.png`);
      await page.screenshot({ path: file, fullPage: false });
      frameIdx++;
      // Repete frame pra dar pausa visual (cada frame = 200ms no GIF a 5fps)
      const repeats = Math.max(1, Math.floor(holdMs / 200));
      for (let i = 1; i < repeats; i++) {
        const dup = path.join(FRAMES_DIR, `frame-${String(frameIdx).padStart(4, '0')}.png`);
        fs.copyFileSync(file, dup);
        frameIdx++;
      }
    };

    // Cena 1: estado idle
    await injectLogs(page, []);
    await setRunning(page, false);
    await setMetrics(page, 0, 0, '—', 'OK');
    await snap(1000);

    // Cena 2: clique iniciar (rodando, sem logs ainda)
    await setRunning(page, true);
    await snap(600);

    // Cena 3: logs aparecendo gradualmente
    for (let i = 1; i <= LOGS_RODANDO.length; i++) {
      await injectLogs(page, LOGS_RODANDO.slice(0, i));
      // Atualiza métricas conforme reservas acontecem
      const reservasAteAgora = LOGS_RODANDO.slice(0, i).filter(l => l[2] === 'log-vaga').length;
      await setMetrics(page, Math.min(i * 6, 47), reservasAteAgora, 'CONECTA…', '7-12s');
      await snap(700);
    }

    // Cena final segura
    await snap(1500);

    await context.close();

    // ffmpeg: frames → gif otimizado
    console.log('→ ffmpeg montando GIF...');
    const gifPath = path.join(OUT_DIR, 'demo-fluxo.gif');
    const palettePath = path.join(FRAMES_DIR, 'palette.png');
    // gera palette pra qualidade decente
    spawnSync('ffmpeg', [
      '-y',
      '-framerate', '5',
      '-i', path.join(FRAMES_DIR, 'frame-%04d.png'),
      '-vf', 'palettegen=max_colors=128',
      palettePath
    ], { stdio: 'inherit' });
    spawnSync('ffmpeg', [
      '-y',
      '-framerate', '5',
      '-i', path.join(FRAMES_DIR, 'frame-%04d.png'),
      '-i', palettePath,
      '-lavfi', 'paletteuse=dither=bayer:bayer_scale=5',
      '-loop', '0',
      gifPath
    ], { stdio: 'inherit' });

    fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
    console.log(`✓ GIF: ${gifPath} (${(fs.statSync(gifPath).size / 1024).toFixed(0)} KB)`);
  }

  await browser.close();

  // ─── Recomprime PNGs via ffmpeg ─────────────────────────────────────────────
  console.log('\n→ Recomprimindo PNGs com ffmpeg...');
  const pngs = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.png'));
  let savedTotal = 0;
  for (const f of pngs) {
    const r = recompressPNG(path.join(OUT_DIR, f));
    if (r) {
      const saved = r.oldSize - r.newSize;
      savedTotal += saved;
      console.log(`  ${f}: ${(r.oldSize / 1024).toFixed(0)}KB → ${(r.newSize / 1024).toFixed(0)}KB (-${(saved / 1024).toFixed(0)}KB)`);
    }
  }
  console.log(`✓ Total economizado: ${(savedTotal / 1024).toFixed(0)}KB`);

  console.log('\n✓ Screenshots em:', OUT_DIR);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
