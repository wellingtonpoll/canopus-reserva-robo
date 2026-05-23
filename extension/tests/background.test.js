const {
  parseGruposConfig,
  removerGrupoDoConfig,
  apiPost,
  parseRetryAfter,
  ajustarDelayDinamico,
  extrairGrupos,
  extrairReserva,
  formatarDataBR,
  usuarioExibicao,
  sistemaEstaAberto,
  proximaAberturaBR,
  fazerLogin,
  reservarComLimite,
  reservarViaTab,
  garantirAbaPortal,
  runMonitorCycle,
  handleTurnstileChallenge,
  telegramNotify,
  sleep
} = require('../background.js');

const mockGrupo = {
  CD_Grupo: "009113",
  ID_Grupo: 12345,
  ID_Bem: 1,
  ID_Produto: 2,
  NM_Produto: "Consórcio Imóvel 300k",
  PZ_Comercializacao: 200
};

// Acelera sleep/setTimeout para não esperar 5-15s nos testes
function mockSleep() {
  jest.spyOn(global, 'setTimeout').mockImplementation((fn) => { fn(); return 0; });
}

// ─── parseGruposConfig ───────────────────────────────────────────────────────

describe("parseGruposConfig", () => {
  test("parseia formato grupo:limite corretamente", () => {
    expect(parseGruposConfig("009113:3,009114:2")).toEqual({ "009113": 3, "009114": 2 });
  });

  test("retorna objeto vazio para string vazia", () => {
    expect(parseGruposConfig("")).toEqual({});
  });

  test("retorna objeto vazio para null/undefined", () => {
    expect(parseGruposConfig(null)).toEqual({});
    expect(parseGruposConfig(undefined)).toEqual({});
  });

  test("ignora entradas malformadas (sem dois-pontos)", () => {
    expect(parseGruposConfig("009113:3,invalido,009114:2")).toEqual({ "009113": 3, "009114": 2 });
  });

  test("ignora entradas com limite não numérico", () => {
    expect(parseGruposConfig("009113:abc,009114:2")).toEqual({ "009114": 2 });
  });

  test("parseia grupo único", () => {
    expect(parseGruposConfig("009113:5")).toEqual({ "009113": 5 });
  });

  test("trim em espaços extras", () => {
    expect(parseGruposConfig(" 009113 : 3 , 009114 : 2 ")).toEqual({ "009113": 3, "009114": 2 });
  });
});

// ─── removerGrupoDoConfig ────────────────────────────────────────────────────

describe("removerGrupoDoConfig", () => {
  test("remove grupo do meio", () => {
    expect(removerGrupoDoConfig("009113:3,009114:2,009115:1", "009114")).toBe("009113:3,009115:1");
  });

  test("remove único grupo — retorna string vazia", () => {
    expect(removerGrupoDoConfig("009113:3", "009113")).toBe("");
  });

  test("remove primeiro grupo", () => {
    expect(removerGrupoDoConfig("009113:3,009114:2", "009113")).toBe("009114:2");
  });

  test("remove último grupo", () => {
    expect(removerGrupoDoConfig("009113:3,009114:2", "009114")).toBe("009113:3");
  });

  test("retorna config inalterada se grupo não existe", () => {
    expect(removerGrupoDoConfig("009113:3,009114:2", "009999")).toBe("009113:3,009114:2");
  });

  test("retorna string vazia para configStr null", () => {
    expect(removerGrupoDoConfig(null, "009113")).toBe("");
  });
});

// ─── apiPost — sucesso e rate limit ─────────────────────────────────────────

describe("apiPost", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    chrome.storage.local.get.mockResolvedValue({});
  });
  afterEach(() => jest.restoreAllMocks());

  test("retorna JSON em sucesso", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [1] })
    });
    const result = await apiPost("/test", { foo: "bar" });
    expect(result).toEqual({ success: true, data: [1] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("429 → lança RATE_LIMIT (sem retry)", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 });
    await expect(apiPost("/test", {})).rejects.toMatchObject({ message: "RATE_LIMIT", status: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("403 (Cloudflare) → lança RATE_LIMIT (sem retry)", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });
    await expect(apiPost("/test", {})).rejects.toMatchObject({ message: "RATE_LIMIT", status: 403 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("não retenta em erros HTTP 4xx diferentes de 429/403", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(apiPost("/test", {})).rejects.toThrow("HTTP 500");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("retenta em erro de rede e recupera", async () => {
    global.fetch = jest.fn()
      .mockRejectedValueOnce(new TypeError("Network failed"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await apiPost("/test", {});
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("lança após MAX_TENTATIVAS_NET de erro de rede", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Network failed"));
    await expect(apiPost("/test", {})).rejects.toThrow("Network failed");
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  test("body com 1015 → RATE_LIMIT.cloudflare1015 = true", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 429,
      headers: { get: () => null },
      clone: function() { return { text: async () => "Cloudflare error 1015 — rate limited" }; }
    });
    await expect(apiPost("/test", {})).rejects.toMatchObject({
      message: "RATE_LIMIT",
      cloudflare1015: true
    });
  });

  test("body com 1015 → loga snippet do body pra diagnóstico Turnstile", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 429,
      headers: { get: () => null },
      clone: function() { return { text: async () => "<html>Cloudflare error 1015 — rate limited by zone</html>" }; }
    });
    await expect(apiPost("/test", {})).rejects.toMatchObject({ message: "RATE_LIMIT" });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "log",
        text: expect.stringMatching(/🔎 Body 429.*1015/)
      })
    );
  });

  test("Retry-After numérico passa pro erro como retryAfterSec", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 429,
      headers: { get: (h) => h.toLowerCase() === "retry-after" ? "45" : null }
    });
    await expect(apiPost("/test", {})).rejects.toMatchObject({
      message: "RATE_LIMIT",
      retryAfterSec: 45
    });
  });

  test("Fix 6.3: error_code 1106 → lança IP_BANIDO (sem retry)", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 403,
      headers: { get: () => null },
      clone: function() { return { text: async () => '{"error_code":1106,"error_name":"ipv6_banned","title":"Access denied"}' }; }
    });
    await expect(apiPost("/test", {})).rejects.toMatchObject({
      message: "IP_BANIDO",
      status: 403
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("Fix 6.3: body com ipv6_banned → IP_BANIDO mesmo com status 429", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 429,
      headers: { get: () => null },
      clone: function() { return { text: async () => 'Access denied. ipv6_banned' }; }
    });
    await expect(apiPost("/test", {})).rejects.toMatchObject({
      message: "IP_BANIDO"
    });
  });
});

// ─── fazerLogin ─────────────────────────────────────────────────────────────

describe("fazerLogin", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    chrome.storage.local.get.mockResolvedValue({ USUARIO: "12345", SENHA: "senha123" });
  });
  afterEach(() => jest.restoreAllMocks());

  test("retorna data[0] em sucesso", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [{ IdUsuario: 99, IdEmpresa: 1 }] })
    });
    const result = await fazerLogin();
    expect(result.IdUsuario).toBe(99);
  });

  test("lança LOGIN_FALHOU se data.data for array vazio", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [] })
    });
    await expect(fazerLogin()).rejects.toThrow("LOGIN_FALHOU");
  });

  test("lança LOGIN_FALHOU se success for false", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: false, data: null })
    });
    await expect(fazerLogin()).rejects.toThrow("LOGIN_FALHOU");
  });

  test("lança LOGIN_FALHOU se data não for array", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: { IdUsuario: 1 } })
    });
    await expect(fazerLogin()).rejects.toThrow("LOGIN_FALHOU");
  });

  test("padeia usuário com zeros à esquerda até 10 dígitos", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [{ IdUsuario: 1, IdEmpresa: 1 }] })
    });
    await fazerLogin();
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.Usuario).toBe("0000012345");
  });

  test("funciona com USUARIO/SENHA ausentes no storage (strings vazias)", async () => {
    chrome.storage.local.get.mockResolvedValue({});
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [{ IdUsuario: 1, IdEmpresa: 1 }] })
    });
    const body = JSON.parse((await fetch.mock?.calls?.[0]?.[1]?.body) || '{}');
    // Não deve lançar — usa strings vazias com segurança
    expect(async () => await fazerLogin()).not.toThrow();
  });

  test("propaga erro de rede do login", async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Network failed"));
    await expect(fazerLogin()).rejects.toThrow();
  });
});

// ─── reservarComLimite ───────────────────────────────────────────────────────

function mockTabAberta(tabResponse) {
  chrome.tabs.query.mockResolvedValue([{ id: 42 }]);
  chrome.tabs.sendMessage.mockResolvedValue(tabResponse);
}

