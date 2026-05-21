# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test                                       # Jest, 105+ tests
npm test -- --testNamePattern="sistemaEstaAberto"  # single describe/test by name
npm test -- extension/tests/background.test.js     # single file
npm run build                                  # Tailwind CLI → extension/popup.css (one-shot)
npm run build:watch                            # Tailwind CLI in watch mode (dev)
```

**Install extension in Chrome:**
1. `chrome://extensions` → enable Developer Mode → "Load unpacked" → select `extension/` folder.
2. Click extension icon → side panel opens (NOT popup — uses `chrome.sidePanel` API). Side panel persists when clicking outside.
3. `npm run build` must have run at least once so `extension/popup.css` exists (gitignored or regenerable from `extension/src/input.css`).

## Architecture

Chrome Extension (Manifest V3) for **Portal Parceiros Canopus** — monitors consortium reservation quotas and books them automatically. Modeled after a Python/aiohttp reference script (`config.py`/`asyncio` flow); the JS implementation mirrors its semantics closely.

### MV3 lifecycle constraints

Service worker can terminate at any moment. **All state lives in `chrome.storage`, never in module-level JS variables.** The polling loop is kept alive by chained `setTimeout`, with `chrome.alarms` (1-min period) as fallback that re-invokes `runPollingLoop` if the SW was killed.

| State | Storage | Why |
|-------|---------|-----|
| `USUARIO`, `SENHA`, `GRUPOS_CONFIG`, `DELAY_MIN/MAX`, `TELEGRAM_*`, `MODO_TESTE` | `local` | User config, persists across browser restarts |
| `idUsuario`, `idEmpresa`, `reservasPorGrupo` | `local` | Session-derived but persists between cycles |
| `isRunning`, `rateLimitHit`, `currentMin/Max`, `produtosBloqueados`, `sistemaFechadoLogged` | `session` | Runtime state, reset on browser restart |

### `extension/background.js` — core flow

`runPollingLoop()` is the heartbeat. Each iteration:

