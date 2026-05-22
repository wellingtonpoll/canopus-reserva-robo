// extension/lib/notifications.js — comunicação com popup + persistência de último erro.
// Zero dependências (só chrome APIs).

function notificarPopup(text) {
  chrome.runtime.sendMessage({ action: "log", text }).catch(() => {});
}

// Fix 14 U1: persistir último erro em storage.session pra popup recuperar ao reabrir.
// Popup limpa quando fecha — sem persistência o ERRO no footer some.
async function registrarUltimoErroPersistente(texto) {
  if (!texto) return;
  const t = String(texto).replace(/[❌💣🚫]/g, "").trim();
  if (!t) return;
  try {
    await chrome.storage.session.set({ ultimoErro: { texto: t.slice(0, 200), t: Date.now() } });
  } catch (_) {}
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.notificarPopup = notificarPopup;
  self.registrarUltimoErroPersistente = registrarUltimoErroPersistente;
}
if (typeof module !== "undefined") {
  module.exports = { notificarPopup, registrarUltimoErroPersistente };
}