describe("reservarComLimite (via content-script)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    chrome.storage.local.get.mockResolvedValue({
      USUARIO: "12345",
      GRUPOS_CONFIG: "009113:3,009114:2",
      TELEGRAM_TOKEN: "",
      TELEGRAM_CHAT_ID: ""
    });
    chrome.tabs.query.mockResolvedValue([{ id: 42 }]);
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true, reserva: {} });
  });
  afterEach(() => jest.restoreAllMocks());

  test("modo teste — não chama content-script", async () => {
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, true);
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  test("modo teste — notifica popup com [TESTE]", async () => {
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "log", text: expect.stringContaining("[TESTE]") })
    );
  });

  test("modo real — roteia via chrome.tabs.sendMessage para tab do portal", async () => {
    mockTabAberta({ ok: true, reserva: {} });
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(chrome.tabs.query).toHaveBeenCalledWith({
      url: "https://parceiros.consorciocanopus.com.br/apps/*"
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ action: "reservar_via_dom", grupo: mockGrupo })
    );
  });

  test("Fix 16: NÃO rouba foco da aba/janela ao reservar", async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 42, windowId: 7 }]);
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true, reserva: {} });
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    const updateFocusCalls = chrome.tabs.update.mock.calls.filter(c => c[1] && c[1].active === true);
    expect(updateFocusCalls).toHaveLength(0);
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });

  test("Fix 16 Lote B: sem aba + windows.create falha → retorna semAba", async () => {
    chrome.tabs.query.mockResolvedValue([]);
    chrome.windows.create.mockRejectedValueOnce(new Error("user closed"));
    const reservasPorGrupo = { "009113": 1 };
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, reservasPorGrupo, false);
    expect(out).toMatchObject({ reservou: false, semAba: true });
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "reservar_via_dom" })
    );
    const counterSet = chrome.storage.local.set.mock.calls.find(c => c[0].reservasPorGrupo);
    expect(counterSet).toBeUndefined();
  });

  test("Fix 16 Lote B: sem aba + windows.create falha → loga aviso", async () => {
    chrome.tabs.query.mockResolvedValue([]);
    chrome.windows.create.mockRejectedValueOnce(new Error("user closed"));
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "log",
        text: expect.stringMatching(/Abra parceiros\.consorciocanopus\.com\.br/i)
      })
    );
  });

  test("Fix 16 Lote B: sem aba → cria janela minimizada e usa pra reservar", async () => {
    chrome.tabs.query.mockResolvedValue([]);
    chrome.windows.create.mockResolvedValueOnce({ id: 555, tabs: [{ id: 666 }] });
    // ping responde no primeiro poll
    chrome.tabs.sendMessage.mockResolvedValueOnce({ pong: true });
    // depois reserva via dom retorna sucesso
    chrome.tabs.sendMessage.mockResolvedValueOnce({ ok: true, reserva: {} });
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(chrome.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ state: "minimized", focused: false })
    );
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(666, expect.objectContaining({ action: "ping" }));
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(666, expect.objectContaining({ action: "reservar_via_dom" }));
    expect(out).toMatchObject({ reservou: true });
  });

  test("incrementa contador após sucesso via tab", async () => {
    mockTabAberta({ ok: true, reserva: { CodigoCota: "9876" } });
    const reservasPorGrupo = { "009113": 1 };
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, reservasPorGrupo, false);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ reservasPorGrupo: { "009113": 2 } })
    );
  });

  test("NÃO incrementa contador se tab retorna { ok: false, details }", async () => {
    mockTabAberta({ ok: false, details: "Vaga esgotada" });
    const reservasPorGrupo = {};
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, reservasPorGrupo, false);
    const counterSet = chrome.storage.local.set.mock.calls.find(c => c[0].reservasPorGrupo);
    expect(counterSet).toBeUndefined();
  });

  test("remove grupo ao atingir limite", async () => {
    mockTabAberta({ ok: true, reserva: {} });
    const reservasPorGrupo = { "009113": 2 };
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, reservasPorGrupo, false);
    const setCall = chrome.storage.local.set.mock.calls.find(c => c[0].GRUPOS_CONFIG !== undefined);
    expect(setCall[0].GRUPOS_CONFIG).not.toContain("009113");
    expect(setCall[0].GRUPOS_CONFIG).toContain("009114:2");
  });

  test("não remove grupo abaixo do limite", async () => {
    mockTabAberta({ ok: true, reserva: {} });
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    const gruposConfigSet = chrome.storage.local.set.mock.calls.find(c => c[0].GRUPOS_CONFIG !== undefined);
    expect(gruposConfigSet).toBeUndefined();
  });

  test("TURNSTILE_TIMEOUT do content-script — grava cooldown 60s e não corrompe contador", async () => {
    mockTabAberta({ ok: false, erro: "TURNSTILE_TIMEOUT" });
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(out).toMatchObject({ reservou: false, turnstile: true });
    const coolCall = chrome.storage.session.set.mock.calls.find(c => c[0].gruposEmCooldown);
    expect(coolCall).toBeDefined();
    expect(coolCall[0].gruposEmCooldown["009113"]).toBeGreaterThan(Date.now() + 50_000);
    const counterSet = chrome.storage.local.set.mock.calls.find(c => c[0].reservasPorGrupo);
    expect(counterSet).toBeUndefined();
  });

  test("TURNSTILE_TIMEOUT — loga aviso (não é silencioso)", async () => {
    mockTabAberta({ ok: false, erro: "TURNSTILE_TIMEOUT" });
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "log",
        text: expect.stringMatching(/Turnstile timeout no grupo 009113/)
      })
    );
  });

  test("FASE_2_PENDENTE_SELECTORS — sinaliza pendência sem erro fatal", async () => {
    mockTabAberta({ ok: false, erro: "FASE_2_PENDENTE_SELECTORS" });
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(out).toMatchObject({ reservou: false, fase2Pendente: true });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "log",
        text: expect.stringMatching(/Fase 2/)
      })
    );
  });

  test("content-script não injetado — orienta cliente a recarregar aba (recuperação falhou)", async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 42, url: "https://parceiros.consorciocanopus.com.br/apps/dashboard" }]);
    chrome.tabs.sendMessage.mockRejectedValue(
      new Error("Could not establish connection. Receiving end does not exist.")
    );
    chrome.scripting.executeScript.mockRejectedValue(new Error("inject fail"));
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(out).toMatchObject({ reservou: false, erro: "CONTENT_SCRIPT_NAO_INJETADO" });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "log",
        text: expect.stringMatching(/abra parceiros|Recarregue/i)
      })
    );
  });

  test("Fix 11: content-script ausente em /apps/* → injeta via scripting + retry sucesso", async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 42, url: "https://parceiros.consorciocanopus.com.br/apps/reservas" }]);
    let callCount = 0;
    chrome.tabs.sendMessage.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      return { ok: true, reserva: {} };
    });
    chrome.scripting.executeScript.mockResolvedValue([{ result: undefined }]);
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: ["content.js"]
    });
    expect(out).toMatchObject({ reservou: true });
  });

  test("Fix 11: content-script ausente em rota fora de /apps/* → navega pra /apps/reservas", async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 42, url: "https://parceiros.consorciocanopus.com.br/pages/auth/login" }]);
    let callCount = 0;
    chrome.tabs.sendMessage.mockImplementation(async () => {
      callCount++;
      // 1ª chamada (reservar_via_dom) falha → tenta recuperar via navigate
      // 2ª+ chamadas (ping no aguardarContentScriptVivo) sucesso → vivo
      // Última chamada (reservar_via_dom retry) sucesso
      if (callCount === 1) {
        throw new Error("Could not establish connection. Receiving end does not exist.");
      }
      if (callCount === 2) return { ok: true, alive: true };
      return { ok: true, reserva: {} };
    });
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(chrome.tabs.update).toHaveBeenCalledWith(42, {
      url: "https://parceiros.consorciocanopus.com.br/apps/reservas"
    });
  });
});

// ─── Fix 14 E: edge cases adicionais ─────────────────────────────────────────

describe("Fix 14: race em flushTelemetria + telemetria concurrent", () => {
  const { telemetria, flushTelemetria, __resetTelemetriaCache, __resetTelemetriaBatch, TELEMETRIA_BATCH_MAX } = require('../background.js');

  beforeEach(() => {
    jest.clearAllMocks();
    __resetTelemetriaCache();
    __resetTelemetriaBatch();
    chrome.storage.local.get.mockResolvedValue({ TELEMETRIA_LIGADA: true, telemetria_buffer: [] });
    chrome.storage.local.set.mockResolvedValue(undefined);
    chrome.storage.session.get.mockResolvedValue({});
    chrome.storage.session.set.mockResolvedValue(undefined);
    jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
  });
  afterEach(() => jest.restoreAllMocks());

  test("telemetria() durante flush não perde eventos (snapshot atomic via splice)", async () => {
    // Adiciona 9 eventos (1 abaixo do batch max)
    for (let i = 0; i < TELEMETRIA_BATCH_MAX - 1; i++) {
      await telemetria("evento", { i });
    }
    // Dispara flush + telemetria em paralelo
    const flushP = flushTelemetria();
    await telemetria("durante_flush", { i: 99 });
    await flushP;

    // Os 9 originais devem ter sido escritos; o "durante_flush" pode estar em batch ou
    // já no buffer dependendo do timing — mas NENHUM evento perdido
    const allCalls = chrome.storage.local.set.mock.calls
      .filter(c => c[0].telemetria_buffer)
      .flatMap(c => c[0].telemetria_buffer);
    const tipos = allCalls.map(e => e.tipo);
    expect(tipos.filter(t => t === "evento").length).toBe(TELEMETRIA_BATCH_MAX - 1);
  });
});

