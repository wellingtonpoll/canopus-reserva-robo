// ─── Spec 01: carrega libs em ordem topológica ───────────────────────────────
// SW context (Chrome MV3): importScripts é síncrono e popula self.X
// Node test context (Jest): chrome-mock.js shim do importScripts faz require + Object.assign(global)
if (typeof importScripts !== "undefined") {
  importScripts('lib/state.js', 'lib/format.js', 'lib/notifications.js', 'lib/horario.js', 'lib/telemetria.js', 'lib/telegram.js', 'lib/rate-limit.js', 'lib/schedule.js', 'lib/api.js', 'lib/auth.js', 'lib/grupos.js', 'lib/turnstile.js', 'lib/portal.js', 'lib/reserva.js', 'lib/cycle.js');
}
if (typeof require !== "undefined" && typeof module !== "undefined") {
  Object.assign(global, require('./lib/state'));
  Object.assign(global, require('./lib/format'));
  Object.assign(global, require('./lib/notifications'));
  Object.assign(global, require('./lib/horario'));
  Object.assign(global, require('./lib/telemetria'));
  Object.assign(global, require('./lib/telegram'));
  Object.assign(global, require('./lib/rate-limit'));
  Object.assign(global, require('./lib/schedule'));
  Object.assign(global, require('./lib/api'));
  Object.assign(global, require('./lib/auth'));
  Object.assign(global, require('./lib/grupos'));
  Object.assign(global, require('./lib/turnstile'));
  Object.assign(global, require('./lib/portal'));
  Object.assign(global, require('./lib/reserva'));
  Object.assign(global, require('./lib/cycle'));
}

// Telemetria movida pra lib/telemetria.js (Spec 01) — getTelemetriaLigada,
// sanitize, telemetria, flushTelemetria, persistirBatchPendente, __reset* etc.

// sleep movido pra lib/state.js (Spec 01)

// tomarToken + registrarHitERateLimit movidos pra lib/rate-limit.js (Spec 01)
// agendarProximoCiclo + ajustarDelayDinamico movidos pra lib/schedule.js (Spec 01)

// getHeaders, parseRetryAfter, apiPost movidos pra lib/api.js (Spec 01)

// fazerLogin movido pra lib/auth.js (Spec 01)

