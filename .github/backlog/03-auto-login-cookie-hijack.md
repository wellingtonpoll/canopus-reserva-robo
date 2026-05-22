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
depends_on: []
tags: [autenticação, ux, autonomia]
---

# Auto-login via cookie hijack (TokenLogin → chrome.cookies.set)

## Context

Hoje a extensão tem **duas autenticações paralelas**:

1. **SW-side (API)**: `fazerLogin` em `extension/background.js` chama `/auth/enterPlataforma` com USUARIO+SENHA armazenados em `chrome.storage.local`. Retorna `IdUsuario` e `TokenLogin`. **Não exige 2FA**. Telemetria do cliente em v1.2.0 confirma: `apiPost.req body: { Senha: "***", Usuario: "0000008158" } → success: true, TokenLogin: "a1d71678-..."`.

2. **Browser UI session**: cliente precisa fazer login manual no portal UI **uma vez** pra setar cookies HttpOnly da sessão Angular. Esse fluxo UI exige **2FA** (email/SMS). Cookie persiste por semanas; quando expirar, robô detecta via Lote E E4 (LOGIN_NECESSARIO) e abre janela em foco.

Assimetria explorável: backend aceita API auth sem 2FA, mas exige cookie de sessão UI pro `/reservas/add`. Se a extensão injetar cookie equivalente ao TokenLogin no jar do Chrome, próxima request DOM herda sessão sem cliente nunca abrir UI de login.

Resultado se funcionar: **robô 100% autônomo**, cliente clica "Iniciar" e nunca mais loga. Esse é o ideal explícito do cliente.

## Motivation

- **+3 UX**: elimina fricção de login manual + 2FA. Cliente "clica e dorme".
- **+2 arquitetura**: unifica fonte de verdade (1 auth via API), abolindo o ciclo manual de re-login quando cookie expira.
- **Score impact alvo**: +5 (UX 88→91, Arquitetura 88→90).

## Approach

**Fase 1 — Diagnóstico de cookies (PRÉ-REQUISITO BLOQUEANTE)**:

Cliente precisa fazer login manual 1× e capturar cookies do domínio. Sem o nome exato do cookie de sessão, `chrome.cookies.set` chuta no escuro.

Passos pro cliente:
1. Abrir <https://parceiros.consorciocanopus.com.br>, logar normalmente
2. F12 → aba **Application** → **Storage** → **Cookies** → `https://parceiros.consorciocanopus.com.br`
3. Capturar screenshot ou copiar lista de cookies (nome, valor parcial, domain, path, HttpOnly, Secure, SameSite, Expires)
4. Mandar pro suporte

Hipótese forte: cookie principal de sessão é algo tipo `token`, `auth_token`, `session_id` ou `_canopus_session`, com valor casando com `TokenLogin` da response API. Pode haver cookies adicionais (XSRF, CSRF).

**Fase 2 — Implementação**:

1. Adicionar `"cookies"` ao array `permissions` em `extension/manifest.json`.
2. Em `lib/auth.js` (ou `background.js` se sem lote 01), após `fazerLogin` retornar sucesso:
   ```js
   const tokenLogin = loginData.TokenLogin;
   await chrome.cookies.set({
     url: "https://parceiros.consorciocanopus.com.br/",
     name: "<COOKIE_NAME_DESCOBERTO>",
     value: tokenLogin,
     domain: "parceiros.consorciocanopus.com.br",
     path: "/",
     httpOnly: true,
     secure: true,
     sameSite: "lax",
     expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 3600
   });
   ```
3. Se houver múltiplos cookies (XSRF), setar todos com valores corretos. Pra XSRF, geralmente é gerado em request inicial — pode precisar fazer GET autenticado pro endpoint root pra forçar set-cookie pelo servidor (em vez de inventar valor).
4. Atualizar `garantirAbaPortal`: continuar usando `chrome.windows.create({state:"minimized"})` mas agora a janela criada **já vem logada** porque o cookie está no jar.
5. Modificar fluxo de `runMonitorCycle`: sempre chamar `fazerLogin` se cookie expirou (não só `idUsuarioObtidoEm > 6h`). Adicionar verificação via `chrome.cookies.get` antes do ciclo; se ausente/expirado, re-login + re-inject.

**Fase 3 — Validação**:

Tentar reservar via fluxo automático em browser limpo (perfil novo Chrome), sem cliente nunca abrir UI. Se reserva funciona → cookie hijack OK. Se `/reservas/add` retorna 401/redirect login → portal valida mais que cookie isolado (provavelmente fingerprint IP+UA+browser tokens) e cookie hijack não cobre. Documenta limitação e mantém fluxo manual atual.

## Files

