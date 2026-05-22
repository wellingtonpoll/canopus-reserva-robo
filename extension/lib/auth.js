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
  return data.data[0];
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") self.fazerLogin = fazerLogin;
if (typeof module !== "undefined") module.exports = { fazerLogin };
