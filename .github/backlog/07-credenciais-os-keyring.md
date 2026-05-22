---
id: 07
title: Credenciais via OS keyring (Native Messaging Host)
status: backlog
priority: P1
effort: L
score_impact: +5
score_categories:
  - Segurança (+5)
depends_on: [06]
tags: [segurança, credenciais, native-messaging]
---

# Credenciais via OS keyring (Native Messaging Host)

## Context

Hoje USUARIO + SENHA + TELEGRAM_TOKEN ficam em `chrome.storage.local` **plaintext**:

```js
await chrome.storage.local.set({ USUARIO: "8158", SENHA: "Mudar12345@@", ... });
```

Chrome encripta o profile inteiro em disco (Windows DPAPI, macOS Keychain pra master key, Linux libsecret), mas:
1. **Outras extensions do mesmo profile** podem ler via `chrome.storage` cross-extension? Não — storage é isolado por extension. OK.
2. **Memória durante runtime**: storage values estão em RAM em texto puro quando SW lê. Acessível por debugger conectado, dumps de memória, exploit que escalou pra contexto extension.
3. **Backup do profile**: cliente que copia profile (sync ou backup manual) leva creds plaintext junto.
4. **Telemetria**: já sanitizada (`Senha` → `***`), mas qualquer função futura que loggar storage sem cuidado vaza.

Em comparação: gerenciadores de senha decentes usam OS keyring (Credential Manager Windows, Keychain macOS, libsecret/gnome-keyring Linux). Credenciais ficam encriptadas com chave master que só o user sessão atual pode desbloquear.

## Motivation

- **+5 segurança**: tira plaintext da memória do SW. Score Segurança 78→83.
- Cliente confia mais — credenciais Canopus expostas seriam incidente sério.
- **Score impact alvo**: +5.

## Approach

Chrome MV3 não tem acesso direto a OS keyring via JS API. Solução: **Native Messaging Host** — binário externo que roda fora do sandbox e expõe um stdio protocol pra extension.

### Componentes

1. **Native Messaging Host binary** (`canopus-credentials-host`):
   - Windows: C# .NET ou Go binary compilado pra `.exe`. Usa `System.Security.Cryptography.ProtectedData` (DPAPI) ou `CredentialManagement` namespace.
   - macOS: Swift/Go binary. Usa `Security.framework` → Keychain Services.
   - Linux: Go binary. Usa `libsecret` via dbus.
   - **Recomendação**: Go pra single codebase cross-platform; binários pequenos; sem runtime dependency.

2. **Native messaging manifest** (`com.canopus.credentials.json`):
   - Lista host em path do filesystem
   - Whitelist extension ID
   - Registro no SO:
     - Windows: `HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.canopus.credentials`
     - macOS: `/Library/Google/Chrome/NativeMessagingHosts/com.canopus.credentials.json`
     - Linux: `/etc/opt/chrome/native-messaging-hosts/com.canopus.credentials.json`

3. **Manifest extension** — adicionar `"nativeMessaging"` em `permissions`.

4. **Cliente JS no SW** — wrapper que chama host:
   ```js
   async function setCredencial(key, value) {
     return new Promise((resolve, reject) => {
       const port = chrome.runtime.connectNative("com.canopus.credentials");
       port.onMessage.addListener(msg => {
         if (msg.ok) resolve();
         else reject(new Error(msg.error));
         port.disconnect();
       });
       port.postMessage({ op: "set", key, value });
     });
   }

   async function getCredencial(key) { /* similar, op: "get" */ }
   ```

5. **Migration**: na primeira execução pós-update, se `chrome.storage.local.USUARIO` existir e keyring vazio, mover creds pro keyring + limpar storage. Idempotent.

6. **Fallback**: se Native Messaging Host não instalado (cliente macOS/Linux sem rodar `install-X.sh` que registra host), reverter pra `chrome.storage.local` com warning loggado. Não trava extensão.

### Instalador atualizado

`install.ps1` / `install-macos.sh` / `install-linux.sh` ganha responsabilidade extra:
- Copiar binário `canopus-credentials-host.exe` (ou `.bin`) pra path conhecido
- Registrar host nativo no path do SO
- Validar permissions de execução

Por isso o lote 06 (installer cross-platform) é pré-requisito.

## Files

