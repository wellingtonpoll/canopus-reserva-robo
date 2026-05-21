# Canopus Reserva Robô

[![Version](https://img.shields.io/github/v/release/wellingtonpoll/canopus-reserva-robo?label=vers%C3%A3o&color=success)](https://github.com/wellingtonpoll/canopus-reserva-robo/releases)
[![Tests](https://img.shields.io/badge/tests-110%20passing-brightgreen)](./extension/tests)
[![Manifest](https://img.shields.io/badge/Chrome%20MV3-supported-blue)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-success)](https://nodejs.org)

Extensão Chrome (Manifest V3) para monitoramento e reserva automática de cotas no **Portal Parceiros Canopus**.

Roda como um Side Panel persistente dentro do navegador, mantém sessão de login, varre os grupos configurados em paralelo e dispara reservas assim que vagas são liberadas. Suporta notificações via Telegram, modo teste sem reserva, controle dinâmico de rate limit (AIMD + `Retry-After`) e respeito automático ao horário comercial.

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

- **Monitoramento contínuo** em paralelo de múltiplos grupos com limite de reservas configurável por grupo.
- **Login automático** e renovação de sessão em caso de expiração.
- **Rate limit dinâmico (AIMD)** — delay aumenta automaticamente quando o servidor responde 429/403; respeita header `Retry-After` quando presente; decai gradualmente em ciclos bem-sucedidos.
- **Horário comercial automático** — Seg-Sex 07:55-19:01, Sáb 07:55-13:00, Dom fechado (TZ Brasil). Fora disso, dorme até a próxima abertura sem desperdiçar requests.
- **Notificações Telegram** — duas mensagens por reserva (cota encontrada + reserva concluída com detalhes da cota, produto e datas).
- **Modo Teste** — valida fluxo completo sem efetivar reservas; bypassa horário comercial para permitir testes a qualquer hora.
- **Tratamento de erros específicos** do servidor:
  - `restrição vigente` → dorme até próxima abertura
  - `limite do produto no ponto de venda` → bloqueia o produto na sessão atual
- **Side Panel** que permanece aberto ao clicar fora da janela (UX mais estável que popup tradicional).
- **Interface Material Design 3** light theme com cards colapsáveis e logs em tempo real.

---

## Como usar

> Guia rápido para usuários comuns. Para detalhes técnicos veja [Como funciona por dentro](#como-funciona-por-dentro).

### 1. Abrir o painel

Clique no ícone da extensão na barra do Chrome. O **Side Panel** abre na lateral direita e fica aberto até você fechar manualmente (não fecha ao clicar fora).

### 2. Configurar credenciais e grupos

Expanda o card **Configurações** clicando nele e preencha:

| Campo | Exemplo | O que é |
|-------|---------|---------|
| Usuário Canopus | `12345` | Código do usuário do Portal Parceiros |
| Senha Canopus | `••••••` | Sua senha do portal |
| Grupos monitorados | `009113:3,009114:2` | Lista de grupos + limite de reservas — veja abaixo |
| Delay mín. (s) | `1.0` | Tempo mínimo entre ciclos de busca |
| Delay máx. (s) | `3.0` | Tempo máximo entre ciclos (delay é randomizado entre min/max) |

**Formato dos grupos:** `CD_GRUPO:LIMITE`, separados por vírgula. Exemplo:
```
009113:3,009114:2,009115:1
```
Significa: tentar reservar até 3 cotas do grupo 009113, 2 do grupo 009114 e 1 do grupo 009115. Quando o limite de um grupo é atingido, ele é removido automaticamente da lista de monitoramento.

Clique em **💾 Salvar Configurações**. Aparece confirmação no log.

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

### 6. Significado dos ícones nos logs

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
| ⚙️ | AIMD ajustou delay automaticamente |
| ⛔ | Sistema fora do horário comercial |
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

- **Manifest V3** Chrome Extension + Side Panel API
- **JavaScript** vanilla (sem framework)
- **Tailwind CSS v3** + `@tailwindcss/forms` (build via CLI, output estático)
- **Jest** para testes unitários (110 testes)

### Estrutura

```
extension/
├── background.js              Service Worker — lógica principal
├── popup.html                 Side Panel HTML
├── popup.js                   Side Panel controller
├── popup.css                  Tailwind gerado (build)
├── popup-base.css             Estilos custom (cards, animações)
├── manifest.json              Manifest V3 config
├── icons/                     Ícones 16/48/128
├── src/
│   └── input.css              Tailwind input
└── tests/
    ├── background.test.js     Suite Jest
    └── chrome-mock.js         Mocks chrome.*

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
npm install                                       # primeira vez
npm test                                          # roda todos os 110 testes
npm test -- --testNamePattern="sistemaEstaAberto" # filtra por nome
npm run build                                     # gera extension/popup.css
npm run build:watch                               # rebuild contínuo durante dev
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

**1. Bump da versão** no `extension/manifest.json`:

```json
{
  "version": "1.0.1"
}
```

**2. Rodar tests + build:**

```bash
npm test         # 110/110 passando
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
git tag v1.0.1
git push origin v1.0.1
```

**5. Criar Release no GitHub:**

- GitHub.com → **Releases** → **Draft a new release**
- **Tag:** `v1.0.1`
- **Title:** `v1.0.1`
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

- Cobre helpers puros (`parseGruposConfig`, `sistemaEstaAberto`, `proximaAberturaBR`, `formatarDataBR`, `extrairGrupos`, `extrairReserva`, `parseRetryAfter`, `usuarioExibicao`)
- Cobre fluxo do ciclo (`runMonitorCycle`) incluindo paralelismo, login automático, modo teste, produtos bloqueados
- Cobre AIMD (`ajustarDelayDinamico`), token bucket (`tomarToken`), circuit breaker (`registrarHitERateLimit`), state machine (`agendarProximoCiclo`)
- Cobre tratamento de erros específicos do servidor
- Mocks de Chrome API em `extension/tests/chrome-mock.js`

---

## Limitações conhecidas

- **Cloudflare Turnstile em `/reservas/add`** — a API protege o endpoint de reserva com Turnstile. Rodar dentro do contexto do navegador via extensão pode bypassar nativamente, mas isso ainda não foi confirmado empiricamente em produção. Caso o bypass não funcione, a próxima estratégia é mover o request via content script injetado em `parceiros.consorciocanopus.com.br`.
- **API `secret` e `token` são constantes** do Canopus, hardcoded em `getHeaders()`. Não são credenciais do usuário — não devem ser configuráveis na UI.
- A API devolve grupos em **array aninhado** (`data: [[grupos]]`) — `extrairGrupos()` desempacota; documentado em `CLAUDE.md`.
- O campo de filtro de grupos é **`CD_Grupo`** (código exibido, ex `"009113"`), NÃO `ID_Grupo` (PK interna).

---

## Licença

ISC — veja [`package.json`](./package.json).
