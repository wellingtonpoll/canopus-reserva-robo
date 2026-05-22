// extension/lib/lifecycle.js — iniciarMonitoramento + pararMonitoramento.
// Deps: state (FLOOR_DELAY_MIN/MAX, BUCKET_CAPACITY, alarmName),
//       telemetria, notifications, loop (runPollingLoop).

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

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.iniciarMonitoramento = iniciarMonitoramento;
  self.pararMonitoramento = pararMonitoramento;
}
if (typeof module !== "undefined") {
  module.exports = { iniciarMonitoramento, pararMonitoramento };
}
