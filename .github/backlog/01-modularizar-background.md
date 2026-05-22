---
id: 01
title: Modularizar background.js em arquivos por domínio
status: backlog
priority: P2
effort: M
score_impact: +8
score_categories:
  - Código (+5)
  - Manutenibilidade (+3)
depends_on: []
tags: [arquitetura, refactor, código]
---

# Modularizar background.js em arquivos por domínio

## Context

`extension/background.js` tem **1643 LOC** num único arquivo e concentra HTTP layer, auth, discovery, reserva, cycle orchestration, rate limit, turnstile, portal window management, Telegram, telemetria, métricas, helpers de horário e lifecycle handlers. Tests file referencia ~30 funções por nome via `module.exports`.

Leitura/manutenção sofrem. Falta separação por domínio.

## Motivation

- **+5 código**: arquivos menores são navegáveis.
- **+3 manutenibilidade**: substituir uma lib sem mexer no resto.
- **Score impact alvo**: +8 (Código 75→78, Manutenibilidade 75→80).

## Approach

Manter `extension/background.js` como **shim ~30 LOC** que chama `importScripts(...)` em ordem topológica. MV3 service_worker continua sendo único entry point. Cada lib expõe suas funções via `self.X = X` (pra SW global scope) **e** `module.exports = {...}` (pra Jest em Node). Chrome-mock.js shim de `importScripts` permite Node carregar libs sequencialmente sem bundler.

**Por que essa abordagem (Approach B)**:
- Sem bundler (esbuild/rollup) → menos toolchain
- Sem `"type": "module"` no manifest → menos atrito Jest
- `self.X = X` pattern padrão em MV3 SW com importScripts
- Tests continuam funcionando com `require('../background.js')` (background.js re-export mega-objeto que combina todos exports)

## Estrutura final

```
extension/
├── background.js              # SHIM ~30 LOC (importScripts em ordem + module.exports mega)
└── lib/
    ├── state.js               # constantes + sleep (zero deps)
    ├── format.js              # formatarDataBR, usuarioExibicao, brasilNowParts (zero deps)
    ├── notifications.js       # notificarPopup, registrarUltimoErroPersistente (chrome.runtime only)
    ├── horario.js             # sistemaEstaAberto, proximaAberturaBR (deps: state, format)
    ├── telemetria.js          # sanitize, telemetria, flushTelemetria, persistirBatchPendente, getTelemetriaLigada, __reset* (deps: state)
    ├── telegram.js            # telegramNotify (deps: state, telemetria)
    ├── rate-limit.js          # tomarToken, registrarHitERateLimit (deps: state, notifications)
    ├── schedule.js            # ajustarDelayDinamico, agendarProximoCiclo (deps: state)
    ├── api.js                 # getHeaders, parseRetryAfter, apiPost (deps: state, telemetria, notifications, rate-limit)
    ├── auth.js                # fazerLogin (deps: state, api)
    ├── grupos.js              # buscarGrupos, extrairGrupos, extrairReserva, parseGruposConfig, removerGrupoDoConfig (deps: state, api, telemetria)
    ├── turnstile.js           # handleTurnstileChallenge, limparBadgeTurnstile (deps: state, telemetria, notifications, telegram)
    ├── portal.js              # garantirAbaPortal, tentarRecuperarContentScript, reservarViaTab (deps: state, telemetria, notifications, telegram)
    ├── reserva.js             # reservar, reservarComLimite (deps: state, api, telemetria, telegram, notifications, grupos, format, portal)
    ├── cycle.js               # runMonitorCycle (deps: state, telemetria, notifications, api, auth, grupos, reserva, telegram, horario, schedule)
    ├── loop.js                # runPollingLoop, dormirAteAbertura (deps: state, schedule, cycle, horario, telemetria, notifications, telegram, turnstile)
    ├── lifecycle.js           # iniciarMonitoramento, pararMonitoramento (deps: state, loop, schedule, telemetria, notifications)
    └── listeners.js           # registra chrome.alarms.onAlarm, runtime.onMessage, runtime.onInstalled, storage.onChanged, tabs.onRemoved (deps: state, lifecycle, turnstile, telemetria)
```

## Mapeamento função → arquivo

Mapping autoritativo. Cada linha referencia `background.js:LINE_ATUAL` pra busca rápida.

