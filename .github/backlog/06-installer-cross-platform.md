---
id: 06
title: Installer cross-platform (macOS .pkg, Linux .deb/.sh)
status: backlog
priority: P2
effort: L
score_impact: +3
score_categories:
  - Distribuição (+3)
depends_on: []
tags: [distribuição, instalação, multi-plataforma]
---

# Installer cross-platform (macOS .pkg, Linux .deb/.sh)

## Context

Hoje a distribuição cobre só Windows via:
- `install.ps1` — PowerShell nativo, recomendado
- `install.bat` — Batch fallback
- Ambos escrevem `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist` no registry

Cliente atual usa Windows 10/11, então cobertura está OK pra ele. Mas score caiu em "Distribuição" porque:
- Sem opção macOS — cliente futuro com Mac não tem caminho automatizado
- Sem opção Linux — desenvolvedor/dev-tester precisa instalação manual
- README "📦 Instalação" só menciona Windows

Chrome aceita ExtensionInstallForcelist em todos SOs via policy files (não registry):
- **macOS**: `~/Library/Application Support/Google/Chrome/External Extensions/<id>.json` ou Configuration Profile `.mobileconfig`
- **Linux**: `/etc/opt/chrome/policies/managed/canopus.json` ou `~/.config/google-chrome/External Extensions/<id>.json`

## Motivation

- **+3 distribuição**: cobertura platform-completa. Score de distribuição 82→85.
- **Habilita lote 07** (Native Messaging Host pra credentials no OS keyring) — cross-platform pré-requisito.
- **Score impact alvo**: +3.

## Approach

Adicionar 2 installers paralelos aos Windows existentes:

### macOS — `install-macos.sh`

Bash que:
1. Detecta Chrome instalado (`/Applications/Google\ Chrome.app` existe)
2. Escreve JSON com Extension ID + update URL em `~/Library/Application Support/Google/Chrome/External Extensions/<EXTENSION_ID>.json`:
   ```json
   {
     "external_update_url": "https://github.com/.../update_manifest.xml"
   }
   ```
3. Confirma sucesso + instrui usuário a reabrir o Chrome
4. Tratamento de erro: sem Chrome, permissões insuficientes, GPO empresarial (MDM)

Alternativa mais robusta: gerar `.mobileconfig` (XML Configuration Profile) que pode ser deployed via MDM (Jamf, Munki). Out of scope inicial.

### Linux — `install-linux.sh`

Bash que:
1. Detecta Chrome ou Chromium instalado (`google-chrome`/`chromium` no PATH)
2. Determina path de policy: `/etc/opt/chrome/policies/managed/canopus-robo.json`
3. Requer `sudo` pra escrever em `/etc/`
4. Escreve JSON:
   ```json
   {
     "ExtensionInstallForcelist": ["<EXTENSION_ID>;https://.../update_manifest.xml"]
   }
   ```
5. Confirma + instrui reabrir Chrome

Pacote `.deb` opcional pra Ubuntu/Debian — `dpkg-deb` build com postinst hook. Out of scope inicial (manter `.sh` simples).

### Atualizar pack.sh

`pack.sh` substituiu placeholders em `install.ps1`/`install.bat`. Adicionar:
- `install-macos.sh`
- `install-linux.sh`

Ambos com mesma estrutura de placeholders (`EXTENSION_ID_PLACEHOLDER`, URLs latest).

### Atualizar README

Seção "📦 Instalação" ganha tabs/subsections:
- Windows (atual)
- macOS (novo)
- Linux (novo)

Cada uma com 2 linhas de comando + 1 nota de troubleshooting.

## Files

**Criar:**
- `install-macos.sh` — bash com placeholders + lógica
- `install-linux.sh` — bash com placeholders + lógica
- `docs/install-macos.md` — troubleshooting (Gatekeeper, MDM, perfil dedicado)
- `docs/install-linux.md` — troubleshooting (Chromium vs Chrome, multi-distro)

**Modificar:**
- `pack.sh` — incluir 2 novos scripts no `dist/` + zip
- `README.md` — seção Instalação multi-OS
- `INSTALL.md` — adicionar seções macOS e Linux
- `CHANGELOG.md`

**Não modificar:**
- Código de runtime (mesmo `.crx` funciona em todos SOs)
- `update_manifest.xml`

## Verification

### macOS

1. VM macOS (ou Mac real)
2. Chrome instalado, sem extensão
3. `chmod +x install-macos.sh && ./install-macos.sh`
4. Reabrir Chrome
5. `chrome://extensions` mostra extensão instalada via policy (sem warning)
6. Side panel abre

### Linux

1. Ubuntu/Fedora VM com Chrome (ou Chromium)
2. Sem extensão
3. `sudo ./install-linux.sh`
4. Reabrir Chrome
5. `chrome://policy` lista `ExtensionInstallForcelist` com ID correto
6. `chrome://extensions` mostra extensão

### Cross-platform

7. README renderiza tabs/sections corretamente
8. `pack.sh` gera `dist/install-macos.sh` + `dist/install-linux.sh` com placeholders substituídos
9. Release zip inclui ambos

## Risks

- **macOS Gatekeeper**: pode bloquear bash script não-assinado. Mitigação: instruir cliente a desbloquear via `xattr -d com.apple.quarantine install-macos.sh` ou abrir via right-click → Open.
- **Linux distros heterogêneas**: caminho de policy varia (Chrome vs Chromium, snap vs apt). Mitigação: script detecta + tenta ambos. Falha graciosa com mensagem clara.
- **MDM corporativo bloqueia**: clientes em ambientes gerenciados (Jamf, Intune) podem ter policy GPO que bloqueia install user-level. Mitigação: documentar contato com IT do cliente.
- **Cliente atual não usa**: pode parecer trabalho sem retorno imediato. Justifica pelo lote 07 (Native Messaging Host).

## Out of scope

- `.pkg` macOS assinado com Developer ID Apple (US$ 99/ano — cliente não justifica hoje)
- `.deb`/`.rpm` builds (manter `.sh` simples)
- Snap package
- Configuration Profile `.mobileconfig` deploy via MDM
- Auto-update do próprio installer
- ARM macOS support testing (assume universal — Chrome cuida)

## Effort breakdown

| Subtask | Estimativa |
|---------|------------|
| Pesquisar policy paths macOS/Linux + testar manual | 2h |
| Escrever `install-macos.sh` com placeholders | 2h |
| Escrever `install-linux.sh` com placeholders | 2h |
| Atualizar `pack.sh` pra incluir ambos | 1h |
| Test em VM macOS (acesso necessário) | 2h |
| Test em VM Linux (Ubuntu Chrome + Chromium) | 1.5h |
| Docs README + INSTALL.md + troubleshooting | 2h |
| **Total** | **~13h** (L) |

## References

- Chrome External Extensions docs: <https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions>
- macOS policy files: <https://support.google.com/chrome/a/answer/9020077>
- Linux policy files: <https://support.google.com/chrome/a/answer/9027408>
- ExtensionInstallForcelist policy reference: <https://chromeenterprise.google/policies/#ExtensionInstallForcelist>
