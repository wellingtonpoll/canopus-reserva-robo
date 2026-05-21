const BASE_URL = "https://prod-api-portalparceiro-canopus.bsn.dev.br";
const ORIGIN_URL = "https://parceiros.consorciocanopus.com.br";
const alarmName = "canopusMonitor";
const MAX_TENTATIVAS_NET = 4;             // retries só pra erros de rede
const RATE_LIMIT_BACKOFF_FACTOR = 2.0;    // AIMD multiplicative increase
const SUCCESS_DECAY_FACTOR = 0.9;         // AIMD multiplicative decrease (gentle)
const MAX_DYNAMIC_DELAY = 60;             // ceiling em segundos

// Token bucket — prevenção dura de taxa de saída (strict — sem burst)
const BUCKET_CAPACITY       = 1;          // sem burst
const BUCKET_REFILL_PER_SEC = 0.1;        // 1 token a cada 10s, 6 req/min sustained max

// Circuit breaker
const CIRCUIT_HITS_THRESHOLD = 2;         // 2 hits em janela → abre
const CIRCUIT_WINDOW_MS      = 120_000;   // janela de 2min — captura hits espaçados
const CIRCUIT_OPEN_MS        = 10 * 60_000; // pausa de 10min

// Floor obrigatório de DELAY_MIN/MAX (anti-rate-limit)
const FLOOR_DELAY_MIN = 7;                // alinhado com refill ~10s
const FLOOR_DELAY_MAX = 12;

// Cap interno em setTimeout — SW pode morrer; alarm re-ativa a cada 1min
const MAX_SETTIMEOUT_MS = 60_000;

// Backoff longo em rate limit no runPollingLoop
const RATE_LIMIT_BACKOFF_SEC          = 60;
const CLOUDFLARE_1015_BACKOFF_SEC     = 120;

// Smart idle
const IDLE_INCREMENT     = 0.3;           // 30% a mais por ciclo vazio
const IDLE_MAX_CICLOS    = 5;             // cap em 5 ciclos vazios

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function agendarProximoCiclo(ms) {
  const at = Date.now() + ms;
  await chrome.storage.session.set({ nextRunAt: at });
  setTimeout(runPollingLoop, Math.min(ms, MAX_SETTIMEOUT_MS));
}

async function tomarToken() {
  const sess = await chrome.storage.session.get(["bucket"]);
  let tokens     = (sess.bucket && sess.bucket.tokens     != null) ? Number(sess.bucket.tokens)     : BUCKET_CAPACITY;
  let lastRefill = (sess.bucket && sess.bucket.lastRefill != null) ? Number(sess.bucket.lastRefill) : Date.now();

  const now = Date.now();
  const elapsedSec = Math.max(0, (now - lastRefill) / 1000);
  tokens = Math.min(BUCKET_CAPACITY, tokens + elapsedSec * BUCKET_REFILL_PER_SEC);
  lastRefill = now;

  if (tokens < 1) {
    const waitSec = (1 - tokens) / BUCKET_REFILL_PER_SEC;
    notificarPopup(`⏱️ Token bucket vazio — aguardando ${waitSec.toFixed(1)}s`);
    await sleep(waitSec * 1000);
    tokens = 1;
    lastRefill = Date.now();
  }

  tokens -= 1;
  await chrome.storage.session.set({ bucket: { tokens, lastRefill } });
}

async function registrarHitERateLimit() {
  const sess = await chrome.storage.session.get(["hitsRecentes", "circuitAberto"]);
  if (sess.circuitAberto && Date.now() < sess.circuitAberto) {
    // Já estamos com circuito aberto; só marca rateLimitHit
    await chrome.storage.session.set({ rateLimitHit: true });
    return { circuitOpen: true };
  }

  const agora = Date.now();
  const recentes = (Array.isArray(sess.hitsRecentes) ? sess.hitsRecentes : [])
    .filter(t => agora - t < CIRCUIT_WINDOW_MS);
  recentes.push(agora);

  if (recentes.length >= CIRCUIT_HITS_THRESHOLD) {
    const ate = agora + CIRCUIT_OPEN_MS;
    await chrome.storage.session.set({
      hitsRecentes: [],
      circuitAberto: ate,
      rateLimitHit: true
    });
    const msg = `🛑 Circuit breaker aberto — ${CIRCUIT_HITS_THRESHOLD} hits em ${CIRCUIT_WINDOW_MS/1000}s. Pausando ${CIRCUIT_OPEN_MS/60000}min`;
    notificarPopup(msg);
    await telegramNotify(msg);
    return { circuitOpen: true };
  }

  await chrome.storage.session.set({ hitsRecentes: recentes, rateLimitHit: true });
  return { circuitOpen: false };
}

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

