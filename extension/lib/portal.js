// extension/lib/portal.js — gestão da aba do portal: discovery, criação de janela,
// recovery de content-script, ponte de mensagens pra reserva DOM-driven.
// Deps: state (PORTAL_TAB_URL, PORTAL_BOOTSTRAP_URL, MANAGED_WINDOW_READY_TIMEOUT_MS,
//              TAB_RESERVA_TIMEOUT_MS, TURNSTILE_COOLDOWN_MS, sleep),
//       telemetria, notifications, telegram.

async function tentarRecuperarContentScript(tab) {
  if (!tab || tab.id == null) return false;
  const url = tab.url || "";
  const isAppsRoute = /^https:\/\/parceiros\.consorciocanopus\.com\.br\/apps\//.test(url);

  // Poll: ping o content-script até responder ou timeout. Mais robusto que
  // sleep fixo em redes lentas.
  async function aguardarContentScriptVivo(timeoutMs) {
    const inicio = Date.now();
    while (Date.now() - inicio < timeoutMs) {
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { action: "ping" });
        if (resp) return true;
      } catch (_) { /* content-script ainda não responde — tenta de novo */ }
      await sleep(250);
    }
    return false;
  }

  if (isAppsRoute) {
    try {
      if (chrome.scripting && chrome.scripting.executeScript) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"]
        });
        telemetria("content_script.injected", { tabId: tab.id, method: "scripting" });
        const vivo = await aguardarContentScriptVivo(5000);
        telemetria("content_script.alive_after_inject", { vivo });
        return vivo;
      }
    } catch (err) {
      telemetria("content_script.inject_err", { erro: (err && err.message) || String(err) });
      return false;
    }
    return false;
  }

  try {
    const isPortalDomain = /^https:\/\/parceiros\.consorciocanopus\.com\.br/.test(url);
    if (isPortalDomain) {
      await chrome.tabs.update(tab.id, { url: "https://parceiros.consorciocanopus.com.br/apps/reservas" });
      telemetria("content_script.navigated", { tabId: tab.id, from: url });
      // Navegação leva mais tempo: bootstrap Angular + content_scripts via manifest
      const vivo = await aguardarContentScriptVivo(8000);
      telemetria("content_script.alive_after_navigate", { vivo });
      return vivo;
    }
  } catch (err) {
    telemetria("content_script.navigate_err", { erro: (err && err.message) || String(err) });
  }
  return false;
}

