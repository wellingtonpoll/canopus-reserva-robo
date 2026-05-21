const startBtn         = document.getElementById('startBtn');
const stopBtn          = document.getElementById('stopBtn');
const statusBadge      = document.getElementById('statusBadge');
const statusDot        = document.getElementById('statusDot');
const statusText       = document.getElementById('statusText');
const logsEl           = document.getElementById('logs');
const saveBtn          = document.getElementById('saveBtn');
const clearBtn         = document.getElementById('clearBtn');
const copyBtn          = document.getElementById('copyBtn');
const exportTelemBtn   = document.getElementById('exportTelemetriaBtn');
const clearCacheBtn    = document.getElementById('clearCacheBtn');
const modoTesteChk     = document.getElementById('modoTeste');
const telemetriaChk    = document.getElementById('telemetriaLigada');
const logsBadge        = document.getElementById('logsBadge');
const metricCiclos     = document.getElementById('metricCiclos');
const metricReservas   = document.getElementById('metricReservas');
const metricPortal     = document.getElementById('metricPortal');
const metricErro       = document.getElementById('metricErro');
const dashConsultas    = document.getElementById('dashConsultas');
const dashReservas     = document.getElementById('dashReservas');
const dashCiclos       = document.getElementById('dashCiclos');
const dashRateLimit    = document.getElementById('dashRateLimit');
const metricRate       = document.getElementById('metricRate');
const metricErroWrap   = document.getElementById('metricErroWrap');
const tabButtons       = document.querySelectorAll('.tab-btn');
const exportCsvBtn     = document.getElementById('exportCsvBtn');
const confirmDialog    = document.getElementById('confirmDialog');
const confirmDialogTitle = document.getElementById('confirmDialogTitle');
const confirmDialogBody = document.getElementById('confirmDialogBody');
const confirmDialogOk  = document.getElementById('confirmDialogOk');
const confirmDialogCancel = document.getElementById('confirmDialogCancel');

// Fix 14 U6: dialog custom substitui confirm() nativo do navegador
function confirmCustom(titulo, corpo, okLabel = 'Confirmar') {
  return new Promise(resolve => {
    if (!confirmDialog || typeof confirmDialog.showModal !== 'function') {
      // Fallback se <dialog> não suportado (improvável em Chrome moderno)
      resolve(confirm(corpo));
      return;
    }
    confirmDialogTitle.textContent = titulo;
    confirmDialogBody.textContent = corpo;
    confirmDialogOk.textContent = okLabel;
    const cleanup = () => {
      confirmDialogOk.removeEventListener('click', onOk);
      confirmDialogCancel.removeEventListener('click', onCancel);
      confirmDialog.removeEventListener('close', onCancel);
    };
    const onOk = () => { cleanup(); confirmDialog.close(); resolve(true); };
    const onCancel = () => { cleanup(); confirmDialog.close(); resolve(false); };
    confirmDialogOk.addEventListener('click', onOk);
    confirmDialogCancel.addEventListener('click', onCancel);
    confirmDialog.addEventListener('close', onCancel);
    confirmDialog.showModal();
  });
}

const PORTAL_TAB_URL = 'https://parceiros.consorciocanopus.com.br/apps/*';
const METRICAS_REFRESH_MS = 3000;
let metricasTimer = null;
let chartConsultas = null;
let chartReservas = null;
let chartTaxaSucesso = null;
let chartTaxaRateLimit = null;

function setActiveTab(tab) {
  document.body.setAttribute('data-tab', tab);
  tabButtons.forEach(btn => {
    btn.setAttribute('aria-selected', btn.dataset.tab === tab ? 'true' : 'false');
  });
  try { chrome.storage.session.set({ activeTab: tab }); } catch (_) {}
  if (tab === 'historico') atualizarChartsHistorico();
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
});

function emitirTelemetriaPopup(acao, dados = {}) {
  try {
    chrome.runtime.sendMessage({
      action: 'telemetria',
      tipo: 'popup.action',
      dados: { acao, ...dados }
    });
  } catch (_) { /* ignore */ }
}