1. **Horário comercial gate** — `sistemaEstaAberto()` checks BR timezone (Seg-Sex 07:55-19:01, Sáb 07:55-13:00, Dom fechado). If closed → `dormirAteAbertura()` schedules wakeup at next opening (capped 1h chunks so SW death doesn't strand the loop). **Bypassed in MODO_TESTE** so test runs work 24/7.
2. **`runMonitorCycle()`** — login if no `idUsuario` → `buscarGrupos` → filter detectados → reserve in parallel via `Promise.allSettled`.
3. **AIMD delay adjustment** — `ajustarDelayDinamico()` reads `rateLimitHit` flag; if hit, multiplies `currentMin/Max × 2` (cap 60s); otherwise decays × 0.9 down to user floor. Resets flag.
4. **Next tick** — `setTimeout(runPollingLoop, randomDelay * 1000)`.

### API response shape gotchas

The Canopus API uses **nested arrays**:

- `listGruposReserva` returns `{ data: [[ {grupo1}, {grupo2}, ... ]] }` — array-wrapped array. Use `extrairGrupos()`.
- `/reservas/add` success returns either `{ data: [ {reserva} ] }` OR `{ data: [[ {reserva} ] ] }`. Use `extrairReserva()` — both shapes supported.
- Group filter key is **`CD_Grupo`** (e.g. `"009113"`), NOT `ID_Grupo` (PK interno, integer like `12345`). Config string `"009113:3"` matches `CD_Grupo`.
- `ID_Grupo`/`ID_Bem`/`ID_Produto`/`PZ_Comercializacao` are still needed in the `/reservas/add` payload.
- **Do not filter by `Vagas`** — Python reference doesn't; let `/reservas/add` decide via `success: false`.

### Rate limit handling

`apiPost` retries on `429`/`403` up to `MAX_TENTATIVAS = 4`:
- If response has `Retry-After` header, honors it (numeric seconds or HTTP-date via `parseRetryAfter()`).
- Otherwise random 5-15s backoff.
- **Always sets `storage.session.rateLimitHit = true`** so AIMD picks it up at end of cycle even if the retry eventually succeeded.

Additionally, `reservarComLimite` inspects `result.details` from `/reservas/add` for body-level rate limit signals (`1015`, `rate_limited`) and sets the same flag.

### Server-error handling in `reservarComLimite`

Decoded `details` strings trigger specific behavior (mirrors Python):

| Pattern in `details` | Action |
|----------------------|--------|
| `"restrição vigente"` | `throw new Error("SISTEMA_FECHADO")` → caught in `runPollingLoop` → `dormirAteAbertura()` |
| `"limite de reservas desse produto"` | Push `ID_Produto` into `storage.session.produtosBloqueados` array; future cycles skip that product. Logged + Telegram. |
| body contains `1015`/`rate_limited`/`429`/`403` | Set `rateLimitHit` |

### Group reservation tracking

`GRUPOS_CONFIG` parses `"009113:3,009114:2"` → `{ "009113": 3, "009114": 2 }` (CD_Grupo → limite). `storage.local.reservasPorGrupo` keeps counters. When `reservasPorGrupo[code] >= limite`, the group is removed from `GRUPOS_CONFIG` via `removerGrupoDoConfig` (persisted). On the next cycle the group won't match.

### Telegram notifications (Python-style, per-reserve)

Two messages per reservation (NOT cycle-aggregated):
1. **Before** `/reservas/add`: `🍀 Cota {CD_Grupo} encontrada para o usuário {usuário} em {data}!`
2. **After success**: 6-line message with `Usuário`, `Grupo`, `Cota` (from `CodigoCota`), `Produto`, `Data da Reserva`, `Válido até`. Dates via `formatarDataBR()`.

Telegram is silent in MODO_TESTE. `telegramNotify` failures are swallowed — never blocks the cycle.

### `extension/popup.html` + `popup.js` + UI build

UI is a **Side Panel**, not popup. `chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` in `onInstalled`.

- **Tailwind CLI v3** (NOT v4 — v4 has no built-in CLI binary) generates `extension/popup.css` from `extension/src/input.css`. Design tokens (MD3 light theme with `#ffd700` primary) live in `tailwind.config.js`. Project also uses a hand-written `extension/popup-base.css` for layout/animation rules that aren't worth a utility class.
- **CSP override** in `manifest.json` allows Google Fonts stylesheets + `fonts.gstatic.com` fonts. No `unsafe-inline` for styles → all CSS must be in linked files; never use `<style>` blocks or `style=""` attributes. JS may set `element.style.X` (CSSOM is allowed); never `setAttribute("style", ...)` or `style.cssText`.
- **Collapsible config/Telegram cards** use `aria-expanded` + JS `style.maxHeight` animation. Logs card has `flex: 1 1 auto` so it fills remaining vertical space and animates smoothly as cards collapse/expand.

### Tests

Jest, `extension/tests/background.test.js`. Chrome API mocked in `extension/tests/chrome-mock.js` (loaded via Jest `setupFiles`). `storage.session.get` defaults to `mockResolvedValue({})` — runMonitorCycle's `beforeEach` resets this to prevent mock pollution between tests that override it.

`mockSleep()` helper spies `setTimeout` and runs callbacks synchronously — required for testing `apiPost`'s rate-limit retry path without real 5-15s waits.

`mockGrupo` uses `CD_Grupo: "009113"`. `fetchGruposOk` wraps in nested array (`data: [[grupos]]`) to match real API.

### Known limitations

- **Cloudflare Turnstile on `/reservas/add`** — unresolved. Running inside the extension SW context may or may not bypass it; needs empirical confirmation. If SW fetch doesn't bypass, fallback is a content script injected on `parceiros.consorciocanopus.com.br` forwarding the request via `chrome.tabs.sendMessage`.
- API `secret` and `token` headers are **static Canopus credentials** (not user-specific). Hardcoded in `getHeaders()`. Do not expose as configurable UI fields.
