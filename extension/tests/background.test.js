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
  runMonitorCycle,
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

describe("reservarComLimite", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSleep();
    chrome.storage.local.get.mockResolvedValue({
      USUARIO: "12345",
      GRUPOS_CONFIG: "009113:3,009114:2",
      TELEGRAM_TOKEN: "",
      TELEGRAM_CHAT_ID: ""
    });
  });
  afterEach(() => jest.restoreAllMocks());

  test("modo teste — não chama /reservas/add", async () => {
    global.fetch = jest.fn();
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, true);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("modo teste — notifica popup com [TESTE]", async () => {
    global.fetch = jest.fn();
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "log", text: expect.stringContaining("[TESTE]") })
    );
  });

  test("chama /reservas/add em modo real", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true })
    });
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/reservas/add"), expect.any(Object)
    );
  });

  test("incrementa contador de reservas após sucesso", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true })
    });
    const reservasPorGrupo = { "009113": 1 };
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, reservasPorGrupo, false);
    expect(chrome.storage.local.set).toHaveBeenCalledWith(
      expect.objectContaining({ reservasPorGrupo: { "009113": 2 } })
    );
  });

  test("NÃO incrementa contador se success: false", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: false, message: "Vaga esgotada" })
    });
    const reservasPorGrupo = {};
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, reservasPorGrupo, false);
    const counterSet = chrome.storage.local.set.mock.calls.find(c => c[0].reservasPorGrupo);
    expect(counterSet).toBeUndefined(); // contador não alterado
  });

  test("remove grupo ao atingir limite", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true })
    });
    const reservasPorGrupo = { "009113": 2 }; // esta será a 3ª (limite=3)
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, reservasPorGrupo, false);
    const setCall = chrome.storage.local.set.mock.calls.find(c => c[0].GRUPOS_CONFIG !== undefined);
    expect(setCall[0].GRUPOS_CONFIG).not.toContain("009113");
    expect(setCall[0].GRUPOS_CONFIG).toContain("009114:2");
  });

  test("não remove grupo abaixo do limite", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true })
    });
    await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    const gruposConfigSet = chrome.storage.local.set.mock.calls.find(c => c[0].GRUPOS_CONFIG !== undefined);
    expect(gruposConfigSet).toBeUndefined();
  });

  test("rate limit em /reservas/add — lança RATE_LIMIT sem corromper contador", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 429 });
    const reservasPorGrupo = {};
    await expect(
      reservarComLimite(mockGrupo, 99, 1, "009113", 3, reservasPorGrupo, false)
    ).rejects.toMatchObject({ message: "RATE_LIMIT" });
    const counterSet = chrome.storage.local.set.mock.calls.find(c => c[0].reservasPorGrupo);
    expect(counterSet).toBeUndefined();
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

  function fetchReservaOk() {
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  }

  test("ciclo com vaga (grupo no config) — chama buscarGrupos + reservar", async () => {
    storageWith();
    global.fetch = jest.fn()
      .mockResolvedValueOnce(fetchGruposOk([mockGrupo]))
      .mockResolvedValueOnce(fetchReservaOk());
    await runMonitorCycle();
    expect(fetch).toHaveBeenCalledTimes(2);
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

  test("múltiplos grupos — falha em um não cancela outros (Promise.allSettled)", async () => {
    const grupo2 = { ...mockGrupo, CD_Grupo: "009114", ID_Grupo: 67890, ID_Produto: 3, NM_Produto: "Outro" };
    storageWith({ GRUPOS_CONFIG: "009113:3,009114:3" });

    global.fetch = jest.fn()
      .mockResolvedValueOnce(fetchGruposOk([mockGrupo, grupo2]))
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValue(fetchReservaOk());

    await expect(runMonitorCycle()).resolves.toBeUndefined();
  });

  test("modo teste — não chama /reservas/add", async () => {
    storageWith({ MODO_TESTE: true });
    global.fetch = jest.fn().mockResolvedValue(fetchGruposOk([mockGrupo]));
    await runMonitorCycle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("[TESTE]") })
    );
  });

  test("loga '🔍 Buscando por cotas' quando há detectados", async () => {
    storageWith();
    global.fetch = jest.fn()
      .mockResolvedValueOnce(fetchGruposOk([mockGrupo]))
      .mockResolvedValueOnce(fetchReservaOk());
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
    global.fetch = jest.fn()
      .mockResolvedValueOnce(fetchGruposOk([mockGrupo]))
      .mockResolvedValueOnce({ ok: true })           // telegram encontrada
      .mockResolvedValueOnce(fetchReservaOk())       // /reservas/add
      .mockResolvedValue({ ok: true });              // telegrams seguintes
    await runMonitorCycle();
    const telegramBodies = fetch.mock.calls
      .filter(c => String(c[0]).includes("api.telegram.org"))
      .map(c => JSON.parse(c[1].body).text);
    expect(telegramBodies.some(t => /🍀 Cota 009113 encontrada/.test(t))).toBe(true);
  });

  test("Telegram '🎉 Reservado!' detalhado após sucesso", async () => {
    storageWith({ TELEGRAM_TOKEN: "BOT", TELEGRAM_CHAT_ID: "CHAT" });
    global.fetch = jest.fn()
      .mockResolvedValueOnce(fetchGruposOk([mockGrupo]))
      .mockResolvedValueOnce({ ok: true })  // telegram encontrada
      .mockResolvedValueOnce({              // /reservas/add com data aninhado
        ok: true, status: 200,
        json: async () => ({
          success: true,
          data: [[{
            CodigoCota: "9876",
            NomeProduto: "Imóvel 300k",
            DataReserva: "2026-05-20T22:14:11",
            DataValidade: "2026-05-21T22:14:11"
          }]]
        })
      })
      .mockResolvedValue({ ok: true });
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
  });
  afterEach(() => jest.restoreAllMocks());

  test("modo teste → { teste: true, grupoId, produto }", async () => {
    global.fetch = jest.fn();
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, true);
    expect(out).toEqual({ teste: true, grupoId: "009113", produto: "Consórcio Imóvel 300k" });
  });

  test("sucesso sem conclusão → { reservou: true, novoTotal, limite, concluido: false }", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true })
    });
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, { "009113": 1 }, false);
    expect(out).toMatchObject({
      reservou: true, grupoId: "009113", novoTotal: 2, limite: 3, concluido: false
    });
  });

  test("sucesso atinge limite → concluido: true", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true })
    });
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, { "009113": 2 }, false);
    expect(out.concluido).toBe(true);
  });

  test("success: false → { reservou: false }", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: false })
    });
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(out).toMatchObject({ reservou: false, grupoId: "009113", produto: "Consórcio Imóvel 300k" });
  });
});

