const startBtn     = document.getElementById('startBtn');
const stopBtn      = document.getElementById('stopBtn');
const statusBadge  = document.getElementById('statusBadge');
const statusDot    = document.getElementById('statusDot');
const statusText   = document.getElementById('statusText');
const logsEl       = document.getElementById('logs');
const saveBtn      = document.getElementById('saveBtn');
const clearBtn     = document.getElementById('clearBtn');
const modoTesteChk = document.getElementById('modoTeste');

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
    'MODO_TESTE'
  ]);
  if (cfg.USUARIO)           document.getElementById('usuario').value = cfg.USUARIO;
  if (cfg.SENHA)             document.getElementById('senha').value = cfg.SENHA;
  if (cfg.GRUPOS_CONFIG)     document.getElementById('grupos').value = cfg.GRUPOS_CONFIG;
  if (cfg.DELAY_MIN != null) document.getElementById('delayMin').value = cfg.DELAY_MIN;
  if (cfg.DELAY_MAX != null) document.getElementById('delayMax').value = cfg.DELAY_MAX;
  if (cfg.TELEGRAM_TOKEN)    document.getElementById('telegramToken').value = cfg.TELEGRAM_TOKEN;
  if (cfg.TELEGRAM_CHAT_ID)  document.getElementById('telegramChatId').value = cfg.TELEGRAM_CHAT_ID;
  if (cfg.MODO_TESTE)        modoTesteChk.checked = cfg.MODO_TESTE;
});

startBtn.addEventListener('click', async () => {
  const modoTeste = modoTesteChk.checked;
  await chrome.storage.local.set({ MODO_TESTE: modoTeste });

  sendAction('start',
    () => {
      setRunningState(true);
      addLog(`🚀 Monitoramento iniciado${modoTeste ? ' — MODO TESTE' : ''}`);
    },
    () => {}
  );
});

stopBtn.addEventListener('click', () => {
  sendAction('stop',
    () => {
      setRunningState(false);
      addLog('⏹ Monitoramento parado');
    },
    () => {}
  );
});

saveBtn.addEventListener('click', async () => {
  const delayMin = parseFloat(document.getElementById('delayMin').value) || 1;
  const delayMax = parseFloat(document.getElementById('delayMax').value) || 3;

  await chrome.storage.local.set({
    USUARIO:          document.getElementById('usuario').value.trim(),
    SENHA:            document.getElementById('senha').value,
    GRUPOS_CONFIG:    document.getElementById('grupos').value.trim(),
    DELAY_MIN:        delayMin,
    DELAY_MAX:        Math.max(delayMax, delayMin),
    TELEGRAM_TOKEN:   document.getElementById('telegramToken').value.trim(),
    TELEGRAM_CHAT_ID: document.getElementById('telegramChatId').value.trim(),
    MODO_TESTE:       modoTesteChk.checked
  });
  addLog('✅ Configurações salvas');
});

clearBtn.addEventListener('click', () => {
  logsEl.innerHTML = '';
});

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
