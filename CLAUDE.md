# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                           # Jest, 175+ tests across 3 suites
npm test -- --testNamePattern="sistemaEstaAberto"  # filter by name
npm test -- extension/tests/background.test.js     # single file
npm test -- extension/tests/content.test.js        # content-script tests (jsdom)
npm test -- extension/tests/popup.test.js          # popup UI tests (jsdom + indirect eval)
npm run build                                      # Tailwind CLI → extension/popup.css (one-shot)
npm run build:watch                                # Tailwind in watch mode
npm run visual                                     # Playwright headless: screenshots de 4 estados em tests/visual/latest/
```

**Install extension in Chrome:**
1. `chrome://extensions` → enable Developer Mode → "Load unpacked" → select `extension/` folder.
2. Click extension icon → side panel opens (`chrome.sidePanel` API). Persists across clicks outside.
3. `npm run build` precisa ter rodado pelo menos uma vez pra `extension/popup.css` existir (gitignored, regenerável de `extension/src/input.css`).

## Architecture

Chrome Extension MV3 — monitora cotas no **Portal Parceiros Canopus** e reserva automaticamente.

### MV3 lifecycle constraints

Service worker pode terminar a qualquer momento. **Todo estado vive em `chrome.storage`, nunca em variáveis JS do módulo.** Polling mantido por `setTimeout` encadeado + `chrome.alarms` (1min) como fallback.

### Storage layout (atual após Fix 14)

| Key | Storage | Why |
|-----|---------|-----|
| `USUARIO`, `SENHA`, `GRUPOS_CONFIG`, `DELAY_MIN/MAX`, `TELEGRAM_*`, `MODO_TESTE`, `TELEMETRIA_LIGADA` | `local` | Config do usuário, persiste |
| `idUsuario`, `idEmpresa`, `idUsuarioObtidoEm`, `reservasPorGrupo` | `local` | Session-derived, persiste entre ciclos. TTL 6h via `idUsuarioObtidoEm` |
| `metricasDia[YYYY-MM-DD]`, `metricasHoras[YYYY-MM-DD-HH]` | `local` | Agregado 30 dias para Dashboard/Histórico + CSV. Data em **BRT** via `toLocaleDateString('en-CA')` |
| `telemetria_buffer` | `local` | Ring buffer 500 entries. Apenas quando toggle ligado |
| `isRunning`, `rateLimitHit`, `currentMin/Max`, `produtosBloqueados`, `sistemaFechadoLogged`, `bucket`, `hitsRecentes`, `circuitAberto`, `ciclosVazios`, `gruposEmCooldown`, `turnstileBloqueado/Ate`, `cycleRunning/Since`, `pending_telemetria_batch`, `ultimoErro`, `activeTab` | `session` | Estado runtime, reset em browser restart |

**Convenção:** dados persistentes ficam em `local`; estado volátil de ciclo em `session`. Storage.session resets em SW restart — não persiste.

### `extension/background.js` — core flow

`runPollingLoop()` é o heartbeat. Cada iteração:

1. **Batch session read** — uma chamada `chrome.storage.session.get([...])` pega isRunning, nextRunAt, turnstileBloqueado, circuitAberto, sistemaFechadoLogged (Fix 4 M1).
2. **Mutex** — `cycleRunning` lock em session com timeout 90s. Evita race condition entre `setTimeout` e `chrome.alarms` (Fix 9). Reentrância detectada loga `cycle.skip_reentry` na telemetria.
3. **Turnstile pause** — se `turnstileBloqueadoAte > now`, agenda re-check em 5s.
4. **Circuit breaker** — se hits ≥ 2 em 120s, pausa 10min.
5. **Horário comercial** — `sistemaEstaAberto()` checa TZ BR (Seg-Sex 07:55-19:01, Sáb 07:55-13:00, Dom fechado). Bypassed em `MODO_TESTE`.
6. **idUsuario TTL** — se `idUsuarioObtidoEm > 6h`, força re-login no próximo ciclo (Fix 4 M9).
7. **`runMonitorCycle()`** — login → buscarGrupos → filter detectados (dedup por CD_Grupo + cooldown + produtosBloqueados) → reserva **SERIAL** via `for...of await` (Fix 6.1). DOM é singleton; paralelo causa race no modal.
8. **AIMD delay** — `ajustarDelayDinamico()`. Skip se `isRunning=false`.
9. **Métricas** — atomic read-modify-write em `metricasDia[dia]` preservando `rateLimits` que apiPost incrementa em paralelo (Fix 14 B1).
10. **Next tick** — `agendarProximoCiclo(delay)` via setTimeout + nextRunAt.
11. **finally** — libera `cycleRunning` lock.

