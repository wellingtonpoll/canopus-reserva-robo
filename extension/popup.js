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
const modoTesteChk     = document.getElementById('modoTeste');
const telemetriaChk    = document.getElementById('telemetriaLigada');

function emitirTelemetriaPopup(acao, dados = {}) {
  try {
    chrome.runtime.sendMessage({
      action: 'telemetria',
      tipo: 'popup.action',
      dados: { acao, ...dados }
    });
  } catch (_) { /* ignore */ }
}

function setExportTelemetriaVisible(visible) {
  if (!exportTelemBtn) return;
  exportTelemBtn.hidden = !visible;
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
    statusText.textContent = 'Monitorando';
    statusBadge.className = 'status-pill running';
    statusDot.className = 'status-dot active';
    startBtn.disabled = true;
    stopBtn.disabled = false;
  } else {
    statusText.textContent = 'Parado';
    statusBadge.className = 'status-pill';
    statusDot.className = 'status-dot';
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

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

  const line = document.createElement('div');
  line.className = 'log-line';
  line.innerHTML = `<span class="log-time">${time}</span><span class="${cls}">${escapeHtml(text)}</span>`;
  logsEl.appendChild(line);
  logsEl.scrollTop = logsEl.scrollHeight;
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
  setExportTelemetriaVisible(!!cfg.TELEMETRIA_LIGADA);

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
      const ligada = telemetriaChk.checked;
      await chrome.storage.local.set({ TELEMETRIA_LIGADA: ligada });
      setExportTelemetriaVisible(ligada);
      if (!ligada) {
        // Toggle off → limpa buffer pra não deixar dados velhos no storage
        chrome.runtime.sendMessage({ action: 'clear_telemetria_buffer' });
        addLog('🧹 Telemetria desligada — buffer limpo.');
      } else {
        addLog('📡 Telemetria ligada — captura iniciada.');
      }
    });
  }
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

clearBtn.addEventListener('click', () => {
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
