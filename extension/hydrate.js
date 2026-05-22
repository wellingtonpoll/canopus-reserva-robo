// extension/hydrate.js — content-script run_at: document_start (Spec 03).
//
// Hidrata localStorage com TokenLogin + user payload do robô ANTES do Angular
// bootstrap. Resultado: SPA Canopus acredita que cliente está logado, monta UI
// sem redirect pra /login. Cliente nunca precisa logar UI manualmente.
//
// Formato esperado pelo Angular (confirmado via DevTools do cliente em 22/05/2026):
//   localStorage.token = btoa(TokenLogin UUID)
//   localStorage.user  = btoa(JSON.stringify(userPayload))

(async () => {
  try {
    // Se localStorage já tem token (cliente logou manual ou hidratação anterior), no-op.
    if (localStorage.getItem("token")) return;

    const { tokenLogin, userPayload } = await chrome.storage.local.get(["tokenLogin", "userPayload"]);
    if (!tokenLogin || !userPayload) return;

    const tokenB64 = btoa(tokenLogin);
    const userB64 = btoa(JSON.stringify(userPayload));

    localStorage.setItem("token", tokenB64);
    localStorage.setItem("user", userB64);

    chrome.runtime.sendMessage({
      action: "telemetria",
      tipo: "hydrate.localstorage_injected",
      dados: {
        url: location.href,
        tokenPrefix: String(tokenLogin).slice(0, 8),
        userKeys: Object.keys(userPayload).slice(0, 10)
      }
    }).catch(() => {});
  } catch (err) {
    try {
      chrome.runtime.sendMessage({
        action: "telemetria",
        tipo: "hydrate.err",
        dados: { erro: (err && err.message) || String(err) }
      });
    } catch (_) {}
  }
})();