// M8: botão Telemetria sempre visível, mas disabled quando off ou buffer vazio.
// Garante que cliente que esquece de exportar antes de desligar não perde acesso ao
// que está no buffer naquele instante (apesar de toggle off limpar buffer no flush).
function setExportTelemetriaState(ligada) {
  if (!exportTelemBtn) return;
  exportTelemBtn.hidden = false;
  exportTelemBtn.disabled = !ligada;
  exportTelemBtn.title = ligada
    ? 'Exportar telemetria (.json)'
    : 'Ligue a telemetria nas Configurações pra exportar';
}

let dirty = false;

function setDirty(value) {
  dirty = !!value;
  saveBtn.setAttribute('data-dirty', dirty ? 'true' : 'false');
}

async function salvarConfig() {
  const delayMin = parseFloat(document.getElementById('delayMin').value) || 1;
  const delayMax = parseFloat(document.getElementById('delayMax').value) || 3;

  await chrome.storage.local.set({
    USUARIO:           document.getElementById('usuario').value.trim(),
    SENHA:             document.getElementById('senha').value,
    GRUPOS_CONFIG:     document.getElementById('grupos').value.trim(),
    DELAY_MIN:         delayMin,
    DELAY_MAX:         Math.max(delayMax, delayMin),
    TELEGRAM_TOKEN:    document.getElementById('telegramToken').value.trim(),
    TELEGRAM_CHAT_ID:  document.getElementById('telegramChatId').value.trim(),
    MODO_TESTE:        modoTesteChk.checked,
    TELEMETRIA_LIGADA: telemetriaChk ? !!telemetriaChk.checked : false
  });
  setDirty(false);
}

function setRunningState(running) {
  if (running) {
    statusText.textContent = 'MONITORANDO';
    statusBadge.className = 'status-pill-inline running';
    statusDot.className = 'status-dot-inline active';
    startBtn.disabled = true;
    stopBtn.disabled = false;
    if (logsBadge) {
      logsBadge.textContent = 'MONITORANDO';
      logsBadge.setAttribute('data-state', 'monitorando');
    }
  } else {
    statusText.textContent = 'PARADO';
    statusBadge.className = 'status-pill-inline';
    statusDot.className = 'status-dot-inline';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    if (logsBadge) {
      logsBadge.textContent = 'PARADO';
      logsBadge.setAttribute('data-state', 'parado');
    }
  }
}

async function atualizarMetricas() {
  try {
    const dia = new Date().toLocaleDateString('en-CA'); // BRT-aware via browser TZ
    const [local, sess] = await Promise.all([
      chrome.storage.local.get(['metricasDia', 'metricasHoras']),
      chrome.storage.session.get(['currentMin', 'currentMax', 'circuitAberto', 'ultimoErro'])
    ]);

    // Fix 14 U1: restaura último erro persistido
    if (sess.ultimoErro && sess.ultimoErro.texto && metricErro && metricErroWrap) {
      metricErro.textContent = sess.ultimoErro.texto.slice(0, 80);
      metricErro.setAttribute('title', sess.ultimoErro.texto);
      metricErroWrap.hidden = false;
    }
    const m = (local.metricasDia && local.metricasDia[dia]) || { ciclos: 0, reservas: 0, consultas: 0 };

    if (metricCiclos)   metricCiclos.textContent   = String(m.ciclos);
    if (metricReservas) metricReservas.textContent = String(m.reservas);

    // Dashboard cards
    if (dashConsultas) dashConsultas.textContent = String(m.consultas || 0);
    if (dashReservas)  dashReservas.textContent  = String(m.reservas);
    if (dashCiclos)    dashCiclos.textContent    = String(m.ciclos);
    const cMin = Number(sess.currentMin || 0).toFixed(0);
    const cMax = Number(sess.currentMax || 0).toFixed(0);
    let rateText, rateState;
    if (sess.circuitAberto && Date.now() < sess.circuitAberto) {
      rateText = 'BLOQ';
      rateState = 'error';
    } else if (cMin > 15 || cMax > 30) {
      rateText = `${cMin}-${cMax}s`;
      rateState = 'warn';
    } else {
      rateText = cMin && cMax ? `${cMin}-${cMax}s` : 'OK';
      rateState = 'ok';
    }
    if (metricRate) {
      metricRate.textContent = rateText;
      metricRate.setAttribute('data-state', rateState);
    }
    if (dashRateLimit) {
      dashRateLimit.textContent = rateText === 'BLOQ' ? 'BLOQUEADO' : rateText;
      dashRateLimit.setAttribute('data-state', rateState);
    }

  } catch (_) {}

  // Status portal
  try {
    if (chrome.tabs && chrome.tabs.query) {
      const tabs = await chrome.tabs.query({ url: PORTAL_TAB_URL });
      const conectado = tabs && tabs.length > 0;
      if (metricPortal) {
        metricPortal.textContent = conectado ? 'CONECTADO' : 'DESCONECTADO';
        metricPortal.setAttribute('data-state', conectado ? 'on' : 'off');
      }
    }
  } catch (_) {
    if (metricPortal) {
      metricPortal.textContent = '—';
      metricPortal.setAttribute('data-state', 'idle');
    }
  }
}


