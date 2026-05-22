---
id: 03
title: Auto-login via cookie hijack (TokenLogin → chrome.cookies.set)
status: backlog
priority: P1
effort: M
score_impact: +5
score_categories:
  - UX (+3)
  - Arquitetura (+2)
depends_on: [01]
tags: [autenticação, ux, autonomia, cookies]
---

# Auto-login via cookie hijack (TokenLogin → chrome.cookies.set)

## Context

Hoje a extensão tem **duas autenticações paralelas**:

1. **SW-side (API)**: `lib/auth.js` `fazerLogin()` chama `/auth/enterPlataforma` com USUARIO+SENHA armazenados em `chrome.storage.local`. Retorna `IdUsuario`, `IdEmpresa`, `TokenLogin`. **Não exige 2FA**.
2. **Browser UI session**: cliente faz login manual UI **uma vez** pra setar cookies HttpOnly Angular. Esse fluxo UI exige **2FA** (email/SMS). Cookie persiste por semanas. Quando expira, Lote E E4 detecta redirect `/login` e abre janela.

Telemetria do cliente em v1.2.0 confirma resposta API:
```json
{
  "success": true,
  "data": [{
    "IdUsuario": 313,
    "Usuario": "0000008158",
    "TokenLogin": "a1d71678-70a2-4dce-bc46-634326abf345",
    "IdEmpresa": 1,
    "2faData": {"hasEmail": true, "hasCelular": true, "OrigemAuth": "TEc="}
  }]
}
```

API auth NÃO tem 2FA. Backend aceita só USUARIO+SENHA. **Se conseguirmos sincronizar o `TokenLogin` no cookie jar do Chrome via `chrome.cookies.set`, próxima request DOM herda sessão sem cliente nunca abrir UI** — robô 100% autônomo.

## Motivation

- **+3 UX**: elimina fricção de login manual + 2FA. Cliente clica Iniciar e nunca mais loga.
- **+2 arquitetura**: unifica fonte de verdade (1 auth via API), abolindo ciclo manual de re-login.
- **Score impact alvo**: +5 (UX 88→91, Arquitetura 88→90).

## Approach overall

Dividir em **3 fases sequenciais**. Fase 1 é blocking (precisa cliente), Fase 2 implementa código, Fase 3 valida em produção.

## Fase 1 — Diagnóstico de cookies (BLOQUEANTE, precisa cliente)

**Sem o nome exato do cookie de sessão UI, `chrome.cookies.set` chuta no escuro.** Implementação NÃO inicia até Fase 1 completa.

### Pro cliente (criar `docs/diagnostico-cookies.md`)

Texto literal a copiar pro doc:

```markdown
# Diagnóstico de Cookies — Portal Canopus

## Como capturar lista de cookies pós-login UI

1. Abrir Chrome (perfil que tem a extensão instalada)
2. Acessar https://parceiros.consorciocanopus.com.br
3. Fazer login normal com USUARIO + SENHA + 2FA
4. Após dashboard carregar, pressionar **F12** → aba **Application** (ou **Aplicativo**)
5. Painel esquerdo: **Storage** → **Cookies** → `https://parceiros.consorciocanopus.com.br`
6. Lista de cookies aparece na direita
7. Tirar **screenshot da tabela inteira** (visível: nomes, valores, domain, path, expires, http only, secure, samesite, size)
8. Tirar **screenshot adicional do "Application"** mostrando "Local Storage" e "Session Storage" do mesmo domínio (pode ter token JWT lá em vez de cookie)
9. Enviar prints + responder:
   - Qual cookie tem valor visualmente IGUAL ao `TokenLogin` que aparece nos logs de telemetria? (ex: `a1d71678-...`)
   - Se nenhum bate exato, qual cookie parece ser de sessão (geralmente tem `session`, `token`, `auth` no nome + HttpOnly=true)?
   - Quantos cookies HttpOnly têm no total?

## Alternativa via cURL (se DevTools indisponível)

1. Após login manual, em terminal:
   ```bash
   curl -v --cookie-jar canopus-cookies.txt https://parceiros.consorciocanopus.com.br/apps/reservas
   ```
   (não vai funcionar exatamente — Chrome cookies não migram pra cURL — mas mostra padrão)

