---
id: 03
title: Auto-login via localStorage hijack (content-script document_start)
status: backlog
priority: P1
effort: M
score_impact: +5
score_categories:
  - UX (+3)
  - Arquitetura (+2)
depends_on: [01]
tags: [autenticação, ux, autonomia, localstorage, content-script]
---

# Auto-login via localStorage hijack (content-script document_start)

## Context

**Diagnóstico (script JS no DevTools do cliente em 22/05/2026) revelou:**

Portal Canopus **não usa cookies pra auth UI**. Sessão vive em `localStorage`:

```json
{
  "localStorage": {
    "token": "YTFkNzk0NGEtOTBlNS00NDllLTk3NGUtZGRjM2QwN2I3MTIz",
    "user": "<base64 JSON com IdUsuario, TokenLogin, NomePessoa, IdEmpresa, etc>",
    "navigation": "<JSON menu>"
  },
  "sessionStorage": {},
  "documentCookie": "<só analytics _ga/_gcl/_fbp>"
}
```

`atob("YTFkNzk0NGEt...")` = `"a1d7944a-90e5-449e-974e-ddc3d07b7123"` (UUID = `TokenLogin` da API response `/auth/enterPlataforma` codificado em base64).

`atob(localStorage.user)` = JSON COMPLETO com `IdUsuario`, `TokenLogin`, `IdEmpresa`, `NomePessoa`, `CpfCnpj`, `UltimoLogin` — **exatamente o payload `data[0]` da response API**.

**Captura adicional de headers Angular:** todas as requests pra `prod-api-portalparceiro-canopus.bsn.dev.br` (`/reservas/listGruposReserva/313`, `/reservas/get-produtos`, `/reservas/verificaRestricaoHorario`) usam APENAS:

```
secret: e4537470554544d8a5909f16fca68f9b
token:  f33da0eae2de47028f59c60f125c2da3
```

**Esses tokens são hardcoded públicos** — idênticos aos de `lib/api.js getHeaders()`. **Zero header `Authorization`/`Bearer`/`X-Auth-Token`**. Backend identifica usuário via `IdUsuario` no PATH/BODY, não em header.

**Conclusão:** API backend ignora sessão UI. localStorage do front existe só pra Angular SPA decidir "mostrar UI logada" vs "redirect `/login`". Se injetarmos `token` + `user` em `localStorage` ANTES do Angular bootstrap, SPA acredita que cliente está logado e monta UI normal — sem cliente ter ID logado manualmente.

## Motivation

- **+3 UX**: cliente clica Iniciar e nunca mais loga UI. Robô 100% autônomo.
- **+2 arquitetura**: sessão UI deriva da API auth do SW; uma única fonte de verdade.
- **Score impact alvo**: +5 (UX 88→91, Arquitetura 88→90).

## Approach

Adicionar segundo content-script `hydrate.js` com **`run_at: "document_start"`** (executa antes do Angular bootstrap). Lê dados persistidos pelo SW após `fazerLogin`, escreve em `localStorage` da página. `content.js` atual (`document_idle`) continua intocado pro fluxo DOM driver.

Timing crítico: Angular SPA lê `localStorage.token` em algum ponto do bootstrap (`AppInitializer` ou route guard). Se token ausente → redirect `/login`. Se token presente → monta dashboard.

`document_start` roda BEFORE `DOMContentLoaded`, BEFORE Angular boot, BEFORE qualquer JS da página. `localStorage.setItem` síncrono garante valor presente quando Angular ler.

## Files

### 1. `extension/manifest.json` — adicionar segundo content-script

```diff
   "content_scripts": [
+    {
+      "matches": ["https://parceiros.consorciocanopus.com.br/apps/*"],
+      "js": ["hydrate.js"],
+      "run_at": "document_start"
+    },
     {
       "matches": ["https://parceiros.consorciocanopus.com.br/apps/*"],
       "js": ["content.js"],
       "run_at": "document_idle"
     }
   ]
```

### 2. `extension/hydrate.js` — novo arquivo

