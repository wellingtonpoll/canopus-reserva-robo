let isRunning = false;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusEl = document.getElementById('status');
const logsEl = document.getElementById('logs');

function addLog(message) {
  const time = new Date().toLocaleTimeString('pt-BR');
  logsEl.textContent += `[${time}] ${message}\n`;
  logsEl.scrollTop = logsEl.scrollHeight;
}

startBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'start' });
  isRunning = true;
  statusEl.textContent = 'Status: RODANDO';
  startBtn.disabled = true;
  stopBtn.disabled = false;
  addLog('🚀 Monitoramento iniciado pelo usuário');
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stop' });
  isRunning = false;
  statusEl.textContent = 'Status: Parado';
  startBtn.disabled = false;
  stopBtn.disabled = true;
  addLog('⏹️ Monitoramento parado pelo usuário');
});

// Receber logs do background
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'log') {
    addLog(message.text);
  }
});

console.log('Popup carregado');