function parseRetryAfter(header) {
  if (!header) return 0;
  const sec = parseInt(header, 10);
  if (!isNaN(sec) && sec >= 0) return sec;
  const ts = Date.parse(header);
  if (!isNaN(ts)) return Math.max(0, Math.ceil((ts - Date.now()) / 1000));
  return 0;
}

async function apiPost(path, body, tentativaNet = 0) {
  await tomarToken();
  const headers = getHeaders();
  let resp;
  try {
    resp = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  } catch (netErr) {
    if (tentativaNet < MAX_TENTATIVAS_NET) {
      const wait = 5000 + Math.random() * 10000;
      notificarPopup(`⚠️ Erro de rede. Aguardando ${(wait / 1000).toFixed(0)}s...`);
      await sleep(wait);
      return apiPost(path, body, tentativaNet + 1);
    }
    throw netErr;
  }

  if (resp.status === 429 || resp.status === 403) {
    const retryAfterHeader = resp.headers && typeof resp.headers.get === "function"
      ? resp.headers.get("retry-after")
      : null;
    const retryAfterSec = parseRetryAfter(retryAfterHeader);
    let bodyText = "";
    try {
      if (resp && typeof resp.clone === "function") {
        bodyText = await resp.clone().text();
      } else if (resp && typeof resp.text === "function") {
        bodyText = await resp.text();
      }
    } catch (_) { /* corpo ilegível — segue sem detecção 1015 */ }
    const cloudflare1015 = /1015|rate.?limited/i.test(bodyText);

    await registrarHitERateLimit();

    const err = new Error("RATE_LIMIT");
    err.status = resp.status;
    err.retryAfterSec = retryAfterSec;
    err.cloudflare1015 = cloudflare1015;
    throw err;
  }

  if (!resp.ok) throw new Error(`HTTP ${resp.status} em ${path}`);
  return resp.json();
}

async function ajustarDelayDinamico() {
  const { DELAY_MIN = 5, DELAY_MAX = 10 } = await chrome.storage.local.get(["DELAY_MIN", "DELAY_MAX"]);
  const floorMin = Number(DELAY_MIN);
  const floorMax = Number(DELAY_MAX);

  const sess = (await chrome.storage.session.get(["rateLimitHit", "currentMin", "currentMax"])) || {};
  let cMin = sess.currentMin != null ? Number(sess.currentMin) : floorMin;
  let cMax = sess.currentMax != null ? Number(sess.currentMax) : floorMax;

  if (sess.rateLimitHit) {
    cMin = Math.min(cMin * RATE_LIMIT_BACKOFF_FACTOR, MAX_DYNAMIC_DELAY);
    cMax = Math.min(cMax * RATE_LIMIT_BACKOFF_FACTOR, MAX_DYNAMIC_DELAY);
    notificarPopup(`⚙️ Rate limit detectado → delay ajustado para ${cMin.toFixed(1)}-${cMax.toFixed(1)}s`);
  } else {
    const novoMin = cMin * SUCCESS_DECAY_FACTOR;
    const novoMax = cMax * SUCCESS_DECAY_FACTOR;
    cMin = Math.max(novoMin, floorMin);
    cMax = Math.max(novoMax, floorMax);
  }

  if (cMax < cMin) cMax = cMin;

  await chrome.storage.session.set({
    currentMin: cMin,
    currentMax: cMax,
    rateLimitHit: false
  });

  return { currentMin: cMin, currentMax: cMax };
}