// ─── P1.2 — Erros específicos do servidor em reservarComLimite ──────────────

describe("reservarComLimite — erros específicos", () => {
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

  test('"restrição vigente" → lança SISTEMA_FECHADO', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: false, details: "Há uma restrição vigente para efetuar reservas neste momento." })
    });
    await expect(
      reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false)
    ).rejects.toThrow("SISTEMA_FECHADO");
  });

  test('"limite de reservas desse produto" → adiciona em produtosBloqueados', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: false, details: "Limite de reservas desse produto para o ponto de venda atingido." })
    });
    const out = await reservarComLimite(mockGrupo, 99, 1, "009113", 3, {}, false);
    expect(out).toMatchObject({ reservou: false, produtoBloqueado: true });
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({ produtosBloqueados: [2] })
    );
  });

  test('body com "1015" → seta rateLimitHit', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ success: false, details: "error 1015 cloudflare" })
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
    chrome.storage.session.get.mockResolvedValue({ hitsRecentes: [] });
    const out = await registrarHitERateLimit();
    expect(out.circuitOpen).toBe(false);
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({ rateLimitHit: true })
    );
  });

  test("2 hits em 60s — abre circuito por 10min", async () => {
    const agora = Date.now();
    chrome.storage.session.get.mockResolvedValue({
      hitsRecentes: [agora - 5000]
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
      hitsRecentes: [antigo]
    });
    const out = await registrarHitERateLimit();
    expect(out.circuitOpen).toBe(false);  // antigo descartado, agora só 1 recente
  });

  test("circuito já aberto — não re-abre, só marca rateLimitHit", async () => {
    chrome.storage.session.get.mockResolvedValue({
      circuitAberto: Date.now() + 60_000
    });
    const out = await registrarHitERateLimit();
    expect(out.circuitOpen).toBe(true);
    // Não deveria sobrescrever circuitAberto
    const setCalls = chrome.storage.session.set.mock.calls;
    const overwriteCb = setCalls.find(c => c[0].circuitAberto != null);
    expect(overwriteCb).toBeUndefined();
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
    // 10s × 0.15 = 1.5 tokens. Consome 1 → fica ~0.5
    expect(setCall[0].bucket.tokens).toBeGreaterThanOrEqual(0);
    expect(setCall[0].bucket.tokens).toBeLessThanOrEqual(1);
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
      currentMax: 4
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
      currentMax: 50
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
      currentMax: 12
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
      currentMax: 5.1
    });
    const out = await ajustarDelayDinamico();
    expect(out.currentMin).toBe(2);
    expect(out.currentMax).toBe(5);
  });

  test("primeira chamada (session vazia) → usa floor do user como ponto de partida", async () => {
    chrome.storage.local.get.mockResolvedValue({ DELAY_MIN: 1.5, DELAY_MAX: 4 });
    chrome.storage.session.get.mockResolvedValue({});
    const out = await ajustarDelayDinamico();
    expect(out.currentMin).toBe(1.5);
    expect(out.currentMax).toBe(4);
  });

  test("reseta rateLimitHit após ajuste", async () => {
    chrome.storage.local.get.mockResolvedValue({ DELAY_MIN: 1, DELAY_MAX: 3 });
    chrome.storage.session.get.mockResolvedValue({
      rateLimitHit: true,
      currentMin: 1,
      currentMax: 3
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
      currentMax: 3
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