// buscarGrupos movido pra lib/grupos.js (Spec 01)


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
  // M1: 1 batch read em vez de 4× session.get separados
  const sess = await chrome.storage.session.get([
    "isRunning", "nextRunAt",
    "turnstileBloqueado", "turnstileBloqueadoAte",
    "circuitAberto",
    "sistemaFechadoLogged"
  ]);
  if (!sess.isRunning) return;

  // H3: tenta restaurar batch persistido em SW kill prévia (no-op se vazio)
  await flushTelemetria().catch(() => {});

  // State machine guard — respeita o próximo schedule independente de quem disparou (alarm vs setTimeout)
  if (sess.nextRunAt && Date.now() < sess.nextRunAt) {
    const restanteMs = sess.nextRunAt - Date.now();
    setTimeout(runPollingLoop, Math.min(restanteMs, MAX_SETTIMEOUT_MS));
    return;
  }

  const { MODO_TESTE } = await chrome.storage.local.get(["MODO_TESTE"]);

  // Turnstile interativo — robô pausado até cliente resolver no portal (ou expirar)
  if (sess.turnstileBloqueado && sess.turnstileBloqueadoAte && Date.now() < sess.turnstileBloqueadoAte) {
    const restanteMs = sess.turnstileBloqueadoAte - Date.now();
    setTimeout(runPollingLoop, Math.min(restanteMs, MAX_SETTIMEOUT_MS));
    return;
  }
  if (sess.turnstileBloqueado) {
    await chrome.storage.session.set({ turnstileBloqueado: false, turnstileBloqueadoAte: null });
    await limparBadgeTurnstile();
    notificarPopup(`✅ Pausa por Turnstile encerrada. Retomando.`);
  }

  // Circuit breaker — verifica antes de qualquer request
  if (sess.circuitAberto && Date.now() < sess.circuitAberto) {
    const restanteMs = sess.circuitAberto - Date.now();
    notificarPopup(`🛑 Circuit breaker aberto. Próxima tentativa em ${(restanteMs/1000).toFixed(0)}s`);
    await agendarProximoCiclo(restanteMs);
    return;
  }
  if (sess.circuitAberto && Date.now() >= sess.circuitAberto) {
    await chrome.storage.session.set({ circuitAberto: null, hitsRecentes: [] });
    notificarPopup(`✅ Circuit breaker fechado. Retomando.`);
  }

  // Horário comercial — bypass em modo teste pra permitir validação a qualquer hora
  if (!MODO_TESTE && !sistemaEstaAberto()) {
    await dormirAteAbertura();
    return;
  }

  // Transição fechado → aberto: avisa retomada
  if (sess.sistemaFechadoLogged) {
    const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
    const usuarioFmt = usuarioExibicao(USUARIO);
    const agora = formatarDataBR(new Date().toISOString());
    const msg = `🚀 Retomando buscas no usuário ${usuarioFmt} em ${agora}.`;
    notificarPopup(msg);
    await telegramNotify(msg);
    await chrome.storage.session.set({ sistemaFechadoLogged: false });
  }

  // M9: invalida sessão Canopus se mais velha que TTL — pega caso "robô voltou
  // do SW kill, sessão pode ter expirado no backend"
  const ID_USUARIO_TTL_MS = 6 * 60 * 60 * 1000; // 6h
  const { idUsuarioObtidoEm } = await chrome.storage.local.get(["idUsuarioObtidoEm"]);
  if (idUsuarioObtidoEm && Date.now() - idUsuarioObtidoEm > ID_USUARIO_TTL_MS) {
    await chrome.storage.local.remove(["idUsuario", "idEmpresa", "idUsuarioObtidoEm"]);
    notificarPopup("🔄 Sessão Canopus expirada (>6h). Re-autenticando no próximo ciclo.");
  }

  // Fix 9: mutex pra evitar reentrância (setTimeout + chrome.alarms disparam paralelo).
  // Sem isso, 2 ciclos rodam simultâneo → 2× requests à API → acelera bloqueio Cloudflare.
  const CYCLE_MAX_MS = 90_000;
  const sessLock = await chrome.storage.session.get(["cycleRunning", "cycleRunningSince"]);
  const lockAgora = Date.now();
  if (sessLock.cycleRunning && sessLock.cycleRunningSince && (lockAgora - sessLock.cycleRunningSince) < CYCLE_MAX_MS) {
    telemetria("cycle.skip_reentry", { decorridoMs: lockAgora - sessLock.cycleRunningSince });
    return;
  }
  await chrome.storage.session.set({ cycleRunning: true, cycleRunningSince: lockAgora });

  try {
    try {
      await runMonitorCycle();
    } catch (error) {
      if (error.message === "SISTEMA_FECHADO") {
        await chrome.storage.session.set({ sistemaFechadoLogged: false });
        await dormirAteAbertura();
        return;
      }

      if (error.message === "IP_BANIDO") {
        // Cloudflare baniu o IP do cliente. Não dá retry. Para tudo e alerta crítico.
        const msg = `🚫 IP BANIDO pelo Cloudflare (HTTP ${error.status}). Robô parado. Cliente precisa esperar 24h+ ou trocar de IP/rede.`;
        notificarPopup(msg);
        await registrarUltimoErroPersistente(`IP banido (HTTP ${error.status})`);
        await telegramNotify(msg);
        telemetria("sw.lifecycle", { event: "stopped_ip_banned", body: error.body });
        await flushTelemetria();
        await pararMonitoramento();
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
      await registrarUltimoErroPersistente(`Erro: ${error.message}`);
      await telegramNotify(`❌ Erro no robô: ${error.message}`);

      if (error.message.includes("LOGIN_FALHOU") || error.message.includes("HTTP 401")) {
        await chrome.storage.local.remove(["idUsuario", "idEmpresa", "idUsuarioObtidoEm"]);
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
  } finally {
    await chrome.storage.session.set({ cycleRunning: false, cycleRunningSince: null });
  }
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
  // M9: mantemos idUsuario/idEmpresa entre stops — TTL no runPollingLoop invalida quando >6h
  await chrome.storage.local.remove(["idUsuario", "idEmpresa", "idUsuarioObtidoEm"]);
  notificarPopup("⏹ Monitoramento parado");
  telemetria("sw.lifecycle", { event: "stopped" });
  await flushTelemetria();
  await persistirBatchPendente();
}

// Alarm como fallback: reativa loop se SW foi encerrado pelo browser.
// Respeita nextRunAt — não fura schedule do RATE_LIMIT/circuit/etc.
// Fix 16 Lote B: limpa managedWindow se o cliente fechar a aba gerenciada.
// Próximo reservarViaTab recria via garantirAbaPortal.
if (chrome.tabs && chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === "function") {
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    try {
      const sess = await chrome.storage.session.get(["managedWindow"]);
      const mw = sess.managedWindow;
      if (mw && mw.tabId === tabId) {
        await chrome.storage.session.set({ managedWindow: null });
        telemetria("portal.managed_window_closed", { tabId });
      }
    } catch (_) {}
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== alarmName) return;
  const { isRunning, nextRunAt } = await chrome.storage.session.get(["isRunning", "nextRunAt"]);
  if (!isRunning) return;
  if (nextRunAt && Date.now() < nextRunAt) return;
  runPollingLoop();
});