async function fazerLogin() {
  const { USUARIO, SENHA } = await chrome.storage.local.get(["USUARIO", "SENHA"]);
  const data = await apiPost("/auth/enterPlataforma", {
    Usuario: String(USUARIO || "").padStart(10, "0"),
    Senha: SENHA || "",
    Ip: "",
    Browser: "Chrome",
    Acesso: "USR"
  });
  if (!data.success || !Array.isArray(data.data) || data.data.length === 0) {
    throw new Error("LOGIN_FALHOU: resposta inválida");
  }
  return data.data[0];
}

async function buscarGrupos(idUsuario) {
  const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
  return apiPost(`/reservas/listGruposReserva/${idUsuario}`, {
    IdUsuario: idUsuario,
    Usuario: String(USUARIO || "").padStart(10, "0")
  });
}

async function reservar(grupo, idUsuario, idEmpresa) {
  const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
  return apiPost("/reservas/add", {
    IdEmpresa: idEmpresa,
    IdUsuario: idUsuario,
    Usuario: String(USUARIO || "").padStart(10, "0"),
    ID_Grupo: grupo.ID_Grupo,
    ID_Bem: grupo.ID_Bem,
    ID_Produto: grupo.ID_Produto,
    NM_Produto: grupo.NM_Produto,
    PZ_Comercializacao: grupo.PZ_Comercializacao
  });
}

function extrairGrupos(resp) {
  if (!resp || !Array.isArray(resp.data)) return [];
  const outer = resp.data;
  // API devolve { data: [[ {grupo}, ... ]] } — array aninhado
  if (outer.length > 0 && Array.isArray(outer[0])) return outer[0];
  // Fallback: caso já venha flat
  return outer;
}

function extrairReserva(resp) {
  if (!resp || !Array.isArray(resp.data)) return {};
  const first = resp.data[0];
  if (first && typeof first === "object" && !Array.isArray(first)) return first;
  if (Array.isArray(first) && first.length > 0 && typeof first[0] === "object") return first[0];
  return {};
}

function formatarDataBR(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = n => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function usuarioExibicao(usr) {
  const u = String(usr || "").trim();
  return u.replace(/^0+/, "") || u;
}

function brasilNowParts(date) {
  const d = date || new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = fmt.formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // Intl em alguns runtimes devolve "24" à meia-noite
  return {
    weekday: wdMap[get("weekday")] ?? 0,
    hour,
    minute: parseInt(get("minute"), 10),
    second: parseInt(get("second"), 10),
    year: parseInt(get("year"), 10),
    month: parseInt(get("month"), 10),
    day: parseInt(get("day"), 10)
  };
}

const ABERTURA_HHMM      = 7 * 60 + 55;   // 07:55
const FECHAMENTO_SEMANA  = 19 * 60 + 1;   // 19:01
const FECHAMENTO_SABADO  = 13 * 60;       // 13:00

function sistemaEstaAberto(date) {
  const { weekday, hour, minute } = brasilNowParts(date);
  const hhmm = hour * 60 + minute;
  if (weekday >= 1 && weekday <= 5) return hhmm >= ABERTURA_HHMM && hhmm < FECHAMENTO_SEMANA;
  if (weekday === 6)                return hhmm >= ABERTURA_HHMM && hhmm < FECHAMENTO_SABADO;
  return false;
}

function proximaAberturaBR(date) {
  const now = brasilNowParts(date);
  const hhmm = now.hour * 60 + now.minute;

  let y = now.year, m = now.month, d = now.day, wd = now.weekday;
  const hojeValidoEAntes =
    ((wd >= 1 && wd <= 5) || wd === 6) && hhmm < ABERTURA_HHMM;

  if (!hojeValidoEAntes) {
    // Avança até próximo dia válido (não-domingo)
    do {
      const t = new Date(Date.UTC(y, m - 1, d));
      t.setUTCDate(t.getUTCDate() + 1);
      y  = t.getUTCFullYear();
      m  = t.getUTCMonth() + 1;
      d  = t.getUTCDate();
      wd = t.getUTCDay();
    } while (wd === 0);
  }

  const pad = n => String(n).padStart(2, "0");
  const dataStr = `${pad(d)}/${pad(m)}/${y} às 07:55:00`;
  // BR fixo em UTC-03:00 (sem DST desde 2019)
  const target = new Date(`${y}-${pad(m)}-${pad(d)}T07:55:00-03:00`);
  const ms = Math.max(0, target.getTime() - Date.now());
  return { dataStr, ms };
}

function parseGruposConfig(configStr) {
  const alvo = {};
  if (!configStr) return alvo;
  for (const item of configStr.split(",")) {
    const parts = item.trim().split(":");
    if (parts.length === 2 && parts[0].trim() && !isNaN(parseInt(parts[1], 10))) {
      alvo[parts[0].trim()] = parseInt(parts[1], 10);
    }
  }
  return alvo;
}

function removerGrupoDoConfig(configStr, grupoId) {
  if (!configStr) return "";
  return configStr
    .split(",")
    .map(s => s.trim())
    .filter(s => !s.startsWith(grupoId + ":"))
    .join(",");
}

function notificarPopup(text) {
  chrome.runtime.sendMessage({ action: "log", text }).catch(() => {});
}

async function telegramNotify(msg) {
  const { TELEGRAM_TOKEN, TELEGRAM_CHAT_ID } = await chrome.storage.local.get([
    "TELEGRAM_TOKEN", "TELEGRAM_CHAT_ID"
  ]);
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg })
    });
  } catch (_) {}
}

