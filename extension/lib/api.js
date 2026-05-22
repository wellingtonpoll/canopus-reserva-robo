// extension/lib/api.js — HTTP layer (apiPost + retry + 429/403 + IP ban detection).
// Deps: state (BASE_URL, ORIGIN_URL, MAX_TENTATIVAS_NET, TELEMETRIA_BODY_TRUNC, sleep),
//       telemetria (telemetria, truncateString), notifications, rate-limit (tomarToken, registrarHitERateLimit).

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

// ─── Exports ────────────────────────────────────────────────────────────────
if (typeof self !== "undefined") {
  self.getHeaders = getHeaders;
  self.parseRetryAfter = parseRetryAfter;
  self.apiPost = apiPost;
}
if (typeof module !== "undefined") {
  module.exports = { getHeaders, parseRetryAfter, apiPost };
}
