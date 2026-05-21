# Canopus Reserva Robô

[![Version](https://img.shields.io/github/v/release/wellingtonpoll/canopus-reserva-robo?label=vers%C3%A3o&color=success)](https://github.com/wellingtonpoll/canopus-reserva-robo/releases)
[![Tests CI](https://github.com/wellingtonpoll/canopus-reserva-robo/actions/workflows/test.yml/badge.svg)](https://github.com/wellingtonpoll/canopus-reserva-robo/actions/workflows/test.yml)
[![Tests](https://img.shields.io/badge/tests-176%20passing-brightgreen)](./extension/tests)
[![Manifest](https://img.shields.io/badge/Chrome%20MV3-supported-blue)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-success)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-ISC-blue)](./LICENSE)

Extensão Chrome (Manifest V3) para monitoramento e reserva automática de cotas no **Portal Parceiros Canopus**.

Roda como um Side Panel persistente dentro do navegador, mantém sessão de login, varre os grupos configurados, e dispara reservas assim que vagas são liberadas — replicando o fluxo manual no DOM da página pra passar pelo Cloudflare Turnstile. Suporta notificações via Telegram, modo teste sem reserva, controle dinâmico de rate limit (AIMD + `Retry-After`), histórico agregado de 30 dias com gráficos + exportação CSV, telemetria opcional para suporte, e respeito automático ao horário comercial.

---

## 📦 Instalação

Instalação automática em **2 passos** (apenas Windows):

1. **Baixe** o [`install.bat` da release mais recente](https://github.com/wellingtonpoll/canopus-reserva-robo/releases/latest).
2. **Execute como Administrador** — clique duas vezes no arquivo e autorize o controle de conta de usuário (UAC). O instalador pede elevação automaticamente.

Pronto. Abra o Chrome — a extensão é instalada automaticamente em até 1 minuto via política corporativa (`ExtensionInstallForcelist`). Procure o ícone do robô na barra de extensões.

> **Atualizações automáticas:** novas versões publicadas em [Releases](https://github.com/wellingtonpoll/canopus-reserva-robo/releases) são instaladas pelo Chrome sem nenhuma ação do usuário.

> **Desinstalar:** rode o `uninstall.bat` da release (ou apague a chave `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist` manualmente).

---

## Sumário

- [Funcionalidades](#funcionalidades)
- [Como usar](#como-usar)
- [Configurações](#configurações)
- [Notificações Telegram](#notificações-telegram)
- [Modo Teste](#modo-teste)
- [Como funciona por dentro](#como-funciona-por-dentro)
- [🔧 Para desenvolvedores](#-para-desenvolvedores)
- [Limitações conhecidas](#limitações-conhecidas)
- [Licença](#licença)

---

## Funcionalidades

- **Monitoramento contínuo** com mutex anti-reentrância e dedup por `CD_Grupo`, com limite de reservas configurável por grupo.
- **Reserva via DOM** (content-script) pra passar pelo Cloudflare Turnstile — replica o fluxo manual de Nova Reserva → seleção → Turnstile → Reservar → toast.
- **Auto-recovery** do content-script — extensão recarregada não trava: injeta dinâmico via `chrome.scripting`, ou navega pra `/apps/reservas` se aba estiver em outra rota.
- **Detecção de IP banido** (Cloudflare 1106) — para o robô + alerta crítico em vez de queimar requests.
- **Login automático** com TTL de 6h e renovação ao expirar.
- **Rate limit dinâmico (AIMD)** + token bucket + circuit breaker — delay aumenta em 429/403 (cap 60s), respeita header `Retry-After`, decai em ciclos limpos. Circuit abre após 2 hits em 120s.
- **Horário comercial automático** — Seg-Sex 07:55-19:01, Sáb 07:55-13:00, Dom fechado (TZ Brasil). Fora disso, dorme até próxima abertura.
- **Interface multi-tab** (Operações / Histórico / Configurações) em Side Panel:
  - **Operações** — controles + grupos + logs terminal em tempo real + dashboard expansivo
  - **Histórico** — 4 gráficos Chart.js × 30 dias (consultas/dia, reservas/dia, taxa sucesso %, taxa rate-limit %) + exportação CSV
  - **Configurações** — credenciais + delays + Telegram + Telemetria + Limpar cache
- **Métricas agregadas persistentes** — 30 dias em `chrome.storage.local`, com data em BRT. Trocar usuário Canopus mantém o histórico do cliente.
- **Notificações Telegram** — duas mensagens por reserva (cota encontrada + reserva concluída com detalhes).
- **Telemetria opcional** — toggle no Configurações captura request/response/DOM events com `Senha`/`TELEGRAM_TOKEN` redacted. Export `.json` pra suporte. Buffer ring 500.
- **Limpar cache** — botão na Configurações apaga tudo (configs + métricas + telemetria + logs) sem afetar sessão do portal.
- **Modo Teste** — fluxo sem efetivar reservas, bypassa horário comercial.
- **Tratamento de erros específicos**:
  - `restrição vigente` → dorme até próxima abertura
  - `limite do produto no ponto de venda` → bloqueia o produto na sessão atual
  - `RATE_LIMIT` por grupo → cooldown de 30s, não martela o mesmo grupo
- **Side Panel** persistente (não fecha ao clicar fora).

---

## Como usar

> Guia rápido para usuários comuns. Para detalhes técnicos veja [Como funciona por dentro](#como-funciona-por-dentro).

### 1. Abrir o painel

Clique no ícone da extensão na barra do Chrome. O **Side Panel** abre na lateral direita e fica aberto até você fechar manualmente (não fecha ao clicar fora).

### 2. Configurar credenciais e grupos

Vá para a aba **Configurações** e preencha:

| Campo | Exemplo | O que é |
|-------|---------|---------|
| Usuário Canopus | `12345` | Código do usuário do Portal Parceiros |
| Senha Canopus | `••••••` | Sua senha do portal |
| Delay mín. (s) | `5.0` | Tempo mínimo entre ciclos de busca |
| Delay máx. (s) | `10.0` | Tempo máximo entre ciclos (delay é randomizado entre min/max) |
| Bot Token (Telegram) | `123:ABC...` | Opcional — token do bot pra notificações |
| Chat ID (Telegram) | `-100...` | Opcional — destino das notificações |
| Telemetria | toggle | Opcional — captura detalhada pro suporte (toggle off limpa buffer) |

**Grupos monitorados** ficam na aba **Operações** (não em Configurações — faz parte do fluxo operacional).

**Formato dos grupos:** `CD_GRUPO:LIMITE`, separados por vírgula. Exemplo:
```
009113:3,009114:2,009115:1
```
Significa: tentar reservar até 3 cotas do grupo 009113, 2 do grupo 009114 e 1 do grupo 009115. Quando o limite de um grupo é atingido, ele é removido automaticamente da lista de monitoramento.

Clique em **💾 Salvar Configurações** no rodapé do card. Aparece confirmação no log.

### 3. (Opcional) Configurar Telegram

Expanda o card **Telegram** e preencha:
- **Bot Token** — token do seu bot (criar via [@BotFather](https://t.me/BotFather))
- **Chat ID** — ID do chat/grupo onde receber notificações

Salve. Você receberá uma mensagem para cada cota encontrada e cada reserva efetivada.

> Se você não preencher Telegram, o robô funciona normalmente — só não envia notificações externas.

### 4. Iniciar o monitoramento

Clique em **▶ Iniciar Robô**.

O badge no topo muda para **Monitorando** com pontinho verde pulsando. Você vê os logs em tempo real:

```
22:14:11  🚀 Monitoramento iniciado
22:14:12  ✅ Login realizado com sucesso!
22:14:15  📦 47 grupos consultados
22:14:15  💥 Nenhuma cota disponível no momento...
22:14:18  📦 47 grupos consultados
22:14:18  🔍 Buscando por cotas: 009113, 009114...
22:14:19  🍀 Cota 009113 encontrada para o usuário 12345 em 20/05/2026 22:14:19!
22:14:20  🎉 Reservado!
          Usuário: 12345
          Grupo: 009113
          Cota: 9876
          Produto: Imóvel 300k
          Data da Reserva: 20/05/2026 22:14:20
          Válido até: 21/05/2026 22:14:20
```

### 5. Parar o monitoramento

Clique em **⏹ Parar** a qualquer momento. O badge volta para **Parado**.

### 6. Histórico e exportação

Vá pra aba **Histórico** pra ver:
- Consultas por dia (últimos 30 dias)
- Reservas realizadas por dia
- Taxa de sucesso (% reservas / consultas)
- Taxa de rate-limit (% requests bloqueados)

Botão **CSV** baixa arquivo `canopus-metricas-YYYYMMDD.csv` com 30 dias de dados pra abrir no Excel/Sheets.

Métricas persistem em `chrome.storage.local` mesmo se trocar de usuário Canopus na mesma extensão.

### 7. Significado dos ícones nos logs

| Ícone | Significado |
|-------|-------------|
| 🚀 | Início ou retomada do monitoramento |
| ✅ | Login OK / grupo concluído (limite atingido) |
| 📦 | Resposta do servidor com lista de grupos |
| 🔍 | Cotas encontradas neste ciclo |
| 🍀 | Vaga detectada — vai tentar reservar |
| 🎉 | Reserva efetuada com sucesso |
| 💥 | Nenhuma cota disponível neste ciclo |
| 💣 | Produto bloqueado (atingiu limite no ponto de venda) |
| ⚠️ | Rate limit detectado, aguardando |
| ⚙️ | AIMD ajustou delay automaticamente / content-script auto-recovery |
| ⛔ | Sistema fora do horário comercial |
| 🚫 | IP banido pelo Cloudflare — robô parado |
| 🚨 | Turnstile pediu interação manual — resolva no portal |
| 📡 | Telemetria ligada / capturando |
| 📊 | Exportação de métricas |
| 🧹 | Cache limpo |
| ❌ | Erro no ciclo |

---

## Configurações

Todas as configurações são salvas em `chrome.storage.local` e persistem entre reinicializações do navegador.

| Campo | Tipo | Default | Descrição |
|-------|------|---------|-----------|
| `USUARIO` | string | — | Código do usuário Canopus (será zfill para 10 dígitos no envio) |
| `SENHA` | string | — | Senha do usuário |
| `GRUPOS_CONFIG` | string | — | `CD_GRUPO:LIMITE,CD_GRUPO:LIMITE,...` |
| `DELAY_MIN` | number | `1.0` | Floor mínimo de delay entre ciclos (segundos) |
| `DELAY_MAX` | number | `3.0` | Floor máximo de delay entre ciclos (segundos) |
| `TELEGRAM_TOKEN` | string | `""` | Bot token; vazio desativa Telegram |
| `TELEGRAM_CHAT_ID` | string | `""` | Chat ID destino |
| `MODO_TESTE` | bool | `false` | Quando true: simula reservas, não chama `/reservas/add`, ignora horário comercial |
| `TELEMETRIA_LIGADA` | bool | `false` | Captura detalhada pro suporte. Toggle off limpa buffer |
| `metricasDia` | object | `{}` | Auto-populado: histórico 30 dias agregados (ciclos/consultas/reservas/rate_limits por dia BRT) |

**Sobre os delays:** o robô usa AIMD — esses valores são apenas o piso. Em caso de rate limit, o delay efetivo cresce dinamicamente até 60s e decai gradualmente em ciclos limpos. Para servidores muito agressivos, suba o piso para `3-7s` ou `5-10s`.

---

## Notificações Telegram

A extensão envia duas mensagens por reserva:

**1. Cota detectada** (antes de tentar reservar):
```
🍀 Cota 009113 encontrada para o usuário 12345 em 20/05/2026 22:14:19!
```

**2. Reserva concluída** (após sucesso):
```
🎉 Reservado!
Usuário: 12345
Grupo: 009113
Cota: 9876
Produto: Imóvel 300k
Data da Reserva: 20/05/2026 22:14:20
Válido até: 21/05/2026 22:14:20
```

Falhas no Telegram (token inválido, rede caída) **não interrompem** o robô — apenas são silenciosamente descartadas.

### Criar um bot Telegram (passo rápido)

1. No Telegram, fale com [@BotFather](https://t.me/BotFather)
2. Envie `/newbot` e siga as instruções
3. Anote o token (algo como `123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
4. Para obter o **chat ID**: fale com [@userinfobot](https://t.me/userinfobot) (para chat pessoal) ou adicione o bot a um grupo e fale com [@RawDataBot](https://t.me/RawDataBot)
5. Cole token + chat ID nas configurações

---

## Modo Teste

Ative o toggle **Modo Teste** antes de iniciar para validar o fluxo sem efetivar reservas reais:

- **Sem chamadas** a `/reservas/add` (zero risco de reservar acidentalmente)
- **Sem mensagens Telegram** (não polui o canal durante testes)
- **Bypassa horário comercial** — roda 24/7 incluindo fins de semana
- Logs aparecem normalmente com prefixo `[TESTE] Simularia reserva: ...`

Útil para validar credenciais, formato de grupos e fluxo end-to-end.

---

## Como funciona por dentro

> Resumo técnico. Para detalhes completos veja [`CLAUDE.md`](./CLAUDE.md).

```
┌──────────────────────────────────────────┐
│  Side Panel UI (popup.html + popup.js)   │
│  ───────────────────────────────────────  │
│  Configurações, controles e logs em vivo  │
└────────────┬─────────────────────────────┘
             │ chrome.runtime.sendMessage
             ▼
┌──────────────────────────────────────────┐
│  Service Worker (background.js)          │
│  ───────────────────────────────────────  │
│  runPollingLoop  ──────►  setTimeout loop │
│       │                                   │
│       ├─ sistemaEstaAberto? ──► sleep até abertura
│       │                                   │
│       ├─ runMonitorCycle:                 │
│       │     ├─ fazerLogin (se preciso)    │
│       │     ├─ buscarGrupos               │
│       │     ├─ filtrar detectados         │
│       │     └─ Promise.allSettled         │
│       │         └─ reservarComLimite × N  │
│       │                                   │
│       └─ ajustarDelayDinamico (AIMD)      │
└──────────────────────────────────────────┘
             │
             ▼ POST
┌──────────────────────────────────────────┐
│   API Canopus + Telegram Bot API          │
└──────────────────────────────────────────┘
```

- **MV3 lifecycle**: o Service Worker pode ser terminado a qualquer momento. Todo o estado vive em `chrome.storage` (nunca em variáveis JS).
- **Polling**: `setTimeout` encadeado mantém o SW vivo; `chrome.alarms` (1 min) reativa em caso de morte.
- **AIMD**: ao receber 429/403, o delay × 2 (cap 60s); a cada ciclo limpo, × 0.9 até o floor do usuário.

---

## 🔧 Para desenvolvedores

### Stack

- **Manifest V3** Chrome Extension + Side Panel API + content-script + `chrome.scripting`
- **JavaScript** vanilla (sem framework)
- **Tailwind CSS v3** + `@tailwindcss/forms` (build via CLI, output estático)
- **Chart.js v4** self-hosted (`extension/lib/chart.umd.min.js`) — CSP bloqueia CDN
- **Jest** para testes unitários — 3 suítes, 175 testes:
  - `background.test.js` — service worker (~150 tests)
  - `content.test.js` — DOM driver via jsdom (12 tests)
  - `popup.test.js` — UI via jsdom + indirect eval (13 tests)
- **Playwright** pra visual check headless (`npm run visual`) — gera screenshots das 3 tabs em `tests/visual/latest/`

### Estrutura

```
extension/
├── background.js              Service Worker — lógica principal (ciclo, reserva, AIMD, telemetria)
├── content.js                 DOM driver injetado no portal (reserva via UI, Turnstile)
├── popup.html                 Side Panel HTML — 3 tabs (Operações/Histórico/Configurações)
├── popup.js                   Side Panel controller (charts, métricas, dialogs)
├── popup.css                  Tailwind gerado (build)
├── popup-base.css             Estilos custom (cards, animações, dialogs)
├── manifest.json              Manifest V3 config
├── lib/
│   └── chart.umd.min.js       Chart.js v4 self-hosted
├── icons/                     Ícones 16/48/128
├── src/
│   └── input.css              Tailwind input
└── tests/
    ├── background.test.js     Service worker tests (~150)
    ├── content.test.js        DOM driver tests via jsdom (12)
    ├── popup.test.js          UI tests via jsdom (13)
    └── chrome-mock.js         Mocks chrome.*

tests/
├── visual-check.js            Playwright headless — screenshots automatizados
└── visual/
    └── latest/                Screenshots da última execução

install.bat                    Instalador Windows (auto-elevação + force-list)
update_manifest.xml            Google Update Protocol 2.0 manifest
pack.sh                        Script de empacotamento .crx + zip da release
tailwind.config.js             Design tokens MD3
package.json                   Scripts npm + Jest config
PRIVACY.md                     Política de privacidade
CLAUDE.md                      Guia para LLM assistants
```

### Comandos npm

```bash
npm install                                          # primeira vez (inclui playwright + jsdom)
npx playwright install chromium                      # primeira vez — baixa Chromium headless
npm test                                             # roda todos os 175 testes (3 suítes)
npm test -- --testNamePattern="sistemaEstaAberto"    # filtra por nome
npm test -- extension/tests/content.test.js          # roda só uma suite
npm run build                                        # gera extension/popup.css
npm run build:watch                                  # rebuild contínuo durante dev
npm run visual                                       # gera screenshots em tests/visual/latest/
```

### Desenvolvimento local

1. Clone o repositório:
   ```bash
   git clone https://github.com/wellingtonpoll/canopus-reserva-robo.git
   cd canopus-reserva-robo
   npm install
   npm run build
   ```
2. Abra `chrome://extensions` → ative **Modo do desenvolvedor** → **Carregar sem compactação** → selecione `extension/`.

### Publicar nova versão (release no GitHub)

O ciclo de release distribui a extensão via `install.bat` + `update_manifest.xml` + `.crx` anexados a uma **GitHub Release**. O Chrome do cliente baixa a `.crx` via política `ExtensionInstallForcelist` e atualiza automaticamente sempre que uma nova release é marcada como `latest`.

**1. Bump da versão** no `extension/manifest.json` E `package.json` (sempre em sync):

```json
{
  "version": "1.1.0"
}
```

**2. Rodar tests + visual + build:**

```bash
npm test         # 175/175 passando
npm run visual   # 4 screenshots limpos em tests/visual/latest/
npm run build    # regenera popup.css
```

**3. Empacotar:**

```bash
./pack.sh                # usa key.pem existente — mantém o mesmo Extension ID
./pack.sh --new-key      # só na PRIMEIRA execução — gera key.pem (BACKUP OBRIGATÓRIO)
```

A primeira execução gera `key.pem` na raiz do repo. **Guarde essa chave em local seguro** (cofre de senhas, gerenciador secret, etc) — ela define o Extension ID; perdê-la significa novo ID + reinstalação manual em todos os clientes. Está no `.gitignore` e nunca deve ser commitada.

Saída em `dist/`:
- `canopus-reserva-robo.crx` — binário assinado
- `update_manifest.xml` — com Extension ID + versão substituídos
- `install.bat` — com Extension ID substituído
- `canopus-reserva-robo-v<versão>.zip` — pacote completo (caso prefira distribuir como zip único)

**4. Criar tag + push:**

```bash
git tag v1.1.0
git push origin v1.1.0
```

**5. Criar Release no GitHub:**

- GitHub.com → **Releases** → **Draft a new release**
- **Tag:** `v1.1.0`
- **Title:** `v1.1.0`
- **Anexar individualmente** (NÃO o zip — o instalador depende dos URLs diretos `/latest/download/<arquivo>`):
  - `dist/canopus-reserva-robo.crx`
  - `dist/update_manifest.xml`
  - `dist/install.bat`
- **Marcar como Latest release** (obrigatório — o instalador resolve `/latest/download/`)
- Descrever changelog no body

**6. Validar URLs:**

```bash
curl -I https://github.com/wellingtonpoll/canopus-reserva-robo/releases/latest/download/canopus-reserva-robo.crx
curl -I https://github.com/wellingtonpoll/canopus-reserva-robo/releases/latest/download/update_manifest.xml
# devem responder HTTP 302 → 200
```

**7. Distribuir.** Cliente baixa `install.bat` da release e executa. Chrome instala/atualiza automaticamente em até 1min.

### Como funciona o canal de atualizações

| Componente | Função |
|------------|--------|
| `install.bat` | Escreve a política `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist` com `EXTENSION_ID;UPDATE_URL` |
| `update_manifest.xml` | Google Update Protocol v2 — informa ao Chrome qual versão está disponível e onde baixar o `.crx` |
| `canopus-reserva-robo.crx` | Extensão assinada com `key.pem` — o Chrome valida a assinatura contra o `EXTENSION_ID` |
| `pack.sh` | Calcula `EXTENSION_ID` deterministicamente a partir do `key.pem` (SHA-256 da chave pública → primeiros 32 hex → mapeados para a-p) e substitui placeholders |

### Testes

3 suítes Jest cobrindo ~175 testes (~80% do código):

**`background.test.js`** (~150 tests):
- Helpers puros (`parseGruposConfig`, `sistemaEstaAberto`, `proximaAberturaBR`, `formatarDataBR`, `extrairGrupos`, `extrairReserva`, `parseRetryAfter`, `usuarioExibicao`)
- `apiPost` — retry 429/403, Retry-After header, IP_BANIDO (Cloudflare 1106), incremento atômico de `metricasDia.rateLimits`
- `runMonitorCycle` — serial via `for...of`, dedup, login automático, modo teste, produtos bloqueados, focus tab
- `runPollingLoop` — mutex (`cycleRunning`), turnstile pause, circuit breaker
- `reservarComLimite` via content-script — success, semAba, TURNSTILE_TIMEOUT, FASE_2_PENDENTE, cooldown por grupo
- `tentarRecuperarContentScript` — auto-recovery via `chrome.scripting` ou navegação
- AIMD (`ajustarDelayDinamico`), token bucket (`tomarToken`), circuit breaker (`registrarHitERateLimit`)
- Telemetria — `sanitize` redact, batch flush, ring buffer 500, race concurrent
- Handler `handleTurnstileChallenge` + `clear_telemetria_buffer` (await Promise.all)

**`content.test.js`** (12 tests, jsdom):
- `tryCandidato` (selector/text/predicate)
- `getTurnstileToken`, `detectarTurnstileInterativo`
- `snapshotInterativos` cap 40
- Message handlers (ping, reservar_via_dom, unknown)

**`popup.test.js`** (13 tests, jsdom + indirect eval):
- `setDirty`, `setRunningState`, `addLog` (cls por kind, cap 500, escape XSS)
- `setActiveTab`, `atualizarMetricas` (lê storage, restaura ultimoErro)
- `registrarUltimoErro`, helpers (`ultimosDias`, `labelCurto`)

Mocks de Chrome API em `extension/tests/chrome-mock.js`. Visual check em `tests/visual-check.js` gera screenshots automatizados pra revisão pré-release.

---

## Limitações conhecidas

- **Cloudflare 1106 (IP ban)** — quando o Cloudflare baniu o IP do cliente (típico após múltiplas tentativas de bypass), o robô **para sozinho** e alerta. Sem retry possível. Cliente precisa esperar 24h ou trocar de IP/rede.
- **Cloudflare Turnstile em `/reservas/add`** — exige DOM real. Resolvido via content-script (`extension/content.js`) que replica o fluxo manual no portal. Aba do portal precisa estar aberta em `/apps/*` pro robô conseguir reservar.
- **Turnstile interativo** — quando Cloudflare escala pra desafio interativo (checkbox/imagem), robô **pausa 30s** e pede pro cliente resolver manualmente na aba (alerta via popup + Telegram). Sem captcha solver automatizado.
- **API `secret` e `token` são constantes** do Canopus, hardcoded em `getHeaders()`. Não são credenciais do usuário — não devem ser configuráveis na UI.
- A API devolve grupos em **array aninhado** (`data: [[grupos]]`) — `extrairGrupos()` desempacota; documentado em `CLAUDE.md`.
- O campo de filtro de grupos é **`CD_Grupo`** (código exibido, ex `"009113"`), NÃO `ID_Grupo` (PK interna).
- **Selectors do portal Angular** são ofuscados — content-script usa heurística (texto + role + atributos) com telemetria que captura snapshot quando miss, pra suporte ajustar quando portal mudar layout.

---

## Licença

ISC — veja [`package.json`](./package.json).