| Função / Constante | LOC atual | Arquivo alvo |
|---|---|---|
| `BASE_URL`, `ORIGIN_URL`, `alarmName` | 1-3 | `lib/state.js` |
| `MAX_TENTATIVAS_NET`, `RATE_LIMIT_BACKOFF_FACTOR`, `SUCCESS_DECAY_FACTOR`, `MAX_DYNAMIC_DELAY` | 4-7 | `lib/state.js` |
| `BUCKET_CAPACITY`, `BUCKET_REFILL_PER_SEC` | 10-11 | `lib/state.js` |
| `CIRCUIT_HITS_THRESHOLD`, `CIRCUIT_WINDOW_MS`, `CIRCUIT_OPEN_MS` | 14-16 | `lib/state.js` |
| `GRUPO_COOLDOWN_MS`, `TURNSTILE_COOLDOWN_MS`, `TURNSTILE_BLOQUEIO_MS` | 19-25 | `lib/state.js` |
| `PORTAL_TAB_URL`, `PORTAL_BOOTSTRAP_URL` | 29-32 | `lib/state.js` |
| `MANAGED_WINDOW_READY_TIMEOUT_MS`, `TAB_RESERVA_TIMEOUT_MS` | 36-39 | `lib/state.js` |
| `FLOOR_DELAY_MIN`, `FLOOR_DELAY_MAX`, `MAX_SETTIMEOUT_MS` | 42-46 | `lib/state.js` |
| `RATE_LIMIT_BACKOFF_SEC`, `CLOUDFLARE_1015_BACKOFF_SEC` | 49-50 | `lib/state.js` |
| `IDLE_INCREMENT`, `IDLE_MAX_CICLOS` | 53-54 | `lib/state.js` |
| `TELEMETRIA_MAX_ENTRIES`, `TELEMETRIA_BATCH_MAX`, `TELEMETRIA_FLUSH_MS`, `TELEMETRIA_BODY_TRUNC` | 57-60 | `lib/state.js` |
| `SANITIZE_REDACT_KEYS`, `SANITIZE_TRUNCATE_KEYS`, `SANITIZE_HEADER_KEYS` | 94-96 | `lib/state.js` |
| `ABERTURA_HHMM`, `FECHAMENTO_SEMANA`, `FECHAMENTO_SABADO` | 879-881 | `lib/state.js` |
| `TELEGRAM_TIMEOUT_MS` | 955 | `lib/state.js` |
| `sleep` | 191 | `lib/state.js` |
| `TELEMETRIA_BATCH`, `TELEMETRIA_FLUSH_TIMER`, `TELEMETRIA_LIGADA_CACHE` | 62-67 | `lib/telemetria.js` (module-private) |
| `getTelemetriaLigada()` | 69 | `lib/telemetria.js` |
| `__resetTelemetriaCache()` | 81 | `lib/telemetria.js` |
| `__resetTelemetriaBatch()` | 86 | `lib/telemetria.js` |
| `truncateString(s, max)` | 98 | `lib/telemetria.js` (interno) |
| `sanitize(obj, depth)` | 104 | `lib/telemetria.js` |
| `telemetria(tipo, dados)` | 131 | `lib/telemetria.js` |
| `flushTelemetria()` | 147 | `lib/telemetria.js` |
| `persistirBatchPendente()` | 180 | `lib/telemetria.js` |
| `notificarPopup(text)` | 940 | `lib/notifications.js` |
| `registrarUltimoErroPersistente(texto)` | 946 | `lib/notifications.js` |
| `formatarDataBR(iso)` | 836 | `lib/format.js` |
| `usuarioExibicao(usr)` | 845 | `lib/format.js` |
| `brasilNowParts(date)` | 850 | `lib/format.js` |
| `sistemaEstaAberto(date)` | 883 | `lib/horario.js` |
| `proximaAberturaBR(date)` | 891 | `lib/horario.js` |
| `telegramNotify(msg)` | 957 | `lib/telegram.js` |
| `tomarToken()` | 199 | `lib/rate-limit.js` |
| `registrarHitERateLimit()` | 222 | `lib/rate-limit.js` |
| `agendarProximoCiclo(ms)` | 193 | `lib/schedule.js` |
| `ajustarDelayDinamico()` | 374 | `lib/schedule.js` |
| `getHeaders()` | 254 | `lib/api.js` |
| `parseRetryAfter(header)` | 266 | `lib/api.js` |
| `apiPost(path, body, tentativaNet)` | 275 | `lib/api.js` |
| `fazerLogin()` | 408 | `lib/auth.js` |
| `buscarGrupos(idUsuario)` | 423 | `lib/grupos.js` |
| `extrairGrupos(resp)` | 819 | `lib/grupos.js` |
| `extrairReserva(resp)` | 828 | `lib/grupos.js` |
| `parseGruposConfig(configStr)` | 919 | `lib/grupos.js` |
| `removerGrupoDoConfig(configStr, grupoId)` | 931 | `lib/grupos.js` |
| `handleTurnstileChallenge()` | 1505 | `lib/turnstile.js` |
| `limparBadgeTurnstile()` | 1523 | `lib/turnstile.js` |
| `garantirAbaPortal()` | 525 | `lib/portal.js` |
| `tentarRecuperarContentScript(tab)` | 468 | `lib/portal.js` |
| `reservarViaTab(grupo, grupoId)` | 710 | `lib/portal.js` |
| `reservar(grupo, idUsuario, idEmpresa)` | 450 | `lib/reserva.js` (mantém mesmo sendo dead code per CLAUDE.md) |
| `reservarComLimite(...)` | 977 | `lib/reserva.js` |
| `runMonitorCycle()` | 1079 | `lib/cycle.js` |
| `dormirAteAbertura()` | 1271 | `lib/loop.js` |
| `runPollingLoop()` | 1286 | `lib/loop.js` |
| `iniciarMonitoramento()` | 1433 | `lib/lifecycle.js` |
| `pararMonitoramento()` | 1469 | `lib/lifecycle.js` |
| `chrome.alarms.onAlarm.addListener` | 1497 | `lib/listeners.js` |
| `chrome.runtime.onMessage.addListener` | 1531 | `lib/listeners.js` |
| `chrome.runtime.onInstalled.addListener` | 1584 | `lib/listeners.js` |
| `chrome.storage.onChanged.addListener` | 1589 | `lib/listeners.js` |
| (futuro `chrome.tabs.onRemoved` do Fix 16 Lote B) | — | `lib/listeners.js` |