```js
// extension/hydrate.js — content-script run_at: document_start.
// Hidrata localStorage com TokenLogin + user payload do robô ANTES do Angular
// bootstrap. Resultado: SPA acredita que cliente está logado, monta UI sem
// redirect pra /login.
//
// Síncrono no início; depois async pra ler chrome.storage.local.

(async () => {
  try {
    // Se localStorage já tem token (cliente logou manual ou hidratação anterior), no-op.
    if (localStorage.getItem("token")) return;

    const { tokenLogin, userPayload } = await chrome.storage.local.get(["tokenLogin", "userPayload"]);
    if (!tokenLogin || !userPayload) return;

    // base64 encode (formato esperado pelo Angular, capturado via DevTools do cliente)
    const tokenB64 = btoa(tokenLogin);
    const userB64 = btoa(JSON.stringify(userPayload));

    localStorage.setItem("token", tokenB64);
    localStorage.setItem("user", userB64);

    // Notifica SW pra telemetria
    chrome.runtime.sendMessage({
      action: "telemetria",
      tipo: "hydrate.localstorage_injected",
      dados: {
        url: location.href,
        tokenPrefix: tokenLogin.slice(0, 8),
        userKeys: Object.keys(userPayload).slice(0, 10)
      }
    }).catch(() => {});
  } catch (err) {
    chrome.runtime.sendMessage({
      action: "telemetria",
      tipo: "hydrate.err",
      dados: { erro: (err && err.message) || String(err) }
    }).catch(() => {});
  }
})();
```

### 3. `extension/lib/auth.js` — persistir payload após login

```diff
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
+  // Spec 03: persiste TokenLogin + user payload pra hydrate.js hidratar localStorage
+  // da janela criada via chrome.windows.create — robô fica autônomo, sem login UI manual.
+  if (loginData.TokenLogin) {
+    await chrome.storage.local.set({
+      tokenLogin: loginData.TokenLogin,
+      userPayload: loginData
+    });
+  }
+  return loginData;
 }
```

### 4. `extension/lib/listeners.js` — handler clear (popup "Limpar cache")

Já existe handler `clear_telemetria_buffer`. Adicionar limpeza dos campos novos quando cliente clica "Limpar cache da extensão" (popup já chama `chrome.storage.local.clear()` que remove tudo — então nem precisa mexer no listener. Apenas garantir que `hydrate.js` faça no-op quando keys ausentes — já garantido).

### 5. `extension/lib/loop.js` — invalida hydrate state em TTL

`runPollingLoop` já tem TTL 6h pra `idUsuarioObtidoEm`. Estender pra limpar `tokenLogin`/`userPayload` também:

```diff
   const ID_USUARIO_TTL_MS = 6 * 60 * 60 * 1000; // 6h
   const { idUsuarioObtidoEm } = await chrome.storage.local.get(["idUsuarioObtidoEm"]);
   if (idUsuarioObtidoEm && Date.now() - idUsuarioObtidoEm > ID_USUARIO_TTL_MS) {
-    await chrome.storage.local.remove(["idUsuario", "idEmpresa", "idUsuarioObtidoEm"]);
+    await chrome.storage.local.remove([
+      "idUsuario", "idEmpresa", "idUsuarioObtidoEm",
+      "tokenLogin", "userPayload"
+    ]);
     notificarPopup("🔄 Sessão Canopus expirada (>6h). Re-autenticando no próximo ciclo.");
   }
```

### 6. `extension/lib/portal.js` — atualizar mensagem de LOGIN_NECESSARIO

Hoje LOGIN_NECESSARIO disparado quando URL final = `/login`. Com hydrate funcionando, esse caso só acontece se:
1. `hydrate.js` falhou (sem `tokenLogin` no storage)
2. Angular fez chamada de validação ao backend que rejeitou
3. Cookie persistente do portal (cliente já tinha sessão expirada antes do hydrate)

Mensagem deve sugerir tentar de novo (talvez login API expirou):

```diff
     const msg = `🔐 Robô abriu o portal mas você precisa fazer login (URL atual: ${urlFinal.split("?")[0]}). Faça login e mantenha a aba aberta — o robô usa a sessão dela.`;
+    // Spec 03: pode ser hydrate falho. Limpa cache pra forçar re-login fresh no próximo ciclo.
+    await chrome.storage.local.remove([
+      "idUsuario", "idEmpresa", "idUsuarioObtidoEm",
+      "tokenLogin", "userPayload"
+    ]);
```

### 7. `extension/tests/chrome-mock.js` — sem mudança

Mocks atuais cobrem `chrome.storage.local.get/set/remove`. Suficiente pros testes novos.

### 8. `extension/tests/background.test.js` — testes novos

