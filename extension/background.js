// ─── Spec 01: carrega libs em ordem topológica ───────────────────────────────
// SW context (Chrome MV3): importScripts é síncrono e popula self.X
// Node test context (Jest): chrome-mock.js shim do importScripts faz require + Object.assign(global)
if (typeof importScripts !== "undefined") {
  importScripts('lib/state.js', 'lib/format.js', 'lib/notifications.js', 'lib/horario.js', 'lib/telemetria.js', 'lib/telegram.js', 'lib/rate-limit.js');
}
if (typeof require !== "undefined" && typeof module !== "undefined") {
  Object.assign(global, require('./lib/state'));
  Object.assign(global, require('./lib/format'));
  Object.assign(global, require('./lib/notifications'));
  Object.assign(global, require('./lib/horario'));
  Object.assign(global, require('./lib/telemetria'));
  Object.assign(global, require('./lib/telegram'));
  Object.assign(global, require('./lib/rate-limit'));
}

// Telemetria movida pra lib/telemetria.js (Spec 01) — getTelemetriaLigada,
// sanitize, telemetria, flushTelemetria, persistirBatchPendente, __reset* etc.

// sleep movido pra lib/state.js (Spec 01)

async function agendarProximoCiclo(ms) {
  const at = Date.now() + ms;
  await chrome.storage.session.set({ nextRunAt: at });
  setTimeout(runPollingLoop, Math.min(ms, MAX_SETTIMEOUT_MS));
}

// tomarToken + registrarHitERateLimit movidos pra lib/rate-limit.js (Spec 01)

function getHeaders() {
  return {
    "secret": "e4537470554544d8a5909f16fca68f9b",
    "token": "f33da0eae2de47028f59c60f125c2da3",
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "Origin": ORIGIN_URL,
    "Referer": `${ORIGIN_URL}/pages/auth/login`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36"
  };
}

function parseRetryAfter(header) {
  if (!header) return 0;
  const sec = parseInt(header, 10);
  if (!isNaN(sec) && sec >= 0) return sec;
  const ts = Date.parse(header);
  if (!isNaN(ts)) return Math.max(0, Math.ceil((ts - Date.now()) / 1000));
  return 0;
}