async function reservarComLimite(grupo, uid, eid, grupoId, limite, reservasPorGrupo, modoTeste) {
  if (modoTeste) {
    notificarPopup(`[TESTE] Simularia reserva: ${grupo.NM_Produto} (Grupo ${grupoId})`);
    return { teste: true, grupoId, produto: grupo.NM_Produto };
  }

  const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
  const usuarioFmt = usuarioExibicao(USUARIO);
  const agora = formatarDataBR(new Date().toISOString());

  const msgEncontrada = `🍀 Cota ${grupoId} encontrada para o usuário ${usuarioFmt} em ${agora}!`;
  notificarPopup(msgEncontrada);
  await telegramNotify(msgEncontrada);

  const result = await reservar(grupo, uid, eid);

  if (!(result && result.success)) {
    const details = String((result && (result.details || result.message)) || "");
    const detailsLower = details.toLowerCase();
    const bodyStr = JSON.stringify(result || {}).toLowerCase();

    if (detailsLower.includes("restrição vigente") || detailsLower.includes("restricao vigente")) {
      throw new Error("SISTEMA_FECHADO");
    }

    if (detailsLower.includes("limite de reservas desse produto")) {
      const idProd = grupo.ID_Produto;
      const sess = await chrome.storage.session.get(["produtosBloqueados"]);
      const lista = Array.isArray(sess.produtosBloqueados) ? sess.produtosBloqueados : [];
      if (!lista.includes(idProd)) {
        lista.push(idProd);
        await chrome.storage.session.set({ produtosBloqueados: lista });
      }
      const msg = `💣 Erro: "${details}" Removendo o produto: ${grupo.NM_Produto} do grupo ${grupoId}.`;
      notificarPopup(msg);
      await telegramNotify(msg);
      return { reservou: false, grupoId, produto: grupo.NM_Produto, produtoBloqueado: true };
    }

    if (bodyStr.includes("1015") || bodyStr.includes("rate_limited") || bodyStr.includes("\"429\"") || bodyStr.includes("\"403\"")) {
      await chrome.storage.session.set({ rateLimitHit: true });
    }

    if (details) {
      notificarPopup(`❌ Erro ao reservar: ${details}`);
    }
    return { reservou: false, grupoId, produto: grupo.NM_Produto, details };
  }

  const novoTotal = (reservasPorGrupo[grupoId] || 0) + 1;
  reservasPorGrupo[grupoId] = novoTotal;
  await chrome.storage.local.set({ reservasPorGrupo });

  const reserva = extrairReserva(result);
  const cota = String(reserva.CodigoCota || reserva.CD_Cota || "N/D");
  const produtoNome = reserva.NomeProduto || grupo.NM_Produto || "N/D";
  const dtReserva = formatarDataBR(reserva.DataReserva || reserva.DT_Reserva);
  const dtValidade = formatarDataBR(reserva.DataValidade || reserva.DT_Validade);

  const msgReserva =
    `🎉 Reservado!\n` +
    `Usuário: ${usuarioFmt}\n` +
    `Grupo: ${grupoId}\n` +
    `Cota: ${cota}\n` +
    `Produto: ${produtoNome}\n` +
    `Data da Reserva: ${dtReserva}\n` +
    `Válido até: ${dtValidade}`;

  notificarPopup(msgReserva);
  await telegramNotify(msgReserva);

  const concluido = novoTotal >= limite;
  if (concluido) {
    const conclusao = `✅ Grupo ${grupoId} concluído — ${limite} reservas feitas`;
    notificarPopup(conclusao);
    await telegramNotify(conclusao);
    const { GRUPOS_CONFIG } = await chrome.storage.local.get(["GRUPOS_CONFIG"]);
    const novoConfig = removerGrupoDoConfig(GRUPOS_CONFIG, grupoId);
    await chrome.storage.local.set({ GRUPOS_CONFIG: novoConfig });
  }

  return { reservou: true, grupoId, produto: grupo.NM_Produto, novoTotal, limite, concluido, cota };
}

