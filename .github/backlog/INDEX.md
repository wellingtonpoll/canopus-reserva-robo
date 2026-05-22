# Backlog — Canopus Reserva Robô

Specs versionadas dos próximos passos pra elevar o score do projeto de **823 → ~857-870** (faixa Chrome Web Store / Enterprise-grade). Cada arquivo é executável: pega o `.md` correspondente, lê `Approach` + `Files` + `Verification`, implementa.

Score atual e análise completa: ver discussão no histórico do projeto (`SCORE: 823/1000`, breakdown em 10 categorias). Cada item abaixo declara `score_impact` no frontmatter.

## Items

| ID | Título | Priority | Effort | Score | Status | Depends |
|----|--------|----------|--------|-------|--------|---------|
| 02 | [Publicar Chrome Web Store](./02-chrome-web-store.md) | P1 | L | +8 | backlog | — |
| 03 | [Auto-login via cookie hijack](./03-auto-login-cookie-hijack.md) | P1 | M | +5 | backlog | 01 |
| 07 | [Credenciais via OS keyring](./07-credenciais-os-keyring.md) | P1 | L | +5 | backlog | 06 |
| 01 | [Modularizar background.js](./01-modularizar-background.md) | P2 | M | +8 | ✅ done | — |
| 06 | [Installer cross-platform (macOS/Linux)](./06-installer-cross-platform.md) | P2 | L | +3 | backlog | — |
| 08 | [E2E test stub com portal fake](./08-e2e-test-stub.md) | P2 | L | +3 | backlog | — |
| 04 | [Coverage report CI com threshold](./04-coverage-ci-threshold.md) | P3 | S | +3 | backlog | — |
| 05 | [Arquitetura diagram no README](./05-architecture-diagram.md) | P3 | S | +2 | backlog | — |

## Quick stats

- **Total pendente**: 7 items (1 done)
- **Score atual estimado**: 823 + 8 (item 01 done) = **831/1000**
- **Score teto se tudo done**: 823 + 37 = **860/1000**
- **Próximo recomendado**: `02-chrome-web-store` (mais visível pro cliente, +8 score, sem dependências)
- **Quick wins (S effort)**: 04, 05 (~6h combinados, +5 score)
- **Pré-requisitos críticos**: 07 depende de 06 (Native Messaging Host precisa installer cross-platform pra distribuir o binário)

## Legenda

- **Priority**: P0 crítico bloqueante / P1 alto valor / P2 médio / P3 nice-to-have
- **Effort**: S (<4h) / M (4-16h) / L (1-3 dias) / XL (>3 dias)
- **Status**: backlog / in_progress / done / cancelled
- **Score**: delta esperado no score total `/1000` ao concluir

## Workflow sugerido

1. Pegar próximo item por prioridade
2. Mudar `status: backlog` → `in_progress` no frontmatter
3. Implementar seguindo `Approach` + `Files`
4. Rodar `Verification`
5. Commit + atualizar `status: done` + atualizar tabela acima

## Critérios de aceite p/ adicionar nova spec

- Beneficia score em pelo menos +2
- Tem `Files` específicos (não vaga)
- Tem `Verification` testável
- Effort estimado realista (com breakdown)