async function apiPost(path, body, tentativaNet = 0) {
  await tomarToken();
  const headers = getHeaders();
  const reqStart = Date.now();
  telemetria("apiPost.req", { path, body, tentativaNet });
  let resp;
  try {
    resp = await fetch(`${BASE_URL}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  } catch (netErr) {
    telemetria("apiPost.err", { path, kind: "network", message: (netErr && netErr.message) || String(netErr), tentativaNet, latencyMs: Date.now() - reqStart });
    if (tentativaNet < MAX_TENTATIVAS_NET) {
      const wait = 5000 + Math.random() * 10000;
      notificarPopup(`⚠️ Erro de rede. Aguardando ${(wait / 1000).toFixed(0)}s...`);
      await sleep(wait);
      return apiPost(path, body, tentativaNet + 1);
    }
    throw netErr;
  }

  if (resp.status === 429 || resp.status === 403) {
    const retryAfterHeader = resp.headers && typeof resp.headers.get === "function"
      ? resp.headers.get("retry-after")
      : null;
    const retryAfterSec = parseRetryAfter(retryAfterHeader);
    let bodyText = "";
    try {
      if (resp && typeof resp.clone === "function") {
        bodyText = await resp.clone().text();
      } else if (resp && typeof resp.text === "function") {
        bodyText = await resp.text();
      }
    } catch (_) { /* corpo ilegível — segue sem detecção 1015 */ }
    const cloudflare1015 = /1015|rate.?limited/i.test(bodyText);

    // Fix 6.3: detecta Cloudflare 1106 (IP banido). Não é rate-limit transiente — é
    // bloqueio explícito do dono do site, sem retry possível. Throw IP_BANIDO →
    // runPollingLoop para tudo e alerta cliente.
    const ipBanned = /error_code\s*[":=]\s*"?1106|ipv6_banned|ip_banned|access_denied/i.test(bodyText);
    if (ipBanned) {
      telemetria("apiPost.err", {
        path, kind: "ip_banned", status: resp.status,
        body: truncateString(bodyText, TELEMETRIA_BODY_TRUNC),
        latencyMs: Date.now() - reqStart
      });
      const err = new Error("IP_BANIDO");
      err.status = resp.status;
      err.body = bodyText.slice(0, 500);
      throw err;
    }

    if (cloudflare1015 && bodyText) {
      const snippet = bodyText.slice(0, 200).replace(/\s+/g, " ").trim();
      notificarPopup(`🔎 Body 429 (Cloudflare?): ${snippet}`);
    }

    await registrarHitERateLimit();

    // Fix 13: incrementa counter de rate-limits em metricasDia (persistente)
    try {
      const diaRl = new Date().toLocaleDateString('en-CA');
      const localRl = await chrome.storage.local.get(["metricasDia"]);
      const mdRl = (localRl.metricasDia && typeof localRl.metricasDia === "object") ? localRl.metricasDia : {};
      const dayRl = mdRl[diaRl] || { ciclos: 0, reservas: 0, consultas: 0, rateLimits: 0 };
      dayRl.rateLimits = (dayRl.rateLimits || 0) + 1;
      mdRl[diaRl] = dayRl;
      await chrome.storage.local.set({ metricasDia: mdRl });
    } catch (_) {}

    telemetria("apiPost.err", {
      path, kind: "rate_limit", status: resp.status,
      retryAfterSec, cloudflare1015,
      body: truncateString(bodyText, TELEMETRIA_BODY_TRUNC),
      latencyMs: Date.now() - reqStart
    });

    const err = new Error("RATE_LIMIT");
    err.status = resp.status;
    err.retryAfterSec = retryAfterSec;
    err.cloudflare1015 = cloudflare1015;
    throw err;
  }

  if (!resp.ok) {
    telemetria("apiPost.err", { path, kind: "http", status: resp.status, latencyMs: Date.now() - reqStart });
    throw new Error(`HTTP ${resp.status} em ${path}`);
  }
  const json = await resp.json();
  telemetria("apiPost.resp", {
    path, status: resp.status,
    body: truncateString(JSON.stringify(json), TELEMETRIA_BODY_TRUNC),
    latencyMs: Date.now() - reqStart
  });
  return json;
}

async function ajustarDelayDinamico() {
  const { DELAY_MIN = 5, DELAY_MAX = 10 } = await chrome.storage.local.get(["DELAY_MIN", "DELAY_MAX"]);
  const floorMin = Number(DELAY_MIN);
  const floorMax = Number(DELAY_MAX);

  const sess = (await chrome.storage.session.get(["rateLimitHit", "currentMin", "currentMax", "isRunning"])) || {};
  if (!sess.isRunning) {
    return { currentMin: floorMin, currentMax: floorMax };
  }
  let cMin = sess.currentMin != null ? Number(sess.currentMin) : floorMin;
  let cMax = sess.currentMax != null ? Number(sess.currentMax) : floorMax;

  if (sess.rateLimitHit) {
    cMin = Math.min(cMin * RATE_LIMIT_BACKOFF_FACTOR, MAX_DYNAMIC_DELAY);
    cMax = Math.min(cMax * RATE_LIMIT_BACKOFF_FACTOR, MAX_DYNAMIC_DELAY);
    notificarPopup(`⚙️ Rate limit detectado → delay ajustado para ${cMin.toFixed(1)}-${cMax.toFixed(1)}s`);
  } else {
    const novoMin = cMin * SUCCESS_DECAY_FACTOR;
    const novoMax = cMax * SUCCESS_DECAY_FACTOR;
    cMin = Math.max(novoMin, floorMin);
    cMax = Math.max(novoMax, floorMax);
  }

  if (cMax < cMin) cMax = cMin;

  await chrome.storage.session.set({
    currentMin: cMin,
    currentMax: cMax,
    rateLimitHit: false
  });

  return { currentMin: cMin, currentMax: cMax };
}

async function fazerLogin() {
  const { USUARIO, SENHA } = await chrome.storage.local.get(["USUARIO", "SENHA"]);
  const data = await apiPost("/auth/enterPlataforma", {
    Usuario: String(USUARIO || "").padStart(10, "0"),
    Senha: SENHA || "",
    Ip: "",
    Browser: "Chrome",
    Acesso: "USR"
  });
  if (!data.success || !Array.isArray(data.data) || data.data.length === 0) {
    throw new Error("LOGIN_FALHOU: resposta inválida");
  }
  return data.data[0];
}

async function buscarGrupos(idUsuario) {
  const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
  const resp = await apiPost(`/reservas/listGruposReserva/${idUsuario}`, {
    IdUsuario: idUsuario,
    Usuario: String(USUARIO || "").padStart(10, "0")
  });
  // Fix 16 Lote C: telemetria diagnóstica pra investigar se backend pagina.
  // Pure diagnostic — não muda comportamento. Cliente exporta telemetria,
  // suporte verifica count + shape da response pra decidir fix de paginação.
  try {
    const grupos = extrairGrupos(resp);
    telemetria("buscarGrupos.resultado", {
      count: grupos.length,
      primeiros5CDGrupo: grupos.slice(0, 5).map(g => String(g && g.CD_Grupo || "")),
      sampleKeys: grupos[0] ? Object.keys(grupos[0]) : [],
      respKeys: resp ? Object.keys(resp) : [],
      temField_totalPages: resp && typeof resp.totalPages !== "undefined",
      temField_hasNext: resp && typeof resp.hasNext !== "undefined",
      temField_pageSize: resp && typeof resp.pageSize !== "undefined",
      respDataShape: Array.isArray(resp && resp.data)
        ? (Array.isArray(resp.data[0]) ? "nested-array" : "flat-array")
        : "non-array"
    });
  } catch (_) {}
  return resp;
}

async function reservar(grupo, idUsuario, idEmpresa) {
  const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
  return apiPost("/reservas/add", {
    IdEmpresa: idEmpresa,
    IdUsuario: idUsuario,
    Usuario: String(USUARIO || "").padStart(10, "0"),
    ID_Grupo: grupo.ID_Grupo,
    ID_Bem: grupo.ID_Bem,
    ID_Produto: grupo.ID_Produto,
    NM_Produto: grupo.NM_Produto,
    PZ_Comercializacao: grupo.PZ_Comercializacao
  });
}

// Fix 11 + 14 B5: tenta recuperar content-script automaticamente. Sem reload —
// usa chrome.scripting.executeScript pra injetar content.js dinamicamente.
// Se aba está em outra rota do portal, navega pra /apps/reservas.
// Em vez de delays hardcoded, faz polling até sendMessage suceder (max 5s).
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

function extrairGrupos(resp) {
  if (!resp || !Array.isArray(resp.data)) return [];
  const outer = resp.data;
  // API devolve { data: [[ {grupo}, ... ]] } — array aninhado
  if (outer.length > 0 && Array.isArray(outer[0])) return outer[0];
  // Fallback: caso já venha flat
  return outer;
}

function extrairReserva(resp) {
  if (!resp || !Array.isArray(resp.data)) return {};
  const first = resp.data[0];
  if (first && typeof first === "object" && !Array.isArray(first)) return first;
  if (Array.isArray(first) && first.length > 0 && typeof first[0] === "object") return first[0];
  return {};
}

// formatarDataBR, usuarioExibicao, brasilNowParts movidos pra lib/format.js (Spec 01)

// ABERTURA_HHMM, FECHAMENTO_SEMANA, FECHAMENTO_SABADO movidos pra lib/state.js (Spec 01)

// sistemaEstaAberto, proximaAberturaBR movidos pra lib/horario.js (Spec 01)

function parseGruposConfig(configStr) {
  const alvo = {};
  if (!configStr) return alvo;
  for (const item of configStr.split(",")) {
    const parts = item.trim().split(":");
    if (parts.length === 2 && parts[0].trim() && !isNaN(parseInt(parts[1], 10))) {
      alvo[parts[0].trim()] = parseInt(parts[1], 10);
    }
  }
  return alvo;
}

function removerGrupoDoConfig(configStr, grupoId) {
  if (!configStr) return "";
  return configStr
    .split(",")
    .map(s => s.trim())
    .filter(s => !s.startsWith(grupoId + ":"))
    .join(",");
}

// notificarPopup, registrarUltimoErroPersistente movidos pra lib/notifications.js (Spec 01)

// TELEGRAM_TIMEOUT_MS + telegramNotify movidos pra lib/telegram.js (Spec 01)

async function reservarComLimite(grupo, uid, eid, grupoId, limite, reservasPorGrupo, modoTeste) {
  if (modoTeste) {
    notificarPopup(`[TESTE] Simularia reserva: ${grupo.NM_Produto} (Grupo ${grupoId})`);
    return { teste: true, grupoId, produto: grupo.NM_Produto };
  }

  const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
  const usuarioFmt = usuarioExibicao(USUARIO);
  const agora = formatarDataBR(new Date().toISOString());

  const msgEncontrada = `🍀 Cota ${grupoId} encontrada para o usuário ${usuarioFmt} em ${agora}!`;
  notificarPopup(msgEncontrada);
  await telegramNotify(msgEncontrada);

  const tabResult = await reservarViaTab(grupo, grupoId);
  if (tabResult.semAba) {
    return { reservou: false, grupoId, produto: grupo.NM_Produto, semAba: true };
  }
  if (tabResult.turnstileTimeout || tabResult.turnstileError) {
    const sessCool = await chrome.storage.session.get(["gruposEmCooldown"]);
    const cool = sessCool.gruposEmCooldown && typeof sessCool.gruposEmCooldown === "object" ? sessCool.gruposEmCooldown : {};
    cool[grupoId] = Date.now() + TURNSTILE_COOLDOWN_MS;
    await chrome.storage.session.set({ gruposEmCooldown: cool });
    return { reservou: false, grupoId, produto: grupo.NM_Produto, turnstile: true };
  }
  if (tabResult.fase2Pendente) {
    return { reservou: false, grupoId, produto: grupo.NM_Produto, fase2Pendente: true };
  }
  if (tabResult.erro) {
    return { reservou: false, grupoId, produto: grupo.NM_Produto, erro: tabResult.erro };
  }

  const result = tabResult.result;

  if (!(result && result.success)) {
    const details = String((result && (result.details || result.message)) || "");
    const detailsLower = details.toLowerCase();
    const bodyStr = JSON.stringify(result || {}).toLowerCase();

    if (detailsLower.includes("restrição vigente") || detailsLower.includes("restricao vigente")) {
      throw new Error("SISTEMA_FECHADO");
    }

    if (detailsLower.includes("limite de reservas desse produto")) {
      const idProd = grupo.ID_Produto;
      const sess = await chrome.storage.session.get(["produtosBloqueados"]);
      const lista = Array.isArray(sess.produtosBloqueados) ? sess.produtosBloqueados : [];
      if (!lista.includes(idProd)) {
        lista.push(idProd);
        await chrome.storage.session.set({ produtosBloqueados: lista });
      }
      const msg = `💣 Erro: "${details}" Removendo o produto: ${grupo.NM_Produto} do grupo ${grupoId}.`;
      notificarPopup(msg);
      await telegramNotify(msg);
      return { reservou: false, grupoId, produto: grupo.NM_Produto, produtoBloqueado: true };
    }

    if (bodyStr.includes("1015") || bodyStr.includes("rate_limited") || bodyStr.includes("\"429\"") || bodyStr.includes("\"403\"")) {
      await chrome.storage.session.set({ rateLimitHit: true });
    }

    if (details) {
      notificarPopup(`❌ Erro ao reservar: ${details}`);
    }
    return { reservou: false, grupoId, produto: grupo.NM_Produto, details };
  }

  const novoTotal = (reservasPorGrupo[grupoId] || 0) + 1;
  reservasPorGrupo[grupoId] = novoTotal;
  await chrome.storage.local.set({ reservasPorGrupo });

  const reserva = extrairReserva(result);
  const cota = String(reserva.CodigoCota || reserva.CD_Cota || "N/D");
  const produtoNome = reserva.NomeProduto || grupo.NM_Produto || "N/D";
  const dtReserva = formatarDataBR(reserva.DataReserva || reserva.DT_Reserva);
  const dtValidade = formatarDataBR(reserva.DataValidade || reserva.DT_Validade);

  const msgReserva =
    `🎉 Reservado!\n` +
    `Usuário: ${usuarioFmt}\n` +
    `Grupo: ${grupoId}\n` +
    `Cota: ${cota}\n` +
    `Produto: ${produtoNome}\n` +
    `Data da Reserva: ${dtReserva}\n` +
    `Válido até: ${dtValidade}`;

  notificarPopup(msgReserva);
  await telegramNotify(msgReserva);

  const concluido = novoTotal >= limite;
  if (concluido) {
    const conclusao = `✅ Grupo ${grupoId} concluído — ${limite} reservas feitas`;
    notificarPopup(conclusao);
    await telegramNotify(conclusao);
    const { GRUPOS_CONFIG } = await chrome.storage.local.get(["GRUPOS_CONFIG"]);
    const novoConfig = removerGrupoDoConfig(GRUPOS_CONFIG, grupoId);
    await chrome.storage.local.set({ GRUPOS_CONFIG: novoConfig });
  }

  return { reservou: true, grupoId, produto: grupo.NM_Produto, novoTotal, limite, concluido, cota };
}

async function runMonitorCycle() {
  const cycleStart = Date.now();
  telemetria("cycle.start", {});

  // Fix 15: declarado no top do escopo pra ficar acessível no finally — garante que
  // cycle.end + atualização metricasDia rode mesmo em ciclos sem detectados.
  let detectados = [];
  let resultados = [];
  let sistemaFechadoErr = null;

  try {
    const stored = await chrome.storage.local.get([
      "idUsuario", "idEmpresa", "GRUPOS_CONFIG", "MODO_TESTE"
    ]);
    let uid = stored.idUsuario;
    let eid = stored.idEmpresa;

    if (!uid) {
      const loginData = await fazerLogin();
      uid = loginData.IdUsuario;
      eid = loginData.IdEmpresa;
      await chrome.storage.local.set({ idUsuario: uid, idEmpresa: eid, idUsuarioObtidoEm: Date.now() });
      const loginMsg = "✅ Login realizado com sucesso!";
      notificarPopup(loginMsg);
      await telegramNotify(loginMsg);
    }

    const gruposResp = await buscarGrupos(uid);
    const gruposAlvo = parseGruposConfig(stored.GRUPOS_CONFIG);
    const grupos = extrairGrupos(gruposResp);

    notificarPopup(`📦 ${grupos.length} grupos consultados`);

    const { reservasPorGrupo = {} } = await chrome.storage.local.get(["reservasPorGrupo"]);
    const sessProdutos = await chrome.storage.session.get(["produtosBloqueados", "gruposEmCooldown"]);
    const produtosBloqueados = Array.isArray(sessProdutos.produtosBloqueados) ? sessProdutos.produtosBloqueados : [];
    const cooldownRaw = sessProdutos.gruposEmCooldown && typeof sessProdutos.gruposEmCooldown === "object" ? sessProdutos.gruposEmCooldown : {};
    const agoraMs = Date.now();
    let cooldownLimpou = false;
    const cooldown = {};
    for (const k of Object.keys(cooldownRaw)) {
      if (cooldownRaw[k] > agoraMs) cooldown[k] = cooldownRaw[k];
      else cooldownLimpou = true;
    }
    if (cooldownLimpou) await chrome.storage.session.set({ gruposEmCooldown: cooldown });

    // Dedup por CD_Grupo: API retorna múltiplos bens do mesmo grupo no mesmo ciclo.
    // Sem dedup, reservaríamos 2× o mesmo grupoId em paralelo (2× sendMessage, 2× cooldown).
    const jaDetectado = new Set();
    const dedupContagem = {};
    for (const grupo of grupos) {
      const codigo = String(grupo.CD_Grupo || "");
      if (!(codigo in gruposAlvo)) continue;
      dedupContagem[codigo] = (dedupContagem[codigo] || 0) + 1;
      if (jaDetectado.has(codigo)) continue;

      const limite = gruposAlvo[codigo];
      const feitas = reservasPorGrupo[codigo] || 0;
      if (feitas >= limite) continue;

      if (produtosBloqueados.includes(grupo.ID_Produto)) continue;
      if (cooldown[codigo]) continue;

      jaDetectado.add(codigo);
      detectados.push({ grupo, grupoId: codigo, limite });
    }
    const duplicados = Object.keys(dedupContagem).filter(k => dedupContagem[k] > 1);
    if (duplicados.length) {
      telemetria("dedup.applied", { duplicados, contagem: dedupContagem });
    }

    // Fix 16 Lote C: telemetria do filtro pra distinguir bug de paginação vs bug de filtro.
    // Se brutosCount alto mas detectadosCount=0, problema é filtro/config. Se brutosCount
    // truncado (ex: sempre 100), backend pagina e robô só vê página 1.
    telemetria("filter.detectados", {
      brutosCount: grupos.length,
      alvoConfigCount: Object.keys(gruposAlvo).length,
      detectadosCount: detectados.length,
      configKeys: Object.keys(gruposAlvo),
      cdGruposBrutos: grupos.slice(0, 20).map(g => String(g && g.CD_Grupo || "")),
      produtosBloqueadosCount: produtosBloqueados.length,
      cooldownAtivos: Object.keys(cooldown)
    });

    if (detectados.length === 0) {
      notificarPopup(`💥 Nenhuma cota disponível no momento...`);
      const sessIdle = await chrome.storage.session.get(["ciclosVazios"]);
      const novosVazios = Math.min(Number(sessIdle.ciclosVazios || 0) + 1, IDLE_MAX_CICLOS);
      await chrome.storage.session.set({ ciclosVazios: novosVazios });
      return; // finally roda — cycle.end + metricasDia
    }

    // Vagas detectadas → reset idle counter
    await chrome.storage.session.set({ ciclosVazios: 0 });

    const lista = Object.keys(gruposAlvo).sort().join(", ");
    notificarPopup(`🔍 Buscando por cotas: ${lista}...`);

    // Fix 6.1: serial — DOM é singleton, paralelo cria race condition no modal global
    for (const d of detectados) {
      try {
        const valor = await reservarComLimite(d.grupo, uid, eid, d.grupoId, d.limite, reservasPorGrupo, stored.MODO_TESTE);
        resultados.push({ status: "fulfilled", value: valor });
      } catch (err) {
        resultados.push({ status: "rejected", reason: err });
        if (err && err.message === "SISTEMA_FECHADO") {
          sistemaFechadoErr = err;
          break; // não adianta tentar mais grupos com sistema fechado
        }
      }
    }
  } finally {
    // Fix 15: cycle.end + atualização métricas SEMPRE rodam (mesmo em ciclo vazio
    // ou exception). Garante que ciclos/consultas crescem na tab Operações e Histórico
    // independente de haver detectados ou reservas.
    telemetria("cycle.end", {
      duracaoMs: Date.now() - cycleStart,
      detectados: detectados.length,
      resultados: resultados.map(r => r.status === "fulfilled"
        ? { ok: true, ...r.value }
        : { ok: false, erro: (r.reason && r.reason.message) || String(r.reason) })
    });

    // Fix 12: métricas em storage.local (persistente) pra agregar entre sessões + usuários.
    // metricasDia mantém últimos 30 dias. metricasHoras só do dia atual (cleanup auto).
    try {
      const agora = new Date();
      // Fix 14 B4: usa data local (BRT) em vez de UTC pra evitar virada em UTC midnight
      const dia = agora.toLocaleDateString('en-CA');
      const hh = String(agora.getHours()).padStart(2, "0");
      const keyHora = dia + "-" + hh;

      const local = await chrome.storage.local.get(["metricasDia", "metricasHoras"]);
      const metricasDia = (local.metricasDia && typeof local.metricasDia === "object") ? local.metricasDia : {};
      const metricasHoras = (local.metricasHoras && typeof local.metricasHoras === "object") ? local.metricasHoras : {};

      const reservasNoCiclo = resultados.filter(r => r.status === "fulfilled" && r.value && r.value.reservou).length;
      // 1 = chamada listGruposReserva; +N = chamadas de reserva tentadas (mesmo se falharam)
      const consultasNoCiclo = 1 + detectados.length;

      // Fix 14 B1: preservar rateLimits que apiPost incrementa em paralelo.
      // Read-modify-write: nunca sobrescrever campo que outro caminho atualiza.
      const m = metricasDia[dia] || { ciclos: 0, reservas: 0, consultas: 0, rateLimits: 0 };
      m.ciclos = (m.ciclos || 0) + 1;
      m.reservas = (m.reservas || 0) + reservasNoCiclo;
      m.consultas = (m.consultas || 0) + consultasNoCiclo;
      if (m.rateLimits == null) m.rateLimits = 0;
      metricasDia[dia] = m;

      const h = metricasHoras[keyHora] || { ciclos: 0, reservas: 0 };
      h.ciclos += 1;
      h.reservas += reservasNoCiclo;
      metricasHoras[keyHora] = h;

      // Cleanup metricasDia: mantém últimos 30 dias
      const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
      const cutoffStr = new Date(cutoff).toLocaleDateString('en-CA');
      for (const k of Object.keys(metricasDia)) {
        if (k < cutoffStr) delete metricasDia[k];
      }

      // Cleanup metricasHoras: só hoje
      for (const k of Object.keys(metricasHoras)) {
        if (!k.startsWith(dia + "-")) delete metricasHoras[k];
      }

      await chrome.storage.local.set({ metricasDia, metricasHoras });
    } catch (_) {}

    // Issue 2: missão cumprida — se GRUPOS_CONFIG esvaziou + houve pelo menos
    // uma reserva no histórico, para sozinho. Cliente não precisa clicar stop manual.
    try {
      const local = await chrome.storage.local.get(["GRUPOS_CONFIG", "reservasPorGrupo"]);
      const configVazia = !local.GRUPOS_CONFIG || !local.GRUPOS_CONFIG.trim();
      const totalReservas = local.reservasPorGrupo
        ? Object.values(local.reservasPorGrupo).reduce((acc, n) => acc + (n || 0), 0)
        : 0;
      if (configVazia && totalReservas > 0) {
        const msg = `🎯 Todas reservas concluídas (${totalReservas} ${totalReservas === 1 ? "feita" : "feitas"}). Robô parado automaticamente.`;
        notificarPopup(msg);
        telegramNotify(msg).catch(() => {});
        telemetria("missao.cumprida", { totalReservas });
        await pararMonitoramento();
      }
    } catch (_) {}

    await flushTelemetria();
  }

  if (sistemaFechadoErr) throw sistemaFechadoErr;
}

async function dormirAteAbertura() {
  const { dataStr, ms } = proximaAberturaBR();
  const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
  const usuarioFmt = usuarioExibicao(USUARIO);
  const sess = await chrome.storage.session.get(["sistemaFechadoLogged"]);
  if (!sess.sistemaFechadoLogged) {
    const msg = `⛔ Sistema fechado. Próxima abertura: ${dataStr}.`;
    notificarPopup(msg);
    await telegramNotify(msg);
    await chrome.storage.session.set({ sistemaFechadoLogged: true, usuarioFechado: usuarioFmt });
  }
  const sleepMs = Math.max(1000, Math.min(ms, 1000 * 60 * 60));
  await agendarProximoCiclo(sleepMs);
}

async function runPollingLoop() {
  // M1: 1 batch read em vez de 4× session.get separados
  const sess = await chrome.storage.session.get([
    "isRunning", "nextRunAt",
    "turnstileBloqueado", "turnstileBloqueadoAte",
    "circuitAberto",
    "sistemaFechadoLogged"
  ]);
  if (!sess.isRunning) return;

  // H3: tenta restaurar batch persistido em SW kill prévia (no-op se vazio)
  await flushTelemetria().catch(() => {});

  // State machine guard — respeita o próximo schedule independente de quem disparou (alarm vs setTimeout)
  if (sess.nextRunAt && Date.now() < sess.nextRunAt) {
    const restanteMs = sess.nextRunAt - Date.now();
    setTimeout(runPollingLoop, Math.min(restanteMs, MAX_SETTIMEOUT_MS));
    return;
  }

  const { MODO_TESTE } = await chrome.storage.local.get(["MODO_TESTE"]);

  // Turnstile interativo — robô pausado até cliente resolver no portal (ou expirar)
  if (sess.turnstileBloqueado && sess.turnstileBloqueadoAte && Date.now() < sess.turnstileBloqueadoAte) {
    const restanteMs = sess.turnstileBloqueadoAte - Date.now();
    setTimeout(runPollingLoop, Math.min(restanteMs, MAX_SETTIMEOUT_MS));
    return;
  }
  if (sess.turnstileBloqueado) {
    await chrome.storage.session.set({ turnstileBloqueado: false, turnstileBloqueadoAte: null });
    await limparBadgeTurnstile();
    notificarPopup(`✅ Pausa por Turnstile encerrada. Retomando.`);
  }

  // Circuit breaker — verifica antes de qualquer request
  if (sess.circuitAberto && Date.now() < sess.circuitAberto) {
    const restanteMs = sess.circuitAberto - Date.now();
    notificarPopup(`🛑 Circuit breaker aberto. Próxima tentativa em ${(restanteMs/1000).toFixed(0)}s`);
    await agendarProximoCiclo(restanteMs);
    return;
  }
  if (sess.circuitAberto && Date.now() >= sess.circuitAberto) {
    await chrome.storage.session.set({ circuitAberto: null, hitsRecentes: [] });
    notificarPopup(`✅ Circuit breaker fechado. Retomando.`);
  }

  // Horário comercial — bypass em modo teste pra permitir validação a qualquer hora
  if (!MODO_TESTE && !sistemaEstaAberto()) {
    await dormirAteAbertura();
    return;
  }

  // Transição fechado → aberto: avisa retomada
  if (sess.sistemaFechadoLogged) {
    const { USUARIO } = await chrome.storage.local.get(["USUARIO"]);
    const usuarioFmt = usuarioExibicao(USUARIO);
    const agora = formatarDataBR(new Date().toISOString());
    const msg = `🚀 Retomando buscas no usuário ${usuarioFmt} em ${agora}.`;
    notificarPopup(msg);
    await telegramNotify(msg);
    await chrome.storage.session.set({ sistemaFechadoLogged: false });
  }

  // M9: invalida sessão Canopus se mais velha que TTL — pega caso "robô voltou
  // do SW kill, sessão pode ter expirado no backend"
  const ID_USUARIO_TTL_MS = 6 * 60 * 60 * 1000; // 6h
  const { idUsuarioObtidoEm } = await chrome.storage.local.get(["idUsuarioObtidoEm"]);
  if (idUsuarioObtidoEm && Date.now() - idUsuarioObtidoEm > ID_USUARIO_TTL_MS) {
    await chrome.storage.local.remove(["idUsuario", "idEmpresa", "idUsuarioObtidoEm"]);
    notificarPopup("🔄 Sessão Canopus expirada (>6h). Re-autenticando no próximo ciclo.");
  }

  // Fix 9: mutex pra evitar reentrância (setTimeout + chrome.alarms disparam paralelo).
  // Sem isso, 2 ciclos rodam simultâneo → 2× requests à API → acelera bloqueio Cloudflare.
  const CYCLE_MAX_MS = 90_000;
  const sessLock = await chrome.storage.session.get(["cycleRunning", "cycleRunningSince"]);
  const lockAgora = Date.now();
  if (sessLock.cycleRunning && sessLock.cycleRunningSince && (lockAgora - sessLock.cycleRunningSince) < CYCLE_MAX_MS) {
    telemetria("cycle.skip_reentry", { decorridoMs: lockAgora - sessLock.cycleRunningSince });
    return;
  }
  await chrome.storage.session.set({ cycleRunning: true, cycleRunningSince: lockAgora });

  try {
    try {
      await runMonitorCycle();
    } catch (error) {
      if (error.message === "SISTEMA_FECHADO") {
        await chrome.storage.session.set({ sistemaFechadoLogged: false });
        await dormirAteAbertura();
        return;
      }

      if (error.message === "IP_BANIDO") {
        // Cloudflare baniu o IP do cliente. Não dá retry. Para tudo e alerta crítico.
        const msg = `🚫 IP BANIDO pelo Cloudflare (HTTP ${error.status}). Robô parado. Cliente precisa esperar 24h+ ou trocar de IP/rede.`;
        notificarPopup(msg);
        await registrarUltimoErroPersistente(`IP banido (HTTP ${error.status})`);
        await telegramNotify(msg);
        telemetria("sw.lifecycle", { event: "stopped_ip_banned", body: error.body });
        await flushTelemetria();
        await pararMonitoramento();
        return;
      }

      if (error.message === "RATE_LIMIT") {
        const baseWait = error.cloudflare1015
          ? CLOUDFLARE_1015_BACKOFF_SEC
          : Math.max(error.retryAfterSec || 0, RATE_LIMIT_BACKOFF_SEC);
        const fonte = error.cloudflare1015 ? "🔥 Cloudflare 1015" : `⛔ Rate limit (HTTP ${error.status || 429})`;
        const msg = `${fonte} — pausando ${baseWait}s antes de retry`;
        notificarPopup(msg);
        await telegramNotify(msg);
        await agendarProximoCiclo(baseWait * 1000);
        return;
      }

      console.error("❌ Erro no ciclo:", error.message);
      notificarPopup(`❌ Erro: ${error.message}`);
      await registrarUltimoErroPersistente(`Erro: ${error.message}`);
      await telegramNotify(`❌ Erro no robô: ${error.message}`);

      if (error.message.includes("LOGIN_FALHOU") || error.message.includes("HTTP 401")) {
        await chrome.storage.local.remove(["idUsuario", "idEmpresa", "idUsuarioObtidoEm"]);
      }
    }

    const { currentMin, currentMax } = await ajustarDelayDinamico();

    // Smart idle multiplier
    const { ciclosVazios = 0 } = await chrome.storage.session.get(["ciclosVazios"]);
    const idleMultiplier = 1 + IDLE_INCREMENT * Math.min(Number(ciclosVazios), IDLE_MAX_CICLOS);

    // Jitter triangular (bias suave pro centro do intervalo)
    const u = Math.random();
    const triangular = u < 0.5
      ? Math.sqrt(u * 0.5)
      : 1 - Math.sqrt((1 - u) * 0.5);
    const baseDelay = currentMin + triangular * Math.max(0, currentMax - currentMin);
    const delay = baseDelay * idleMultiplier;

    await agendarProximoCiclo(delay * 1000);
  } finally {
    await chrome.storage.session.set({ cycleRunning: false, cycleRunningSince: null });
  }
}

async function iniciarMonitoramento() {
  const local = await chrome.storage.local.get(["DELAY_MIN", "DELAY_MAX"]);
  let dMin = Number(local.DELAY_MIN);
  let dMax = Number(local.DELAY_MAX);
  if (!isFinite(dMin) || dMin <= 0) dMin = FLOOR_DELAY_MIN;
  if (!isFinite(dMax) || dMax <= 0) dMax = FLOOR_DELAY_MAX;

  // Floor enforcement — bloqueia config muito agressiva
  if (dMin < FLOOR_DELAY_MIN) {
    notificarPopup(`⚙️ DELAY_MIN ajustado de ${dMin}s para ${FLOOR_DELAY_MIN}s (anti-rate-limit)`);
    dMin = FLOOR_DELAY_MIN;
  }
  if (dMax < FLOOR_DELAY_MAX) {
    dMax = Math.max(FLOOR_DELAY_MAX, dMin);
  }
  if (dMax < dMin) dMax = dMin;
  // Persistir de volta no local pra UI refletir
  await chrome.storage.local.set({ DELAY_MIN: dMin, DELAY_MAX: dMax });

  await chrome.storage.session.set({
    isRunning: true,
    rateLimitHit: false,
    sistemaFechadoLogged: false,
    produtosBloqueados: [],
    currentMin: dMin,
    currentMax: dMax,
    bucket: { tokens: BUCKET_CAPACITY, lastRefill: Date.now() },
    hitsRecentes: [],
    circuitAberto: null,
    ciclosVazios: 0,
    nextRunAt: null
  });
  await chrome.alarms.create(alarmName, { periodInMinutes: 1 });
  runPollingLoop();
}

async function pararMonitoramento() {
  await chrome.storage.session.set({ isRunning: false });
  await chrome.alarms.clear(alarmName);
  // M9: mantemos idUsuario/idEmpresa entre stops — TTL no runPollingLoop invalida quando >6h
  await chrome.storage.local.remove(["idUsuario", "idEmpresa", "idUsuarioObtidoEm"]);
  notificarPopup("⏹ Monitoramento parado");
  telemetria("sw.lifecycle", { event: "stopped" });
  await flushTelemetria();
  await persistirBatchPendente();
}

// Alarm como fallback: reativa loop se SW foi encerrado pelo browser.
// Respeita nextRunAt — não fura schedule do RATE_LIMIT/circuit/etc.
// Fix 16 Lote B: limpa managedWindow se o cliente fechar a aba gerenciada.
// Próximo reservarViaTab recria via garantirAbaPortal.
if (chrome.tabs && chrome.tabs.onRemoved && typeof chrome.tabs.onRemoved.addListener === "function") {
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    try {
      const sess = await chrome.storage.session.get(["managedWindow"]);
      const mw = sess.managedWindow;
      if (mw && mw.tabId === tabId) {
        await chrome.storage.session.set({ managedWindow: null });
        telemetria("portal.managed_window_closed", { tabId });
      }
    } catch (_) {}
  });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== alarmName) return;
  const { isRunning, nextRunAt } = await chrome.storage.session.get(["isRunning", "nextRunAt"]);
  if (!isRunning) return;
  if (nextRunAt && Date.now() < nextRunAt) return;
  runPollingLoop();
});

async function handleTurnstileChallenge() {
  const ate = Date.now() + TURNSTILE_BLOQUEIO_MS;
  await chrome.storage.session.set({ turnstileBloqueado: true, turnstileBloqueadoAte: ate });
  const msg = `🚨 Turnstile pediu interação manual — resolva no portal em ${TURNSTILE_BLOQUEIO_MS/1000}s. Robô pausado.`;
  notificarPopup(msg);
  telemetria("turnstile.detected_interactive", { bloqueioMs: TURNSTILE_BLOQUEIO_MS });
  // Fix 16 Lote A: sinaliza no ícone da extensão (visível independente do popup).
  try {
    if (chrome.action && chrome.action.setBadgeText) {
      await chrome.action.setBadgeText({ text: "🔒" });
      if (chrome.action.setBadgeBackgroundColor) {
        await chrome.action.setBadgeBackgroundColor({ color: "#d32f2f" });
      }
    }
  } catch (_) {}
  await telegramNotify(msg);
}

async function limparBadgeTurnstile() {
  try {
    if (chrome.action && chrome.action.setBadgeText) {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch (_) {}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;

  if (message.action === "start") {
    iniciarMonitoramento()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.action === "stop") {
    pararMonitoramento()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.action === "turnstile_challenge") {
    handleTurnstileChallenge()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.action === "telemetria") {
    telemetria(message.tipo || "unknown", message.dados || {})
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (message.action === "clear_telemetria_buffer") {
    // Fix 14 B2: aguarda escrita antes de responder; sem isso sendResponse retorna
    // antes de storage gravar e clear pode ser perdido em SW kill subsequente.
    (async () => {
      __resetTelemetriaBatch();
      try {
        await Promise.all([
          chrome.storage.local.set({ telemetria_buffer: [] }),
          chrome.storage.session.set({ pending_telemetria_batch: [] })
        ]);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "flush_telemetria") {
    flushTelemetria()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// H1: invalida cache da flag quando popup muda valor em storage
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.TELEMETRIA_LIGADA) {
    __setTelemetriaCacheValue(!!changes.TELEMETRIA_LIGADA.newValue);
  }
});

// Exports para testes automatizados (ignorado no browser)
if (typeof module !== "undefined") {
  module.exports = {
    parseGruposConfig,
    removerGrupoDoConfig,
    apiPost,
    parseRetryAfter,
    ajustarDelayDinamico,
    tomarToken,
    registrarHitERateLimit,
    extrairGrupos,
    extrairReserva,
    formatarDataBR,
    usuarioExibicao,
    sistemaEstaAberto,
    proximaAberturaBR,
    brasilNowParts,
    fazerLogin,
    reservarComLimite,
    reservarViaTab,
    garantirAbaPortal,
    runMonitorCycle,
    runPollingLoop,
    handleTurnstileChallenge,
    sanitize,
    telemetria,
    flushTelemetria,
    persistirBatchPendente,
    getTelemetriaLigada,
    __resetTelemetriaCache,
    __resetTelemetriaBatch,
    telegramNotify,
    sleep,
    BUCKET_CAPACITY,
    BUCKET_REFILL_PER_SEC,
    CIRCUIT_HITS_THRESHOLD,
    CIRCUIT_WINDOW_MS,
    CIRCUIT_OPEN_MS,
    FLOOR_DELAY_MIN,
    FLOOR_DELAY_MAX,
    TURNSTILE_BLOQUEIO_MS,
    TURNSTILE_COOLDOWN_MS,
    TELEMETRIA_MAX_ENTRIES,
    TELEMETRIA_BATCH_MAX,
    TELEMETRIA_FLUSH_MS,
    TELEMETRIA_BODY_TRUNC,
    agendarProximoCiclo
  };
}
