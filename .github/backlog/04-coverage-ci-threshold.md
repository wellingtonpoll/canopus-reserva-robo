---
id: 04
title: Coverage report no CI com threshold mínimo
status: backlog
priority: P3
effort: S
score_impact: +3
score_categories:
  - Testes (+2)
  - Manutenibilidade (+1)
depends_on: []
tags: [ci, testes, qualidade]
---

# Coverage report no CI com threshold mínimo

## Context

Suite atual tem 186 testes verde. Mas **cobertura % não é medida nem versionada** — não dá pra dizer se branches críticos têm asserção. Quando alguém adiciona código novo (especialmente em PRs futuros ou contributor externo), nada bloqueia regressão de cobertura.

Jest já suporta nativamente via `--coverage` + `coverageThreshold`. Setup atual em `package.json`:

```json
"jest": {
  "testEnvironment": "node",
  "testMatch": ["**/tests/**/*.test.js"],
  "setupFiles": ["./extension/tests/chrome-mock.js"]
}
```

Sem `collectCoverage` nem `coverageThreshold`. CI workflow (`.github/workflows/test.yml`) roda só `npm test` puro.

## Motivation

- **+2 testes**: garante que pull requests não baixem cobertura abaixo de threshold. Reviewers veem delta automaticamente.
- **+1 manutenibilidade**: badge de cobertura no README mostra rigor; futuro contributor confia mais no projeto.
- **Score impact alvo**: +3 (Testes 82→84, Manutenibilidade 75→76).

## Approach

1. **Configurar Jest pra coletar coverage** em `package.json`:
   ```json
   "jest": {
     "testEnvironment": "node",
     "testMatch": ["**/tests/**/*.test.js"],
     "setupFiles": ["./extension/tests/chrome-mock.js"],
     "collectCoverage": false,
     "collectCoverageFrom": [
       "extension/background.js",
       "extension/content.js",
       "extension/popup.js",
       "!extension/lib/chart.umd.min.js"
     ],
     "coverageReporters": ["text", "lcov", "html"],
     "coverageDirectory": "coverage",
     "coverageThreshold": {
       "global": {
         "branches": 70,
         "functions": 80,
         "lines": 80,
         "statements": 80
       }
     }
   }
   ```
   `collectCoverage: false` mantém `npm test` rápido pra dev local. CI passa `--coverage` explícito.

2. **Adicionar script dedicado** em `package.json`:
   ```json
   "test:coverage": "jest --coverage"
   ```

3. **Atualizar CI workflow** `.github/workflows/test.yml`:
   - Trocar `npm test` por `npm run test:coverage` na step Test
   - Adicionar step upload coverage:
     ```yaml
     - name: Upload coverage
       if: matrix.node-version == 22
       uses: codecov/codecov-action@v4
       with:
         files: coverage/lcov.info
         fail_ci_if_error: false
     ```
   - OU sem codecov: artifact upload pra inspeção manual:
     ```yaml
     - name: Upload coverage report
       if: matrix.node-version == 22
       uses: actions/upload-artifact@v4
       with:
         name: coverage-report
         path: coverage/
     ```

4. **Badge no README**:
   - Via codecov: `[![codecov](https://codecov.io/gh/.../branch/main/graph/badge.svg)](...)`
   - OU via shields.io estático após coletar: `[![Coverage](https://img.shields.io/badge/coverage-XX%25-brightgreen)](...)`

5. **`.gitignore`** ganha `coverage/` (já provavelmente tem `node_modules`; adicionar coverage caso falte).

6. **Threshold realista**: começar conservador (70% branches, 80% lines) pra não bloquear o estado atual. Subir gradualmente.

## Files

**Modificar:**
- `package.json` — `jest.collectCoverageFrom`, `coverageThreshold`, novo script `test:coverage`
- `.github/workflows/test.yml` — usar `npm run test:coverage`, opcional upload
- `.gitignore` — `coverage/`
- `README.md` — adicionar badge de cobertura no topo (junto aos outros badges)

**Criar (opcional):**
- `codecov.yml` na raiz se usar codecov.io — config customizada de threshold

**Não modificar:**
- Código de testes existentes (cobertura é cálculo passivo)
- Código de produção

## Verification

1. `npm run test:coverage` localmente — gera diretório `coverage/` com `lcov.info`, `html/index.html`.
2. Abrir `coverage/lcov-report/index.html` — visualizar cobertura por arquivo. Confirmar `background.js`, `content.js`, `popup.js` listados.
3. Threshold falha intencional: baixar `lines: 80` pra `lines: 99` no `package.json`, rodar `npm run test:coverage` → exit code != 0. Restaurar.
4. CI workflow: criar PR test com 1 commit qualquer → Actions run mostra coverage. Confirmar badge atualiza (se codecov).
5. README badge renderiza com valor real.

## Risks

- **Threshold inicial baixo demais**: mascara baixa cobertura. Mitigação: rodar `--coverage` antes de definir threshold; pegar valor atual − 2% como floor inicial.
- **CI lento**: `--coverage` adiciona ~30% no tempo. Aceitável (CI atual <2min, vai pra <3min).
- **Codecov free tier**: gratuito pra repos públicos. Sem risco.
- **Coverage flakiness**: branches assíncronos podem reportar diferente entre runs. Mitigação: usar `coverageProvider: "v8"` (mais determinístico).

## Out of scope

- Mutation testing (Stryker — overhead alto, pra outro momento)
- Cobertura de `content.js` testada em browser real (precisa Playwright, mais caro)
- Cobertura em popup.js além do que indirect-eval atual captura
- Threshold per-file (manter global pra evitar overhead manual)
- Enforce 100% coverage em arquivos críticos (fica P2 separado)

## Effort breakdown

| Subtask | Estimativa |
|---------|------------|
| Configurar `jest.coverageThreshold` em package.json | 30min |
| Rodar `--coverage` local e ajustar threshold inicial | 30min |
| Atualizar `.github/workflows/test.yml` | 30min |
| Setup codecov (conta + repo enable) OU artifact upload | 45min |
| Badge no README | 15min |
| Testar PR mock com regressão de cobertura | 30min |
| **Total** | **~3h** (S) |

## References

- Jest coverage config: <https://jestjs.io/docs/configuration#collectcoveragefrom-array>
- Codecov GitHub Action: <https://github.com/codecov/codecov-action>
- shields.io badge custom: <https://shields.io/badges/dynamic-badge>
- v8 coverage provider: <https://jestjs.io/docs/configuration#coverageprovider-string>
