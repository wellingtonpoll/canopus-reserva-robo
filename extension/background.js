// extension/background.js — entrypoint Service Worker MV3.
//
// Toda lógica vive em lib/*. Esse arquivo é shim ~40 LOC que:
// 1. Carrega libs em ordem topológica (importScripts em SW / require em Node tests)
// 2. Registra listeners via lib/listeners.js (último import)
// 3. Re-exporta tudo pra testes Node via module.exports
//
// Spec 01 (Modularizar background.js) — completo em 18 commits incrementais.

const LIBS = [
  'lib/state.js',       // constantes + sleep
  'lib/format.js',      // formatarDataBR, usuarioExibicao, brasilNowParts
  'lib/notifications.js', // notificarPopup, registrarUltimoErroPersistente
  'lib/horario.js',     // sistemaEstaAberto, proximaAberturaBR
  'lib/telemetria.js',  // sanitize, telemetria, flushTelemetria, persistirBatchPendente
  'lib/telegram.js',    // telegramNotify com AbortController
  'lib/rate-limit.js',  // tomarToken, registrarHitERateLimit (token bucket + circuit)
  'lib/schedule.js',    // agendarProximoCiclo, ajustarDelayDinamico (AIMD)
  'lib/api.js',         // getHeaders, parseRetryAfter, apiPost
  'lib/auth.js',        // fazerLogin
  'lib/grupos.js',      // buscarGrupos, extrair*, parseGruposConfig, removerGrupoDoConfig
  'lib/turnstile.js',   // handleTurnstileChallenge, limparBadgeTurnstile
  'lib/portal.js',      // garantirAbaPortal, tentarRecuperarContentScript, reservarViaTab
  'lib/reserva.js',     // reservar (dead code), reservarComLimite
  'lib/cycle.js',       // runMonitorCycle
  'lib/loop.js',        // runPollingLoop, dormirAteAbertura
  'lib/lifecycle.js',   // iniciarMonitoramento, pararMonitoramento
  'lib/listeners.js'    // chrome.* event listeners (deve ser último)
];

// SW context (Chrome MV3): importScripts é síncrono e popula self.X
if (typeof importScripts !== "undefined") {
  importScripts(...LIBS);
}

// Node test context (Jest): chrome-mock.js shim do importScripts faz require + Object.assign(global)
if (typeof require !== "undefined" && typeof module !== "undefined") {
  for (const p of LIBS) {
    const lib = require('./' + p.replace(/\.js$/, ''));
    if (lib && typeof lib === 'object') Object.assign(global, lib);
  }

  // Re-exporta tudo pra testes existentes que fazem `require('../background.js')`
  module.exports = Object.assign({},
    require('./lib/state'),
    require('./lib/format'),
    require('./lib/notifications'),
    require('./lib/horario'),
    require('./lib/telemetria'),
    require('./lib/telegram'),
    require('./lib/rate-limit'),
    require('./lib/schedule'),
    require('./lib/api'),
    require('./lib/auth'),
    require('./lib/grupos'),
    require('./lib/turnstile'),
    require('./lib/portal'),
    require('./lib/reserva'),
    require('./lib/cycle'),
    require('./lib/loop'),
    require('./lib/lifecycle')
  );
}
