// ===============================================
// CANOPUS RESERVA ROBÔ - BACKGROUND SERVICE WORKER
// ===============================================

const BASE_URL = "https://prod-api-portalparceiro-canopus.bsn.dev.br";
const ORIGIN_URL = "https://parceiros.consorciocanopus.com.br";

let config = {};
let isRunning = false;
let alarmName = "canopusMonitor";

// Headers fixos (exatamente como no Python)
function getHeaders() {
  return {
    "secret": "e4537470554544d8a5909f16fca68f9b",
    "token": "f33da0eae2de47028f59c60f125c2da3",
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": ORIGIN_URL,
    "Referer": `${ORIGIN_URL}/pages/auth/login`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
  };
}

// Carregar configurações
async function loadConfig() {
  const data = await chrome.storage.local.get(null);
  config = data;
  console.log("✅ Config carregada:", config);
}

// Funções principais (traduzidas do seu Python)
async function fazerLogin() {
  const url = `${BASE_URL}/auth/enterPlataforma`;
  const payload = {
    Usuario: String(config.USUARIO).padStart(10, '0'),
    Senha: config.SENHA,
    Ip: "",
    Browser: "Chrome",
    Acesso: "USR"
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(payload)
  });

  const data = await resp.json();
  if (!data.success || !data.data) {
    throw new Error("LOGIN_FALHOU");
  }
  return data.data[0];
}

async function buscarGrupos(idUsuario) {
  const url = `${BASE_URL}/reservas/listGruposReserva/${idUsuario}`;
  const payload = {
    IdUsuario: idUsuario,
    Usuario: String(config.USUARIO).padStart(10, '0')
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(payload)
  });

  return await resp.json();
}

async function reservar(grupo, idUsuario, idEmpresa) {
  const url = `${BASE_URL}/reservas/add`;
  const payload = {
    IdEmpresa: idEmpresa,
    IdUsuario: idUsuario,
    Usuario: String(config.USUARIO).padStart(10, '0'),
    ID_Grupo: grupo.ID_Grupo,
    ID_Bem: grupo.ID_Bem,
    ID_Produto: grupo.ID_Produto,
    NM_Produto: grupo.NM_Produto,
    PZ_Comercializacao: grupo.PZ_Comercializacao
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(payload)
  });

  return await resp.json();
}

// Função principal de monitoramento (loop)
async function startMonitoring() {
  if (isRunning) return;
  isRunning = true;

  console.log("🚀 Iniciando monitoramento Canopus...");

  try {
    const loginData = await fazerLogin();
    const idUsuario = loginData.IdUsuario;
    const idEmpresa = loginData.IdEmpresa;

    console.log("✅ Login realizado com sucesso!");

    // Aqui vamos implementar o loop completo em próximas iterações
    // Por enquanto, só testando login + busca
    const grupos = await buscarGrupos(idUsuario);
    console.log("📦 Grupos recebidos:", grupos);

  } catch (error) {
    console.error("❌ Erro no monitoramento:", error);
  }
}

// Listener do alarm (melhor prática para Service Worker MV3)
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === alarmName && isRunning) {
    startMonitoring();
  }
});

// Inicialização
chrome.runtime.onInstalled.addListener(() => {
  loadConfig();
});

console.log("🔥 Background Service Worker do Canopus Robô carregado!");
