// extension/lib/auth.js — login Canopus.
// Deps: api (apiPost).

async function fazerLogin() {
  const { USUARIO, SENHA } = await chrome.storage.local.get(["USUARIO", "SENHA"]);
  const data = await apiPost("/auth/enterPlataforma", {
    Usuario: String(USUARIO || "").padStart(10, "0"),
    Senha: SENHA || "",
    Ip: "",
    Browser: "Chrome",
    Acesso: "USR"
  });
  if (!data.success || !Array.isArray(data.data) || data.data.length === 0) {
    throw new Error("LOGIN_FALHOU: resposta inválida");
  }
  const loginData = data.data[0];
  // Spec 03: persiste TokenLogin + user payload pra hydrate.js (content-script
  // document_start) hidratar localStorage da janela criada via garantirAbaPortal.
  // Resultado: Angular SPA acredita que cliente está logado — robô autônomo
  // sem cliente nunca abrir UI de login (zero 2FA fricção).
  if (loginData && loginData.TokenLogin) {
    try {
      await chrome.storage.local.set({
        tokenLogin: loginData.TokenLogin,
        userPayload: loginData
      });
    } catch (_) { /* hydrate falha gracioso → fallback LOGIN_NECESSARIO do Lote E */ }
  }
  return loginData;
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") self.fazerLogin = fazerLogin;
if (typeof module !== "undefined") module.exports = { fazerLogin };
