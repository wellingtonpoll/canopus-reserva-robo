---
id: 08
title: E2E test stub com portal Angular fake
status: backlog
priority: P2
effort: L
score_impact: +3
score_categories:
  - Testes (+3)
depends_on: []
tags: [testes, e2e, playwright]
---

# E2E test stub com portal Angular fake

## Context

Tests atuais (186) cobrem unit + jsdom integration mas **não testam o fluxo end-to-end real** com extensão carregada em Chrome de verdade. `tests/visual-check.js` usa Playwright mas só com `popup.html` standalone + mocks; não exercita SW ↔ content-script ↔ DOM portal.

Gap real: regressão em selectors de `content.js`, em `runMonitorCycle` orchestration, em mutex, em ciclo completo passa despercebida até cliente reportar. Telemetria captura, mas é reativo.

Solução: **portal Angular fake** servido localmente, Chrome inicializado com extension real apontando pra esse host, Playwright dispara fluxo, assert outcome.

## Motivation

- **+3 testes**: fecha gap E2E. Confiança alta de que release não quebra fluxo crítico.
- Habilita CI a pegar regressão em DOM selectors antes de release (vs depender de cliente reportar).
- **Score impact alvo**: +3 (Testes 82→85).

## Approach

### Portal fake

`tests/e2e/portal-fake/` — servidor Express HTTP servindo:
- `/apps/reservas` — HTML mínimo que simula DOM relevante:
  - botão "Nova Reserva"
  - modal "Selecione um Grupo" (lista de `mat-row` com CD_Grupo)
  - modal "Dados da Reserva" com input `cf-turnstile-response` simulado + botão Reservar
  - `.mat-snack-bar-container` toast injetado on success
- `/auth/enterPlataforma` — endpoint POST que responde JSON real `{ success: true, data: [{ IdUsuario, IdEmpresa, TokenLogin, ... }] }` baseado em USUARIO+SENHA enviados (qualquer combo OK pra teste)
- `/reservas/listGruposReserva/<id>` — POST responde grupos mockados
- `/reservas/add` — POST responde sucesso

Reuso de telemetria do cliente (v1.2.0 capturou response real do `/auth/enterPlataforma`): podemos usar exatamente esse JSON como fixture.

Selectors do portal fake batem com heurísticas atuais de `content.js`:
- `button` com `innerText === "Nova Reserva"` ✅
- `mat-dialog-container` contendo "Selecione um Grupo" ✅
- `mat-row` com text `CD_Grupo` ✅
- Turnstile widget falso (input `[name="cf-turnstile-response"]` setado pra `"fake-token"` após 500ms — simula token invisible)
- Toast `.mat-snack-bar-container` com text "Reserva efetuada com sucesso! OK"

### Playwright test

`tests/e2e/portal.test.js`:

```js
const { chromium } = require('playwright');
const path = require('path');
const { startPortalFake } = require('./portal-fake/server');

describe('E2E reservation flow', () => {
  let server, browser, context;

  beforeAll(async () => {
    server = await startPortalFake({ port: 8765 });
    const extensionPath = path.resolve(__dirname, '..', '..', 'extension');
    context = await chromium.launchPersistentContext('', {
      headless: false,  // extensions require headed
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
  });

  afterAll(async () => {
    await context.close();
    await server.close();
  });

  test('cycle completo dispara reserva', async () => {
    // Configurar URL do portal pra apontar pra localhost via override
    // (precisa lib/state.js do lote 01 OU global override via env var)
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');

    // Injetar config via SW
    await sw.evaluate(async () => {
      await chrome.storage.local.set({
        USUARIO: 'test-user',
        SENHA: 'test-pass',
        GRUPOS_CONFIG: '009113:1',
        DELAY_MIN: 1,
        DELAY_MAX: 2,
        MODO_TESTE: false,
        TELEGRAM_TOKEN: '',
        TELEGRAM_CHAT_ID: '',
      });
      await chrome.storage.session.set({ isRunning: true });
    });

    // Abrir portal fake (simula cliente logado)
    const page = await context.newPage();
    await page.goto('http://localhost:8765/apps/reservas');
    await page.waitForLoadState('networkidle');

    // Iniciar via SW
    await sw.evaluate(() => {
      // chamar iniciarMonitoramento()
    });

    // Aguardar reserva concluída via storage signal
    await page.waitForFunction(async () => {
      const r = await chrome.storage.local.get(['reservasPorGrupo']);
      return r.reservasPorGrupo && r.reservasPorGrupo['009113'] >= 1;
    }, { timeout: 30000 });

    // Assert toast apareceu no portal fake
    const toast = await page.waitForSelector('.mat-snack-bar-container');
    expect(await toast.textContent()).toContain('sucesso');
  });
});
```