## Pattern de export pra cada lib

Cada arquivo `lib/X.js` segue formato:

```js
// ─── lib/example.js ─────────────────────────────────────────────────────────
// Dependências esperadas no escopo global (definidas por libs anteriores via
// self.X = X no SW, ou via shim de importScripts em Node tests):
//   - sleep (state.js)
//   - sanitize, telemetria (telemetria.js)

async function exemploFn(arg) {
  // ... pode chamar sleep(...), telemetria(...), etc. (já globais via self)
}

function _internalHelper() {
  // private; NÃO exposto via self
}

// Exports — SW (popula self/globalThis) + Node test (module.exports)
if (typeof self !== "undefined") {
  self.exemploFn = exemploFn;
}
if (typeof module !== "undefined") {
  module.exports = { exemploFn };
}
```

`telemetria.js` é especial: `TELEMETRIA_BATCH`/`TELEMETRIA_FLUSH_TIMER`/`TELEMETRIA_LIGADA_CACHE` ficam **module-private** (não exposto via self). Funções `__resetTelemetriaBatch`/`__resetTelemetriaCache` mutam essas vars via closure.

## `background.js` final (shim ~30 LOC)

```js
// background.js — entrypoint SW MV3.
// Toda lógica está em lib/*. Esse arquivo só importa em ordem topológica.
self.importScripts(
  'lib/state.js',
  'lib/format.js',
  'lib/notifications.js',
  'lib/horario.js',
  'lib/telemetria.js',
  'lib/telegram.js',
  'lib/rate-limit.js',
  'lib/schedule.js',
  'lib/api.js',
  'lib/auth.js',
  'lib/grupos.js',
  'lib/turnstile.js',
  'lib/portal.js',
  'lib/reserva.js',
  'lib/cycle.js',
  'lib/loop.js',
  'lib/lifecycle.js',
  'lib/listeners.js'  // registra listeners ao carregar
);

// Pra testes Node: re-exporta tudo o que background.js antigo exportava.
// (Em SW, esse bloco é no-op porque typeof module === "undefined")
if (typeof module !== "undefined") {
  module.exports = Object.assign({},
    require('./lib/state'),
    require('./lib/format'),
    require('./lib/notifications'),
    require('./lib/horario'),
    require('./lib/telemetria'),
    require('./lib/telegram'),
    require('./lib/rate-limit'),
    require('./lib/schedule'),
    require('./lib/api'),
    require('./lib/auth'),
    require('./lib/grupos'),
    require('./lib/turnstile'),
    require('./lib/portal'),
    require('./lib/reserva'),
    require('./lib/cycle'),
    require('./lib/loop'),
    require('./lib/lifecycle')
  );
}
```

