// ─── Spec 01: carrega libs em ordem topológica ───────────────────────────────
// SW context (Chrome MV3): importScripts é síncrono e popula self.X
// Node test context (Jest): chrome-mock.js shim do importScripts faz require + Object.assign(global)
if (typeof importScripts !== "undefined") {
  importScripts('lib/state.js', 'lib/format.js', 'lib/notifications.js', 'lib/horario.js', 'lib/telemetria.js', 'lib/telegram.js', 'lib/rate-limit.js', 'lib/schedule.js', 'lib/api.js', 'lib/auth.js', 'lib/grupos.js', 'lib/turnstile.js', 'lib/portal.js', 'lib/reserva.js', 'lib/cycle.js', 'lib/loop.js');
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
  Object.assign(global, require('./lib/loop'));
}

// Telemetria movida pra lib/telemetria.js (Spec 01) — getTelemetriaLigada,
// sanitize, telemetria, flushTelemetria, persistirBatchPendente, __reset* etc.

// sleep movido pra lib/state.js (Spec 01)

// tomarToken + registrarHitERateLimit movidos pra lib/rate-limit.js (Spec 01)
// agendarProximoCiclo + ajustarDelayDinamico movidos pra lib/schedule.js (Spec 01)

// getHeaders, parseRetryAfter, apiPost movidos pra lib/api.js (Spec 01)

// fazerLogin movido pra lib/auth.js (Spec 01)

// buscarGrupos movido pra lib/grupos.js (Spec 01)



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