async function runMonitorCycle() {
  const stored = await chrome.storage.local.get([
    "idUsuario", "idEmpresa", "GRUPOS_CONFIG", "MODO_TESTE"
  ]);
  let uid = stored.idUsuario;
  let eid = stored.idEmpresa;

  if (!uid) {
    const loginData = await fazerLogin();
    uid = loginData.IdUsuario;
    eid = loginData.IdEmpresa;
    await chrome.storage.local.set({ idUsuario: uid, idEmpresa: eid });
    const loginMsg = "✅ Login realizado com sucesso!";
    notificarPopup(loginMsg);
    await telegramNotify(loginMsg);
  }

  const gruposResp = await buscarGrupos(uid);
  const gruposAlvo = parseGruposConfig(stored.GRUPOS_CONFIG);
  const grupos = extrairGrupos(gruposResp);

  notificarPopup(`📦 ${grupos.length} grupos consultados`);

  const { reservasPorGrupo = {} } = await chrome.storage.local.get(["reservasPorGrupo"]);
  const sessProdutos = await chrome.storage.session.get(["produtosBloqueados"]);
  const produtosBloqueados = Array.isArray(sessProdutos.produtosBloqueados) ? sessProdutos.produtosBloqueados : [];
  const detectados = [];

  for (const grupo of grupos) {
    const codigo = String(grupo.CD_Grupo || "");
    if (!(codigo in gruposAlvo)) continue;

    const limite = gruposAlvo[codigo];
    const feitas = reservasPorGrupo[codigo] || 0;
    if (feitas >= limite) continue;

    if (produtosBloqueados.includes(grupo.ID_Produto)) continue;

    detectados.push({ grupo, grupoId: codigo, limite });
  }

  if (detectados.length === 0) {
    notificarPopup(`💥 Nenhuma cota disponível no momento...`);
    const sessIdle = await chrome.storage.session.get(["ciclosVazios"]);
    const novosVazios = Math.min(Number(sessIdle.ciclosVazios || 0) + 1, IDLE_MAX_CICLOS);
    await chrome.storage.session.set({ ciclosVazios: novosVazios });
    return;
  }

  // Vagas detectadas → reset idle counter
  await chrome.storage.session.set({ ciclosVazios: 0 });

  const lista = Object.keys(gruposAlvo).sort().join(", ");
  notificarPopup(`🔍 Buscando por cotas: ${lista}...`);

  await Promise.allSettled(
    detectados.map(d =>
      reservarComLimite(d.grupo, uid, eid, d.grupoId, d.limite, reservasPorGrupo, stored.MODO_TESTE)
    )
  );
}