### URL override em runtime

Problema: `extension/background.js` tem `const BASE_URL = "https://prod-api-..."` hardcoded. Pra testar contra `localhost:8765`, precisa override.

Opções:
1. **Env var no build**: `pack.sh` substitui `BASE_URL` placeholder. Custom build pra E2E.
2. **Storage override**: SW lê `chrome.storage.local.__test_base_url` se setado. Hack, mas funcional sem mexer no build.
3. **Manifest override host_permissions**: adicionar `http://localhost:*/*` em test build.

Recomendação: opção 2 — pequeno hack só em E2E, zero impacto em prod.

### Integrar no CI

`.github/workflows/test.yml` ganha job opcional `e2e`:
```yaml
e2e:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: 22 }
    - run: npm ci
    - run: npx playwright install --with-deps chromium
    - run: npm run test:e2e
```

`test:e2e` script novo em `package.json`.

## Files

**Criar:**
- `tests/e2e/portal-fake/server.js` — Express server
- `tests/e2e/portal-fake/public/index.html` — DOM Angular-like simulado
- `tests/e2e/portal-fake/fixtures/login-response.json`
- `tests/e2e/portal-fake/fixtures/grupos-response.json`
- `tests/e2e/portal.test.js` — Playwright spec
- `tests/e2e/README.md` — como rodar local

**Modificar:**
- `package.json` — script `test:e2e: playwright test tests/e2e/`, deps `express` em devDeps
- `extension/background.js` (ou `lib/state.js` se lote 01 done) — fallback pra `chrome.storage.local.__test_base_url` se presente
- `.github/workflows/test.yml` — job opcional E2E
- `extension/tests/background.test.js` — teste pra que `__test_base_url` override funciona

## Verification

1. `npm run test:e2e` local — passa.
2. Servidor fake responde corretamente: `curl localhost:8765/apps/reservas` → HTML; `curl -X POST localhost:8765/auth/enterPlataforma -d '{}'` → JSON sucesso.
3. Extension carregada com `--load-extension` ataca o portal fake.
4. `reservasPorGrupo['009113']` atualizado em storage após ciclo.
5. Toast aparece no portal fake DOM.
6. Sem network real (verificar via `chrome.webRequest` ou simples — fake é localhost).
7. CI job E2E roda + passa em GitHub Actions.

## Risks

- **Playwright + extension headed**: precisa `headless: false`, mas CI Linux precisa `xvfb-run`. Mitigação: action `xvfb-action` ou `playwright install` com deps incluídas.
- **DOM fake diverge do real**: portal Canopus muda Angular → fake fica stale → falso verde. Mitigação: tagged release de v1.2.0 telemetria captura DOM real; usar snapshot pra atualizar fake periodicamente.
- **Tempo de execução cresce**: E2E ~30-60s por test. CI passa de 2min pra 4-5min. Aceitável.
- **Flaky tests**: timing-sensitive (Turnstile delay, modal transitions). Mitigação: `waitForFunction` ao invés de `waitForTimeout`; retry 2× no Playwright config.
- **MV3 SW timeout**: SW termina após 30s sem eventos. E2E precisa keep-alive. Mitigação: registrar `chrome.alarms` no test setup.

## Out of scope

- Testar contra portal Canopus real (impossível sem conta de teste)
- Testar Turnstile interativo escalation (mock invisible suficiente)
- Testar Telegram (já tem unit test)
- Cross-browser (só Chromium)
- Performance benchmarks (Lighthouse etc.)
- Test de 2FA flow (não dá pra simular email/SMS)

## Effort breakdown

| Subtask | Estimativa |
|---------|------------|
| Express server fake + HTML DOM Angular-like | 4h |
| Fixtures JSON (login, grupos, reserva) | 1h |
| Playwright spec (cycle completo) | 3h |
| URL override mechanism in SW | 1h |
| Test de Turnstile fake delay + toast | 2h |
| CI workflow E2E job + xvfb setup | 2h |
| Refinar selectors + timing pra evitar flake | 3h |
| Documentação `tests/e2e/README.md` | 1h |
| **Total** | **~17h** (L) |

## References

- Playwright extension testing: <https://playwright.dev/docs/chrome-extensions>
- Chrome MV3 SW lifecycle: <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- Express minimal server: <https://expressjs.com/en/starter/hello-world.html>
- xvfb-action: <https://github.com/marketplace/actions/xvfb-action-for-github-actions>
