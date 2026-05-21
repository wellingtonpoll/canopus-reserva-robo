# Política de Privacidade — Canopus Reserva Robô

**Última atualização:** 20 de maio de 2026

Esta política descreve quais dados a extensão **Canopus Reserva Robô** coleta, como utiliza e quais são as garantias oferecidas ao usuário.

---

## Resumo

- A extensão **não envia dados para servidores externos do desenvolvedor**.
- Todas as credenciais ficam armazenadas **apenas no seu navegador**, via `chrome.storage.local`.
- Os dados são usados **exclusivamente** para autenticar você no Portal Parceiros Canopus e enviar notificações ao Telegram (se você optar por configurar).
- **Nenhum dado é compartilhado** com terceiros além dos próprios endpoints da Canopus e da API oficial do Telegram, ambos sob sua escolha explícita.

---

## Dados coletados localmente

A extensão armazena os seguintes dados no armazenamento local do Chrome (`chrome.storage.local`), no seu computador:

| Dado | Finalidade |
|------|-----------|
| Usuário Canopus | Autenticação no Portal Parceiros |
| Senha Canopus | Autenticação no Portal Parceiros |
| Lista de grupos monitorados | Determinar quais cotas devem ser observadas |
| Delays (mín./máx.) | Configurar intervalo entre verificações |
| Telegram Bot Token | Enviar notificações para você (opcional) |
| Telegram Chat ID | Destino das notificações (opcional) |
| Identificadores de sessão | `IdUsuario` e `IdEmpresa` retornados pela API Canopus, usados para autenticação subsequente |
| Histórico de reservas por grupo | Contar quantas reservas já foram feitas, respeitando o limite configurado |

Esses dados **nunca saem do seu navegador**, exceto quando enviados diretamente para:
- **API da Canopus** (`prod-api-portalparceiro-canopus.bsn.dev.br`) — exclusivamente para realizar login, consultar grupos e efetuar reservas.
- **API do Telegram** (`api.telegram.org`) — exclusivamente se você configurar o Bot Token, e somente para enviar mensagens ao chat que você indicou.

---

## Dados que NÃO coletamos

- Histórico de navegação
- Cookies de outros sites
- Dados pessoais além das credenciais que você fornece voluntariamente
- Estatísticas de uso, telemetria ou analytics
- Geolocalização

---

## Permissões da extensão

A extensão solicita as seguintes permissões do Chrome, todas com justificativa funcional:

| Permissão | Por quê |
|-----------|---------|
| `storage` | Persistir configurações e estado da sessão localmente |
| `alarms` | Manter o monitoramento ativo mesmo com o Service Worker em standby |
| `sidePanel` | Exibir a interface do robô no painel lateral do Chrome |
| Acesso ao host `parceiros.consorciocanopus.com.br/*` | Origem das chamadas à API Canopus |
| Acesso ao host `prod-api-portalparceiro-canopus.bsn.dev.br/*` | Endpoint real da API Canopus |

---

## Segurança

- As credenciais são armazenadas em `chrome.storage.local`, com isolamento de processo nativo do Chrome.
- A extensão **não exporta**, **não sincroniza** e **não faz backup** das credenciais.
- Caso você desinstale a extensão ou limpe os dados do navegador, todos os dados locais são apagados imediatamente.
- Recomenda-se utilizar a extensão apenas em computadores pessoais ou de confiança.

---

## Retenção e exclusão

Você pode apagar todos os dados a qualquer momento:

1. Abrindo a extensão e limpando os campos de configuração; ou
2. Removendo a extensão pelo `chrome://extensions`.

Após qualquer dessas ações, **nenhum dado permanece** armazenado pela extensão.

---

## Contato

Dúvidas ou solicitações relativas a privacidade podem ser enviadas para:

**Wellington Luiz do Nascimento**
[wellingtonpoleti@gmail.com](mailto:wellingtonpoleti@gmail.com)

---

## Alterações desta política

Eventuais alterações nesta política serão publicadas neste mesmo documento, no repositório oficial do projeto:

[github.com/wellingtonpoll/canopus-reserva-robo](https://github.com/wellingtonpoll/canopus-reserva-robo)