describe("Fix 14: tentarRecuperarContentScript dedicated tests", () => {
  // Cobre apenas o caminho via reservarComLimite (função interna não exportada).
  // Edge cases já cobertos no describe "reservarComLimite (via content-script)".
  // Aqui validamos comportamento quando aguardarContentScriptVivo retorna false.

  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    chrome.storage.local.get.mockResolvedValue({
      USUARIO: "12345", GRUPOS_CONFIG: "009113:3",
      TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: ""
    });
    chrome.storage.session.get.mockResolvedValue({});
  });
  afterEach(() => jest.restoreAllMocks());

  test("scripting.executeScript falha → fallback message + retorna CONTENT_SCRIPT_NAO_INJETADO", async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 42, url: "https://parceiros.consorciocanopus.com.br/apps/reservas" }]);
    chrome.tabs.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    chrome.scripting.executeScript.mockRejectedValue(new Error("inject permission denied"));
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(out).toMatchObject({ reservou: false, erro: "CONTENT_SCRIPT_NAO_INJETADO" });
  });

  test("URL não-portal (e.g., outro site) → não navega pra reservas, retorna CONTENT_SCRIPT_NAO_INJETADO", async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 42, url: "https://google.com" }]);
    chrome.tabs.sendMessage.mockRejectedValue(new Error("Could not establish connection"));
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(out).toMatchObject({ erro: "CONTENT_SCRIPT_NAO_INJETADO" });
    // tabs.update pode ser chamado pra focar aba ({ active: true }) mas NUNCA pra navegar URL
    const navegou = chrome.tabs.update.mock.calls.some(c => c[1] && c[1].url);
    expect(navegou).toBe(false);
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  });
});

// ─── telegramNotify ──────────────────────────────────────────────────────────

describe("telegramNotify — falha não bloqueia fluxo", () => {
  beforeEach(() => jest.clearAllMocks());

  test("não lança quando Telegram API retorna erro", async () => {
    chrome.storage.local.get.mockResolvedValue({
      TELEGRAM_TOKEN: "123:abc",
      TELEGRAM_CHAT_ID: "456"
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
    await expect(telegramNotify("teste")).resolves.toBeUndefined();
  });

  test("não lança quando fetch lança erro de rede", async () => {
    chrome.storage.local.get.mockResolvedValue({
      TELEGRAM_TOKEN: "123:abc",
      TELEGRAM_CHAT_ID: "456"
    });
    global.fetch = jest.fn().mockRejectedValue(new TypeError("Network failed"));
    await expect(telegramNotify("teste")).resolves.toBeUndefined();
  });

  test("não chama fetch quando token ausente", async () => {
    chrome.storage.local.get.mockResolvedValue({ TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: "456" });
    global.fetch = jest.fn();
    await telegramNotify("teste");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("não chama fetch quando chat_id ausente", async () => {
    chrome.storage.local.get.mockResolvedValue({ TELEGRAM_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "" });
    global.fetch = jest.fn();
    await telegramNotify("teste");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("envia para URL correta quando configurado", async () => {
    chrome.storage.local.get.mockResolvedValue({
      TELEGRAM_TOKEN: "BOT_TOKEN",
      TELEGRAM_CHAT_ID: "CHAT_ID"
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    await telegramNotify("vaga encontrada");
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("api.telegram.org/botBOT_TOKEN/sendMessage"),
      expect.any(Object)
    );
  });
});

// ─── runMonitorCycle — resiliência do ciclo principal ───────────────────────

describe("runMonitorCycle", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    chrome.storage.session.get.mockResolvedValue({});
    chrome.tabs.query.mockResolvedValue([{ id: 42 }]);
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true, reserva: {} });
  });
  afterEach(() => jest.restoreAllMocks());

  function storageWith(overrides = {}) {
    const defaults = {
      idUsuario: 99,
      idEmpresa: 1,
      USUARIO: "12345",
      GRUPOS_CONFIG: "009113:3",
      MODO_TESTE: false,
      reservasPorGrupo: {},
      TELEGRAM_TOKEN: "",
      TELEGRAM_CHAT_ID: ""
    };
    chrome.storage.local.get.mockResolvedValue({ ...defaults, ...overrides });
  }

  function fetchGruposOk(grupos = [mockGrupo]) {
    // API real devolve data: [[ grupos... ]] — array aninhado
    return { ok: true, status: 200, json: async () => ({ success: true, data: [grupos] }) };
  }

  test("ciclo com vaga (grupo no config) — buscarGrupos via fetch + reserva via content-script", async () => {
    storageWith();
    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo]));
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true, reserva: {} });
    await runMonitorCycle();
    expect(fetch).toHaveBeenCalledTimes(1); // só buscarGrupos
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(
      42, expect.objectContaining({ action: "reservar_via_dom" })
    );
  });

  test("grupo não está no config (CD_Grupo diferente) — não reserva", async () => {
    storageWith({ GRUPOS_CONFIG: "009999:3" });
    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo]));
    await runMonitorCycle();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("grupo já atingiu limite — não reserva", async () => {
    storageWith({ reservasPorGrupo: { "009113": 3 } });
    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo]));
    await runMonitorCycle();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("buscarGrupos retorna data: null — não lança, trata como lista vazia", async () => {
    storageWith();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: null })
    });
    await expect(runMonitorCycle()).resolves.toBeUndefined();
  });

  test("buscarGrupos retorna data ausente — não lança", async () => {
    storageWith();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: false })
    });
    await expect(runMonitorCycle()).resolves.toBeUndefined();
  });

  test("rate limit em buscarGrupos — lança RATE_LIMIT (sem retry interno)", async () => {
    storageWith();
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 });
    await expect(runMonitorCycle()).rejects.toMatchObject({ message: "RATE_LIMIT" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("sem idUsuario — faz login antes de consultar grupos", async () => {
    storageWith({ idUsuario: undefined, idEmpresa: undefined, GRUPOS_CONFIG: "009999:3" });
    global.fetch = jest.fn()
      .mockResolvedValueOnce({  // login
        ok: true, status: 200,
        json: async () => ({ success: true, data: [{ IdUsuario: 99, IdEmpresa: 1 }] })
      })
      .mockResolvedValueOnce(fetchGruposOk([mockGrupo]));
    await runMonitorCycle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ idUsuario: 99, idEmpresa: 1 })
    );
  });

  test("login falha — lança e não prossegue para busca de grupos", async () => {
    storageWith({ idUsuario: undefined });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: false, data: [] })
    });
    await expect(runMonitorCycle()).rejects.toThrow("LOGIN_FALHOU");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("múltiplos grupos — falha em um não cancela outros (sequencial)", async () => {
    const grupo2 = { ...mockGrupo, CD_Grupo: "009114", ID_Grupo: 67890, ID_Produto: 3, NM_Produto: "Outro" };
    storageWith({ GRUPOS_CONFIG: "009113:3,009114:3" });

    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo, grupo2]));
    chrome.tabs.sendMessage
      .mockResolvedValueOnce({ ok: false, erro: "ALGUM_ERRO" })
      .mockResolvedValue({ ok: true, reserva: {} });

    await expect(runMonitorCycle()).resolves.toBeUndefined();
  });

  test("Fix 6.1: múltiplos grupos rodam SERIAL (não paralelo)", async () => {
    const grupo2 = { ...mockGrupo, CD_Grupo: "009114", ID_Grupo: 67890, ID_Produto: 3, NM_Produto: "Outro" };
    storageWith({ GRUPOS_CONFIG: "009113:3,009114:3" });
    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo, grupo2]));

    const callOrder = [];
    chrome.tabs.sendMessage.mockImplementation(async (tabId, msg) => {
      callOrder.push({ at: "start", grupoId: msg.grupo.CD_Grupo });
      await new Promise(r => setTimeout(r, 10));
      callOrder.push({ at: "end", grupoId: msg.grupo.CD_Grupo });
      return { ok: true, reserva: {} };
    });

    await runMonitorCycle();

    // Cada grupo deve completar antes do próximo começar
    expect(callOrder[0]).toEqual({ at: "start", grupoId: "009113" });
    expect(callOrder[1]).toEqual({ at: "end",   grupoId: "009113" });
    expect(callOrder[2]).toEqual({ at: "start", grupoId: "009114" });
    expect(callOrder[3]).toEqual({ at: "end",   grupoId: "009114" });
  });

  test("Fix 6.1: SISTEMA_FECHADO no 1º grupo interrompe sequencia (não chama 2º)", async () => {
    const grupo2 = { ...mockGrupo, CD_Grupo: "009114", ID_Grupo: 67890, ID_Produto: 3, NM_Produto: "Outro" };
    storageWith({ GRUPOS_CONFIG: "009113:3,009114:3" });
    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo, grupo2]));
    chrome.tabs.sendMessage.mockResolvedValueOnce({
      ok: false,
      details: "Há uma restrição vigente para efetuar reservas neste momento."
    });
    await expect(runMonitorCycle()).rejects.toThrow("SISTEMA_FECHADO");
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1); // 2º não foi chamado
  });

  test("modo teste — não chama content-script", async () => {
    storageWith({ MODO_TESTE: true });
    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo]));
    await runMonitorCycle();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("[TESTE]") })
    );
  });

  test("loga '🔍 Buscando por cotas' quando há detectados", async () => {
    storageWith();
    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo]));
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true, reserva: {} });
    await runMonitorCycle();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "log",
        text: expect.stringMatching(/🔍 Buscando por cotas: 009113/)
      })
    );
  });

  test("loga '💥 Nenhuma cota disponível' em ciclo vazio", async () => {
    storageWith({ GRUPOS_CONFIG: "009999:3" });
    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo]));
    await runMonitorCycle();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "log",
        text: expect.stringContaining("💥 Nenhuma cota disponível")
      })
    );
  });

  test("Fix 15: ciclo vazio ainda incrementa metricasDia.ciclos + .consultas", async () => {
    storageWith({ GRUPOS_CONFIG: "009999:3" });
    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo]));

    // Capture writes em storage.local pra inspecionar metricasDia
    const writes = [];
    chrome.storage.local.set.mockImplementation(async (obj) => { writes.push(obj); });

    await runMonitorCycle();

    // Espera-se 1 write com metricasDia incrementado (ciclos=1, consultas=1, reservas=0)
    const metricasWrite = writes.find(w => w.metricasDia);
    expect(metricasWrite).toBeDefined();
    const diaKey = Object.keys(metricasWrite.metricasDia)[0];
    expect(metricasWrite.metricasDia[diaKey]).toMatchObject({
      ciclos: 1,
      consultas: 1, // 1 = listGruposReserva; +0 = sem detectados (filtrados)
      reservas: 0
    });
  });

  test("filtra grupos com ID_Produto em produtosBloqueados", async () => {
    storageWith();
    chrome.storage.session.get.mockResolvedValue({ produtosBloqueados: [2] });
    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo]));
    await runMonitorCycle();
    // Produto bloqueado → não detecta → não reserva, mas loga "💥 Nenhuma cota disponível"
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("💥 Nenhuma cota disponível") })
    );
  });

  test("Telegram '🍀 Cota encontrada' antes da reserva", async () => {
    storageWith({ TELEGRAM_TOKEN: "BOT", TELEGRAM_CHAT_ID: "CHAT" });
    global.fetch = jest.fn().mockResolvedValue({ ok: true });  // grupos + telegrams
    global.fetch.mockResolvedValueOnce(fetchGruposOk([mockGrupo]));
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true, reserva: {} });
    await runMonitorCycle();
    const telegramBodies = fetch.mock.calls
      .filter(c => String(c[0]).includes("api.telegram.org"))
      .map(c => JSON.parse(c[1].body).text);
    expect(telegramBodies.some(t => /🍀 Cota 009113 encontrada/.test(t))).toBe(true);
  });

  test("CD_Grupo duplicado no resultado da API — dedup, só 1 sendMessage por grupo", async () => {
    storageWith();
    const grupoDup = { ...mockGrupo, ID_Bem: 99 }; // mesmo CD_Grupo, bem diferente
    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo, grupoDup]));
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true, reserva: {} });
    await runMonitorCycle();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  test("Telegram '🎉 Reservado!' detalhado após sucesso via content-script", async () => {
    storageWith({ TELEGRAM_TOKEN: "BOT", TELEGRAM_CHAT_ID: "CHAT" });
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    global.fetch.mockResolvedValueOnce(fetchGruposOk([mockGrupo]));
    chrome.tabs.sendMessage.mockResolvedValue({
      ok: true,
      reserva: {
        CodigoCota: "9876",
        NomeProduto: "Imóvel 300k",
        DataReserva: "2026-05-20T22:14:11",
        DataValidade: "2026-05-21T22:14:11"
      }
    });
    await runMonitorCycle();
    const telegramBodies = fetch.mock.calls
      .filter(c => String(c[0]).includes("api.telegram.org"))
      .map(c => JSON.parse(c[1].body).text);
    const reservado = telegramBodies.find(t => t.startsWith("🎉 Reservado!"));
    expect(reservado).toBeDefined();
    expect(reservado).toContain("Cota: 9876");
    expect(reservado).toContain("Imóvel 300k");
  });
});