// Fix 16 Lote B: garante que existe uma aba do portal aberta. Se nenhuma existir,
// cria uma janela minimizada e espera o content-script subir. Retorna a aba que
// reservarViaTab vai usar — ou erro estruturado se não foi possível disponibilizar.
async function garantirAbaPortal() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: PORTAL_TAB_URL });
  } catch (err) {
    telemetria("portal.query_err", { erro: (err && err.message) || String(err) });
    return { ok: false, motivo: "TABS_QUERY_FAILED" };
  }

  if (tabs && tabs.length > 0) {
    return { ok: true, tabId: tabs[0].id, windowId: tabs[0].windowId, created: false, tab: tabs[0] };
  }

  // Sem aba aberta — cria janela minimizada dedicada.
  if (!chrome.windows || typeof chrome.windows.create !== "function") {
    return { ok: false, motivo: "WINDOWS_API_INDISPONIVEL" };
  }

  let novaJanela;
  try {
    novaJanela = await chrome.windows.create({
      url: PORTAL_BOOTSTRAP_URL,
      state: "minimized",
      focused: false,
      type: "normal"
    });
  } catch (err) {
    telemetria("portal.window_create_err", { erro: (err && err.message) || String(err) });
    return { ok: false, motivo: "WINDOW_CREATE_FAILED" };
  }

  const novaTab = novaJanela && Array.isArray(novaJanela.tabs) && novaJanela.tabs[0];
  if (!novaTab || novaTab.id == null) {
    return { ok: false, motivo: "WINDOW_SEM_TAB" };
  }

  // Helper: cliente clicou stop? Aborta cedo pra não travar cliente vendo coisas
  // depois do stop. Strict check: só considera parado se isRunning explicitamente
  // false. Undefined (SW restart) não conta — runPollingLoop já trata isso antes.
  async function clienteParouMonitoramento() {
    try {
      const s = await chrome.storage.session.get(["isRunning"]);
      return s.isRunning === false;
    } catch (_) {
      return false;
    }
  }

  // Fix 16 Lote E (E3): em vez de polling cego, espera tab status === "complete"
  // primeiro (até timeout/2). Janela minimizada é throttled, mas onUpdated dispara
  // assim que load termina — evita pingar enquanto Angular ainda bootstrapando.
  const inicio = Date.now();
  const timeoutComplete = Math.floor(MANAGED_WINDOW_READY_TIMEOUT_MS / 2);
  let urlFinal = novaTab.url || PORTAL_BOOTSTRAP_URL;
  let statusFinal = novaTab.status || "loading";
  let stopAbort = false;
  try {
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        clearInterval(stopCheck);
        try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
        resolve();
      }, timeoutComplete);
      const listener = (id, changeInfo, tab) => {
        if (id !== novaTab.id) return;
        if (tab && tab.url) urlFinal = tab.url;
        if (tab && tab.status) statusFinal = tab.status;
        if (changeInfo.status === "complete" || tab.status === "complete") {
          clearTimeout(t);
          clearInterval(stopCheck);
          try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Issue 1: poll isRunning a cada 1s — aborta cedo se cliente parou
      const stopCheck = setInterval(async () => {
        if (await clienteParouMonitoramento()) {
          stopAbort = true;
          clearInterval(stopCheck);
          clearTimeout(t);
          try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
          resolve();
        }
      }, 1000);
    });
  } catch (_) {}

  if (stopAbort) {
    telemetria("portal.window_created", { tabId: novaTab.id, windowId: novaJanela.id, contentScriptVivo: false, motivo: "STOP_DURING_LOAD" });
    return { ok: false, motivo: "STOP_DURING_LOAD", tabId: novaTab.id, windowId: novaJanela.id };
  }

  // Após "complete" (ou timeout), checa URL final via chrome.tabs.get
  try {
    if (chrome.tabs && typeof chrome.tabs.get === "function") {
      const t = await chrome.tabs.get(novaTab.id);
      if (t && t.url) urlFinal = t.url;
      if (t && t.status) statusFinal = t.status;
    }
  } catch (_) {}

  // Fix 16 Lote E (E4): se URL final não é /apps/*, provavelmente é tela de login.
  // Content-script só matches /apps/*. Avisa cliente abrindo janela em foco.
  const isAppsRoute = /^https:\/\/parceiros\.consorciocanopus\.com\.br\/apps\//.test(urlFinal);
  if (!isAppsRoute) {
    try {
      await chrome.windows.update(novaJanela.id, { state: "normal", focused: true });
    } catch (_) {}
    telemetria("portal.window_created", {
      tabId: novaTab.id,
      windowId: novaJanela.id,
      contentScriptVivo: false,
      url: urlFinal,
      status: statusFinal,
      motivo: "URL_FORA_DE_APPS"
    });
    const msg = `🔐 Robô abriu o portal mas você precisa fazer login (URL atual: ${urlFinal.split("?")[0]}). Faça login e mantenha a aba aberta — o robô usa a sessão dela.`;
    notificarPopup(msg);
    telegramNotify(msg).catch(() => {});
    return { ok: false, motivo: "LOGIN_NECESSARIO", tabId: novaTab.id, windowId: novaJanela.id, url: urlFinal };
  }

  // Poll ping até content-script responder. Fix 16 Lote E (E5): se ping não vier
  // até 1/4 do timeout restante, tenta injetar via scripting.executeScript como
  // fallback (mesmo mecanismo de tentarRecuperarContentScript que funciona quando
  // aba já existe).
  const restanteMs = () => MANAGED_WINDOW_READY_TIMEOUT_MS - (Date.now() - inicio);
  let vivo = false;
  let injetouFallback = false;
  while (restanteMs() > 0) {
    // Issue 1: aborta cedo se cliente parou enquanto pollávamos content-script
    if (await clienteParouMonitoramento()) {
      telemetria("portal.window_created", { tabId: novaTab.id, windowId: novaJanela.id, contentScriptVivo: false, motivo: "STOP_DURING_PING" });
      return { ok: false, motivo: "STOP_DURING_PING", tabId: novaTab.id, windowId: novaJanela.id };
    }
    try {
      const resp = await chrome.tabs.sendMessage(novaTab.id, { action: "ping" });
      if (resp) { vivo = true; break; }
    } catch (_) { /* ainda carregando */ }

    // Fallback: se já passou 1/4 do restante e ainda não respondeu, injeta script
    if (!injetouFallback && (Date.now() - inicio) > MANAGED_WINDOW_READY_TIMEOUT_MS / 2) {
      injetouFallback = true;
      try {
        if (chrome.scripting && chrome.scripting.executeScript) {
          await chrome.scripting.executeScript({
            target: { tabId: novaTab.id },
            files: ["content.js"]
          });
          telemetria("portal.window_script_inject_fallback", { tabId: novaTab.id });
        }
      } catch (_) {}
    }

    await sleep(500);
  }

  telemetria("portal.window_created", {
    tabId: novaTab.id,
    windowId: novaJanela.id,
    contentScriptVivo: vivo,
    esperaMs: Date.now() - inicio,
    url: urlFinal,
    status: statusFinal,
    injetouFallback
  });

  if (!vivo) {
    return { ok: false, motivo: "CONTENT_SCRIPT_NAO_RESPONDEU", tabId: novaTab.id, windowId: novaJanela.id, url: urlFinal };
  }

  await chrome.storage.session.set({
    managedWindow: { tabId: novaTab.id, windowId: novaJanela.id, criadoEm: Date.now() }
  });

  const msg = `🤖 Janela do portal iniciada em segundo plano (minimizada). Sem necessidade de intervenção, exceto se o Turnstile escalar pra interativo.`;
  notificarPopup(msg);
  telegramNotify(msg).catch(() => {});

  return { ok: true, tabId: novaTab.id, windowId: novaJanela.id, created: true, tab: novaTab };
}

