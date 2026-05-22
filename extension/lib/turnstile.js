// extension/lib/turnstile.js — pause/resume + badge no ícone quando interativo.
// Deps: state (TURNSTILE_BLOQUEIO_MS), telemetria, notifications, telegram.

async function handleTurnstileChallenge() {
  const ate = Date.now() + TURNSTILE_BLOQUEIO_MS;
  await chrome.storage.session.set({ turnstileBloqueado: true, turnstileBloqueadoAte: ate });
  const msg = `🚨 Turnstile pediu interação manual — resolva no portal em ${TURNSTILE_BLOQUEIO_MS/1000}s. Robô pausado.`;
  notificarPopup(msg);
  telemetria("turnstile.detected_interactive", { bloqueioMs: TURNSTILE_BLOQUEIO_MS });
  // Fix 16 Lote A: sinaliza no ícone da extensão (visível independente do popup).
  try {
    if (chrome.action && chrome.action.setBadgeText) {
      await chrome.action.setBadgeText({ text: "🔒" });
      if (chrome.action.setBadgeBackgroundColor) {
        await chrome.action.setBadgeBackgroundColor({ color: "#d32f2f" });
      }
    }
  } catch (_) {}
  await telegramNotify(msg);
}

async function limparBadgeTurnstile() {
  try {
    if (chrome.action && chrome.action.setBadgeText) {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (_) {}
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.handleTurnstileChallenge = handleTurnstileChallenge;
  self.limparBadgeTurnstile = limparBadgeTurnstile;
}
if (typeof module !== "undefined") {
  module.exports = { handleTurnstileChallenge, limparBadgeTurnstile };
}