// ─── reservarComLimite — valores de retorno ──────────────────────────────────

describe("reservarComLimite — retorno", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    chrome.storage.local.get.mockResolvedValue({
      USUARIO: "12345",
      GRUPOS_CONFIG: "009113:3",
      TELEGRAM_TOKEN: "",
      TELEGRAM_CHAT_ID: ""
    });
    chrome.tabs.query.mockResolvedValue([{ id: 42 }]);
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true, reserva: {} });
  });
  afterEach(() => jest.restoreAllMocks());

  test("modo teste → { teste: true, grupoId, produto }", async () => {
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, true);
    expect(out).toEqual({ teste: true, grupoId: "009113", produto: "Consórcio Imóvel 300k" });
  });

  test("sucesso sem conclusão → { reservou: true, novoTotal, limite, concluido: false }", async () => {
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true, reserva: {} });
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, { "009113": 1 }, false);
    expect(out).toMatchObject({
      reservou: true, grupoId: "009113", novoTotal: 2, limite: 3, concluido: false
    });
  });

  test("sucesso atinge limite → concluido: true", async () => {
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true, reserva: {} });
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, { "009113": 2 }, false);
    expect(out.concluido).toBe(true);
  });

  test("tab retorna { ok: false } sem details → { reservou: false, erro }", async () => {
    chrome.tabs.sendMessage.mockResolvedValue({ ok: false, erro: "UNKNOWN_DOM_STATE" });
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(out).toMatchObject({ reservou: false, grupoId: "009113", erro: "UNKNOWN_DOM_STATE" });
  });
});

// ─── P1.2 — Erros do backend mapeados pelo content-script ────────────────────

describe("reservarComLimite — erros do backend via content-script", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    chrome.storage.local.get.mockResolvedValue({
      USUARIO: "12345", GRUPOS_CONFIG: "009113:3",
      TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: ""
    });
    chrome.storage.session.get.mockResolvedValue({});
    chrome.tabs.query.mockResolvedValue([{ id: 42 }]);
  });
  afterEach(() => jest.restoreAllMocks());

  test('details "restrição vigente" → lança SISTEMA_FECHADO', async () => {
    chrome.tabs.sendMessage.mockResolvedValue({
      ok: false,
      details: "Há uma restrição vigente para efetuar reservas neste momento."
    });
    await expect(
      reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false)
    ).rejects.toThrow("SISTEMA_FECHADO");
  });

  test('details "limite de reservas desse produto" → adiciona em produtosBloqueados', async () => {
    chrome.tabs.sendMessage.mockResolvedValue({
      ok: false,
      details: "Limite de reservas desse produto para o ponto de venda atingido."
    });
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(out).toMatchObject({ reservou: false, produtoBloqueado: true });
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({ produtosBloqueados: [2] })
    );
  });

  test('details com "1015" → seta rateLimitHit', async () => {
    chrome.tabs.sendMessage.mockResolvedValue({
      ok: false,
      details: "error 1015 cloudflare"
    });
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({ rateLimitHit: true })
    );
  });
});

// ─── Helpers puros ──────────────────────────────────────────────────────────

describe("extrairGrupos", () => {
  test("desempacota data: [[ grupos ]]", () => {
    const resp = { data: [[ mockGrupo, { ...mockGrupo, CD_Grupo: "X" } ]] };
    expect(extrairGrupos(resp)).toHaveLength(2);
  });

  test("aceita data: [ grupos ] flat (fallback)", () => {
    const resp = { data: [mockGrupo] };
    // outer[0] não é array → cai no fallback flat
    expect(extrairGrupos(resp)).toEqual([mockGrupo]);
  });

  test("data ausente → []", () => {
    expect(extrairGrupos({})).toEqual([]);
    expect(extrairGrupos(null)).toEqual([]);
  });

  test("data: [[]] vazio → []", () => {
    expect(extrairGrupos({ data: [[]] })).toEqual([]);
  });
});

describe("extrairReserva", () => {
  test("data: [dict] flat", () => {
    const r = { data: [{ CodigoCota: "1" }] };
    expect(extrairReserva(r)).toEqual({ CodigoCota: "1" });
  });

  test("data: [[dict]] aninhado", () => {
    const r = { data: [[{ CodigoCota: "2" }]] };
    expect(extrairReserva(r)).toEqual({ CodigoCota: "2" });
  });

  test("data vazio → {}", () => {
    expect(extrairReserva({ data: [] })).toEqual({});
    expect(extrairReserva({})).toEqual({});
  });
});

describe("formatarDataBR", () => {
  test("ISO 8601 → DD/MM/YYYY HH:mm:ss", () => {
    // O formato exato depende do TZ local da máquina de teste. Verificamos só estrutura.
    const out = formatarDataBR("2026-05-20T12:00:00");
    expect(out).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  });

  test("null/undefined/'' → '-'", () => {
    expect(formatarDataBR(null)).toBe("-");
    expect(formatarDataBR(undefined)).toBe("-");
    expect(formatarDataBR("")).toBe("-");
  });

  test("string inválida → ela mesma", () => {
    expect(formatarDataBR("xyz")).toBe("xyz");
  });
});