## O que vamos identificar

- **Nome principal do cookie de sessão** (ex: `session_id`, `token`, `_canopus_auth`)
- **Cookies auxiliares**: XSRF-TOKEN, csrf, etc.
- **Atributos**: HttpOnly, Secure, SameSite, Expires
- **Onde o TokenLogin é armazenado**: cookie ou localStorage?
```

### Output esperado (preencher em `extension/lib/state.js` após cliente responder)

```js
// extension/lib/state.js — adicionar constantes Spec 03
const CANOPUS_COOKIE_NAME = "TOKEN_DO_COOKIE_AQUI";      // descoberto via Fase 1
const CANOPUS_COOKIE_DOMAIN = "parceiros.consorciocanopus.com.br";
const CANOPUS_COOKIE_PATH = "/";
const CANOPUS_COOKIE_HTTP_ONLY = true;                    // confirmar via Fase 1
const CANOPUS_COOKIE_SECURE = true;
const CANOPUS_COOKIE_SAMESITE = "lax";                    // ou "strict"/"no_restriction"
const CANOPUS_COOKIE_TTL_SEC = 30 * 24 * 3600;            // 30 dias
```

## Fase 2 — Implementação

Pré-requisitos: Fase 1 done, cookie names conhecidos, Spec 01 done (libs modulares).

### 2.1 — `extension/manifest.json`

Adicionar `cookies` em permissions:

```diff
   "permissions": [
     "storage",
     "alarms",
     "sidePanel",
     "tabs",
-    "scripting"
+    "scripting",
+    "cookies"
   ],
```

### 2.2 — `extension/lib/state.js`

Adicionar constantes da Fase 1 (mostradas acima).

### 2.3 — Nova lib `extension/lib/cookies.js`

```js
// extension/lib/cookies.js — sync TokenLogin → chrome.cookies pra browser herdar sessão.
// Deps: state (CANOPUS_COOKIE_*), telemetria.
//
// Spec 03: depois de fazerLogin API, injetar TokenLogin no cookie jar do Chrome
// pra que chrome.windows.create({/apps/reservas}) herde sessão sem precisar
// cliente abrir UI de login com 2FA.

async function setCanopusCookie(tokenLogin) {
  if (!tokenLogin || typeof tokenLogin !== "string") {
    telemetria("cookie.set_skip", { motivo: "token_invalido" });
    return false;
  }
  if (!chrome.cookies || typeof chrome.cookies.set !== "function") {
    telemetria("cookie.set_skip", { motivo: "api_indisponivel" });
    return false;
  }

  const params = {
    url: `https://${CANOPUS_COOKIE_DOMAIN}${CANOPUS_COOKIE_PATH}`,
    name: CANOPUS_COOKIE_NAME,
    value: tokenLogin,
    domain: CANOPUS_COOKIE_DOMAIN,
    path: CANOPUS_COOKIE_PATH,
    secure: CANOPUS_COOKIE_SECURE,
    httpOnly: CANOPUS_COOKIE_HTTP_ONLY,
    sameSite: CANOPUS_COOKIE_SAMESITE,
    expirationDate: Math.floor(Date.now() / 1000) + CANOPUS_COOKIE_TTL_SEC
  };

  try {
    const result = await chrome.cookies.set(params);
    telemetria("cookie.set", {
      ok: !!result,
      name: CANOPUS_COOKIE_NAME,
      domain: CANOPUS_COOKIE_DOMAIN,
      tokenPrefix: tokenLogin.slice(0, 8)
    });
    return !!result;
  } catch (err) {
    telemetria("cookie.set_err", {
      erro: (err && err.message) || String(err),
      name: CANOPUS_COOKIE_NAME
    });
    return false;
  }
}

async function getCanopusCookie() {
  if (!chrome.cookies || typeof chrome.cookies.get !== "function") return null;
  try {
    return await chrome.cookies.get({
      url: `https://${CANOPUS_COOKIE_DOMAIN}${CANOPUS_COOKIE_PATH}`,
      name: CANOPUS_COOKIE_NAME
    });
  } catch (_) {
    return null;
  }
}