### Reserva flow — content-script (Fix 3-H)

Reservas via `/reservas/add` NÃO funcionam direto do Service Worker (Cloudflare Turnstile bloqueia). Solução: `chrome.tabs.sendMessage` → content-script no DOM real → replica fluxo manual (Nova Reserva → seleciona grupo → Turnstile resolve → Reservar → toast).

**`reservarViaTab(grupo, grupoId)`:**
1. `chrome.tabs.query` busca tab em `parceiros.consorciocanopus.com.br/apps/*`
2. Foco aba + janela (Fix 5) — cliente é puxado pra resolver Turnstile se interativo
3. `chrome.tabs.sendMessage({ action: "reservar_via_dom", grupo })`
4. Auto-recovery (Fix 11+14): se `"Receiving end does not exist"`, tenta:
   - `chrome.scripting.executeScript` injeta content.js dinâmico (se URL em `/apps/*`)
   - OU `chrome.tabs.update` navega pra `/apps/reservas` (se outra rota)
   - Polling `ping` no content-script até alive (max 5s scripting / 8s navigate)
5. Retorna `{ ok, reserva }` ou erro estruturado

### `extension/content.js` — DOM driver

`reservarViaDom(grupo)` orquestra:
1. `clicarNovaReserva()` — botão "Nova Reserva"
2. `aguardarModalSelecioneGrupo()` — modal `<mat-dialog-container>`
3. `selecionarLinhaGrupo(modalEl, cdGrupo)` — `mat-row` com CD_Grupo
4. `aguardarModalDadosReserva()` — modal "Dados da Reserva"
5. `aguardarTurnstile(modalEl)` — polling `window.turnstile.getResponse()` + detecta interativo via `iframe[src*="challenges.cloudflare.com"]` (height/width > 50). Se interativo, envia `turnstile_challenge` ao SW → pausa robô 30s
6. `clicarReservar(modalEl)` — botão Reservar
7. `aguardarToast(modalDados)` — detecta sucesso/restrição/limite/erro genérico. Modal fechar sem toast = `incerto`

`aguardarElemento(fn, candidatos, timeout)` tenta candidatos em ordem (selector → text exato → text partial → predicate). Cada `try`/`match`/`miss` loga telemetria pra suporte ajustar selectors quando layout mudar.

Helpers expostos em `window.__canopusRobo` **apenas se `DEBUG=true`** (Fix 4 H4) — anti-detecção bot.

### `apiPost` rate limit + IP ban handling

`apiPost(path, body)` retorna 429/403:
- Detecta Cloudflare 1106 / `ipv6_banned` / `access_denied` no body → throw `IP_BANIDO`. `runPollingLoop` chama `pararMonitoramento` + alerta crítico.
- Detecta `1015`/`rate_limited` no body → flag cloudflare1015 + throw RATE_LIMIT.
- Sempre incrementa `metricasDia[dia].rateLimits` direto em storage.local. cycle.end preserva esse campo via read-modify-write atômico (Fix 14 B1).
- Sempre seta `storage.session.rateLimitHit = true` pra AIMD pegar no fim do ciclo.
- Registra hit em `hitsRecentes`; ≥ 2 em 120s abre circuit breaker (10min).

### API response shape gotchas

- `listGruposReserva` retorna `{ data: [[grupos]] }` (array aninhado) — `extrairGrupos()` desempacota.
- `/reservas/add` success: `{ data: [reserva] }` ou `{ data: [[reserva]] }` — `extrairReserva()` aceita ambos.
- Filter key é **`CD_Grupo`** (e.g. `"009113"`), não `ID_Grupo` (PK integer).
- API retorna **CD_Grupo duplicado** (1 entry por bem do grupo). Dedup por CD_Grupo em `runMonitorCycle` — pega primeiro bem não-bloqueado. Logs `dedup.applied` na telemetria.

### Server-error patterns em `reservarComLimite`

Branch `success: false` via `tabResp.details` do content-script:

| Pattern | Action |
|---------|--------|
| `"restrição vigente"` | throw SISTEMA_FECHADO → propaga via `for...of` break → `dormirAteAbertura()` |
| `"limite de reservas desse produto"` | Push `ID_Produto` em `produtosBloqueados`. Futuros ciclos skip. |
| `"1015"`/`"rate_limited"` no body | Seta rateLimitHit |
| Exception `RATE_LIMIT` direto | Cooldown 30s do grupo em `gruposEmCooldown` |
| Exception `TURNSTILE_TIMEOUT`/`TURNSTILE_ERROR` | Cooldown 60s do grupo |

### Group reservation tracking