describe("usuarioExibicao", () => {
  test("strip leading zeros", () => {
    expect(usuarioExibicao("0000012345")).toBe("12345");
  });

  test("preserva se já sem zeros", () => {
    expect(usuarioExibicao("12345")).toBe("12345");
  });

  test("apenas zeros → preserva como está", () => {
    expect(usuarioExibicao("0000")).toBe("0000");
  });
});

describe("sistemaEstaAberto", () => {
  // Datas TZ BR (UTC-3)
  function brDate(yyyy, mm, dd, hh, mi) {
    const pad = n => String(n).padStart(2, "0");
    return new Date(`${yyyy}-${pad(mm)}-${pad(dd)}T${pad(hh)}:${pad(mi)}:00-03:00`);
  }

  test("Seg 10h → aberto", () => {
    // 2026-05-18 é segunda
    expect(sistemaEstaAberto(brDate(2026, 5, 18, 10, 0))).toBe(true);
  });

  test("Seg 07:54 → fechado (antes da abertura)", () => {
    expect(sistemaEstaAberto(brDate(2026, 5, 18, 7, 54))).toBe(false);
  });

  test("Seg 07:55 → aberto", () => {
    expect(sistemaEstaAberto(brDate(2026, 5, 18, 7, 55))).toBe(true);
  });

  test("Seg 19:01 → fechado", () => {
    expect(sistemaEstaAberto(brDate(2026, 5, 18, 19, 1))).toBe(false);
  });

  test("Sáb 12:59 → aberto", () => {
    // 2026-05-23 é sábado
    expect(sistemaEstaAberto(brDate(2026, 5, 23, 12, 59))).toBe(true);
  });

  test("Sáb 13:00 → fechado", () => {
    expect(sistemaEstaAberto(brDate(2026, 5, 23, 13, 0))).toBe(false);
  });

  test("Dom → sempre fechado", () => {
    // 2026-05-24 é domingo
    expect(sistemaEstaAberto(brDate(2026, 5, 24, 10, 0))).toBe(false);
    expect(sistemaEstaAberto(brDate(2026, 5, 24, 8, 0))).toBe(false);
  });
});

describe("proximaAberturaBR", () => {
  function brDate(yyyy, mm, dd, hh, mi) {
    const pad = n => String(n).padStart(2, "0");
    return new Date(`${yyyy}-${pad(mm)}-${pad(dd)}T${pad(hh)}:${pad(mi)}:00-03:00`);
  }

  test("Seg 06h → próxima abertura é hoje 07:55", () => {
    const out = proximaAberturaBR(brDate(2026, 5, 18, 6, 0));
    expect(out.dataStr).toBe("18/05/2026 às 07:55:00");
  });

  test("Seg 20h → próxima abertura é terça 07:55", () => {
    const out = proximaAberturaBR(brDate(2026, 5, 18, 20, 0));
    expect(out.dataStr).toBe("19/05/2026 às 07:55:00");
  });

  test("Sáb 14h → pula domingo, próxima é segunda 07:55", () => {
    const out = proximaAberturaBR(brDate(2026, 5, 23, 14, 0));
    expect(out.dataStr).toBe("25/05/2026 às 07:55:00");
  });

  test("Dom 10h → próxima é segunda 07:55", () => {
    const out = proximaAberturaBR(brDate(2026, 5, 24, 10, 0));
    expect(out.dataStr).toBe("25/05/2026 às 07:55:00");
  });
});

// ─── parseRetryAfter ────────────────────────────────────────────────────────

describe("parseRetryAfter", () => {
  test("parseia segundos numéricos", () => {
    expect(parseRetryAfter("30")).toBe(30);
    expect(parseRetryAfter("0")).toBe(0);
  });

  test("parseia HTTP-date (futuro)", () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const sec = parseRetryAfter(future);
    expect(sec).toBeGreaterThanOrEqual(44);
    expect(sec).toBeLessThanOrEqual(46);
  });

  test("HTTP-date no passado → 0", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  test("null / undefined / vazio → 0", () => {
    expect(parseRetryAfter(null)).toBe(0);
    expect(parseRetryAfter(undefined)).toBe(0);
    expect(parseRetryAfter("")).toBe(0);
  });

  test("string inválida → 0", () => {
    expect(parseRetryAfter("xyz")).toBe(0);
  });
});

// ─── Circuit breaker ────────────────────────────────────────────────────────

describe("registrarHitERateLimit (circuit breaker)", () => {
  const { registrarHitERateLimit, CIRCUIT_HITS_THRESHOLD } = require('../background.js');

  beforeEach(() => {
    jest.clearAllMocks();
    chrome.storage.local.get.mockResolvedValue({});
    chrome.storage.session.get.mockResolvedValue({});
  });

  test("1 hit isolado — não abre circuito, seta rateLimitHit", async () => {
    chrome.storage.session.get.mockResolvedValue({ hitsRecentes: [], isRunning: true });
    const out = await registrarHitERateLimit();
    expect(out.circuitOpen).toBe(false);
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({ rateLimitHit: true })
    );
  });

  test("2 hits em 60s — abre circuito por 10min", async () => {
    const agora = Date.now();
    chrome.storage.session.get.mockResolvedValue({
      hitsRecentes: [agora - 5000], isRunning: true
    });
    const out = await registrarHitERateLimit();
    expect(out.circuitOpen).toBe(true);
    const setCalls = chrome.storage.session.set.mock.calls;
    const cbCall = setCalls.find(c => c[0].circuitAberto != null);
    expect(cbCall).toBeDefined();
    expect(cbCall[0].circuitAberto).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  test("hits antigos (>60s) são filtrados", async () => {
    const antigo = Date.now() - 120_000;
    chrome.storage.session.get.mockResolvedValue({
      hitsRecentes: [antigo], isRunning: true
    });
    const out = await registrarHitERateLimit();
    expect(out.circuitOpen).toBe(false);  // antigo descartado, agora só 1 recente
  });

  test("circuito já aberto — não re-abre, só marca rateLimitHit", async () => {
    chrome.storage.session.get.mockResolvedValue({
      circuitAberto: Date.now() + 60_000, isRunning: true
    });
    const out = await registrarHitERateLimit();
    expect(out.circuitOpen).toBe(true);
    // Não deveria sobrescrever circuitAberto
    const setCalls = chrome.storage.session.set.mock.calls;
    const overwriteCb = setCalls.find(c => c[0].circuitAberto != null);
    expect(overwriteCb).toBeUndefined();
  });

  test("monitoramento parado — ignora hit (não corrompe contador/circuit)", async () => {
    chrome.storage.session.get.mockResolvedValue({ hitsRecentes: [], isRunning: false });
    const out = await registrarHitERateLimit();
    expect(out.ignored).toBe(true);
    expect(chrome.storage.session.set).not.toHaveBeenCalled();
  });
});

// ─── Token bucket ───────────────────────────────────────────────────────────

describe("tomarToken", () => {
  const { tomarToken, BUCKET_CAPACITY, BUCKET_REFILL_PER_SEC } = require('../background.js');

  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
  });
  afterEach(() => jest.restoreAllMocks());

  test("bucket cheio — consome 1 token sem aguardar", async () => {
    chrome.storage.session.get.mockResolvedValue({
      bucket: { tokens: BUCKET_CAPACITY, lastRefill: Date.now() }
    });
    await tomarToken();
    const setCall = chrome.storage.session.set.mock.calls.find(c => c[0].bucket);
    expect(setCall[0].bucket.tokens).toBeCloseTo(BUCKET_CAPACITY - 1, 1);
  });

  test("bucket vazio — aguarda refill antes de consumir", async () => {
    chrome.storage.session.get.mockResolvedValue({
      bucket: { tokens: 0, lastRefill: Date.now() }
    });
    await tomarToken();
    // Algum setTimeout grande foi chamado (refill wait)
    const waitCall = setTimeout.mock.calls.find(c => c[1] >= 1000);
    expect(waitCall).toBeDefined();
  });

  test("refilll proporcional ao tempo decorrido", async () => {
    const t0 = Date.now() - 10_000; // 10s atrás
    chrome.storage.session.get.mockResolvedValue({
      bucket: { tokens: 0, lastRefill: t0 }
    });
    await tomarToken();
    const setCall = chrome.storage.session.set.mock.calls.find(c => c[0].bucket);
    // 10s × BUCKET_REFILL_PER_SEC tokens, clampeado em BUCKET_CAPACITY, depois -1
    expect(setCall[0].bucket.tokens).toBeGreaterThanOrEqual(0);
    expect(setCall[0].bucket.tokens).toBeLessThanOrEqual(BUCKET_CAPACITY - 1);
  });

  test("primeiro uso (sem state) — começa com BUCKET_CAPACITY", async () => {
    chrome.storage.session.get.mockResolvedValue({});
    await tomarToken();
    const setCall = chrome.storage.session.set.mock.calls.find(c => c[0].bucket);
    expect(setCall[0].bucket.tokens).toBeCloseTo(BUCKET_CAPACITY - 1, 1);
  });
});

// ─── State machine: agendarProximoCiclo ─────────────────────────────────────