```js
describe("Spec 03: localStorage hydrate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chrome.storage.local.get.mockResolvedValue({ USUARIO: "8158", SENHA: "test" });
  });

  test("fazerLogin persiste tokenLogin + userPayload em storage.local", async () => {
    const loginPayload = {
      IdUsuario: 313, IdEmpresa: 1, Usuario: "0000008158",
      TokenLogin: "a1d7944a-90e5-449e-974e-ddc3d07b7123",
      NomePessoa: "F M M SERVICOS"
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [loginPayload] })
    });

    await fazerLogin();

    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenLogin: "a1d7944a-90e5-449e-974e-ddc3d07b7123",
        userPayload: loginPayload
      })
    );
  });

  test("fazerLogin não persiste se response sem TokenLogin", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [{ IdUsuario: 313 }] }) // sem TokenLogin
    });

    await fazerLogin();

    const setCalls = chrome.storage.local.set.mock.calls;
    const hydrateSet = setCalls.find(c => c[0].tokenLogin !== undefined);
    expect(hydrateSet).toBeUndefined();
  });

  test("runPollingLoop limpa tokenLogin/userPayload em TTL >6h", async () => {
    chrome.storage.local.get.mockImplementation((keys) => {
      if (Array.isArray(keys) && keys.includes("idUsuarioObtidoEm")) {
        return Promise.resolve({ idUsuarioObtidoEm: Date.now() - 7 * 60 * 60 * 1000 });
      }
      if (Array.isArray(keys) && keys.includes("MODO_TESTE")) return Promise.resolve({});
      return Promise.resolve({});
    });
    chrome.storage.session.get.mockResolvedValue({ isRunning: true });

    await runPollingLoop();

    expect(chrome.storage.local.remove).toHaveBeenCalledWith(
      expect.arrayContaining(["tokenLogin", "userPayload"])
    );
  });
});
```

Hydrate.js em si é difícil testar via Jest (depende de `localStorage` + `chrome.storage` + `chrome.runtime.sendMessage` em context isolado). Pode-se testar parsing/lógica mas timing real exige browser. Cobertura E2E via spec 08 (futuro).

### 9. `extension/popup.js` — botão "Limpar cache" já cobre

`chrome.storage.local.clear()` removerá `tokenLogin`/`userPayload` automaticamente. Próximo `fazerLogin` recria. Sem mudança.

### 10. `extension/manifest.json` — bump versão + permissions check

Permissions atuais: `storage, alarms, sidePanel, tabs, scripting` — suficientes (hydrate.js usa `chrome.storage` e `chrome.runtime.sendMessage`, ambos cobertos por `storage` + permissões padrão extension).

### 11. `CHANGELOG.md` — registrar v1.4.0

```markdown
## [1.4.0] - YYYY-MM-DD

### Added
- **Auto-login autônomo via localStorage hijack (Spec 03)** — cliente NÃO precisa mais fazer login UI manual no portal Canopus. Após primeira config de USUARIO+SENHA, robô chama `/auth/enterPlataforma` via API (sem 2FA), persiste `TokenLogin` + user payload, e content-script `hydrate.js` (run_at: document_start) injeta em `localStorage` da janela criada antes do Angular bootstrap. SPA acredita que cliente está logado e monta UI normal.
- Novo arquivo `extension/hydrate.js` — content-script document_start (~30 LOC)
- Telemetria `hydrate.localstorage_injected` + `hydrate.err`

### Changed
- `lib/auth.js fazerLogin()` agora persiste `tokenLogin` + `userPayload` em `chrome.storage.local`
- `lib/loop.js` TTL 6h limpa `tokenLogin`/`userPayload` junto com `idUsuario`
- `manifest.json` content_scripts ganha entry document_start

### Removed
- Pré-requisito "login UI manual 1×" — não é mais necessário
```

### 12. `README.md` — atualizar seção "Pré-requisitos"

Remover instrução de "cliente precisa logar UI 1× antes". Adicionar nota: "Robô faz login sozinho via API ao iniciar pela primeira vez. Sem 2FA, sem fricção."

## Verification

### Fase 1 — Unit tests

```bash
npm test
# Esperado: 186 atual + 3 novos = 189 verde
```

### Fase 2 — Manual em perfil Chrome LIMPO

1. Build novo `.crx`
2. Abrir Chrome com perfil totalmente novo (Configurações → Perfis → Adicionar perfil)
3. **NÃO abrir portal Canopus em nenhuma aba**
4. Instalar extensão via install.ps1 ou drag-and-drop
5. Configurar USUARIO+SENHA em Configurações, salvar
6. **NÃO fazer login UI no portal**
7. Click Iniciar
8. Esperar primeiro ciclo (15-30s)
9. Verificar telemetria:
   - `apiPost.req /auth/enterPlataforma` (ok)
   - `apiPost.resp 200` (sucesso, retorna TokenLogin)
   - `hydrate.localstorage_injected` (content-script document_start rodou) — APARECE quando janela criada via `garantirAbaPortal`
   - `portal.window_created url: "/apps/reservas"` (NÃO `/login` → hydrate funcionou)
   - `content.dom.match` (DOM driver achou modais)
   - `content.toast.appeared kind: "sucesso"` (reserva concluída)

