// extension/lib/listeners.js — registra chrome.* event listeners no SW.
// Deps: state (alarmName), telemetria, lifecycle (iniciarMonitoramento, pararMonitoramento),
//       loop (runPollingLoop), turnstile (handleTurnstileChallenge — resolved via global).

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

// Alarm como fallback: reativa loop se SW foi encerrado pelo browser.
// Respeita nextRunAt — não fura schedule do RATE_LIMIT/circuit/etc.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== alarmName) return;
  const { isRunning, nextRunAt } = await chrome.storage.session.get(["isRunning", "nextRunAt"]);
  if (!isRunning) return;
  if (nextRunAt && Date.now() < nextRunAt) return;
  runPollingLoop();
});

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