// ─── Histórico (Fix 13): 4 gráficos de 30 dias ──────────────────────────────

function ultimosDias(n) {
  const arr = [];
  const hoje = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    arr.push(d.toISOString().slice(0, 10));
  }
  return arr;
}

function labelCurto(dia) {
  // "2026-05-21" → "21/05"
  return dia.slice(8, 10) + '/' + dia.slice(5, 7);
}

function ehrCommonOpts(extra) {
  return Object.assign({
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { intersect: false } },
    scales: {
      x: {
        ticks: {
          font: { family: 'JetBrains Mono', size: 8 },
          color: '#7e775f',
          autoSkip: true,
          autoSkipPadding: 4,
          maxRotation: 0
        },
        grid: { display: false }
      },
      y: {
        beginAtZero: true,
        ticks: { font: { family: 'JetBrains Mono', size: 8 }, color: '#7e775f', precision: 0 },
        grid: { color: '#f5f3f3' }
      }
    }
  }, extra || {});
}

function inicializarChartsHistorico() {
  if (typeof Chart === 'undefined') return;
  const dias = ultimosDias(30);
  const labels = dias.map(labelCurto);
  const zeros = new Array(dias.length).fill(0);

  const consultasEl = document.getElementById('chartConsultas');
  if (consultasEl && !chartConsultas) {
    chartConsultas = new Chart(consultasEl.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Consultas', data: zeros.slice(), backgroundColor: '#ffd700', borderRadius: 3 }] },
      options: ehrCommonOpts()
    });
  }
  const reservasEl = document.getElementById('chartReservas');
  if (reservasEl && !chartReservas) {
    chartReservas = new Chart(reservasEl.getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Reservas', data: zeros.slice(), backgroundColor: '#69db7c', borderRadius: 3 }] },
      options: ehrCommonOpts()
    });
  }
  const taxaSucEl = document.getElementById('chartTaxaSucesso');
  if (taxaSucEl && !chartTaxaSucesso) {
    chartTaxaSucesso = new Chart(taxaSucEl.getContext('2d'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Taxa', data: zeros.slice(), borderColor: '#705d00', backgroundColor: 'rgba(255,215,0,0.15)', fill: true, tension: 0.3, pointRadius: 2 }] },
      options: ehrCommonOpts({ scales: { x: { ticks: { font: { family: 'JetBrains Mono', size: 8 }, color: '#7e775f', autoSkip: true, autoSkipPadding: 4, maxRotation: 0 }, grid: { display: false } }, y: { beginAtZero: true, max: 100, ticks: { font: { family: 'JetBrains Mono', size: 8 }, color: '#7e775f', callback: v => v + '%' }, grid: { color: '#f5f3f3' } } } })
    });
  }
  const taxaRlEl = document.getElementById('chartTaxaRateLimit');
  if (taxaRlEl && !chartTaxaRateLimit) {
    chartTaxaRateLimit = new Chart(taxaRlEl.getContext('2d'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Rate Limit', data: zeros.slice(), borderColor: '#ba1a1a', backgroundColor: 'rgba(186,26,26,0.1)', fill: true, tension: 0.3, pointRadius: 2 }] },
      options: ehrCommonOpts({ scales: { x: { ticks: { font: { family: 'JetBrains Mono', size: 8 }, color: '#7e775f', autoSkip: true, autoSkipPadding: 4, maxRotation: 0 }, grid: { display: false } }, y: { beginAtZero: true, max: 100, ticks: { font: { family: 'JetBrains Mono', size: 8 }, color: '#7e775f', callback: v => v + '%' }, grid: { color: '#f5f3f3' } } } })
    });
  }
}

