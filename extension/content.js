// Canopus Reserva Robô — content script (Fase 1)
//
// Roda em parceiros.consorciocanopus.com.br/*. Recebe { action: "reservar_via_dom", grupo }
// do service worker e replica o fluxo manual de "Nova Reserva" → seleciona grupo →
// resolve Turnstile → clica "Reservar" → reporta resultado.
//
// Fase 1: esqueleto + aguardarTurnstile + protocolo de mensagens. Selectors específicos
// do modal entram na Fase 2 quando o cliente mandar snapshot do DOM.

(function () {
  "use strict";

  const TURNSTILE_INVISIBLE_TIMEOUT_MS = 10_000;
  const TURNSTILE_INTERACTIVE_TIMEOUT_MS = 30_000;
  const TURNSTILE_DETECTAR_INTERATIVO_MS = 5_000;
  const POLL_INTERVAL_MS = 200;

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function telemetriaSend(tipo, dados) {
    try {
      chrome.runtime.sendMessage({ action: "telemetria", tipo, dados });
    } catch (_) { /* ignore */ }
  }

  function getTurnstileToken() {
    try {
      const resp = window.turnstile && typeof window.turnstile.getResponse === "function"
        ? window.turnstile.getResponse()
        : null;
      if (resp) return resp;
    } catch (_) { /* ignore */ }
    const input = document.querySelector('input[name="cf-turnstile-response"]');
    return input && input.value ? input.value : null;
  }

  function detectarTurnstileInterativo(rootEl) {
    const scope = rootEl || document;
    const cfFrame = scope.querySelector('iframe[src*="challenges.cloudflare.com"]');
    if (!cfFrame) return false;
    const rect = cfFrame.getBoundingClientRect();
    return rect.height > 50 && rect.width > 50;
  }

  async function aguardarTurnstile(modalEl) {
    const inicio = Date.now();
    let avisouCliente = false;

    while (Date.now() - inicio < TURNSTILE_INTERACTIVE_TIMEOUT_MS) {
      const token = getTurnstileToken();
      if (token) {
        telemetriaSend("turnstile.token_received", { decorridoMs: Date.now() - inicio, interativo: avisouCliente });
        return { token, interativo: avisouCliente };
      }

      const decorrido = Date.now() - inicio;
      const interativoAgora =
        decorrido > TURNSTILE_DETECTAR_INTERATIVO_MS &&
        detectarTurnstileInterativo(modalEl);

      if (interativoAgora && !avisouCliente) {
        try {
          chrome.runtime.sendMessage({ action: "turnstile_challenge" });
        } catch (_) { /* ignore */ }
        telemetriaSend("turnstile.detected_interactive_dom", { decorridoMs: decorrido });
        avisouCliente = true;
      }

      if (!avisouCliente && decorrido > TURNSTILE_INVISIBLE_TIMEOUT_MS) {
        telemetriaSend("turnstile.error", { kind: "invisible_timeout", decorridoMs: decorrido });
        throw new Error("TURNSTILE_INVISIBLE_TIMEOUT");
      }

      await sleep(POLL_INTERVAL_MS);
    }
    telemetriaSend("turnstile.error", { kind: "timeout", decorridoMs: Date.now() - inicio });
    throw new Error("TURNSTILE_TIMEOUT");
  }

  async function reservarViaDom(grupo) {
    const grupoId = String(grupo && grupo.CD_Grupo || "");
    telemetriaSend("content.reservar.start", { grupoId, NM_Produto: grupo && grupo.NM_Produto });
    // Stub Fase 1 — sequência DOM real depende de selectors que o cliente vai mandar.
    // Por enquanto, sinaliza pra equipe que o canal está ligado mas falta DOM mapping.
    const out = {
      ok: false,
      erro: "FASE_2_PENDENTE_SELECTORS",
      grupoId
    };
    telemetriaSend("content.reservar.end", { grupoId, ok: false, erro: "FASE_2_PENDENTE_SELECTORS" });
    return out;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.action !== "reservar_via_dom") return false;

    (async () => {
      try {
        const resp = await reservarViaDom(message.grupo);
        sendResponse(resp);
      } catch (err) {
        sendResponse({
          ok: false,
          erro: (err && err.message) || String(err),
          grupoId: String((message.grupo && message.grupo.CD_Grupo) || "")
        });
      }
    })();

    return true; // resposta assíncrona
  });

  // Exporta helpers pra debug via console (window.__canopusRobo) — não usar em produção
  window.__canopusRobo = { getTurnstileToken, detectarTurnstileInterativo, aguardarTurnstile };
})();