**Modificar:**
- `extension/manifest.json` — adicionar `"cookies"` em `permissions`
- `extension/background.js` (ou `extension/lib/auth.js` se lote 01 feito):
  - após `fazerLogin` success: bloco que chama `chrome.cookies.set` com TokenLogin
  - `runMonitorCycle` ou `runPollingLoop`: verificação periódica de cookie via `chrome.cookies.get`
- `extension/tests/background.test.js` — testes pra: cookie set após login, cookie verification, fallback graceful se hijack falha
- `extension/tests/chrome-mock.js` — adicionar `chrome.cookies.set/get` mocks
- `CHANGELOG.md` — registrar feature

**Criar:**
- `docs/diagnostico-cookies.md` — guia pro cliente capturar cookies (espelho de `docs/diagnostico-paginacao.md`)

**Funções existentes a reusar:**
- `fazerLogin` em `extension/background.js` — usa retorno `data.data[0]` que inclui `TokenLogin`
- `garantirAbaPortal` — sem mudanças; o cookie injetado vai surtir efeito automaticamente
- `tentarRecuperarContentScript` — sem mudanças

## Verification

1. Cliente manda lista de cookies pós-login. Identificar nome do cookie de sessão.
2. Em ambiente de teste (perfil Chrome dedicado, sem cookie do Canopus): instalar extensão v1.x.y, configurar USUARIO+SENHA, NÃO logar UI, clicar Iniciar.
3. Telemetria: confirmar `apiPost.req /auth/enterPlataforma → resp TokenLogin`, depois `cookies.set` chamado (adicionar telemetria nova `cookie.injected`).
4. `garantirAbaPortal` cria janela → URL final fica em `/apps/reservas` (não `/login`). Telemetria `portal.window_created` deve mostrar `url: "https://.../apps/reservas"`.
5. Reserva flui: `content.dom.match` em toda etapa, `content.toast.appeared kind: "sucesso"`. Sem entry `LOGIN_NECESSARIO`.
6. `npm test` 186+ verde com novos testes de cookie injection.
7. Logout no portal (deletar cookie manual via DevTools) → próximo ciclo robô re-injeta sem cliente intervir.

## Risks

- **Portal valida fingerprint além de cookie**: cookie isolado pode não bastar; servidor checa IP, UA, JA3 TLS fingerprint, browser tokens cruzados. Mitigação: testar em ambiente real cedo; se falhar, documentar limitação e manter manual login 1×.
- **Cookie name muda**: portal Canopus pode mudar nome do cookie em update. Mitigação: capturar via `chrome.cookies.getAll` pós-login UI manual (se houver) e detectar pattern; alertar suporte se schema mudar.
- **Multiplos cookies necessários (XSRF + session)**: XSRF tipicamente é set pelo servidor em response de pre-flight. Pode ser necessário fazer `fetch(/apps/reservas, { credentials: include })` no SW pra forçar XSRF cookie set, antes da reserva.
- **Token expirado server-side mesmo com cookie injetado**: portal pode invalidar TokenLogin em janela curta. Robô precisa re-login periódico independente do TTL local (já existe via `idUsuarioObtidoEm` 6h).
- **2FA escala de UI pra API no futuro**: se Canopus adicionar 2FA ao endpoint `/auth/enterPlataforma`, esse fix quebra. Risco baixo curto prazo.

## Out of scope

- Suportar OAuth/SAML se Canopus migrar pra isso (decisão posterior)
- Multi-factor auth automation (e.g., ler email/SMS automaticamente — proibido por segurança/ToS)
- Cookie sync entre profiles do Chrome
- Suporte a "Lembrar-me" flag se portal expor

## Effort breakdown

| Subtask | Estimativa |
|---------|------------|
| Diagnóstico cookies (assíncrono, cliente) | 30min + tempo cliente |
| `manifest.json` + permission cookies | 15min |
| `cookies.set` após fazerLogin + telemetria | 1h |
| Cookie verification antes do ciclo | 1h |
| `chrome-mock.js` + testes novos | 1.5h |
| `docs/diagnostico-cookies.md` | 30min |
| Manual test em perfil limpo | 1h |
| Fallback graceful se hijack falha | 1h |
| **Total** | **~7h** (M) |

## References

- chrome.cookies API: <https://developer.chrome.com/docs/extensions/reference/api/cookies>
- chrome.cookies.set: <https://developer.chrome.com/docs/extensions/reference/api/cookies#method-set>
- HttpOnly + Secure semantics: <https://developer.mozilla.org/en-US/docs/Web/HTTP/Cookies>
- Telemetria atual: `apiPost.req`/`resp` em telemetria do cliente v1.2.0 prova TokenLogin retornado sem 2FA