## Adaptação Jest

`extension/tests/chrome-mock.js` ganha shim de `importScripts`:

```js
// extension/tests/chrome-mock.js
const path = require('path');

global.chrome = { /* ... mocks atuais ... */ };

// Shim importScripts pra Node — propaga libs pro global usando require + Object.assign(global, ...)
global.self = global; // alias self → global em Node (SW usa self)
global.importScripts = (...paths) => {
  for (const p of paths) {
    const lib = require(path.resolve(__dirname, '..', p));
    if (lib && typeof lib === 'object') {
      Object.assign(global, lib); // expõe exports no global (simula self.X = X)
    }
  }
};
```

Tests existentes que fazem `require('../background.js')` continuam funcionando porque:
1. `require('../background.js')` carrega o shim
2. `self.importScripts(...)` na linha 1 do shim usa global.importScripts (do chrome-mock)
3. Cada lib carrega via require → expõe via Object.assign(global, ...)
4. `module.exports = Object.assign({}, require('./lib/*')...)` no fim devolve tudo agregado
5. Test recebe o mesmo objeto que recebia antes (mesmas keys)

## Ordem de migração (incremental, 1 lib por commit)

Fazer migração em **18 commits pequenos**, cada um movendo 1 lib e mantendo tests verde:

1. `extract: lib/state.js` — só constantes + sleep. Background.js importa via require síncrono no top. Tests verde.
2. `extract: lib/format.js` — formatarDataBR, usuarioExibicao, brasilNowParts.
3. `extract: lib/notifications.js`.
4. `extract: lib/horario.js`.
5. `extract: lib/telemetria.js` — cuidado com vars module-private.
6. `extract: lib/telegram.js`.
7. `extract: lib/rate-limit.js`.
8. `extract: lib/schedule.js`.
9. `extract: lib/api.js`.
10. `extract: lib/auth.js`.
11. `extract: lib/grupos.js`.
12. `extract: lib/turnstile.js`.
13. `extract: lib/portal.js`.
14. `extract: lib/reserva.js`.
15. `extract: lib/cycle.js`.
16. `extract: lib/loop.js`.
17. `extract: lib/lifecycle.js`.
18. `extract: lib/listeners.js` + finalize background.js como shim.

Estratégia "leave behind": durante migração, background.js mantém referência a função antiga como `const X = require('./lib/X').X` até o ÚLTIMO commit que apaga tudo. Tests veem mesmo behavior em cada passo.

**Alternativa big-bang** (1 commit gigante): rejeitada — bisect impossível, review difícil.

## Files

**Criar (18 libs):** todos em `extension/lib/`. Ver tabela acima.

**Modificar:**
- `extension/background.js` — vai vindo cada vez menor até virar shim ~30 LOC
- `extension/tests/chrome-mock.js` — adicionar shim de `importScripts`, alias `self = global`
- `extension/manifest.json` — **NENHUMA mudança** (service_worker continua `background.js`)
- `pack.sh` — confirmar que zip inclui `extension/lib/` (provavelmente já inclui via `zip -r`)

**Não modificar:**
- `extension/popup.js`, `extension/popup.html`, `extension/popup-base.css`
- `extension/content.js`
- `extension/tests/background.test.js` — código de teste deve ficar idêntico
- `extension/tests/content.test.js`, `extension/tests/popup.test.js`
- CSP no manifest (importScripts não viola `script-src 'self'`)

## Verification

A cada commit incremental:

1. `npm test` — 186/186 verde mantido. Se quebrar, investigar antes do próximo extract.
2. `git diff HEAD~1 -- extension/lib/` — confirma só add (não modify).
3. `git diff HEAD~1 -- extension/background.js` — confirma só removal de funções movidas.

