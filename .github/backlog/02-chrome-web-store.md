---
id: 02
title: Publicar extensão na Chrome Web Store
status: backlog
priority: P1
effort: L
score_impact: +8
score_categories:
  - Distribuição (+6)
  - UX (+2)
depends_on: []
tags: [distribuição, marketing, web-store]
---

# Publicar extensão na Chrome Web Store

## Context

Hoje a extensão é distribuída como `.crx` sideload via `ExtensionInstallForcelist` policy do Chrome (registry HKLM). Funciona mas:

- Cliente novo precisa rodar `install.ps1` com permissão admin (UAC).
- Em PCs corporativos com GPO, instalação pode falhar (HKLM bloqueado).
- Drag-and-drop do `.crx` em `chrome://extensions` mostra warning "esta extensão não está listada na Chrome Web Store" e Chrome auto-desativa.
- Sem auto-update via Chrome (depende de `update_manifest.xml` no GitHub Releases).
- Sem listing público — onboarding de cliente novo depende de README + screenshots manualmente.

Publicar na Chrome Web Store elimina warnings, dá 1-click install, auto-update via Google e adiciona credibilidade.

## Motivation

- **+6 distribuição**: link Web Store é o padrão que cliente espera. Onboarding cai de "rode esse PowerShell como admin" pra "clica aqui".
- **+2 UX**: sem warning de "não listada"; sem janela de UAC; cookie de profile não exige Admin do Windows.
- **Score impact alvo**: +8 (Distribuição 82→88, UX 88→90).

## Approach

Submeter `.crx` da v1.3.0 (ou versão mais recente disponível na hora) à Chrome Web Store via [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). Fluxo:

1. **Conta Developer**: criar conta com email do owner (`wellingtonpoll@gmail.com` ou conta dedicada). Pagar taxa única **US$ 5**.
2. **Listing assets** — já temos `store-assets/` com ícones; pode precisar ajustes:
   - Ícone 128×128 (PNG, transparente OK)
   - Screenshots 1280×800 ou 640×400 (PNG/JPG). Reutilizar `docs/screenshots/` adaptando se necessário.
   - Promo tile pequena 440×280
   - Descrição curta (até 132 chars)
   - Descrição longa (até 16k chars) — adaptar README
   - Categoria: "Produtividade" ou "Workflow & Planning"
3. **Privacy policy URL** obrigatório — pode hospedar Markdown no próprio repo (`docs/privacy-policy.md`) ou GitHub Pages.
4. **Single purpose narrative** explicando: extensão automatiza monitoramento de cotas para consultores autorizados do Portal Parceiros Canopus.
5. **Justificativa de permissions** — explicar `tabs`, `scripting`, `storage`, `alarms`, `sidePanel` ponto a ponto. Cada permission no manifest precisa rationale.
6. **Submeter zip** (não `.crx` — Web Store reempacota). Zip do diretório `extension/` sem `tests/`, `src/`, sem `.crx`/`.pem`.
7. **Aguardar review**: 1-7 dias. Risco real de rejeição (ver Risks).
8. **Publicar**: ao aprovar, item fica "Unlisted" inicialmente. Promover pra "Public" só se decidir distribuição aberta. Pra cliente único, **Unlisted** já basta (link direto funciona, mas extensão não aparece em busca).
9. **Atualizar README**: substituir seção de install policy por "Instale da Chrome Web Store: [link]".
10. **Update path**: Web Store gerencia atualizações. `update_manifest.xml` + `install.ps1` viram fallback pra cliente corporativo. `pack.sh` continua gerando `.crx` pra clientes não-Web-Store.

## Files

**Criar:**
- `docs/privacy-policy.md` — política simples; "extensão não coleta dados pessoais; credenciais ficam em chrome.storage local; telemetria opt-in sanitizada"
- `store-assets/listing/short-description.txt` (132 chars)
- `store-assets/listing/long-description.md` (até 16k chars; reaproveitar README)
- `store-assets/listing/single-purpose.txt`
- `store-assets/listing/permissions-rationale.md` — texto pra cada permission

**Modificar:**
- `README.md` — seção "📦 Instalação" ganha link Web Store no topo, install policy vira fallback
- `manifest.json` — possivelmente ajustar `homepage_url`, garantir `description` < 132 chars
- `CHANGELOG.md` — registrar versão publicada

**Não modificar:**
- Código de runtime (mesmo `.crx`)

## Verification

1. Conta Developer ativa, taxa paga, console acessível.
2. Submissão aceita sem erros de validação (manifest, ícones, screenshots, descriptions ok).
3. Item aparece em "Dashboard" com status "Pending review".
4. Após aprovação (1-7 dias), link funciona: `https://chrome.google.com/webstore/detail/<id>`.
5. Instalar via link num Chrome novo (perfil temporário) — extensão entra sem warnings, ícone aparece, side panel abre.
6. Forçar update: instalar versão N, publicar N+1 na Store, aguardar ~5h, confirmar update automático.
7. README atualizado com link funciona — cliente novo segue 1 click.

## Risks

- **Rejeição por automação de portal terceiro**: Google revisa policies de "automation of third-party sites without authorization". Canopus não autorizou a extensão por escrito. Risco MÉDIO. Mitigação: enquadrar como "ferramenta de produtividade pra usuários autorizados Canopus, usuário faz login com suas próprias credenciais, extensão só automatiza tarefa repetitiva que o próprio usuário faria manualmente". Se rejeitado, recorrer ou manter sideload.
- **Permissões amplas**: `tabs` + `scripting` + `host_permissions` em domínio terceiro podem disparar review manual. Mitigação: justificativa clara em "permissions-rationale.md".
- **Privacy policy obrigatória**: precisa URL real (não localhost). GitHub Pages resolve.
- **Conta Google bloqueada**: se conta for sinalizada, todas extensions afetadas. Mitigação: conta dedicada `canopus-robo@gmail.com` separada do email pessoal.
- **Review demora**: pode levar 2+ semanas em casos complexos. Não bloqueia distribuição via sideload existente.

## Out of scope

- Pagar review prioritário (não existe na Web Store)
- Remover features pra passar review (decisão posterior se rejeitado)
- Internacionalização do listing (PT-BR único basta pro alvo Canopus)
- Distribuir versão "Public" (manter Unlisted enquanto cliente único)
- Trial/freemium model

## Effort breakdown

| Subtask | Estimativa |
|---------|------------|
| Criar conta Developer + pagar $5 | 30min |
| Preparar listing assets (screenshots, descriptions) | 3h |
| Privacy policy + permissions rationale | 1h |
| Empacotar zip + submissão | 1h |
| Aguardar review (assíncrono) | 1-7 dias |
| Iterar rejeições se necessário | 2-8h |
| Atualizar README + CHANGELOG | 1h |
| Testar instalação via link Web Store | 1h |
| **Total ativo** | **~8-16h** (L) |

## References

- Web Store Developer Dashboard: <https://chrome.google.com/webstore/devconsole>
- Submitting an extension: <https://developer.chrome.com/docs/webstore/publish>
- Single purpose policy: <https://developer.chrome.com/docs/webstore/program-policies/single-purpose>
- Permissions justification: <https://developer.chrome.com/docs/webstore/cws-dashboard-listing>