async function isCanopusCookieValido() {
  const cookie = await getCanopusCookie();
  if (!cookie || !cookie.value) return false;
  // expirationDate em seconds; se ausente, é session cookie (válido enquanto Chrome aberto)
  if (cookie.expirationDate && cookie.expirationDate * 1000 < Date.now()) return false;
  return true;
}

async function limparCanopusCookie() {
  if (!chrome.cookies || typeof chrome.cookies.remove !== "function") return;
  try {
    await chrome.cookies.remove({
      url: `https://${CANOPUS_COOKIE_DOMAIN}${CANOPUS_COOKIE_PATH}`,
      name: CANOPUS_COOKIE_NAME
    });
    telemetria("cookie.removed", { name: CANOPUS_COOKIE_NAME });
  } catch (_) {}
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.setCanopusCookie = setCanopusCookie;
  self.getCanopusCookie = getCanopusCookie;
  self.isCanopusCookieValido = isCanopusCookieValido;
  self.limparCanopusCookie = limparCanopusCookie;
}
if (typeof module !== "undefined") {
  module.exports = { setCanopusCookie, getCanopusCookie, isCanopusCookieValido, limparCanopusCookie };
}
```

### 2.4 — `extension/lib/auth.js` modification

```diff
+// Spec 03: após login API, sincroniza TokenLogin no cookie jar do Chrome
+// pra que chrome.windows.create({/apps/reservas}) herde sessão sem 2FA.
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
-  return data.data[0];
+  const loginData = data.data[0];
+  // Sync cookie pro fluxo DOM (reservarViaTab) herdar sessão sem precisar UI login
+  if (loginData.TokenLogin) {
+    await setCanopusCookie(loginData.TokenLogin);
+  }
+  return loginData;
 }
```

### 2.5 — `extension/background.js` shim

Adicionar `lib/cookies.js` ao array `LIBS` antes de `lib/auth.js`:

```diff
 const LIBS = [
   'lib/state.js',
   'lib/format.js',
   'lib/notifications.js',
   'lib/horario.js',
   'lib/telemetria.js',
   'lib/telegram.js',
   'lib/rate-limit.js',
   'lib/schedule.js',
   'lib/api.js',
+  'lib/cookies.js',
   'lib/auth.js',
   ...
 ];
```

### 2.6 — `extension/lib/loop.js` modification

`runPollingLoop` deve verificar validade do cookie + re-sync se necessário:

```diff
   // M9: invalida sessão Canopus se mais velha que TTL — pega caso "robô voltou
   // do SW kill, sessão pode ter expirado no backend"
   const ID_USUARIO_TTL_MS = 6 * 60 * 60 * 1000; // 6h
   const { idUsuarioObtidoEm } = await chrome.storage.local.get(["idUsuarioObtidoEm"]);
