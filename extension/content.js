// Canopus Reserva Robô — content script (Fase 2: DOM driver completo)
//
// Roda em parceiros.consorciocanopus.com.br/apps/*. Recebe { action: "reservar_via_dom", grupo }
// do service worker e replica o fluxo manual:
//   Nova Reserva → seleciona grupo no modal → aguarda Turnstile → Reservar → reporta resultado.
//
// Selectors são heurísticos (Angular ofuscado, sem data-test no portal). Cada tentativa loga
// via telemetria — quando portal muda layout, suporte exporta .json e ajusta candidatos.

(function () {
  "use strict";

  // Esconde helpers da janela em produção (anti-bot)
  const DEBUG = false;

  const TURNSTILE_INVISIBLE_TIMEOUT_MS = 10_000;
  const TURNSTILE_INTERACTIVE_TIMEOUT_MS = 30_000;
  const TURNSTILE_DETECTAR_INTERATIVO_MS = 5_000;
  const POLL_INTERVAL_MS = 200;

  const MODAL_GRUPO_TIMEOUT_MS = 12_000;
  const MODAL_DADOS_TIMEOUT_MS = 15_000;
  const TOAST_TIMEOUT_MS = 20_000;
  const ACAO_DEFAULT_TIMEOUT_MS = 8_000;

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function telemetriaSend(tipo, dados) {
    try {
      chrome.runtime.sendMessage({ action: "telemetria", tipo, dados });
    } catch (_) { /* ignore */ }
  }

  function isVisivel(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style && style.visibility !== "hidden" && style.display !== "none";
  }

  function textoNormalizado(el) {
    // innerText (preserva quebras renderizadas) preferido; textContent como fallback
    // (usado em jsdom/tests onde innerText não está implementado)
    const t = el && (el.innerText || el.textContent) || "";
    return t.trim().replace(/\s+/g, " ");
  }

  function snapshotInterativos(scope) {
    const root = scope || document;
    const els = Array.from(root.querySelectorAll('button, a, [role="button"], [role="row"], mat-row, tr'))
      .filter(isVisivel)
      .slice(0, 40); // cap pra não estourar payload de telemetria
    return els.map(el => ({
      tag: el.tagName.toLowerCase(),
      text: textoNormalizado(el).slice(0, 80),
      aria: el.getAttribute("aria-label") || null
    }));
  }

  // Resolve um candidato em ordem de preferência. Cada candidato pode ser:
  //   - { tipo: "selector", sel: "button[aria-label*='nova reserva' i]", scope }
  //   - { tipo: "text", tag: "button", text: "Nova Reserva", scope, exato: true }
  //   - { tipo: "predicate", fn: (el) => boolean, all: 'button,a', scope }
  function tryCandidato(c) {
    const scope = c.scope || document;
    if (c.tipo === "selector") {
      const el = scope.querySelector(c.sel);
      return el && isVisivel(el) ? el : null;
    }
    if (c.tipo === "text") {
      const tag = c.tag || "*";
      const els = Array.from(scope.querySelectorAll(tag)).filter(isVisivel);
      const alvo = c.text.toLowerCase();
      for (const el of els) {
        const t = textoNormalizado(el).toLowerCase();
        if (c.exato ? t === alvo : t.includes(alvo)) return el;
      }
      return null;
    }
    if (c.tipo === "predicate") {
      const els = Array.from(scope.querySelectorAll(c.all || "*")).filter(isVisivel);
      for (const el of els) {
        try { if (c.fn(el)) return el; } catch (_) {}
      }
      return null;
    }
    return null;
  }

  async function aguardarElemento(fn, candidatos, timeoutMs = ACAO_DEFAULT_TIMEOUT_MS) {
    // Fix 6.5: logar `try` SÓ na 1ª tentativa por candidato (não a cada poll de 200ms).
    // Reduz volume de telemetria em ~95% sem perder sinal de debug — quando candidato
    // matched, evento `match` registra qual; quando todos falham, `miss` captura snapshot.
    const inicio = Date.now();
    let tentativa = 0;
    while (Date.now() - inicio < timeoutMs) {
      for (let i = 0; i < candidatos.length; i++) {
        const c = candidatos[i];
        if (tentativa === 0) {
          telemetriaSend("content.dom.try", { fn, candidateIndex: i, tipo: c.tipo });
        }
        const el = tryCandidato(c);
        if (el) {
          telemetriaSend("content.dom.match", {
            fn, candidateIndex: i, tipo: c.tipo,
            tentativa,
            tag: el.tagName.toLowerCase(),
            text: textoNormalizado(el).slice(0, 80)
          });
          return el;
        }
      }
      tentativa++;
      await sleep(POLL_INTERVAL_MS);
    }
    telemetriaSend("content.dom.miss", {
      fn,
      tentativas: tentativa,
      candidatos: candidatos.map(c => ({ tipo: c.tipo, sel: c.sel || c.text || "(predicate)" })),
      snapshot: snapshotInterativos(document)
    });
    return null;
  }

  function clickViaEvent(el) {
    // Angular Material precisa de mousedown + mouseup + click sintéticos
    ["mousedown", "mouseup", "click"].forEach(t => {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    });
  }

  function getTurnstileToken() {
    try {
      const resp = window.turnstile && typeof window.turnstile.getResponse === "function"
        ? window.turnstile.getResponse()
        : null;
      if (resp) return resp;
    } catch (_) {}
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
        try { chrome.runtime.sendMessage({ action: "turnstile_challenge" }); } catch (_) {}
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

  function findDialogContaining(textPattern) {
    const dialogs = Array.from(document.querySelectorAll(
      'mat-dialog-container, [role="dialog"], [aria-modal="true"], .cdk-overlay-container .mat-dialog-container'
    )).filter(isVisivel);
    for (const d of dialogs) {
      if (textPattern.test(textoNormalizado(d))) return d;
    }
    return null;
  }

  async function clicarNovaReserva() {
    const btn = await aguardarElemento("clicarNovaReserva", [
      { tipo: "selector", sel: 'button[aria-label*="nova reserva" i]' },
      { tipo: "text", tag: "button", text: "Nova Reserva", exato: true },
      { tipo: "text", tag: "button", text: "Nova Reserva" },
      { tipo: "text", tag: "a", text: "Nova Reserva" }
    ]);
    if (!btn) throw new Error("BOTAO_NOVA_RESERVA_NAO_ENCONTRADO");
    telemetriaSend("content.dom.click", { fn: "clicarNovaReserva" });
    clickViaEvent(btn);
  }

  async function aguardarModalSelecioneGrupo() {
    const modal = await aguardarElemento("aguardarModalSelecioneGrupo", [
      { tipo: "predicate", all: 'mat-dialog-container, [role="dialog"], [aria-modal="true"]',
        fn: el => /selecione\s+um\s+grupo/i.test(textoNormalizado(el)) }
    ], MODAL_GRUPO_TIMEOUT_MS);
    if (!modal) throw new Error("MODAL_SELECIONE_GRUPO_NAO_ABRIU");
    telemetriaSend("content.modal.appeared", { nomeModal: "selecione_grupo" });
    return modal;
  }

  async function selecionarLinhaGrupo(modalEl, cdGrupo) {
    const linha = await aguardarElemento("selecionarLinhaGrupo", [
      { tipo: "predicate", all: '[role="row"], mat-row, tr', scope: modalEl,
        fn: el => textoNormalizado(el).includes(cdGrupo) },
      { tipo: "predicate", all: 'button, a, [role="button"]', scope: modalEl,
        fn: el => textoNormalizado(el).includes(cdGrupo) }
    ]);
    if (!linha) throw new Error("GRUPO_NAO_ENCONTRADO_NO_MODAL");
    telemetriaSend("content.dom.click", { fn: "selecionarLinhaGrupo", cdGrupo });
    clickViaEvent(linha);
  }

  async function aguardarModalDadosReserva() {
    const modal = await aguardarElemento("aguardarModalDadosReserva", [
      { tipo: "predicate", all: 'mat-dialog-container, [role="dialog"], [aria-modal="true"]',
        fn: el => /dados\s+da\s+reserva/i.test(textoNormalizado(el)) }
    ], MODAL_DADOS_TIMEOUT_MS);
    if (!modal) throw new Error("MODAL_DADOS_RESERVA_NAO_ABRIU");
    telemetriaSend("content.modal.appeared", { nomeModal: "dados_reserva" });
    return modal;
  }

  async function clicarReservar(modalEl) {
    const btn = await aguardarElemento("clicarReservar", [
      { tipo: "selector", sel: 'button[type="submit"]:not([disabled])', scope: modalEl },
      { tipo: "predicate", all: 'button:not([disabled])', scope: modalEl,
        fn: el => /^reservar$/i.test(textoNormalizado(el)) },
      { tipo: "predicate", all: 'button:not([disabled])', scope: modalEl,
        fn: el => /reservar/i.test(textoNormalizado(el)) && !/cancelar/i.test(textoNormalizado(el)) }
    ]);
    if (!btn) throw new Error("BOTAO_RESERVAR_NAO_ENCONTRADO");
    if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
      throw new Error("BOTAO_RESERVAR_DESABILITADO");
    }
    telemetriaSend("content.dom.click", { fn: "clicarReservar" });
    clickViaEvent(btn);
  }

  async function aguardarToast(modalDados) {
    const inicio = Date.now();
    while (Date.now() - inicio < TOAST_TIMEOUT_MS) {
      // Fix 6.4: selectors ampliados pra cobrir libs comuns (Material, SweetAlert, Toastr, etc.)
      const containers = Array.from(document.querySelectorAll(
        '.mat-snack-bar-container, [role="alert"], .toast, .snackbar, simple-snack-bar, ' +
        '.swal2-popup, .swal2-container, .notification, .notyf__toast, .toastify, ' +
        'mat-error, .alert, .ng-toast, .mat-error'
      )).filter(isVisivel);
      for (const c of containers) {
        const texto = textoNormalizado(c);
        if (!texto) continue;
        if (/reserva.*sucesso|sucesso.*reserva|efetuada com sucesso/i.test(texto)) {
          telemetriaSend("content.toast.appeared", { texto: texto.slice(0, 120), kind: "sucesso" });
          return { sucesso: true, texto };
        }
        if (/restri[çc][aã]o\s+vigente/i.test(texto)) {
          telemetriaSend("content.toast.appeared", { texto: texto.slice(0, 120), kind: "restricao" });
          return { sucesso: false, details: texto };
        }
        if (/limite\s+de\s+reservas/i.test(texto)) {
          telemetriaSend("content.toast.appeared", { texto: texto.slice(0, 120), kind: "limite_produto" });
          return { sucesso: false, details: texto };
        }
        if (/erro|falha|inv[áa]lid|n[aã]o\s+foi\s+poss[ií]vel/i.test(texto)) {
          telemetriaSend("content.toast.appeared", { texto: texto.slice(0, 120), kind: "erro_generico" });
          return { sucesso: false, details: texto };
        }
      }

      // Fix 6.4: se o modal "Dados da Reserva" fechou sem toast detectado,
      // a action terminou (provável sucesso silencioso ou silent reject backend).
      // Retorna INCERTO pra reservarComLimite parar nessa cota e ir pra próxima.
      if (modalDados && !modalDados.isConnected) {
        telemetriaSend("content.toast.miss", {
          decorridoMs: Date.now() - inicio,
          razao: "modal_fechou_sem_toast"
        });
        return { incerto: true, razao: "modal_fechou_sem_toast" };
      }

      await sleep(POLL_INTERVAL_MS);
    }
    telemetriaSend("content.toast.miss", { decorridoMs: Date.now() - inicio, razao: "timeout" });
    return { timeout: true };
  }

  function extrairReservaDoDom(grupo) {
    // Fix 6.2: prioriza dados do grupo (que sabemos certos) sobre extração do DOM.
    // Procura a linha da tabela cujo texto contém o CD_Grupo + data de HOJE — essa é a
    // reserva que acabou de criar, não a primeira linha (que pode ser de reserva antiga).
    const out = {
      CodigoCota: grupo && grupo.CD_Grupo ? String(grupo.CD_Grupo) : "",
      NomeProduto: grupo && grupo.NM_Produto ? grupo.NM_Produto : ""
    };

    const hoje = new Date();
    const hojeStr = String(hoje.getDate()).padStart(2, "0") + "/" +
                    String(hoje.getMonth() + 1).padStart(2, "0") + "/" +
                    hoje.getFullYear();

    const linhas = Array.from(document.querySelectorAll('mat-row, tr')).filter(isVisivel);
    const cdGrupo = grupo && grupo.CD_Grupo ? String(grupo.CD_Grupo) : null;

    // 1ª passada: linha com CD_Grupo + data de hoje
    let alvo = null;
    if (cdGrupo) {
      for (const linha of linhas) {
        const t = textoNormalizado(linha);
        if (t.includes(cdGrupo) && t.includes(hojeStr)) {
          alvo = linha;
          break;
        }
      }
    }
    // 2ª passada: linha com data de hoje (qualquer grupo) — pega a primeira (top, mais recente)
    if (!alvo) {
      for (const linha of linhas) {
        if (textoNormalizado(linha).includes(hojeStr)) {
          alvo = linha;
          break;
        }
      }
    }

    if (alvo) {
      const cells = alvo.querySelectorAll('mat-cell, td');
      for (const cell of cells) {
        const t = textoNormalizado(cell);
        if (!t) continue;
        if (!out.NumeroReserva && /^\d{4,}$/.test(t)) out.NumeroReserva = t;
        if (/\d{2}\/\d{2}\/\d{4}/.test(t)) {
          if (!out.DataReserva) out.DataReserva = t;
          else if (!out.DataValidade) out.DataValidade = t;
        }
      }
    }
    return out;
  }

  async function reservarViaDom(grupo) {
    const grupoId = String(grupo && grupo.CD_Grupo || "");
    const start = Date.now();
    telemetriaSend("content.reservar.start", { grupoId, NM_Produto: grupo && grupo.NM_Produto });

    try {
      await clicarNovaReserva();
      const modalGrupo = await aguardarModalSelecioneGrupo();
      await selecionarLinhaGrupo(modalGrupo, grupoId);
      const modalDados = await aguardarModalDadosReserva();

      // Aguarda Turnstile resolver (auto ou interativo)
      await aguardarTurnstile(modalDados);

      await clicarReservar(modalDados);

      const toast = await aguardarToast(modalDados);
      if (toast.sucesso) {
        const reserva = extrairReservaDoDom(grupo);
        const out = { ok: true, grupoId, reserva };
        telemetriaSend("content.reservar.end", { grupoId, ok: true, decorridoMs: Date.now() - start });
        return out;
      }
      if (toast.incerto) {
        // Modal fechou sem toast detectado — provável sucesso silencioso (sem feedback visível)
        // OU silent reject do backend. Reporta INCERTO pra reservarComLimite tratar.
        const reserva = extrairReservaDoDom(grupo);
        telemetriaSend("content.reservar.end", { grupoId, ok: false, erro: "TOAST_INCERTO", decorridoMs: Date.now() - start });
        return { ok: false, grupoId, erro: "TOAST_INCERTO", reservaPossivel: reserva };
      }
      if (toast.timeout) {
        telemetriaSend("content.reservar.end", { grupoId, ok: false, erro: "TOAST_NEM_SUCESSO_NEM_ERRO", decorridoMs: Date.now() - start });
        return { ok: false, grupoId, erro: "TOAST_NEM_SUCESSO_NEM_ERRO" };
      }
      // toast.incerto já foi tratado acima

      // Toast de erro: preserva texto como `details` pra reservarComLimite parsear
      // (mantém compatibilidade com lógica de "restrição vigente" / "limite produto")
      telemetriaSend("content.reservar.end", { grupoId, ok: false, erro: "BACKEND_ERROR", details: (toast.details || "").slice(0, 200), decorridoMs: Date.now() - start });
      return { ok: false, grupoId, erro: "BACKEND_ERROR", details: toast.details };
    } catch (err) {
      const erro = (err && err.message) || String(err);
      telemetriaSend("content.reservar.end", { grupoId, ok: false, erro, decorridoMs: Date.now() - start });
      return { ok: false, grupoId, erro };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.action) return false;

    // Ping pra background validar que content-script tá vivo após re-injeção (Fix 14 B5)
    if (message.action === "ping") {
      sendResponse({ ok: true, alive: true });
      return false;
    }

    if (message.action !== "reservar_via_dom") return false;

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

  if (DEBUG) {
    window.__canopusRobo = {
      getTurnstileToken, detectarTurnstileInterativo, aguardarTurnstile,
      tryCandidato, aguardarElemento, snapshotInterativos, reservarViaDom
    };
  }
})();
