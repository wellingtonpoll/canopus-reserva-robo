# Changelog

Todas mudanças notáveis deste projeto serão documentadas aqui.

Formato baseado em [Keep a Changelog](https://keepachangelog.com/), versionamento
[Semantic Versioning](https://semver.org/).

## [1.1.1] - 2026-05-21

### Added
- **`install.ps1`** — instalador PowerShell nativo (recomendado pra Win10/11). Auto-elevação via `Start-Process -Verb RunAs`, detecção de Chrome instalado, mensagens de erro com diagnóstico contextual (GPO corporativa, antivírus, UAC limitado)
- **`INSTALL.md`** — guia completo de troubleshooting com 3 opções de instalação (PS1, BAT, manual via Modo Desenvolvedor) + reset/desinstalação + verificação

### Changed
- **`install.bat`** — mensagens de erro detalhadas com causas e soluções. Detecta Chrome, valida placeholder, auto-elevação melhorada
- **`pack.sh`** — inclui `install.ps1` + `INSTALL.md` no `.zip` da release
- README com instruções atualizadas pra ambos instaladores

### Fixed
- Cliente com Windows sem `cmd` direto conseguiu instalar via PowerShell
- Erro genérico "HKLM não pode ser modificada" agora explica causas reais (GPO/AV/UAC)

## [1.1.0] - 2026-05-21

### Added
- **Interface multi-tab** — Operações / Histórico / Configurações em Side Panel
- **Dashboard histórico 30 dias** — 4 gráficos Chart.js (consultas/dia, reservas/dia, taxa sucesso %, taxa rate-limit %)
- **Exportação CSV** das métricas com período de 30 dias
- **Auto-recovery do content-script** via `chrome.scripting.executeScript` + fallback `chrome.tabs.update` para `/apps/reservas`
- **Detecção de IP banido (Cloudflare 1106)** — robô para sozinho + alerta crítico
- **Mutex em `runPollingLoop`** com timeout 90s — elimina ciclos duplicados quando `setTimeout` + `chrome.alarms` disparam simultâneo
- **Telemetria opcional** — toggle em Configurações captura request/response/DOM events com sanitize (Senha, TELEGRAM_TOKEN, secret/token redacted). Export `.json`. Buffer ring 500
- **Limpar cache da extensão** — botão em Configurações apaga tudo (storage local + session + alarms)
- **Métricas persistentes 30 dias** em `chrome.storage.local` com data BRT-aware
- **Dialog custom** substituindo `confirm()` nativo (UX side panel)
- **Suíte testes content.js** — 12 testes jsdom
- **Suíte testes popup.js** — 13 testes jsdom + indirect eval
- **Visual check Playwright** — `npm run visual` gera screenshots automatizados das 3 tabs
- **Seed script DevTools** (`tests/seed-metricas-devtools.js`) para popular 30 dias sample

### Changed
- Ícones (16/48/128) regenerados a partir de novo PNG 1024×1024
- Chart.js self-hosted em `extension/lib/chart.umd.min.js` (CSP bloqueia CDN)
- `runMonitorCycle` envolto em try/finally — métricas em ciclo vazio agora incrementam normalmente
- `metricasDia` movido de `storage.session` para `storage.local` (persistência entre sessões)
- Datas internas usando `toLocaleDateString('en-CA')` para BRT-awareness

### Fixed
- Race condition em `metricasDia.rateLimits` entre `apiPost` e `cycle.end` (read-modify-write atômico)
- `clear_telemetria_buffer` agora aguarda Promise.all antes de `sendResponse`
- `ultimoErro` persistido em `storage.session` — sobrevive fechar/reabrir popup
- `LOGIN_FALHOU` agora limpa `idUsuarioObtidoEm` (não deixa órfão)
- Métricas em ciclo vazio (`detectados.length === 0`) agora atualizam `metricasDia` corretamente
- `tentarRecuperarContentScript` agora usa polling até `sendMessage` suceder (max 5s scripting / 8s navigate) em vez de delays hardcoded
- Border do botão Save agora visível (#d0c6ab vs #5a4c00 anterior)
- `metricasTimer` é pausado quando side panel oculto via `visibilitychange`

### Infrastructure
- 175/175 → 176/176 testes verde
- `manifest.json` + `package.json` em sync (1.1.0)
- `.gitignore` adiciona `extension_id.md` + `tests/visual/`

## [1.0.1] - 2026-05-20

### Added
- Distribuição via GitHub Releases + Chrome Web Store
- `install.bat` Windows com `ExtensionInstallForcelist` policy
- `update_manifest.xml` para auto-update
- Telegram notifications (cota encontrada + reserva concluída)
- Modo Teste bypassa horário comercial
- AIMD rate limit + token bucket + circuit breaker
- Reserva via content-script (Fix 3-H) para passar Cloudflare Turnstile
- Cooldown por grupo após RATE_LIMIT
- Tratamento de erros server-side: `restrição vigente`, `limite de reservas desse produto`

### Changed
- AIMD `BUCKET_CAPACITY` 1 → 3, refill 0.1/s → 0.3/s
- Logging completo em pontos de erro (anteriormente engolidos por `Promise.allSettled`)

### Fixed
- Cotas detectadas mas não reservadas (try/catch ausente em `reservarComLimite`)
- Log duplicado "⏹ Monitoramento parado"
- Requests em voo continuavam após "Monitoramento parado" (guards `isRunning`)
- `gruposEmCooldown` previne circuit breaker abrir em 2 ciclos

## [1.0.0] - 2026-05-20

### Added
- Versão inicial — Chrome Extension MV3
- Side Panel UI com Tailwind v3 + design tokens MD3
- Monitoramento contínuo via `runPollingLoop` (setTimeout + chrome.alarms heartbeat)
- Login automático Portal Parceiros Canopus
- Filtro de grupos por `CD_Grupo` com limite configurável
- Horário comercial automático (TZ BR Seg-Sex 07:55-19:01, Sáb 07:55-13:00)
- AIMD delay (multiplicação × 2 em rate limit, decay × 0.9 em ciclos limpos)
- Jest test suite (105 testes iniciais)

[1.1.1]: https://github.com/wellingtonpoll/canopus-reserva-robo/releases/tag/v1.1.1
[1.1.0]: https://github.com/wellingtonpoll/canopus-reserva-robo/releases/tag/v1.1.0
[1.0.1]: https://github.com/wellingtonpoll/canopus-reserva-robo/releases/tag/v1.0.1
[1.0.0]: https://github.com/wellingtonpoll/canopus-reserva-robo/releases/tag/v1.0.0