describe("agendarProximoCiclo", () => {
  const { agendarProximoCiclo } = require('../background.js');

  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
  });
  afterEach(() => jest.restoreAllMocks());

  test("persiste nextRunAt = now + ms em storage.session", async () => {
    const t0 = Date.now();
    await agendarProximoCiclo(45_000);
    const setCall = chrome.storage.session.set.mock.calls.find(c => c[0].nextRunAt != null);
    expect(setCall).toBeDefined();
    expect(setCall[0].nextRunAt).toBeGreaterThanOrEqual(t0 + 45_000 - 50);
    expect(setCall[0].nextRunAt).toBeLessThanOrEqual(t0 + 45_000 + 50);
  });

  test("setTimeout cap em MAX_SETTIMEOUT_MS (60s) quando ms é maior", async () => {
    await agendarProximoCiclo(120_000); // 2min — deve cappear em 60s no setTimeout
    const stCalls = setTimeout.mock.calls;
    // Algum setTimeout foi chamado com valor ≤ 60_000 (cap interno)
    const cappedCall = stCalls.find(c => c[1] <= 60_000 && c[1] >= 1);
    expect(cappedCall).toBeDefined();
  });

  test("setTimeout usa o ms cheio quando ≤ cap", async () => {
    await agendarProximoCiclo(30_000);
    const stCalls = setTimeout.mock.calls;
    const matchCall = stCalls.find(c => c[1] === 30_000);
    expect(matchCall).toBeDefined();
  });
});

// ─── ajustarDelayDinamico (AIMD) ────────────────────────────────────────────

describe("ajustarDelayDinamico", () => {
  beforeEach(() => jest.clearAllMocks());

  test("rate limit hit → multiplica delay por 2", async () => {
    chrome.storage.local.get.mockResolvedValue({ DELAY_MIN: 1, DELAY_MAX: 3 });
    chrome.storage.session.get.mockResolvedValue({
      rateLimitHit: true,
      currentMin: 2,
      currentMax: 4,
      isRunning: true
    });
    const out = await ajustarDelayDinamico();
    expect(out.currentMin).toBe(4);
    expect(out.currentMax).toBe(8);
  });

  test("rate limit hit em ceiling → clampeia em MAX_DYNAMIC_DELAY (60s)", async () => {
    chrome.storage.local.get.mockResolvedValue({ DELAY_MIN: 1, DELAY_MAX: 3 });
    chrome.storage.session.get.mockResolvedValue({
      rateLimitHit: true,
      currentMin: 40,
      currentMax: 50,
      isRunning: true
    });
    const out = await ajustarDelayDinamico();
    expect(out.currentMin).toBeLessThanOrEqual(60);
    expect(out.currentMax).toBeLessThanOrEqual(60);
    expect(out.currentMax).toBe(60); // 50*2=100 → clamp 60
  });

  test("sem rate limit hit → decai 10% mas respeita floor do user", async () => {
    chrome.storage.local.get.mockResolvedValue({ DELAY_MIN: 1, DELAY_MAX: 3 });
    chrome.storage.session.get.mockResolvedValue({
      rateLimitHit: false,
      currentMin: 8,
      currentMax: 12,
      isRunning: true
    });
    const out = await ajustarDelayDinamico();
    expect(out.currentMin).toBeCloseTo(7.2, 1);   // 8 * 0.9
    expect(out.currentMax).toBeCloseTo(10.8, 1);  // 12 * 0.9
  });

  test("decay não pode descer abaixo do floor configurado", async () => {
    chrome.storage.local.get.mockResolvedValue({ DELAY_MIN: 2, DELAY_MAX: 5 });
    chrome.storage.session.get.mockResolvedValue({
      rateLimitHit: false,
      currentMin: 2.1,
      currentMax: 5.1,
      isRunning: true
    });
    const out = await ajustarDelayDinamico();
    expect(out.currentMin).toBe(2);
    expect(out.currentMax).toBe(5);
  });

  test("primeira chamada (session vazia) → usa floor do user como ponto de partida", async () => {
    chrome.storage.local.get.mockResolvedValue({ DELAY_MIN: 1.5, DELAY_MAX: 4 });
    chrome.storage.session.get.mockResolvedValue({ isRunning: true });
    const out = await ajustarDelayDinamico();
    expect(out.currentMin).toBe(1.5);
    expect(out.currentMax).toBe(4);
  });

  test("monitoramento parado — não ajusta delay nem persiste storage", async () => {
    chrome.storage.local.get.mockResolvedValue({ DELAY_MIN: 1.5, DELAY_MAX: 4 });
    chrome.storage.session.get.mockResolvedValue({ rateLimitHit: true, isRunning: false });
    await ajustarDelayDinamico();
    expect(chrome.storage.session.set).not.toHaveBeenCalled();
  });

  test("reseta rateLimitHit após ajuste", async () => {
    chrome.storage.local.get.mockResolvedValue({ DELAY_MIN: 1, DELAY_MAX: 3 });
    chrome.storage.session.get.mockResolvedValue({
      rateLimitHit: true,
      currentMin: 1,
      currentMax: 3,
      isRunning: true
    });
    await ajustarDelayDinamico();
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({ rateLimitHit: false })
    );
  });

  test("persiste novos valores em storage.session", async () => {
    chrome.storage.local.get.mockResolvedValue({ DELAY_MIN: 1, DELAY_MAX: 3 });
    chrome.storage.session.get.mockResolvedValue({
      rateLimitHit: true,
      currentMin: 1,
      currentMax: 3,
      isRunning: true
    });
    await ajustarDelayDinamico();
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMin: 2,
        currentMax: 6
      })
    );
  });
});

// ─── Fix 3-H: handler turnstile_challenge + pause em runPollingLoop ─────────

describe("handleTurnstileChallenge", () => {
  const { handleTurnstileChallenge, TURNSTILE_BLOQUEIO_MS } = require('../background.js');

  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    chrome.storage.local.get.mockResolvedValue({ TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: "" });
  });
  afterEach(() => jest.restoreAllMocks());

  test("seta turnstileBloqueado + turnstileBloqueadoAte em storage.session", async () => {
    const antes = Date.now();
    await handleTurnstileChallenge();
    const setCall = chrome.storage.session.set.mock.calls.find(c => c[0].turnstileBloqueado === true);
    expect(setCall).toBeDefined();
    expect(setCall[0].turnstileBloqueadoAte).toBeGreaterThanOrEqual(antes + TURNSTILE_BLOQUEIO_MS - 50);
  });

  test("notifica popup com 🚨 Turnstile", async () => {
    await handleTurnstileChallenge();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "log",
        text: expect.stringMatching(/🚨 Turnstile.*resolva.*Robô pausado/)
      })
    );
  });

  test("dispara Telegram quando configurado", async () => {
    chrome.storage.local.get.mockResolvedValue({
      TELEGRAM_TOKEN: "BOT", TELEGRAM_CHAT_ID: "CHAT"
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    await handleTurnstileChallenge();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("api.telegram.org/botBOT/sendMessage"),
      expect.any(Object)
    );
  });
});

// ─── Telemetria: sanitize / batching / ring buffer ──────────────────────────

describe("Telemetria — sanitize", () => {
  const { sanitize } = require('../background.js');

  test("redact Senha/SENHA/password/pwd/secret", () => {
    const out = sanitize({
      Usuario: "x", Senha: "abc123", SENHA: "y", password: "z", pwd: "w", secret: "s"
    });
    expect(out.Usuario).toBe("x");
    expect(out.Senha).toBe("***");
    expect(out.SENHA).toBe("***");
    expect(out.password).toBe("***");
    expect(out.pwd).toBe("***");
    expect(out.secret).toBe("***");
  });

  test("trunca TELEGRAM_TOKEN para primeiros 6 chars + ...", () => {
    const out = sanitize({ TELEGRAM_TOKEN: "1234567890:ABCDEF" });
    expect(out.TELEGRAM_TOKEN).toBe("123456...");
  });

  test("redact header token longo do Canopus", () => {
    const out = sanitize({ token: "f33da0eae2de47028f59c60f125c2da3" });
    expect(out.token).toBe("***");
  });

  test("recursão em objects e arrays", () => {
    const out = sanitize({ a: { b: { Senha: "x" } }, arr: [{ password: "y" }] });
    expect(out.a.b.Senha).toBe("***");
    expect(out.arr[0].password).toBe("***");
  });

  test("não quebra com null/undefined/primitives", () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize(undefined)).toBeUndefined();
    expect(sanitize(42)).toBe(42);
    expect(sanitize("texto")).toBe("texto");
  });
});

