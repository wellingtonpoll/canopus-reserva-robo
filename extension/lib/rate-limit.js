// extension/lib/rate-limit.js — token bucket + circuit breaker.
// Deps: state (BUCKET_CAPACITY, BUCKET_REFILL_PER_SEC, CIRCUIT_*, sleep),
//       telemetria, notifications, telegram.

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
    telemetria("bucket.empty", { waitSec, tokens });
    await sleep(waitSec * 1000);
    tokens = 1;
    lastRefill = Date.now();
  }

  tokens -= 1;
  await chrome.storage.session.set({ bucket: { tokens, lastRefill } });
}

async function registrarHitERateLimit() {
  const sess = await chrome.storage.session.get(["hitsRecentes", "circuitAberto", "isRunning"]);
  if (!sess.isRunning) return { circuitOpen: false, ignored: true };
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
    telemetria("circuit.opened", { hits: CIRCUIT_HITS_THRESHOLD, windowSec: CIRCUIT_WINDOW_MS/1000, openMin: CIRCUIT_OPEN_MS/60000 });
    await telegramNotify(msg);
    return { circuitOpen: true };
  }

  await chrome.storage.session.set({ hitsRecentes: recentes, rateLimitHit: true });
  return { circuitOpen: false };
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.tomarToken = tomarToken;
  self.registrarHitERateLimit = registrarHitERateLimit;
}
if (typeof module !== "undefined") {
  module.exports = { tomarToken, registrarHitERateLimit };
}