// Reserva via content-script (Fix 3-H). Routes through page DOM context para passar pelo Turnstile.
// Retorna sempre objeto rotulado com chaves específicas (semAba, turnstileTimeout, fase2Pendente, erro, result).
async function reservarViaTab(grupo, grupoId) {
  // Fix 16 Lote B: garante aba antes de tentar reservar. Cria janela minimizada
  // se necessário — cliente não precisa mais manter portal aberto manualmente.
  const portal = await garantirAbaPortal();
  if (!portal.ok) {
    let msg;
    if (portal.motivo === "LOGIN_NECESSARIO") {
      // garantirAbaPortal já avisou cliente. Não duplicar — mas registra reserva perdida.
      msg = `⚠️ Cota ${grupoId} perdida — faça login no portal pra próxima.`;
    } else {
      msg = `⚠️ Cota ${grupoId} encontrada mas robô não conseguiu abrir o portal (${portal.motivo}). Abra parceiros.consorciocanopus.com.br manualmente.`;
    }
    notificarPopup(msg);
    telemetria("reserva.tab.req", { grupoId, semAba: true, motivo: portal.motivo });
    if (portal.motivo !== "LOGIN_NECESSARIO") {
      await telegramNotify(msg);
    }
    return { semAba: true, motivo: portal.motivo };
  }

  const tabId = portal.tabId;
  const windowId = portal.windowId;
  const reqStart = Date.now();
  telemetria("reserva.tab.req", { grupoId, NM_Produto: grupo.NM_Produto, tabId, windowId });

  // Fix 16 Lote A: não rouba mais foco da aba/janela. Content-script roda mesmo
  // com aba em background. Quando Turnstile escala pra interativo, cliente é
  // avisado via badge no ícone + Telegram + popup.

  async function trySendMessage() {
    return Promise.race([
      chrome.tabs.sendMessage(tabId, { action: "reservar_via_dom", grupo }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("TAB_RESERVA_TIMEOUT")), TAB_RESERVA_TIMEOUT_MS)
      )
    ]);
  }

  let tabResp;
  try {
    tabResp = await trySendMessage();
  } catch (err) {
    const errMsg = (err && err.message) || String(err);
    if (errMsg.includes("Receiving end does not exist") || errMsg.includes("Could not establish connection")) {
      // Fix 11: tenta recuperar automaticamente — injetar via scripting OU navegar pra /apps/reservas
      notificarPopup(`⚙️ Content-script ausente — tentando recuperar automaticamente...`);
      const recuperou = await tentarRecuperarContentScript(portal.tab || { id: tabId });
      if (recuperou) {
        try {
          tabResp = await trySendMessage();
          notificarPopup(`✅ Content-script recuperado.`);
        } catch (err2) {
          const errMsg2 = (err2 && err2.message) || String(err2);
          notificarPopup(`❌ Recuperação falhou: ${errMsg2}. Recarregue a aba (F5).`);
          await telegramNotify(`Recuperação automática do content-script falhou. Cliente precisa F5.`);
          return { erro: "CONTENT_SCRIPT_NAO_INJETADO" };
        }
      } else {
        const msg = `⚠️ Não consegui recuperar o content-script. Abra parceiros.consorciocanopus.com.br/apps/reservas e recarregue (F5).`;
        notificarPopup(msg);
        await telegramNotify(msg);
        return { erro: "CONTENT_SCRIPT_NAO_INJETADO" };
      }
    } else {
      notificarPopup(`❌ Falha ao falar com content-script (${grupoId}): ${errMsg}`);
      return { erro: errMsg };
    }
  }

  if (!tabResp) {
    notificarPopup(`❌ Content-script não respondeu para ${grupoId}.`);
    telemetria("reserva.tab.resp", { grupoId, ok: false, erro: "CONTENT_SCRIPT_NO_RESPONSE", latencyMs: Date.now() - reqStart });
    return { erro: "CONTENT_SCRIPT_NO_RESPONSE" };
  }
  telemetria("reserva.tab.resp", { grupoId, ok: !!tabResp.ok, erro: tabResp.erro, latencyMs: Date.now() - reqStart });

  if (tabResp.erro === "TURNSTILE_TIMEOUT") {
    const msg = `⏰ Turnstile timeout no grupo ${grupoId}. Cooldown ${TURNSTILE_COOLDOWN_MS/1000}s.`;
    notificarPopup(msg);
    await telegramNotify(msg);
    return { turnstileTimeout: true };
  }
  if (tabResp.erro === "TURNSTILE_INVISIBLE_TIMEOUT" || tabResp.erro === "TURNSTILE_ERROR") {
    notificarPopup(`⚠️ Turnstile não resolveu (${tabResp.erro}) no grupo ${grupoId}. Cooldown ${TURNSTILE_COOLDOWN_MS/1000}s.`);
    return { turnstileError: true };
  }
  if (tabResp.erro === "FASE_2_PENDENTE_SELECTORS") {
    notificarPopup(`⚙️ Cota ${grupoId} detectada mas implementação DOM ainda na Fase 2 — selectors pendentes.`);
    return { fase2Pendente: true };
  }
  if (!tabResp.ok) {
    // Se content-script reportou details do backend (ex: "restrição vigente", "limite de reservas...")
    // delega o tratamento pra reservarComLimite que já sabe parsear esses padrões.
    if (tabResp.details) {
      return { result: { success: false, details: tabResp.details, message: tabResp.message } };
    }
    notificarPopup(`❌ Reserva ${grupoId} falhou via tab: ${tabResp.erro || "erro desconhecido"}`);
    return { erro: tabResp.erro || "TAB_RESERVA_DESCONHECIDO" };
  }

  // Sucesso — content-script faz o equivalente de extrairReserva() do lado dele
  return {
    result: {
      success: true,
      data: [tabResp.reserva || {}]
    }
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.tentarRecuperarContentScript = tentarRecuperarContentScript;
  self.garantirAbaPortal = garantirAbaPortal;
  self.reservarViaTab = reservarViaTab;
}
if (typeof module !== "undefined") {
  module.exports = { tentarRecuperarContentScript, garantirAbaPortal, reservarViaTab };
}
