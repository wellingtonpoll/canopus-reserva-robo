# Chrome Web Store — Listing Content

Conteúdo pronto pra colar nos campos do dashboard. Copie e cole literalmente.

---

## Nome (obrigatório, max 75 chars)

```
Canopus Reserva Robô
```

---

## Resumo / Tagline (obrigatório, max 132 chars)

```
Automatize o monitoramento e a reserva de cotas no Portal Parceiros Canopus, com notificações em tempo real via Telegram.
```

---

## Descrição detalhada (max 16 KB — use markdown leve)

```
Canopus Reserva Robô é uma extensão para parceiros Canopus que automatiza a etapa repetitiva de monitorar grupos e tentar reservar cotas assim que ficam disponíveis no Portal Parceiros.

━━━━━━━━━━━━━━━━━━━━━━━━━━
PRINCIPAIS RECURSOS
━━━━━━━━━━━━━━━━━━━━━━━━━━

🔄  Monitoramento contínuo em paralelo de múltiplos grupos, com limite de reservas configurável por grupo.

🔐  Login automático no Portal Parceiros e renovação de sessão quando necessário.

⚡  Reservas disparadas imediatamente após detectar uma vaga, em paralelo entre grupos diferentes.

🛡  Rate limit dinâmico (AIMD) que respeita o cabeçalho Retry-After do servidor e aplica backoff exponencial em caso de bloqueio.

🕒  Horário comercial automático (Seg-Sex 07:55–19:01, Sáb 07:55–13:00, Dom fechado) — fora desse intervalo o robô hiberna para não desperdiçar requisições.

📨  Notificações Telegram em tempo real: cota encontrada e reserva concluída, com cota, produto, datas e usuário.

🧪  Modo Teste para validar fluxo sem efetivar reservas (bypassa horário comercial).

📊  Logs ao vivo coloridos por tipo (sucesso, aviso, erro, vaga detectada) no painel lateral.

━━━━━━━━━━━━━━━━━━━━━━━━━━
COMO USAR
━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Instale a extensão.
2. Clique no ícone do robô — abre o painel lateral, que permanece aberto enquanto você trabalha.
3. Em ⚙ Configurações, preencha:
   • Usuário Canopus
   • Senha Canopus
   • Grupos monitorados no formato grupo:limite,grupo:limite (ex.: 009113:3,009114:2)
   • Delay mínimo e máximo entre ciclos (recomendado 7–12s)
4. (Opcional) Configure o token e chat ID do seu bot Telegram para receber notificações.
5. Clique em ▶ Iniciar Robô. Acompanhe os logs ao vivo no painel.

━━━━━━━━━━━━━━━━━━━━━━━━━━
PARA QUEM É
━━━━━━━━━━━━━━━━━━━━━━━━━━

Parceiros credenciados Canopus que já operam o Portal Parceiros e desejam automatizar a etapa de monitoramento de vagas. A extensão usa suas próprias credenciais e operação acontece dentro do mesmo navegador, com seu próprio acesso autorizado.

━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIVACIDADE
━━━━━━━━━━━━━━━━━━━━━━━━━━

Suas credenciais ficam armazenadas apenas no seu navegador, em chrome.storage.local. A extensão não envia dados para servidores do desenvolvedor — apenas para a API Canopus (autenticação e reservas) e a API Telegram (notificações, se você configurar).

Política completa: https://github.com/wellingtonpoll/canopus-reserva-robo/blob/main/PRIVACY.md

━━━━━━━━━━━━━━━━━━━━━━━━━━
OPEN SOURCE
━━━━━━━━━━━━━━━━━━━━━━━━━━

Código-fonte completo em github.com/wellingtonpoll/canopus-reserva-robo (auditável). Sugestões e issues bem-vindas.

━━━━━━━━━━━━━━━━━━━━━━━━━━
SUPORTE
━━━━━━━━━━━━━━━━━━━━━━━━━━

Wellington Luiz do Nascimento
wellingtonpoleti@gmail.com
```

---

## Categoria sugerida

`Produtividade`

---

## Idiomas

`Português (Brasil)`

---

## Single-Purpose Statement (obrigatório no review)

```
Esta extensão tem um único propósito: automatizar o monitoramento e a reserva de cotas no Portal Parceiros Canopus para usuários credenciados, com sua própria autenticação, sem coletar nem transmitir dados pessoais para terceiros além das APIs Canopus e Telegram (esta última opcional).
```

---

## Justificativa das permissões (preencher se Google pedir)

| Permissão | Justificativa |
|-----------|---------------|
| `storage` | Persistir configurações do usuário (credenciais, grupos monitorados, delays) entre sessões do navegador. |
| `alarms` | Manter o monitoramento ativo no Service Worker (Manifest V3) entre suspensões automáticas do Chrome. |
| `sidePanel` | Apresentar a interface do robô no painel lateral, mantendo-a aberta enquanto o usuário trabalha em outras abas. |
| Host `parceiros.consorciocanopus.com.br` | Origem das chamadas à API Canopus (cabeçalho `Origin` exigido). |
| Host `prod-api-portalparceiro-canopus.bsn.dev.br` | Endpoint real da API Canopus, onde as chamadas POST de login, busca de grupos e reserva são efetuadas. |

---

## URL da política de privacidade

Após hospedar o `PRIVACY.md` (ver instruções abaixo), use:

```
https://github.com/wellingtonpoll/canopus-reserva-robo/blob/main/PRIVACY.md
```

Ou se ativar GitHub Pages:

```
https://wellingtonpoll.github.io/canopus-reserva-robo/PRIVACY
```

---

## Como hospedar a Privacy Policy via GitHub Pages

1. No GitHub: repo → Settings → Pages → Source: `Deploy from a branch` → Branch: `main` / folder `/ (root)` → Save.
2. Aguarde ~1 minuto. URL `https://wellingtonpoll.github.io/canopus-reserva-robo/` ficará disponível.
3. Acessar `…/PRIVACY` mostra a página renderizada do `PRIVACY.md`.

Use essa URL no campo "Privacy policy URL" do Chrome Web Store dashboard.