`GRUPOS_CONFIG` parse `"009113:3,009114:2"` → `{ "009113": 3, "009114": 2 }`. `reservasPorGrupo` counter por CD_Grupo. Limite atingido → remove via `removerGrupoDoConfig` + persist.

`gruposEmCooldown[cdGrupo] = expiraEm` evita martelar o mesmo grupo em ciclos consecutivos após rate-limit.

### Telegram notifications

Duas mensagens por reserva (não cycle-aggregated):
1. **Before** `/reservas/add`: `🍀 Cota {CD_Grupo} encontrada...`
2. **After success**: 6-line message com Usuário, Grupo, Cota, Produto, Data, Validade. Datas via `formatarDataBR()`.

`telegramNotify` com `AbortController` timeout 5s (Fix 4 H5) — Telegram offline NÃO trava SW. Silencioso em MODO_TESTE.

### Telemetria (Fix entrega anterior)

Toggle "Telemetria" persiste `TELEMETRIA_LIGADA` em local. Quando ligado:
- Eventos coletados: `apiPost.req/resp/err`, `cycle.start/end`, `reserva.tab.req/resp`, `turnstile.*`, `content.dom.try/match/miss`, `popup.action`, `sw.lifecycle`, etc.
- `sanitize()` redact `Senha|password|secret`, trunca `TELEGRAM_TOKEN`, redact `token` header longo.
- Batch em memória (10 events ou 2s) → flush pra `chrome.storage.local.telemetria_buffer`. Ring buffer 500.
- `__resetTelemetriaCache()` + `__resetTelemetriaBatch()` helpers de teste evitam pollution.
- Botão "Exportar telemetria" no popup gera JSON download.
- Toggle off → limpa buffer (cliente exporta ANTES de desligar).
- `flushTelemetria()` no início de `runPollingLoop` recupera `pending_telemetria_batch` que sobreviveu SW kill.

### `extension/popup.html` + tabs (multi-page)

3 tabs CSS-only (sem router):
- **Operações** (default): card Operações + Grupos + Logs terminal + Dashboard panel collapsible
- **Histórico**: 4 charts Chart.js × 30 dias (consultas/dia, reservas/dia, taxa sucesso %, taxa rate-limit %) + botão Exportar CSV
- **Configurações**: usuário/senha/delays/Telegram/Suporte/Telemetria toggle/Limpar cache + Save sticky footer dentro do card

Switch via `body[data-tab="X"]` + CSS `[data-tab-content]` show/hide. Tab persistida em `storage.session.activeTab`.

`atualizarMetricas()` polling 3s atualiza chips no rodapé do logs (CICLOS/RESERV/PORTAL/RATE) + cards do dashboard panel + último erro persistido. `visibilitychange` pausa interval quando side panel oculto (Fix 14 U5).

`addLog()` cap em 500 entries (Fix 4 H2) com `requestAnimationFrame` debounced scroll (Fix 4 M2).

`<dialog>` custom substitui `confirm()` nativo pra UX consistent no side panel (Fix 14 U6).

### Chart.js self-hosted

`extension/lib/chart.umd.min.js` copiado de node_modules. CDN bloqueada por CSP `script-src 'self'`. ~70KB minified. 4 charts no Histórico + nenhum em Operações (chart 24h removido por redundância).

### Tests

3 suítes (175 tests total):

**`extension/tests/background.test.js`** (~150 tests):
- Helpers: `parseGruposConfig`, `removerGrupoDoConfig`, `sistemaEstaAberto`, `proximaAberturaBR`, `formatarDataBR`, `extrairGrupos`, `extrairReserva`, `parseRetryAfter`, `usuarioExibicao`
- API: `apiPost` (429/403/IP_BANIDO/network retry/Retry-After), `fazerLogin`, `telegramNotify` (AbortController)
- Reserva: `reservarComLimite` via tabs.sendMessage (success, semAba, TURNSTILE_TIMEOUT, FASE_2_PENDENTE_SELECTORS, backend errors, cooldown)
- Auto-recovery: `tentarRecuperarContentScript` (scripting executeScript / navigate / fail)
- Cycle: `runMonitorCycle` (paralelismo serial, dedup, login, modo teste, produtos bloqueados, focus tab)
- Loop: `runPollingLoop` mutex (Fix 9), Turnstile pause, circuit breaker
- AIMD: `ajustarDelayDinamico`, token bucket, `registrarHitERateLimit`, `agendarProximoCiclo`
- Telemetria: `sanitize`, batch flush, ring buffer, persistirBatchPendente, race concurrent
- Handlers: `handleTurnstileChallenge`

**`extension/tests/content.test.js`** (12 tests via jsdom):
- `tryCandidato` (selector/text/predicate)
- `getTurnstileToken` (window.turnstile / input fallback)
- `detectarTurnstileInterativo` (iframe visibility)
- `snapshotInterativos` (cap 40)
- Message handlers (ping/reservar_via_dom/unknown)