async function atualizarChartsHistorico() {
  if (typeof Chart === 'undefined') {
    // Fix 14 U7: Chart.js não carregou (rede bloqueou? bundle missing?). Avisa cliente.
    console.warn('[popup] Chart.js não disponível — gráficos histórico vazios');
    return;
  }
  if (!chartConsultas) return;
  try {
    const { metricasDia = {} } = await chrome.storage.local.get(['metricasDia']);
    const dias = ultimosDias(30);
    const dataConsultas = [];
    const dataReservas = [];
    const dataTaxaSuc = [];
    const dataTaxaRl = [];
    for (const dia of dias) {
      const m = metricasDia[dia] || { consultas: 0, reservas: 0, ciclos: 0, rateLimits: 0 };
      dataConsultas.push(m.consultas || 0);
      dataReservas.push(m.reservas || 0);
      const taxa = m.consultas > 0 ? (m.reservas / m.consultas) * 100 : 0;
      dataTaxaSuc.push(Number(taxa.toFixed(1)));
      const totalReq = (m.consultas || 0) + (m.rateLimits || 0);
      const taxaRl = totalReq > 0 ? ((m.rateLimits || 0) / totalReq) * 100 : 0;
      dataTaxaRl.push(Number(taxaRl.toFixed(1)));
    }
    chartConsultas.data.datasets[0].data = dataConsultas;
    chartReservas.data.datasets[0].data = dataReservas;
    chartTaxaSucesso.data.datasets[0].data = dataTaxaSuc;
    chartTaxaRateLimit.data.datasets[0].data = dataTaxaRl;
    chartConsultas.update('none');
    chartReservas.update('none');
    chartTaxaSucesso.update('none');
    chartTaxaRateLimit.update('none');
  } catch (_) {}
}