async function dormirAteAbertura() {
  const { dataStr, ms } = proximaAberturaBR();
  const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
  const usuarioFmt = usuarioExibicao(USUARIO);
  const sess = await chrome.storage.session.get(["sistemaFechadoLogged"]);
  if (!sess.sistemaFechadoLogged) {
    const msg = `⛔ Sistema fechado. Próxima abertura: ${dataStr}.`;
    notificarPopup(msg);
    await telegramNotify(msg);
    await chrome.storage.session.set({ sistemaFechadoLogged: true, usuarioFechado: usuarioFmt });
  }
  const sleepMs = Math.max(1000, Math.min(ms, 1000 * 60 * 60));
  await agendarProximoCiclo(sleepMs);
}

async function runPollingLoop() {
  const { isRunning, nextRunAt } = await chrome.storage.session.get(["isRunning", "nextRunAt"]);
  if (!isRunning) return;

  // State machine guard — respeita o próximo schedule independente de quem disparou (alarm vs setTimeout)
  if (nextRunAt && Date.now() < nextRunAt) {
    const restanteMs = nextRunAt - Date.now();
    setTimeout(runPollingLoop, Math.min(restanteMs, MAX_SETTIMEOUT_MS));
    return;
  }

  const { MODO_TESTE } = await chrome.storage.local.get(["MODO_TESTE"]);

  // Circuit breaker — verifica antes de qualquer request
  const sessCb = await chrome.storage.session.get(["circuitAberto"]);
  if (sessCb.circuitAberto && Date.now() < sessCb.circuitAberto) {
    const restanteMs = sessCb.circuitAberto - Date.now();
    notificarPopup(`🛑 Circuit breaker aberto. Próxima tentativa em ${(restanteMs/1000).toFixed(0)}s`);
    await agendarProximoCiclo(restanteMs);
    return;
  }
  if (sessCb.circuitAberto && Date.now() >= sessCb.circuitAberto) {
    await chrome.storage.session.set({ circuitAberto: null, hitsRecentes: [] });
    notificarPopup(`✅ Circuit breaker fechado. Retomando.`);
  }

  // Horário comercial — bypass em modo teste pra permitir validação a qualquer hora
  if (!MODO_TESTE && !sistemaEstaAberto()) {
    await dormirAteAbertura();
    return;
  }

  // Transição fechado → aberto: avisa retomada
  const sessF = await chrome.storage.session.get(["sistemaFechadoLogged"]);
  if (sessF.sistemaFechadoLogged) {
    const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
    const usuarioFmt = usuarioExibicao(USUARIO);
    const agora = formatarDataBR(new Date().toISOString());
    const msg = `🚀 Retomando buscas no usuário ${usuarioFmt} em ${agora}.`;
    notificarPopup(msg);
    await telegramNotify(msg);
    await chrome.storage.session.set({ sistemaFechadoLogged: false });
  }

  try {
    await runMonitorCycle();
  } catch (error) {
    if (error.message === "SISTEMA_FECHADO") {
      await chrome.storage.session.set({ sistemaFechadoLogged: false });
      await dormirAteAbertura();
      return;
    }

    if (error.message === "RATE_LIMIT") {
      const baseWait = error.cloudflare1015
        ? CLOUDFLARE_1015_BACKOFF_SEC
        : Math.max(error.retryAfterSec || 0, RATE_LIMIT_BACKOFF_SEC);
      const fonte = error.cloudflare1015 ? "🔥 Cloudflare 1015" : `⛔ Rate limit (HTTP ${error.status || 429})`;
      const msg = `${fonte} — pausando ${baseWait}s antes de retry`;
      notificarPopup(msg);
      await telegramNotify(msg);
      await agendarProximoCiclo(baseWait * 1000);
      return;
    }

    console.error("❌ Erro no ciclo:", error.message);
    notificarPopup(`❌ Erro: ${error.message}`);
    await telegramNotify(`❌ Erro no robô: ${error.message}`);

    if (error.message.includes("LOGIN_FALHOU") || error.message.includes("HTTP 401")) {
      await chrome.storage.local.remove(["idUsuario", "idEmpresa"]);
    }
  }

  const { currentMin, currentMax } = await ajustarDelayDinamico();

  // Smart idle multiplier
  const { ciclosVazios = 0 } = await chrome.storage.session.get(["ciclosVazios"]);
  const idleMultiplier = 1 + IDLE_INCREMENT * Math.min(Number(ciclosVazios), IDLE_MAX_CICLOS);

  // Jitter triangular (bias suave pro centro do intervalo)
  const u = Math.random();
  const triangular = u < 0.5
    ? Math.sqrt(u * 0.5)
    : 1 - Math.sqrt((1 - u) * 0.5);
  const baseDelay = currentMin + triangular * Math.max(0, currentMax - currentMin);
  const delay = baseDelay * idleMultiplier;

  await agendarProximoCiclo(delay * 1000);
}