**Criar (binário externo — provavelmente em repo separado ou subdir):**
- `native-host/main.go` — Go cross-platform binary
- `native-host/keyring_windows.go` — DPAPI integration
- `native-host/keyring_macos.go` — Keychain Services
- `native-host/keyring_linux.go` — libsecret
- `native-host/Makefile` ou script de build cross-compile
- `native-host/com.canopus.credentials.json` (template manifest)

**Modificar:**
- `extension/manifest.json` — adicionar `"nativeMessaging"` em permissions
- `extension/background.js` (ou `lib/credentials.js` se lote 01 done) — wrapper Native Messaging
- `extension/popup.js` — onChange dos inputs USUARIO/SENHA/TELEGRAM_TOKEN passa por `setCredencial` em vez de `storage.local.set`
- `install.ps1`, `install-macos.sh`, `install-linux.sh` — instalar binário + registrar host
- `pack.sh` — incluir binário em `dist/`
- `README.md` — explicar segurança aprimorada
- `CHANGELOG.md`
- `extension/tests/background.test.js` — mocks pra `connectNative`, testes migration

## Verification

1. Build cross-platform binary: `cd native-host && make all` → gera 3 binários (`*.exe`, `*-darwin`, `*-linux`).
2. Instalar via `install.ps1` (Windows) — confirmar `HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.canopus.credentials` existe.
3. Abrir extensão, configurar USUARIO + SENHA, salvar.
4. `chrome.storage.local.get('SENHA')` retorna `undefined` (creds migraram).
5. Inspecionar Credential Manager Windows (`rundll32.exe keymgr.dll, KRShowKeyMgr`) — entrada `canopus-credentials:USUARIO` listada.
6. Rodar ciclo — `fazerLogin` chama `getCredencial("USUARIO")` + `getCredencial("SENHA")` → API responde 200.
7. Telemetria: confirmar que `SENHA` continua sanitizada `***` nos events.
8. Desinstalar binário manualmente → reabrir extensão → modo fallback ativo, warning no popup "Credenciais em storage local (Native Host não detectado). Reinstale via install.ps1 pra segurança total."
9. Testar macOS + Linux com binaries respectivos.

## Risks

- **Complexidade aumenta significativamente**: native binary, registry/plist, signing (binary não assinado pode disparar SmartScreen/Gatekeeper). Mitigação: começar Windows-only (alvo cliente atual), expandir depois.
- **Binary não assinado dispara warnings**: Windows SmartScreen, macOS Gatekeeper. Mitigação: code sign opcional (US$ 100-400/ano Cert authority); por ora, instruções pra desbloquear.
- **Falha de Native Host trava login**: se binary morre, sem creds. Mitigação: timeout 3s em `connectNative` + fallback automático pra `storage.local`.
- **Cliente atual contente com setup**: pode parecer over-engineering. Mitigação: marcar como "segurança opcional" no UI.
- **MV3 SW termina entre invocações**: `connectNative` cria port; reconectar a cada `getCredencial` pode ter overhead. Mitigação: cache em variável de SW durante run; re-fetch se SW restart.

## Out of scope

- Code signing dos binários (decisão separada, custo recorrente)
- Suporte a hardware tokens (Yubikey)
- Integração com 1Password / Bitwarden / Dashlane
- Senha mestre adicional dentro da extensão
- Auditoria de acesso (log de quando creds foram lidas)
- Rotação automática de senha

## Effort breakdown

| Subtask | Estimativa |
|---------|------------|
| Protótipo Go binary Windows DPAPI | 4h |
| Native messaging manifest + registry registration | 2h |
| Wrapper JS no SW + migration logic | 3h |
| Tests + mocks | 3h |
| Adaptar instalador Windows | 2h |
| Porting macOS Keychain | 4h |
| Porting Linux libsecret | 3h |
| Build cross-platform Makefile | 2h |
| Docs README + INSTALL | 2h |
| Smoke test em cada SO | 3h |
| **Total** | **~28h** (L+ borderline XL) |

## References

- Chrome Native Messaging: <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- Windows DPAPI (Go): <https://pkg.go.dev/github.com/billgraziano/dpapi>
- macOS Keychain Go: <https://github.com/keybase/go-keychain>
- Linux libsecret Go: <https://pkg.go.dev/github.com/zalando/go-keyring>
- go-keyring (unified cross-platform): <https://github.com/zalando/go-keyring>