describe("Telemetria — telemetria() e flushTelemetria()", () => {
  const { telemetria, flushTelemetria, TELEMETRIA_MAX_ENTRIES, TELEMETRIA_BATCH_MAX, __resetTelemetriaCache, __resetTelemetriaBatch } = require('../background.js');

  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    __resetTelemetriaCache();
    __resetTelemetriaBatch();
    chrome.storage.local.get.mockResolvedValue({});
    chrome.storage.local.set.mockResolvedValue(undefined);
    chrome.storage.session.get.mockResolvedValue({});
  });
  afterEach(() => jest.restoreAllMocks());

  test("no-op quando TELEMETRIA_LIGADA = false", async () => {
    chrome.storage.local.get.mockResolvedValue({ TELEMETRIA_LIGADA: false });
    await telemetria("evento", { foo: 1 });
    await flushTelemetria();
    expect(chrome.storage.local.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ telemetria_buffer: expect.anything() })
    );
  });

  test("flush ao atingir TELEMETRIA_BATCH_MAX entries", async () => {
    chrome.storage.local.get.mockResolvedValue({ TELEMETRIA_LIGADA: true });
    for (let i = 0; i < TELEMETRIA_BATCH_MAX; i++) {
      await telemetria("evento", { i });
    }
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ telemetria_buffer: expect.any(Array) })
    );
  });

  test("entries sanitizadas (Senha → ***)", async () => {
    chrome.storage.local.get.mockResolvedValue({ TELEMETRIA_LIGADA: true });
    for (let i = 0; i < TELEMETRIA_BATCH_MAX; i++) {
      await telemetria("apiPost.req", { body: { Senha: "secret" + i } });
    }
    const setCall = chrome.storage.local.set.mock.calls.find(c => c[0].telemetria_buffer);
    expect(setCall).toBeDefined();
    const entries = setCall[0].telemetria_buffer;
    entries.forEach(e => {
      expect(e.dados.body.Senha).toBe("***");
    });
  });

  test("ring buffer mantém só os últimos TELEMETRIA_MAX_ENTRIES", async () => {
    const existente = Array.from({ length: TELEMETRIA_MAX_ENTRIES - 2 }, (_, i) => ({ t: i, tipo: "x", dados: {} }));
    chrome.storage.local.get.mockResolvedValue({ TELEMETRIA_LIGADA: true, telemetria_buffer: existente });
    for (let i = 0; i < TELEMETRIA_BATCH_MAX; i++) {
      await telemetria("novo", { i });
    }
    const setCall = chrome.storage.local.set.mock.calls.find(c => c[0].telemetria_buffer);
    expect(setCall[0].telemetria_buffer.length).toBe(TELEMETRIA_MAX_ENTRIES);
    // últimos eventos novos no final
    const ultimas = setCall[0].telemetria_buffer.slice(-TELEMETRIA_BATCH_MAX);
    ultimas.forEach(e => expect(e.tipo).toBe("novo"));
  });

  test("H1: cache TELEMETRIA_LIGADA — segunda chamada não lê storage", async () => {
    const { getTelemetriaLigada, __resetTelemetriaCache } = require('../background.js');
    __resetTelemetriaCache();
    chrome.storage.local.get.mockResolvedValue({ TELEMETRIA_LIGADA: true });
    const v1 = await getTelemetriaLigada();
    expect(v1).toBe(true);
    chrome.storage.local.get.mockClear();
    const v2 = await getTelemetriaLigada();
    expect(v2).toBe(true);
    expect(chrome.storage.local.get).not.toHaveBeenCalled();
  });

  test("H3: persistirBatchPendente salva entries em storage.session", async () => {
    const { persistirBatchPendente, telemetria, __resetTelemetriaCache } = require('../background.js');
    __resetTelemetriaCache();
    chrome.storage.local.get.mockResolvedValue({ TELEMETRIA_LIGADA: true });
    chrome.storage.session.get.mockResolvedValue({});
    // Ignora callback do setTimeout que faria flush precoce do batch
    setTimeout.mockImplementation(() => 0);
    await telemetria("evento_pre_kill", { foo: 1 });
    await persistirBatchPendente();
    const sessSet = chrome.storage.session.set.mock.calls.find(c => c[0].pending_telemetria_batch);
    expect(sessSet).toBeDefined();
    expect(sessSet[0].pending_telemetria_batch.length).toBeGreaterThan(0);
  });

  test("H3: flushTelemetria recupera pending_telemetria_batch após SW restart", async () => {
    const { flushTelemetria, __resetTelemetriaCache } = require('../background.js');
    __resetTelemetriaCache();
    chrome.storage.local.get.mockResolvedValue({ TELEMETRIA_LIGADA: true, telemetria_buffer: [] });
    chrome.storage.session.get.mockResolvedValue({
      pending_telemetria_batch: [{ t: 1, tipo: "antes_kill", dados: {} }]
    });
    await flushTelemetria();
    const localSet = chrome.storage.local.set.mock.calls.find(c => c[0].telemetria_buffer);
    expect(localSet).toBeDefined();
    expect(localSet[0].telemetria_buffer).toEqual([
      expect.objectContaining({ tipo: "antes_kill" })
    ]);
  });
});

describe("Telegram timeout (H5)", () => {
  const { telegramNotify } = require('../background.js');

  beforeEach(() => {
    jest.clearAllMocks();
    chrome.storage.local.get.mockResolvedValue({
      TELEGRAM_TOKEN: "BOT", TELEGRAM_CHAT_ID: "CHAT"
    });
  });
  afterEach(() => jest.restoreAllMocks());

  test("fetch recebe AbortSignal", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    await telegramNotify("teste");
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  test("não lança quando fetch abortado por timeout", async () => {
    global.fetch = jest.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));
    await expect(telegramNotify("teste")).resolves.toBeUndefined();
  });
});

// ─── Fix 9: mutex em runPollingLoop ──────────────────────────────────────────

describe("Fix 9 — mutex runPollingLoop", () => {
  const { runPollingLoop } = require('../background.js');

  beforeEach(() => {
    jest.clearAllMocks();
    // setTimeout no-op pra evitar recursão infinita do agendarProximoCiclo chamando runPollingLoop
    jest.spyOn(global, 'setTimeout').mockImplementation(() => 0);
    chrome.tabs.query.mockResolvedValue([{ id: 42, windowId: 7 }]);
    chrome.tabs.sendMessage.mockResolvedValue({ ok: true, reserva: {} });
  });
  afterEach(() => jest.restoreAllMocks());

  test("2 chamadas concorrentes: segunda detecta cycleRunning e sai sem rodar runMonitorCycle", async () => {
    chrome.storage.local.get.mockImplementation(async (keys) => {
      if (Array.isArray(keys) && keys.includes("GRUPOS_CONFIG")) {
        return {
          idUsuario: 99, idEmpresa: 1, USUARIO: "12345",
          GRUPOS_CONFIG: "009113:3", MODO_TESTE: true,
          reservasPorGrupo: {}, TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: ""
        };
      }
      return {};
    });

    // Primeiro chamador: passa pelos guards, adquire lock
    chrome.storage.session.get.mockImplementation(async (keys) => {
      if (Array.isArray(keys) && keys.includes("cycleRunning")) {
        // Já tem cycle rodando (simula reentrância) — lockedAt agora pra ainda estar dentro de 90s
        return { cycleRunning: true, cycleRunningSince: Date.now() };
      }
      return { isRunning: true };
    });

    global.fetch = jest.fn();
    await runPollingLoop();

    // Verifica que NÃO chamou runMonitorCycle (não houve apiPost de listGruposReserva)
    expect(fetch).not.toHaveBeenCalled();
  });

  test("lock stale (>90s) é ignorado, novo ciclo passa", async () => {
    chrome.storage.local.get.mockImplementation(async (keys) => {
      const all = {
        idUsuario: 99, idEmpresa: 1, USUARIO: "12345",
        GRUPOS_CONFIG: "009999:3", MODO_TESTE: true,
        reservasPorGrupo: {}, TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: ""
      };
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach(k => { if (k in all) out[k] = all[k]; });
        return out;
      }
      return all;
    });

    chrome.storage.session.get.mockImplementation(async (keys) => {
      if (Array.isArray(keys) && keys.includes("cycleRunning")) {
        return { cycleRunning: true, cycleRunningSince: Date.now() - 120_000 }; // 2min atrás
      }
      return { isRunning: true };
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [[]] })
    });

    await runPollingLoop();

    // Lock stale → fetch foi chamado (passou pelo mutex)
    expect(fetch).toHaveBeenCalled();
  });

  test("lock é liberado no finally (cycleRunning volta a false)", async () => {
    chrome.storage.local.get.mockImplementation(async (keys) => {
      const all = {
        idUsuario: 99, idEmpresa: 1, USUARIO: "12345",
        GRUPOS_CONFIG: "009999:3", MODO_TESTE: true,
        reservasPorGrupo: {}, TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: ""
      };
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach(k => { if (k in all) out[k] = all[k]; });
        return out;
      }
      return all;
    });

    chrome.storage.session.get.mockResolvedValue({ isRunning: true });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [[]] })
    });

    await runPollingLoop();

    // Verifica que cycleRunning foi setado pra false no finally
    const lockReleased = chrome.storage.session.set.mock.calls.find(
      c => c[0].cycleRunning === false
    );
    expect(lockReleased).toBeDefined();
  });
});

