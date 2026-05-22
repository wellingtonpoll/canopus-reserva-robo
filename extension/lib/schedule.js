// extension/lib/schedule.js — agendamento de ciclos + AIMD dinamic delay.
// Deps: state (MAX_SETTIMEOUT_MS, RATE_LIMIT_BACKOFF_FACTOR, SUCCESS_DECAY_FACTOR,
//              MAX_DYNAMIC_DELAY), notifications.
// agendarProximoCiclo referencia runPollingLoop (loop.js, carregado depois mas
// resolvido lazy via global no momento do setTimeout).

async function agendarProximoCiclo(ms) {
  const at = Date.now() + ms;
  await chrome.storage.session.set({ nextRunAt: at });
  setTimeout(runPollingLoop, Math.min(ms, MAX_SETTIMEOUT_MS));
}

async function ajustarDelayDinamico() {
  const { DELAY_MIN = 5, DELAY_MAX = 10 } = await chrome.storage.local.get(["DELAY_MIN", "DELAY_MAX"]);
  const floorMin = Number(DELAY_MIN);
  const floorMax = Number(DELAY_MAX);

  const sess = (await chrome.storage.session.get(["rateLimitHit", "currentMin", "currentMax", "isRunning"])) || {};
  if (!sess.isRunning) {
    return { currentMin: floorMin, currentMax: floorMax };
  }
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

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.agendarProximoCiclo = agendarProximoCiclo;
  self.ajustarDelayDinamico = ajustarDelayDinamico;
}
if (typeof module !== "undefined") {
  module.exports = { agendarProximoCiclo, ajustarDelayDinamico };
}
