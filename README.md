# ROBÔ MONITORADOR DE RESERVAS CANOPUS

Robô automático para monitoramento e reserva de cotas no Portal Parceiros Canopus.

## Status Atual
- Login e consulta de grupos funcionando via `aiohttp`
- Endpoint de reserva (`/reservas/add`) bloqueado por **Cloudflare Turnstile**
- Arquitetura híbrida planejada: `aiohttp` (monitoramento) + **Playwright** (reserva)

## TODO / Pontos a esclarecer

1. **Payload exato da reserva** (`/reservas/add`)
   - Formato do body (JSON ou form-data?)
   - Campos obrigatórios (`idGrupo`, `quantidade`, etc.)

2. **Campo do Turnstile**
   - Nome exato do campo do token (`cf-turnstile-response`, `turnstile_response`, ...)

3. **Estratégia de autenticação**
   - Reutilizar cookies do aiohttp no Playwright ou fazer login completo no browser?

4. **Comportamento ao encontrar vaga**
   - Reservar automaticamente a quantidade configurada?
   - Tentativas por grupo? Confirmação?

5. **Configuração do Telegram**
   - Bot Token e Chat ID salvos na interface ou hardcoded?

## Tecnologias
- Python 3.13
- aiohttp + asyncio (monitoramento)
- Playwright (reserva com Turnstile)
- Tkinter (interface gráfica)
- Telegram Bot API

## Como rodar
```bash
git clone https://github.com/wellingtonpoll/canopus-reserva-robo.git
pip install -r requirements.txt
python main.py
```

---
Projeto em desenvolvimento conjunto.