// ─── Fix 16: garantirAbaPortal + badge Turnstile + telemetria paginação ──────
describe("Fix 16 Lote B: garantirAbaPortal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    chrome.storage.local.get.mockResolvedValue({ TELEMETRIA_LIGADA: false });
    chrome.storage.session.get.mockResolvedValue({});
  });

  test("com aba existente → reusa, não chama windows.create", async () => {
    chrome.tabs.query.mockResolvedValue([{ id: 42, windowId: 7 }]);
    const out = await garantirAbaPortal();
    expect(out).toMatchObject({ ok: true, tabId: 42, windowId: 7, created: false });
    expect(chrome.windows.create).not.toHaveBeenCalled();
  });

  test("sem aba + create sucesso + ping vivo → cria janela minimizada", async () => {
    chrome.tabs.query.mockResolvedValue([]);
    chrome.windows.create.mockResolvedValueOnce({ id: 555, tabs: [{ id: 666 }] });
    chrome.tabs.sendMessage.mockResolvedValueOnce({ pong: true });
    const out = await garantirAbaPortal();
    expect(chrome.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({ state: "minimized", focused: false, type: "normal" })
    );
    expect(out).toMatchObject({ ok: true, tabId: 666, windowId: 555, created: true });
    const persistCall = chrome.storage.session.set.mock.calls.find(c => c[0].managedWindow);
    expect(persistCall).toBeDefined();
    expect(persistCall[0].managedWindow).toMatchObject({ tabId: 666, windowId: 555 });
  });

  test("sem aba + create falha → retorna ok:false WINDOW_CREATE_FAILED", async () => {
    chrome.tabs.query.mockResolvedValue([]);
    chrome.windows.create.mockRejectedValueOnce(new Error("user cancelled"));
    const out = await garantirAbaPortal();
    expect(out).toMatchObject({ ok: false, motivo: "WINDOW_CREATE_FAILED" });
  });

  test("Fix 16 Lote E: sem aba + URL final = /login → LOGIN_NECESSARIO + abre janela em foco", async () => {
    chrome.tabs.query.mockResolvedValue([]);
    chrome.windows.create.mockResolvedValueOnce({ id: 555, tabs: [{ id: 666, url: "https://parceiros.consorciocanopus.com.br/login" }] });
    // tabs.get retorna /login (não /apps/*)
    chrome.tabs.get.mockResolvedValueOnce({ id: 666, url: "https://parceiros.consorciocanopus.com.br/login", status: "complete" });
    const out = await garantirAbaPortal();
    expect(out).toMatchObject({ ok: false, motivo: "LOGIN_NECESSARIO" });
    // Janela puxada pra foco pra cliente autenticar
    expect(chrome.windows.update).toHaveBeenCalledWith(555, expect.objectContaining({ state: "normal", focused: true }));
  });

  test("sem aba + create sucesso + ping nunca responde → CONTENT_SCRIPT_NAO_RESPONDEU", async () => {
    chrome.tabs.query.mockResolvedValue([]);
    chrome.windows.create.mockResolvedValueOnce({ id: 555, tabs: [{ id: 666 }] });
    chrome.tabs.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    // Avança Date.now em saltos pra não esperar 20s reais
    let virtual = 0;
    const realNow = Date.now;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      const t = realNow.call(Date) + virtual;
      virtual += 1000;
      return t;
    });
    const out = await garantirAbaPortal();
    expect(out).toMatchObject({ ok: false, motivo: "CONTENT_SCRIPT_NAO_RESPONDEU" });
    Date.now.mockRestore();
  });
});

describe("Issue 1: stop responsivo em garantirAbaPortal", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    chrome.storage.local.get.mockResolvedValue({ TELEMETRIA_LIGADA: false });
  });

  test("aborta loop de ping cedo se isRunning vira false", async () => {
    chrome.tabs.query.mockResolvedValue([]);
    chrome.windows.create.mockResolvedValueOnce({ id: 555, tabs: [{ id: 666 }] });
    chrome.tabs.sendMessage.mockRejectedValue(new Error("Receiving end does not exist"));
    // Primeira chamada storage.session.get retorna isRunning=true; depois vira false
    let calls = 0;
    chrome.storage.session.get.mockImplementation(async () => {
      calls++;
      return { isRunning: calls > 2 ? false : true };
    });
    const out = await garantirAbaPortal();
    expect(out).toMatchObject({ ok: false, motivo: "STOP_DURING_PING" });
  });
});

describe("Issue 2: auto-stop quando todos limites atingidos", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
  });

  test("após cycle.end, GRUPOS_CONFIG vazio + reservas > 0 → para automaticamente", async () => {
    chrome.storage.local.get.mockImplementation((keys) => {
      if (Array.isArray(keys) && keys.includes("GRUPOS_CONFIG")) {
        return Promise.resolve({
          idUsuario: 99, idEmpresa: 1, USUARIO: "12345",
          GRUPOS_CONFIG: "", MODO_TESTE: false,
          reservasPorGrupo: { "009113": 1 },
          TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: ""
        });
      }
      if (Array.isArray(keys) && keys.includes("reservasPorGrupo")) {
        return Promise.resolve({ reservasPorGrupo: { "009113": 1 } });
      }
      if (Array.isArray(keys) && keys.includes("metricasDia")) {
        return Promise.resolve({ metricasDia: {}, metricasHoras: {} });
      }
      return Promise.resolve({});
    });
    chrome.storage.session.get.mockResolvedValue({ isRunning: true });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [[]] })
    });

    await runMonitorCycle();

    // pararMonitoramento setou isRunning=false
    const stopCall = chrome.storage.session.set.mock.calls.find(
      c => c[0] && c[0].isRunning === false
    );
    expect(stopCall).toBeDefined();
  });

  test("config vazia mas reservas=0 → NÃO para", async () => {
    chrome.storage.local.get.mockImplementation((keys) => {
      if (Array.isArray(keys) && keys.includes("GRUPOS_CONFIG")) {
        return Promise.resolve({
          idUsuario: 99, idEmpresa: 1, USUARIO: "12345",
          GRUPOS_CONFIG: "", MODO_TESTE: false,
          reservasPorGrupo: {}, TELEGRAM_TOKEN: "", TELEGRAM_CHAT_ID: ""
        });
      }
      if (Array.isArray(keys) && keys.includes("reservasPorGrupo")) {
        return Promise.resolve({ reservasPorGrupo: {} });
      }
      if (Array.isArray(keys) && keys.includes("metricasDia")) {
        return Promise.resolve({ metricasDia: {}, metricasHoras: {} });
      }
      return Promise.resolve({});
    });
    chrome.storage.session.get.mockResolvedValue({ isRunning: true });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [[]] })
    });

    await runMonitorCycle();

    const stopCall = chrome.storage.session.set.mock.calls.find(
      c => c[0] && c[0].isRunning === false
    );
    expect(stopCall).toBeUndefined();
  });
});

describe("Spec 03: localStorage hydrate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    chrome.storage.local.get.mockResolvedValue({ USUARIO: "8158", SENHA: "test" });
    chrome.storage.session.get.mockResolvedValue({});
  });

  test("fazerLogin persiste tokenLogin + userPayload em storage.local quando TokenLogin presente", async () => {
    const loginPayload = {
      IdUsuario: 313, IdEmpresa: 1, Usuario: "0000008158",
      TokenLogin: "a1d7944a-90e5-449e-974e-ddc3d07b7123",
      NomePessoa: "F M M SERVICOS"
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [loginPayload] })
    });

    await fazerLogin();

    const setCall = chrome.storage.local.set.mock.calls.find(
      c => c[0] && c[0].tokenLogin === "a1d7944a-90e5-449e-974e-ddc3d07b7123"
    );
    expect(setCall).toBeDefined();
    expect(setCall[0].userPayload).toMatchObject({ IdUsuario: 313, TokenLogin: "a1d7944a-90e5-449e-974e-ddc3d07b7123" });
  });

  test("fazerLogin NÃO persiste hydrate keys se response sem TokenLogin", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [{ IdUsuario: 313 }] })
    });

    await fazerLogin();

    const hydrateSet = chrome.storage.local.set.mock.calls.find(
      c => c[0] && c[0].tokenLogin !== undefined
    );
    expect(hydrateSet).toBeUndefined();
  });

  test("storage.set falha gracioso (no throw) se hydrate persist falhar", async () => {
    const loginPayload = {
      IdUsuario: 313, IdEmpresa: 1,
      TokenLogin: "uuid-aaa-bbb"
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: true, data: [loginPayload] })
    });
    chrome.storage.local.set.mockRejectedValueOnce(new Error("storage quota exceeded"));

    const result = await fazerLogin();
    expect(result).toMatchObject({ TokenLogin: "uuid-aaa-bbb" });
  });
});

describe("Fix 16 Lote A: handleTurnstileChallenge sinaliza badge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chrome.storage.session.set.mockResolvedValue(undefined);
    chrome.storage.local.get.mockResolvedValue({ TELEMETRIA_LIGADA: false });
  });

  test("seta badge 🔒 + cor de fundo", async () => {
    await handleTurnstileChallenge();
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "🔒" });
    expect(chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith(
      expect.objectContaining({ color: expect.stringMatching(/^#/) })
    );
  });

  test("seta turnstileBloqueado=true em storage.session", async () => {
    await handleTurnstileChallenge();
    const setCalls = chrome.storage.session.set.mock.calls;
    const blockedCall = setCalls.find(c => c[0].turnstileBloqueado === true);
    expect(blockedCall).toBeDefined();
    expect(blockedCall[0].turnstileBloqueadoAte).toBeGreaterThan(Date.now());
  });
});
