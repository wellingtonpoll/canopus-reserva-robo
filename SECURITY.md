# Política de Segurança

## Versões suportadas

Apenas a versão mais recente recebe correções de segurança.

| Versão | Suportada |
|--------|-----------|
| 1.1.x  | ✅        |
| < 1.1  | ❌        |

## Relatar uma vulnerabilidade

Encontrou uma vulnerabilidade? **Não abra issue pública.**

Reporte em privado por email para o autor (veja `package.json` campo `author`).

Inclua:
- Descrição da vulnerabilidade
- Passos para reproduzir
- Impacto potencial
- Versão afetada

Compromisso de resposta:
- Confirmação de recebimento em até **48h**
- Avaliação inicial em até **7 dias**
- Disclosure coordenado após patch publicado

## Limitações conhecidas (não são bugs)

Documentadas em `README.md` e `CLAUDE.md`:

- **Cloudflare 1106 (IP ban)** — fora de controle da extensão
- **Headers `secret`/`token` Canopus hardcoded** — constantes públicas do app oficial, não credenciais de usuário
- **Senha do usuário em texto plano** no response body do `/auth/enterPlataforma` — comportamento do backend Canopus, não da extensão. `sanitize()` da telemetria redact em logs exportados

## Boas práticas para usuários

- **Não compartilhe** exports de telemetria (`canopus-telemetria-*.json`) publicamente — podem conter texto plano da senha do portal no response body
- **Não commite** `chrome.storage` dump em logs públicos
- **`key.pem` da assinatura** (apenas mantenedor) — backup em cofre de senhas