DEBUG flag substituído em build de teste pra expor helpers via `window.__canopusRobo`.

**`extension/tests/popup.test.js`** (13 tests via jsdom + indirect eval):
- `setDirty`, `setRunningState`, `addLog` (cls per kind, cap 500, escape XSS)
- `setActiveTab` (data-tab + aria-selected)
- `atualizarMetricas` (lê storage.local + restaura ultimoErro de session)
- `registrarUltimoErro`
- `ultimosDias(N)`, `labelCurto`

Indirect eval `(0, eval)(POPUP_JS)` roda no escopo global do Node pra exposição de funções. `function` declarations viram bindings globais; `const`/`let` permanecem locais.

### Seed pra teste de Histórico/CSV

`tests/seed-metricas-devtools.js` — IIFE que cliente (ou dev) cola no DevTools console do popup pra popular `chrome.storage.local.metricasDia` com 30 dias sample. Útil pra validar visualmente charts + CSV sem rodar robô por dias. Limpar via "Limpar cache" na tab Configurações.

### Visual check (Playwright)

`tests/visual-check.js` carrega popup.html em Chromium headless com mocks `chrome.*` injetados via `addInitScript`. Gera dados sample (30 dias métricas + logs). Tira 4 screenshots:
- `01-operacoes.png` — tab default
- `02-operacoes-dashboard-aberto.png` — dashboard expandido
- `03-historico.png` — 4 charts renderizados
- `04-config.png` — form Configurações

Output em `tests/visual/<timestamp>/` + symlink `tests/visual/latest/`. Usa `waitForFunction` (não `waitForTimeout`) pra resistir CI lento (Fix 14 T3).

### Permissions atual (`manifest.json`)

```json
"permissions": ["storage", "alarms", "sidePanel", "tabs", "scripting"]
"host_permissions": ["...parceiros.consorciocanopus.com.br/*", "...prod-api-portalparceiro-canopus.bsn.dev.br/*"]
"content_scripts": [{ "matches": ["...parceiros.consorciocanopus.com.br/apps/*"], "js": ["content.js"], "run_at": "document_idle" }]
```

`scripting` necessário pra `tentarRecuperarContentScript` injetar dinâmico.

### CSP

`"extension_pages": "script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;"`

- Sem `unsafe-inline` em styles → nada de `<style>` inline ou `style=""` no HTML. JS pode `element.style.X` (CSSOM permitido), nunca `setAttribute("style", ...)` ou `style.cssText`.
- Chart.js carrega de `lib/chart.umd.min.js` local (CDN bloqueada).

### Pre-release checklist (Fix 14)

Antes de bump:
1. `npm test` → 175/175 verde
2. `npm run visual` → 4 screenshots limpos, sem warnings
3. Manual no Chrome:
   - Reload extensão com aba portal aberta → auto-recovery via scripting injeta content-script sem reload
   - Stop+start múltiplos — sem leaks
   - Tab switch preserva state (logs, formulário)
   - clearCache dialog custom (não confirm nativo)
   - Telemetria export com sanitize correto
4. Bump `manifest.json` + `package.json` em sync
5. Tag + GitHub Release com `.crx` + `update_manifest.xml` + `install.bat`

### Known limitations

- **Cloudflare 1106 (IP ban)**: detectado em apiPost → para robô + alerta. Cliente precisa esperar 24h ou trocar IP. Sem retry automático possível.
- **Turnstile interativo**: quando Cloudflare escala pra puzzle/checkbox, robô pausa 30s pra cliente resolver no portal. Sem dispatcher remoto possível (token bound to origin+sitekey+session).
- **Headers Canopus `secret`/`token`**: credenciais API públicas (não user-specific). Hardcoded em `getHeaders()`. Sanitize redact em logs.
- **Selectors do portal Angular**: DOM ofuscado. Heurística (text+role+attributes) + telemetria captura snapshot quando miss pra suporte ajustar.
- **Aba do portal aberta obrigatória**: content-script só roda em `/apps/*`. Se ausente, robô não consegue reservar (auto-recovery tenta abrir).

### Versão atual

`1.1.0` — Fix 14 entregue. Mudanças significativas vs 1.0.x:
- Multi-tab UI (Operações/Histórico/Configurações)
- Dashboard 30 dias + CSV export
- Content-script auto-recovery (scripting + navigate)
- Mutex runPollingLoop (Fix 9)
- Telemetria com sanitize + export JSON
- Limpar cache da extensão
- BRT-aware date keys
- 175 tests (era 105)
- Visual check Playwright