async function iniciarMonitoramento() {
  const local = await chrome.storage.local.get(["DELAY_MIN", "DELAY_MAX"]);
  let dMin = Number(local.DELAY_MIN);
  let dMax = Number(local.DELAY_MAX);
  if (!isFinite(dMin) || dMin <= 0) dMin = FLOOR_DELAY_MIN;
  if (!isFinite(dMax) || dMax <= 0) dMax = FLOOR_DELAY_MAX;

  // Floor enforcement — bloqueia config muito agressiva
  if (dMin < FLOOR_DELAY_MIN) {
    notificarPopup(`⚙️ DELAY_MIN ajustado de ${dMin}s para ${FLOOR_DELAY_MIN}s (anti-rate-limit)`);
    dMin = FLOOR_DELAY_MIN;
  }
  if (dMax < FLOOR_DELAY_MAX) {
    dMax = Math.max(FLOOR_DELAY_MAX, dMin);
  }
  if (dMax < dMin) dMax = dMin;
  // Persistir de volta no local pra UI refletir
  await chrome.storage.local.set({ DELAY_MIN: dMin, DELAY_MAX: dMax });

  await chrome.storage.session.set({
    isRunning: true,
    rateLimitHit: false,
    sistemaFechadoLogged: false,
    produtosBloqueados: [],
    currentMin: dMin,
    currentMax: dMax,
    bucket: { tokens: BUCKET_CAPACITY, lastRefill: Date.now() },
    hitsRecentes: [],
    circuitAberto: null,
    ciclosVazios: 0,
    nextRunAt: null
  });
  await chrome.alarms.create(alarmName, { periodInMinutes: 1 });
  runPollingLoop();
}

async function pararMonitoramento() {
  await chrome.storage.session.set({ isRunning: false });
  await chrome.alarms.clear(alarmName);
  await chrome.storage.local.remove(["idUsuario", "idEmpresa"]);
  notificarPopup("⏹ Monitoramento parado");
}

// Alarm como fallback: reativa loop se SW foi encerrado pelo browser.
// Respeita nextRunAt — não fura schedule do RATE_LIMIT/circuit/etc.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== alarmName) return;
  const { isRunning, nextRunAt } = await chrome.storage.session.get(["isRunning", "nextRunAt"]);
  if (!isRunning) return;
  if (nextRunAt && Date.now() < nextRunAt) return;
  runPollingLoop();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "start") {
    iniciarMonitoramento()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.action === "stop") {
    pararMonitoramento()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// Exports para testes automatizados (ignorado no browser)
if (typeof module !== "undefined") {
  module.exports = {
    parseGruposConfig,
    removerGrupoDoConfig,
    apiPost,
    parseRetryAfter,
    ajustarDelayDinamico,
    tomarToken,
    registrarHitERateLimit,
    extrairGrupos,
    extrairReserva,
    formatarDataBR,
    usuarioExibicao,
    sistemaEstaAberto,
    proximaAberturaBR,
    brasilNowParts,
    fazerLogin,
    reservarComLimite,
    runMonitorCycle,
    telegramNotify,
    sleep,
    BUCKET_CAPACITY,
    BUCKET_REFILL_PER_SEC,
    CIRCUIT_HITS_THRESHOLD,
    CIRCUIT_WINDOW_MS,
    CIRCUIT_OPEN_MS,
    FLOOR_DELAY_MIN,
    FLOOR_DELAY_MAX,
    agendarProximoCiclo
  };
}