### Fase 3 — Captura adicional opcional pra validar

Cliente roda no perfil novo + abre DevTools da janela criada pelo robô (clica F12 nela enquanto minimizada — pode precisar restaurá-la primeiro). Application → Local Storage → `parceiros.consorciocanopus.com.br` → deve mostrar `token` + `user` setados pelo robô (mesmos valores que apareceriam após login UI manual). Confirma hijack funcionou.

## Risks

- **Angular faz chamada de validação backend pós-bootstrap**: chamada tipo `/auth/validateSession` que valida TokenLogin no servidor. Se token velho (>6h) → backend rejeita → Angular redireciona `/login` mesmo com localStorage cheio. Mitigação: TTL local 6h em `runPollingLoop` força re-login antes do backend invalidar. Captura adicional confirmaria se essa chamada existe (não apareceu nas 3 capturas do cliente — provavelmente não tem).
- **localStorage keys mudam em update do portal**: portal pode renomear `token`/`user` pra `auth_token`/`session_data`. Mitigação: constantes centralizadas em `state.js` (`LOCALSTORAGE_TOKEN_KEY = "token"`, etc); telemetria `hydrate.localstorage_injected` mostra se ainda funciona; cliente captura novas keys via diagnóstico script.
- **Angular já leu localStorage antes do content-script rodar**: improvável com `document_start` (literalmente o primeiro hook), mas teoricamente possível com inline scripts no `<head>`. Mitigação: telemetria captura timing; se falhar, considera `<all_frames>` + escalation.
- **Browser bloqueia HttpOnly storage** (não aplicável a localStorage) — irrelevante aqui.
- **Cliente em modo incógnito**: extensions desabilitadas por padrão. Documentar.
- **Múltiplos perfis Canopus simultâneos**: se cliente quiser rodar 2 contas no mesmo Chrome, `chrome.storage.local` é por extension não por aba — só 1 conta funciona. Out of scope.
- **Outro código no portal Canopus reseta localStorage**: tipo "logout" button que limpa storage. Robô re-injeta no próximo ciclo via re-login API.

## Out of scope

- Replicar fluxo POST `/reservas/add` direto via SW (sem precisar Turnstile DOM) — exige decifrar como token Turnstile entra no body. Capturable em Fase 3 se quiser pular DOM driver inteiro futuro spec (`03b: SW-only reservation`).
- Auth flow OAuth/SAML se portal migrar
- Multi-conta paralela
- Backup de localStorage hijacked entre profiles do Chrome
- Migration automática se portal mudar storage keys (telemetria detecta falha + cliente alerta)
- 2FA na API (cliente confirmou: API atual NÃO exige 2FA via captura DevTools)

## Effort breakdown

| Subtask | Estimativa |
|---------|------------|
| `manifest.json` adicionar hydrate.js content_script document_start | 10min |
| `extension/hydrate.js` novo arquivo (~30 LOC) | 30min |
| `lib/auth.js` persistir tokenLogin + userPayload | 15min |
| `lib/loop.js` TTL inclui novas keys | 10min |
| `lib/portal.js` LOGIN_NECESSARIO limpa hydrate state | 15min |
| Tests novos (~3) | 1.5h |
| `package.json` + `manifest.json` bump 1.4.0 | 5min |
| CHANGELOG + README pré-requisitos | 45min |
| Build + smoke test em perfil Chrome novo | 1.5h |
| Cliente teste em produção real + análise telemetria | tempo cliente |
| **Total ativo** | **~5h** (M-, próximo de S) |

## References

- Chrome content_scripts run_at: <https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts#run-at>
- localStorage in content-scripts: <https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts#isolated_world>
  > "Content scripts have direct access to the host page's localStorage." (mesma origin)
- Diagnóstico do cliente em 22/05/2026 — script JS rodado no portal logado capturou:
  - `localStorage.token` = base64 do TokenLogin UUID
  - `localStorage.user` = base64 do user payload JSON
  - Cookies só analytics (zero auth)
  - Headers Angular = `secret`/`token` públicos hardcoded (idênticos a `lib/api.js getHeaders()`)
- Spec 01 (modularização) — pré-requisito completo (libs `lib/auth.js`, `lib/loop.js`, `lib/portal.js` existem)

## Histórico

- **22/05/2026**: spec original chamava-se "Auto-login via cookie hijack". Diagnóstico DevTools do cliente revelou que portal não usa cookies pra auth — usa `localStorage`. Spec re-escrita com mesma intenção (auto-login autônomo) mas implementação correta (content-script hydrate.js document_start em vez de chrome.cookies.set). Cookie hijack como abordagem original era cego — capturas confirmaram que não funcionaria.