Após commit final:

4. `wc -l extension/background.js` → ~30 LOC.
5. `wc -l extension/lib/*.js` → 18 arquivos, cada um <300 LOC tipicamente.
6. `npm run visual` — 6 screenshots inalterados (UI não muda).
7. **Manual no Chrome real**:
   - Instalar `.crx` rebuildado da branch
   - Abrir side panel
   - Configurar credenciais + grupo qualquer
   - Click Iniciar — ciclo roda igual
   - Forçar erro (config inválida) — telemetria captura
   - Stop — limpa estado
8. **Smoke test em DevTools do SW** (`chrome://extensions` → service worker → Inspect):
   - Console: `self.apiPost` deve existir
   - Console: `self.runPollingLoop` deve existir
   - Console: `self.TELEMETRIA_BATCH` NÃO deve existir (module-private)
9. CI green: `.github/workflows/test.yml` continua passando.

## Risks

- **Ordem circular**: `api.js` precisa de `rate-limit.js` (chama `tomarToken`); `rate-limit.js` NÃO precisa de api. OK. Ordem topológica é verificada na tabela acima.
- **`function` declarations escope no Node**: declarações de função em CommonJS são module-scoped, não globais. Mitigação: o `Object.assign(global, lib)` no shim de importScripts propaga via global, então `function tomarToken` em rate-limit fica acessível pra api via `global.tomarToken` (ou `self.tomarToken` se rodando no SW). Tests devem usar `global.X` ou rely em re-export pelo background.js.
- **Variáveis module-private em telemetria.js**: `TELEMETRIA_BATCH` é mutado por várias funções (`telemetria`, `flushTelemetria`, `__resetTelemetriaBatch`). Todas ficam no mesmo arquivo, então closure resolve sem export.
- **`module.exports` mega vs duplicate keys**: re-export pode ter colisões se duas libs declararem mesmo identifier. Mitigação: cada lib só exporta o que está na tabela de mapeamento; sem overlap.
- **Tests que mockam `chrome.storage.session.get` confiam em comportamento global**: já são mockados via `chrome-mock.js` que é setupFile do Jest; lib refactor não afeta.
- **Performance no SW**: 18× importScripts adiciona overhead de parse? Negligível — Chrome lê tudo de uma vez.

## Out of scope

- Migrar `popup.js` ou `content.js` (escopo só do SW)
- TypeScript
- Bundler (esbuild/rollup)
- ES modules em vez de importScripts
- Eliminar `module.exports` pattern pra testes (Jest 30 ESM seria opção, mas atrito)
- Renomear funções/variáveis (refactor só de organização)
- Tests novos pra libs (cobertura mantém-se via tests existentes que usam mega-export)

## Effort breakdown

| Subtask | Estimativa |
|---------|------------|
| `lib/state.js` (constantes + sleep) | 30min |
| `lib/format.js` + `lib/notifications.js` (2 libs simples) | 30min |
| `lib/horario.js` + `lib/telemetria.js` (telemetria com vars privadas) | 1.5h |
| `lib/telegram.js` + `lib/rate-limit.js` + `lib/schedule.js` | 1.5h |
| `lib/api.js` + `lib/auth.js` + `lib/grupos.js` | 2h |
| `lib/turnstile.js` + `lib/portal.js` (portal é grande, ~180 LOC) | 1.5h |
| `lib/reserva.js` + `lib/cycle.js` (cycle 200+ LOC) | 2h |
| `lib/loop.js` + `lib/lifecycle.js` | 1h |
| `lib/listeners.js` + finalizar shim background.js | 1h |
| Adaptar `chrome-mock.js` shim de importScripts | 1h |
| Rodar suite a cada commit + debugar quebras | 1.5h |
| Manual smoke test Chrome real | 1h |
| Atualizar CHANGELOG | 15min |
| **Total** | **~14.5h** (M estourado, beira L; aceitável dado granularidade incremental) |

## References

- Chrome importScripts em MV3 SW: <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics>
- MV3 service worker lifecycle: <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- `self` global em Web Workers: <https://developer.mozilla.org/en-US/docs/Web/API/Window/self>
- Jest setupFiles: <https://jestjs.io/docs/configuration#setupfiles-array>
- CommonJS vs ESM trade-off: <https://nodejs.org/api/esm.html>