-  if (idUsuarioObtidoEm && Date.now() - idUsuarioObtidoEm > ID_USUARIO_TTL_MS) {
+  const cookieValido = await isCanopusCookieValido();
+  if ((idUsuarioObtidoEm && Date.now() - idUsuarioObtidoEm > ID_USUARIO_TTL_MS) || !cookieValido) {
     await chrome.storage.local.remove(["idUsuario", "idEmpresa", "idUsuarioObtidoEm"]);
-    notificarPopup("🔄 Sessão Canopus expirada (>6h). Re-autenticando no próximo ciclo.");
+    notificarPopup(cookieValido
+      ? "🔄 Sessão Canopus expirada (>6h). Re-autenticando no próximo ciclo."
+      : "🔄 Cookie de sessão inválido/expirado. Re-autenticando no próximo ciclo.");
   }
```

### 2.7 — `extension/lib/lifecycle.js` modification

`pararMonitoramento` opcionalmente limpa cookie pra evitar reuso indesejado:

```diff
 async function pararMonitoramento() {
   await chrome.storage.session.set({ isRunning: false });
   await chrome.alarms.clear(alarmName);
-  // M9: mantemos idUsuario/idEmpresa entre stops — TTL no runPollingLoop invalida quando >6h
-  await chrome.storage.local.remove(["idUsuario", "idEmpresa", "idUsuarioObtidoEm"]);
+  // Spec 03: mantém idUsuario/idEmpresa + cookie entre stops — TTL invalida quando >6h.
+  // Cliente pode forçar logout via "Limpar cache" no popup (chama limparCanopusCookie lá).
+  await chrome.storage.local.remove(["idUsuario", "idEmpresa", "idUsuarioObtidoEm"]);
   notificarPopup("⏹ Monitoramento parado");
   ...
 }
```

### 2.8 — `extension/popup.js` modification

Botão "Limpar cache" também limpa cookie:

```diff
 clearCacheBtn.addEventListener('click', async () => {
   const confirmed = await openConfirmDialog({ ... });
   if (!confirmed) return;
   try {
     await chrome.storage.local.clear();
     await chrome.storage.session.clear();
     await chrome.alarms.clearAll();
+    // Spec 03: limpa cookie injetado também
+    await chrome.runtime.sendMessage({ action: "clear_canopus_cookie" });
     addLog('✅ Cache limpo (configs + métricas + telemetria + cookies).');
   } catch (err) { ... }
 });
```

### 2.9 — `extension/lib/listeners.js` modification

Novo handler `clear_canopus_cookie`:

```diff
+  if (message.action === "clear_canopus_cookie") {
+    limparCanopusCookie()
+      .then(() => sendResponse({ ok: true }))
+      .catch(e => sendResponse({ ok: false, error: e.message }));
+    return true;
+  }
```

## Fase 3 — Validação em produção

Cliente roda v1.4.0 em **perfil Chrome novo** (nunca logou UI no portal):

1. Instalar extensão (via install.ps1 ou Web Store)
2. Configurar USUARIO+SENHA em Configurações
3. **NÃO abrir portal manualmente, NÃO logar UI**
4. Clicar Iniciar
5. Observar:
   - Telemetria deve mostrar `cookie.set: ok: true` após `apiPost /auth/enterPlataforma`
   - `garantirAbaPortal` cria janela em `/apps/reservas`
   - Telemetria `portal.window_created`: `url: "https://parceiros.consorciocanopus.com.br/apps/reservas"` (NÃO `/login`)
   - Reserva flui normal: content-script → DOM → toast sucesso

Se URL final ainda for `/login` → portal valida mais que cookie (fingerprint IP+UA). Documentar limitação e manter manual login 1×.

## Files

**Criar:**
- `docs/diagnostico-cookies.md` (Fase 1)
- `extension/lib/cookies.js` (Fase 2.3)

**Modificar:**
- `extension/manifest.json` — adicionar `cookies` em permissions
- `extension/lib/state.js` — adicionar 7 constantes `CANOPUS_COOKIE_*`
- `extension/lib/auth.js` — chamar `setCanopusCookie(loginData.TokenLogin)` após `fazerLogin`
- `extension/background.js` — adicionar `lib/cookies.js` no array LIBS
- `extension/lib/loop.js` — verificar `isCanopusCookieValido` no `runPollingLoop`
- `extension/lib/lifecycle.js` — documentar que cookie persiste (não limpar em stop)
- `extension/lib/listeners.js` — handler `clear_canopus_cookie`
- `extension/popup.js` — `clearCacheBtn` chama `clear_canopus_cookie` action
- `extension/tests/chrome-mock.js` — mocks `chrome.cookies.set/get/remove`
- `extension/tests/background.test.js` — testes pra `setCanopusCookie`, `isCanopusCookieValido`, integração fazerLogin
- `CHANGELOG.md` — registrar v1.4.0
- `extension/manifest.json` + `package.json` — bump 1.3.0 → 1.4.0
- `README.md` — atualizar seção "Pré-requisitos" (cliente NÃO precisa mais logar UI)

**Funções existentes a reusar:**
- `lib/auth.js fazerLogin` — entrypoint pra hook do cookie sync
- `lib/portal.js garantirAbaPortal` — sem mudança; cookie injetado faz a magia
- `lib/portal.js` deteção LOGIN_NECESSARIO — fallback se hijack falhar
- `lib/telemetria.js telemetria` — registrar cookie events
- `lib/storage` — sem mudança

## Verification

### Tests unitários

**`extension/tests/chrome-mock.js`** — adicionar:

```js
chrome.cookies = {
  set: jest.fn().mockResolvedValue({ name: "test", value: "test", domain: "x" }),
  get: jest.fn().mockResolvedValue(null),
  remove: jest.fn().mockResolvedValue(undefined)
};
```

**`extension/tests/background.test.js`** — adicionar:

```js
describe("Spec 03: cookie hijack", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chrome.storage.local.get.mockResolvedValue({ USUARIO: "8158", SENHA: "test" });
  });

  test("setCanopusCookie chama chrome.cookies.set com params corretos", async () => {
    const ok = await setCanopusCookie("token-abc-123");
    expect(ok).toBe(true);
    expect(chrome.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.any(String),
        value: "token-abc-123",
        domain: "parceiros.consorciocanopus.com.br",
        secure: true,
        httpOnly: true
      })
    );
  });

  test("setCanopusCookie no-op com token vazio", async () => {
    const ok = await setCanopusCookie("");
    expect(ok).toBe(false);
    expect(chrome.cookies.set).not.toHaveBeenCalled();
  });

  test("setCanopusCookie tolera api ausente", async () => {
    const originalSet = chrome.cookies.set;
    delete chrome.cookies.set;
    const ok = await setCanopusCookie("token");
    expect(ok).toBe(false);
    chrome.cookies.set = originalSet;
  });

  test("isCanopusCookieValido true quando cookie existe e não expirado", async () => {
    chrome.cookies.get.mockResolvedValueOnce({
      value: "token",
      expirationDate: Math.floor(Date.now() / 1000) + 3600
    });
    expect(await isCanopusCookieValido()).toBe(true);
  });

  test("isCanopusCookieValido false quando cookie expirado", async () => {
    chrome.cookies.get.mockResolvedValueOnce({
      value: "token",
      expirationDate: Math.floor(Date.now() / 1000) - 60
    });
    expect(await isCanopusCookieValido()).toBe(false);
  });

  test("fazerLogin chama setCanopusCookie com TokenLogin da response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        success: true,
        data: [{ IdUsuario: 99, IdEmpresa: 1, TokenLogin: "uuid-xyz" }]
      })
    });
    await fazerLogin();
    expect(chrome.cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({ value: "uuid-xyz" })
    );
  });

  test("limparCanopusCookie chama chrome.cookies.remove", async () => {
    await limparCanopusCookie();
    expect(chrome.cookies.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: expect.any(String) })
    );
  });
});
```

### Manual end-to-end

1. Build novo `.crx` da branch
2. **Perfil Chrome novo** (não tem cookie Canopus nenhum)
3. Instalar extensão
4. Configurar USUARIO+SENHA, salvar
5. **NÃO abrir portal manualmente**
6. Click Iniciar
7. Exportar telemetria após 1 ciclo
8. Verificar entries:
   - `apiPost.req path: "/auth/enterPlataforma"` (login OK)
   - `cookie.set ok: true tokenPrefix: "uuid-..."` (sync OK)
   - `portal.window_created url: ".../apps/reservas"` (NÃO /login → hijack funcionou)
   - `content.dom.match` (DOM driver achou elementos)
   - `content.toast.appeared kind: "sucesso"` (reserva concluída)

### Verificação de fallback

Se portal valida fingerprint além de cookie:

1. Telemetria mostraria `portal.window_created url: ".../login"` mesmo com `cookie.set ok: true`
2. Robô cai no Lote E E4 → `LOGIN_NECESSARIO`, abre janela em foco
3. Cliente loga manualmente 1×
4. Daí em diante cookie inerit funcionou — fluxo igual ao atual v1.3.0

Comportamento degrada gracioso. Sem regressão.

## Risks

- **Cookie isolado pode não bastar**: portal pode validar fingerprint conjunto IP+UA+TLS+JS challenge. Cookie alone falha. Mitigação: Fase 3 testa empiricamente; fallback Lote E preservado.
- **`HttpOnly` cookie via `chrome.cookies.set`**: API permite (extension cookies API bypassa restrição). Funciona.
- **Cookie name muda em update do portal**: portal Canopus pode renomear cookie. Mitigação: constante centralizada em `state.js`; telemetria `cookie.set ok` mostra se ainda funciona; cliente captura nova lista via Fase 1 quando der ruim.
- **XSRF/CSRF tokens secundários**: portal pode exigir além do cookie principal. Tipicamente set por servidor em response GET. Mitigação: se hijack falhar isoladamente, próximo passo é fazer `fetch("/apps/reservas", { credentials: include })` no SW após cookie set pra forçar XSRF response set-cookie automático.
- **2FA escala pra API no futuro**: se Canopus adicionar 2FA ao `/auth/enterPlataforma`, esse spec inteiro quebra. Risco baixo curto prazo; longo prazo precisa renegociar abordagem.
- **TokenLogin TTL server-side**: portal pode invalidar token em janela curta (horas). Mitigação: TTL local `idUsuarioObtidoEm` 6h já força re-login periódico. Cookie é re-injetado a cada `fazerLogin` chamado.
- **chrome.cookies.set requer permission**: extensão precisa `"cookies"` em manifest. Se cliente atualizar v1.3.0→v1.4.0, Chrome pede confirmação de nova permissão (warning de update). Comunicar.
- **Perfis Chrome com sync**: cookie sync via Google account pode interferir. Geralmente OK (sync usa profile, não extension cookies API).

## Out of scope

- OAuth/SAML migration se Canopus mudar auth (decisão posterior)
- Automatizar 2FA via leitura de email/SMS (proibido por segurança/ToS)
- Cookie sync entre profiles do Chrome
- Suporte a flag "Lembrar-me" se portal expor
- Native Messaging Host pra storage de credenciais (lote 07 separado)
- Auto-detecção do cookie name via análise de response headers (futuro)
- Suporte a múltiplos cookies (XSRF + session simultâneo) — Fase 4 se necessário

## Effort breakdown

| Subtask | Estimativa |
|---------|------------|
| **FASE 1 — Diagnóstico (assíncrono)** | |
| Criar `docs/diagnostico-cookies.md` com texto pro cliente | 30min |
| Aguardar cliente capturar + responder | tempo cliente (1-3 dias) |
| Analisar resposta + preencher constantes `state.js` | 30min |
| **FASE 2 — Implementação** | |
| `manifest.json` permission `cookies` | 5min |
| `lib/state.js` constantes `CANOPUS_COOKIE_*` | 15min |
| `lib/cookies.js` novo (~80 LOC) | 1h |
| `lib/auth.js` hook setCanopusCookie | 15min |
| `background.js` array LIBS update | 5min |
| `lib/loop.js` verificação isCanopusCookieValido | 30min |
| `lib/listeners.js` handler clear_canopus_cookie | 15min |
| `popup.js` clearCacheBtn limpa cookie também | 15min |
| `chrome-mock.js` mocks chrome.cookies | 15min |
| Tests novos (~7 testes) | 2h |
| Bump versão 1.4.0 + CHANGELOG | 30min |
| README seção pré-requisitos atualizada | 30min |
| **FASE 3 — Validação** | |
| Build + smoke test perfil Chrome limpo | 1h |
| Cliente testa em produção real + envia telemetria | tempo cliente |
| Análise telemetria + ajustes se necessário | 1-3h |
| **Total ativo (sem espera cliente)** | **~9h** (M) |

## References

- chrome.cookies API: <https://developer.chrome.com/docs/extensions/reference/api/cookies>
- chrome.cookies.set: <https://developer.chrome.com/docs/extensions/reference/api/cookies#method-set>
- HttpOnly + SameSite semantics: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies>
- Cookie permission warning em updates: <https://developer.chrome.com/docs/extensions/develop/concepts/permissions#warnings>
- Spec 01 (modularização) — pré-requisito completo
- Telemetria do cliente v1.2.0 prova `TokenLogin` retornado pela API