// handleTurnstileChallenge + limparBadgeTurnstile movidos pra lib/turnstile.js (Spec 01)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;

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
  if (message.action === "turnstile_challenge") {
    handleTurnstileChallenge()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.action === "telemetria") {
    telemetria(message.tipo || "unknown", message.dados || {})
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.action === "clear_telemetria_buffer") {
    // Fix 14 B2: aguarda escrita antes de responder; sem isso sendResponse retorna
    // antes de storage gravar e clear pode ser perdido em SW kill subsequente.
    (async () => {
      __resetTelemetriaBatch();
      try {
        await Promise.all([
          chrome.storage.local.set({ telemetria_buffer: [] }),
          chrome.storage.session.set({ pending_telemetria_batch: [] })
        ]);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "flush_telemetria") {
    flushTelemetria()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// H1: invalida cache da flag quando popup muda valor em storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.TELEMETRIA_LIGADA) {
    __setTelemetriaCacheValue(!!changes.TELEMETRIA_LIGADA.newValue);
  }
});

// Spec 01 (transição): expõe funções ainda em background.js no global pra que
// libs já extraídas (schedule.js, etc) achem referências runtime via lookup.
// Esse bloco some quando todas as funções estiverem em libs próprias.
if (typeof self !== "undefined") {
  Object.assign(self, {
    runPollingLoop,
    iniciarMonitoramento,
    pararMonitoramento,
    runMonitorCycle,
    dormirAteAbertura,
    reservarComLimite,
    handleTurnstileChallenge,
    limparBadgeTurnstile,
    reservarViaTab,
    garantirAbaPortal,
    tentarRecuperarContentScript,
    apiPost,
    parseRetryAfter,
    getHeaders,
    fazerLogin,
    buscarGrupos,
    extrairGrupos,
    extrairReserva,
    parseGruposConfig,
    removerGrupoDoConfig,
    reservar
  });
}

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
    reservarViaTab,
    garantirAbaPortal,
    runMonitorCycle,
    runPollingLoop,
    handleTurnstileChallenge,
    sanitize,
    telemetria,
    flushTelemetria,
    persistirBatchPendente,
    getTelemetriaLigada,
    __resetTelemetriaCache,
    __resetTelemetriaBatch,
    telegramNotify,
    sleep,
    BUCKET_CAPACITY,
    BUCKET_REFILL_PER_SEC,
    CIRCUIT_HITS_THRESHOLD,
    CIRCUIT_WINDOW_MS,
    CIRCUIT_OPEN_MS,
    FLOOR_DELAY_MIN,
    FLOOR_DELAY_MAX,
    TURNSTILE_BLOQUEIO_MS,
    TURNSTILE_COOLDOWN_MS,
    TELEMETRIA_MAX_ENTRIES,
    TELEMETRIA_BATCH_MAX,
    TELEMETRIA_FLUSH_MS,
    TELEMETRIA_BODY_TRUNC,
    agendarProximoCiclo
  };
}
