// extension/lib/telemetria.js — buffer + sanitize + flush + persist.
// Deps: state (TELEMETRIA_MAX_ENTRIES, TELEMETRIA_BATCH_MAX, TELEMETRIA_FLUSH_MS,
//             SANITIZE_REDACT_KEYS, SANITIZE_TRUNCATE_KEYS, SANITIZE_HEADER_KEYS).
//
// Vars module-private (não exportadas): TELEMETRIA_BATCH, TELEMETRIA_FLUSH_TIMER,
// TELEMETRIA_LIGADA_CACHE. Acessadas só pelas funções deste arquivo via closure.

const TELEMETRIA_BATCH = [];
let TELEMETRIA_FLUSH_TIMER = null;

// Cache em memória da flag pra evitar I/O em chrome.storage.local a cada evento.
// `null` = não inicializado (lazy load); `true`/`false` = valor cacheado.
let TELEMETRIA_LIGADA_CACHE = null;

async function getTelemetriaLigada() {
  if (TELEMETRIA_LIGADA_CACHE !== null) return TELEMETRIA_LIGADA_CACHE;
  try {
    const { TELEMETRIA_LIGADA } = await chrome.storage.local.get(["TELEMETRIA_LIGADA"]);
    TELEMETRIA_LIGADA_CACHE = !!TELEMETRIA_LIGADA;
  } catch (_) {
    TELEMETRIA_LIGADA_CACHE = false;
  }
  return TELEMETRIA_LIGADA_CACHE;
}

// Helper pra testes: força re-leitura do storage no próximo getTelemetriaLigada()
function __resetTelemetriaCache() {
  TELEMETRIA_LIGADA_CACHE = null;
}

// Helper pra testes: limpa batch em memória pra evitar pollution entre testes
function __resetTelemetriaBatch() {
  TELEMETRIA_BATCH.length = 0;
  if (TELEMETRIA_FLUSH_TIMER) {
    clearTimeout(TELEMETRIA_FLUSH_TIMER);
    TELEMETRIA_FLUSH_TIMER = null;
  }
}

function truncateString(s, max) {
  if (typeof s !== "string") return s;
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[+${s.length - max} chars]`;
}

function sanitize(obj, depth = 0) {
  if (depth > 8) return "[max-depth]";
  if (obj == null) return obj;
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(v => sanitize(v, depth + 1));

  const out = {};
  for (const k of Object.keys(obj)) {
    if (SANITIZE_REDACT_KEYS.test(k)) {
      out[k] = "***";
      continue;
    }
    if (SANITIZE_TRUNCATE_KEYS.test(k)) {
      const v = obj[k];
      out[k] = typeof v === "string" && v.length > 6 ? v.slice(0, 6) + "..." : "***";
      continue;
    }
    if (SANITIZE_HEADER_KEYS.test(k) && typeof obj[k] === "string" && obj[k].length > 16) {
      out[k] = "***";
      continue;
    }
    out[k] = sanitize(obj[k], depth + 1);
  }
  return out;
}

async function telemetria(tipo, dados) {
  try {
    if (!(await getTelemetriaLigada())) return;

    TELEMETRIA_BATCH.push({ t: Date.now(), tipo, dados: sanitize(dados) });

    if (TELEMETRIA_BATCH.length >= TELEMETRIA_BATCH_MAX) {
      await flushTelemetria();
    } else if (!TELEMETRIA_FLUSH_TIMER) {
      TELEMETRIA_FLUSH_TIMER = setTimeout(() => {
        flushTelemetria().catch(() => {});
      }, TELEMETRIA_FLUSH_MS);
    }
  } catch (_) { /* nunca quebrar o fluxo principal por telemetria */ }
}

async function flushTelemetria() {
  if (TELEMETRIA_FLUSH_TIMER) {
    clearTimeout(TELEMETRIA_FLUSH_TIMER);
    TELEMETRIA_FLUSH_TIMER = null;
  }
  // Snapshot atomic: copia + zera o array em memória ANTES de qualquer await,
  // pra evitar perda de eventos se telemetria() for chamada durante o flush.
  if (TELEMETRIA_BATCH.length === 0) {
    // Tenta recuperar batch persistido (caso SW tenha sido killed antes do flush anterior)
    try {
      const sess = await chrome.storage.session.get(["pending_telemetria_batch"]);
      if (Array.isArray(sess.pending_telemetria_batch) && sess.pending_telemetria_batch.length > 0) {
        TELEMETRIA_BATCH.push(...sess.pending_telemetria_batch);
        await chrome.storage.session.set({ pending_telemetria_batch: [] });
      }
    } catch (_) {}
    if (TELEMETRIA_BATCH.length === 0) return;
  }
  const snapshot = TELEMETRIA_BATCH.splice(0, TELEMETRIA_BATCH.length);
  try {
    const local = await chrome.storage.local.get(["telemetria_buffer"]);
    const buf = Array.isArray(local.telemetria_buffer) ? local.telemetria_buffer : [];
    buf.push(...snapshot);
    while (buf.length > TELEMETRIA_MAX_ENTRIES) buf.shift();
    await chrome.storage.local.set({ telemetria_buffer: buf });
  } catch (_) {
    // Falhou — devolve eventos pro batch pra tentar de novo no próximo flush
    TELEMETRIA_BATCH.unshift(...snapshot);
  }
}

// Persiste batch pendente em storage.session pra sobreviver SW kill. Chamado em
// pontos críticos onde SW pode ser killed em seguida (final de ciclo, stop).
async function persistirBatchPendente() {
  if (TELEMETRIA_BATCH.length === 0) return;
  try {
    const sess = await chrome.storage.session.get(["pending_telemetria_batch"]);
    const pending = Array.isArray(sess.pending_telemetria_batch) ? sess.pending_telemetria_batch : [];
    pending.push(...TELEMETRIA_BATCH);
    TELEMETRIA_BATCH.length = 0;
    await chrome.storage.session.set({ pending_telemetria_batch: pending });
  } catch (_) {}
}

// Acesso ao cache (necessário pra storage.onChanged listener invalidar)
function __setTelemetriaCacheValue(v) {
  TELEMETRIA_LIGADA_CACHE = v;
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.getTelemetriaLigada = getTelemetriaLigada;
  self.__resetTelemetriaCache = __resetTelemetriaCache;
  self.__resetTelemetriaBatch = __resetTelemetriaBatch;
  self.__setTelemetriaCacheValue = __setTelemetriaCacheValue;
  self.sanitize = sanitize;
  self.telemetria = telemetria;
  self.flushTelemetria = flushTelemetria;
  self.persistirBatchPendente = persistirBatchPendente;
  self.truncateString = truncateString; // usado por apiPost também
}
if (typeof module !== "undefined") {
  module.exports = {
    getTelemetriaLigada,
    __resetTelemetriaCache,
    __resetTelemetriaBatch,
    __setTelemetriaCacheValue,
    sanitize,
    telemetria,
    flushTelemetria,
    persistirBatchPendente,
    truncateString
  };
}