function exportarCsv() {
  chrome.storage.local.get(['metricasDia']).then(({ metricasDia = {} }) => {
    const dias = ultimosDias(30);
    // Fix 14 U8: detecta histórico vazio e avisa cliente em vez de gerar arquivo de zeros
    const temDados = dias.some(d => {
      const m = metricasDia[d];
      return m && ((m.ciclos|0) + (m.consultas|0) + (m.reservas|0) + (m.rateLimits|0)) > 0;
    });
    if (!temDados) {
      addLog('ℹ️ Sem dados pra exportar — robô ainda não rodou nesses 30 dias.');
      return;
    }
    const linhas = ['dia,ciclos,consultas,reservas,rate_limits,taxa_sucesso_pct,taxa_rate_limit_pct'];
    for (const dia of dias) {
      const m = metricasDia[dia] || { ciclos: 0, consultas: 0, reservas: 0, rateLimits: 0 };
      const consultas = m.consultas || 0;
      const reservas = m.reservas || 0;
      const rateLimits = m.rateLimits || 0;
      const taxaSuc = consultas > 0 ? ((reservas / consultas) * 100).toFixed(2) : '0.00';
      const totalReq = consultas + rateLimits;
      const taxaRl = totalReq > 0 ? ((rateLimits / totalReq) * 100).toFixed(2) : '0.00';
      linhas.push(`${dia},${m.ciclos || 0},${consultas},${reservas},${rateLimits},${taxaSuc},${taxaRl}`);
    }
    const csv = linhas.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().slice(0,10).replace(/-/g,'');
    a.href = url;
    a.download = `canopus-metricas-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog(`📊 Métricas exportadas — ${dias.length} dias.`);
  });
}

function registrarUltimoErro(texto) {
  if (!metricErro) return;
  const t = (texto || '').replace(/[❌💣]/g, '').trim();
  if (!t) return;
  metricErro.textContent = t.slice(0, 80);
  metricErro.setAttribute('title', t);
  if (metricErroWrap) metricErroWrap.hidden = false;
}

const MAX_LOGS = 500;
let scrollPending = false;

function addLog(text) {
  const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let cls = 'log-info';

  // Erros (vermelho)
  if (text.includes('❌') || text.includes('💣') || text.includes('ERRO')) {
    cls = 'log-error';
  }
  // Sucesso de reserva — destaque (verde negrito)
  else if (text.includes('🎉') || text.startsWith('🎉 Reservado!') || text.includes('RESERVADA')) {
    cls = 'log-vaga';
  }
  // Sucesso geral (verde)
  else if (text.includes('✅') || text.includes('🍀')) {
    cls = 'log-success';
  }
  // Avisos / status / rate limit / horário (amarelo)
  else if (
    text.startsWith('[TESTE]') ||
    text.includes('⚠️') || text.includes('Rate') ||
    text.includes('🔍') || text.includes('⚙️') ||
    text.includes('🚀') || text.includes('⛔')
  ) {
    cls = 'log-warn';
  }
  // 📦, 💥, demais — log-info (cinza)

  if (cls === 'log-error') registrarUltimoErro(text);

  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="log-time">${time}</span><span class="${cls}">${escapeHtml(text)}</span>`;
  logsEl.appendChild(line);

  // H2: cap pra evitar DOM crescer indefinidamente em sessão longa
  while (logsEl.childElementCount > MAX_LOGS) {
    logsEl.removeChild(logsEl.firstElementChild);
  }

  // M2: agrupa scrolls em 1 RAF pra evitar forced reflow em rajadas de log
  if (!scrollPending) {
    scrollPending = true;
    requestAnimationFrame(() => {
      logsEl.scrollTop = logsEl.scrollHeight;
      scrollPending = false;
    });
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sendAction(action, onSuccess, onError) {
  chrome.runtime.sendMessage({ action }, (response) => {
    if (chrome.runtime.lastError) {
      addLog(`❌ Erro: ${chrome.runtime.lastError.message}`);
      onError?.();
      return;
    }
    if (!response?.ok) {
      addLog(`❌ Falha: ${response?.error || 'desconhecido'}`);
      onError?.();
      return;
    }
    onSuccess?.();
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  // Restaura tab ativa
  try {
    const { activeTab } = await chrome.storage.session.get(['activeTab']);
    if (activeTab === 'config' || activeTab === 'operacoes') setActiveTab(activeTab);
  } catch (_) {}

  inicializarChartsHistorico();
  atualizarChartsHistorico();

  const { isRunning } = await chrome.storage.session.get(['isRunning']);
  setRunningState(!!isRunning);

  const cfg = await chrome.storage.local.get([
    'USUARIO', 'SENHA', 'GRUPOS_CONFIG',
    'DELAY_MIN', 'DELAY_MAX',
    'TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID',
    'MODO_TESTE',
    'TELEMETRIA_LIGADA'
  ]);
  if (cfg.USUARIO)              document.getElementById('usuario').value = cfg.USUARIO;
  if (cfg.SENHA)                document.getElementById('senha').value = cfg.SENHA;
  if (cfg.GRUPOS_CONFIG)        document.getElementById('grupos').value = cfg.GRUPOS_CONFIG;
  if (cfg.DELAY_MIN != null)    document.getElementById('delayMin').value = cfg.DELAY_MIN;
  if (cfg.DELAY_MAX != null)    document.getElementById('delayMax').value = cfg.DELAY_MAX;
  if (cfg.TELEGRAM_TOKEN)       document.getElementById('telegramToken').value = cfg.TELEGRAM_TOKEN;
  if (cfg.TELEGRAM_CHAT_ID)     document.getElementById('telegramChatId').value = cfg.TELEGRAM_CHAT_ID;
  if (cfg.MODO_TESTE)           modoTesteChk.checked = cfg.MODO_TESTE;
  if (cfg.TELEMETRIA_LIGADA && telemetriaChk) telemetriaChk.checked = true;
  setExportTelemetriaState(!!cfg.TELEMETRIA_LIGADA);

  setDirty(false);

  // Marca dirty quando o usuário muda qualquer campo de input. Toggle MODO_TESTE
  // também marca dirty pra que start auto-salve o estado do switch.
  const inputs = document.querySelectorAll(
    '#usuario, #senha, #grupos, #delayMin, #delayMax, #telegramToken, #telegramChatId'
  );
  inputs.forEach(el => el.addEventListener('input', () => setDirty(true)));
  modoTesteChk.addEventListener('change', () => setDirty(true));

  if (telemetriaChk) {
    telemetriaChk.addEventListener('change', async () => {
      // Fix 14 U2: telemetria SALVA imediatamente — não marca dirty (telemetria
      // não está no array de inputs que marcam dirty, então OK; não precisa override)
      const ligada = telemetriaChk.checked;
      await chrome.storage.local.set({ TELEMETRIA_LIGADA: ligada });
      setExportTelemetriaState(ligada);
      if (!ligada) {
        chrome.runtime.sendMessage({ action: 'clear_telemetria_buffer' });
        addLog('🧹 Telemetria desligada — buffer limpo.');
      } else {
        addLog('📡 Telemetria ligada — captura iniciada.');
      }
    });
  }

  // D6: footer métricas atualiza ao montar + a cada N segundos
  atualizarMetricas();
  if (metricasTimer) clearInterval(metricasTimer);
  metricasTimer = setInterval(atualizarMetricas, METRICAS_REFRESH_MS);

  // Fix 14 U5: pausa timer quando side panel oculto pra não queimar CPU
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (metricasTimer) {
        clearInterval(metricasTimer);
        metricasTimer = null;
      }
    } else {
      atualizarMetricas();
      if (!metricasTimer) {
        metricasTimer = setInterval(atualizarMetricas, METRICAS_REFRESH_MS);
      }
    }
  });
});

startBtn.addEventListener('click', async () => {
  const wasDirty = dirty;
  // Auto-save: se há alterações não salvas em qualquer campo, salva antes de iniciar.
  // Reduz fricção do erro comum "esqueci de salvar".
  if (dirty) {
    await salvarConfig();
    addLog('💾 Alterações não salvas — salvei antes de iniciar.');
  } else {
    // Mesmo sem dirty, MODO_TESTE precisa estar persistido (fallback de segurança)
    await chrome.storage.local.set({ MODO_TESTE: modoTesteChk.checked });
  }

  const modoTeste = modoTesteChk.checked;
  emitirTelemetriaPopup('start', { modoTeste, autoSalvou: wasDirty });
  sendAction('start',
    () => {
      setRunningState(true);
      addLog(`🚀 Monitoramento iniciado${modoTeste ? ' — MODO TESTE' : ''}`);
    },
    () => {}
  );
});

stopBtn.addEventListener('click', () => {
  emitirTelemetriaPopup('stop');
  sendAction('stop',
    () => {
      setRunningState(false);
    },
    () => {}
  );
});

saveBtn.addEventListener('click', async () => {
  await salvarConfig();
  emitirTelemetriaPopup('save');
  addLog('✅ Configurações salvas');
});

clearBtn.addEventListener('click', async () => {
  if (logsEl.childElementCount === 0) return;
  const ok = await confirmCustom('Limpar logs', 'Limpar todos os logs do painel? Esta ação não pode ser desfeita.', 'Limpar');
  if (!ok) return;
  logsEl.innerHTML = '';
});

copyBtn.addEventListener('click', async () => {
  const lines = Array.from(logsEl.querySelectorAll('.log-line')).map(line => line.textContent.trim());
  if (lines.length === 0) {
    addLog('ℹ️ Nada para copiar — logs vazios.');
    return;
  }
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    addLog(`📋 ${lines.length} linhas copiadas para o clipboard.`);
  } catch (err) {
    addLog(`❌ Falha ao copiar: ${err.message || err}`);
  }
});

if (exportCsvBtn) exportCsvBtn.addEventListener('click', exportarCsv);

if (clearCacheBtn) {
  clearCacheBtn.addEventListener('click', async () => {
    const ok = await confirmCustom(
      'Limpar cache da extensão',
      'Isto vai apagar PERMANENTEMENTE:\n' +
      '• Configurações salvas (usuário, senha, grupos, delays, Telegram)\n' +
      '• Métricas agregadas (ciclos, reservas, histórico 30 dias)\n' +
      '• Buffer de telemetria\n' +
      '• Logs em memória\n\n' +
      'Não afeta sessão do portal Canopus no navegador.',
      'Limpar tudo'
    );
    if (!ok) return;

    try {
      // Para o robô se estiver rodando
      try { await chrome.runtime.sendMessage({ action: 'stop' }); } catch (_) {}

      // Limpa storage local + session
      await Promise.all([
        chrome.storage.local.clear(),
        chrome.storage.session.clear()
      ]);

      // Cancela alarms
      if (chrome.alarms && chrome.alarms.clearAll) {
        await chrome.alarms.clearAll();
      }

      // Limpa UI
      logsEl.innerHTML = '';
      document.querySelectorAll('input[type="text"], input[type="password"], input[type="number"]').forEach(el => { el.value = ''; });
      modoTesteChk.checked = false;
      if (telemetriaChk) telemetriaChk.checked = false;
      setExportTelemetriaState(false);
      setDirty(false);
      setRunningState(false);

      addLog('🧹 Cache da extensão limpo. Reconfigure pra usar novamente.');
    } catch (err) {
      addLog(`❌ Falha ao limpar cache: ${err.message || err}`);
    }
  });
}

if (exportTelemBtn) {
  exportTelemBtn.addEventListener('click', async () => {
    // Garante que tudo em memória foi gravado antes do download
    try { await chrome.runtime.sendMessage({ action: 'flush_telemetria' }); } catch (_) {}
    const { telemetria_buffer } = await chrome.storage.local.get(['telemetria_buffer']);
    const entries = Array.isArray(telemetria_buffer) ? telemetria_buffer : [];
    if (entries.length === 0) {
      addLog('ℹ️ Buffer de telemetria vazio.');
      return;
    }
    const payload = {
      exportadoEm: new Date().toISOString(),
      versao: chrome.runtime.getManifest && chrome.runtime.getManifest().version,
      entries
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    const ts =
      String(now.getFullYear()) +
      String(now.getMonth()+1).padStart(2,'0') +
      String(now.getDate()).padStart(2,'0') + '-' +
      String(now.getHours()).padStart(2,'0') +
      String(now.getMinutes()).padStart(2,'0') +
      String(now.getSeconds()).padStart(2,'0');
    a.href = url;
    a.download = `canopus-telemetria-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog(`📥 Telemetria exportada — ${entries.length} eventos.`);
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'log') {
    addLog(message.text);
  }
});

document.querySelectorAll('[data-collapsible]').forEach((card) => {
  const header = card.querySelector('.card-header');
  const body   = card.querySelector('.card-body');
  if (!header || !body) return;

  const open = () => {
    header.setAttribute('aria-expanded', 'true');
    body.style.maxHeight = body.scrollHeight + 'px';
    const onEnd = (e) => {
      if (e.propertyName !== 'max-height') return;
      body.style.maxHeight = 'none';
      body.removeEventListener('transitionend', onEnd);
    };
    body.addEventListener('transitionend', onEnd);
  };

  const close = () => {
    header.setAttribute('aria-expanded', 'false');
    body.style.maxHeight = body.scrollHeight + 'px';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      body.style.maxHeight = '0';
    }));
  };

  header.addEventListener('click', () => {
    const expanded = header.getAttribute('aria-expanded') === 'true';
    if (expanded) close(); else open();
  });
});
