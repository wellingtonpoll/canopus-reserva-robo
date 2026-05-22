global.chrome = {
  storage: {
    local: {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined)
    },
    session: {
      get: jest.fn().mockResolvedValue({}),
      set: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn().mockResolvedValue(undefined)
    },
    onChanged: { addListener: jest.fn() }
  },
  alarms: {
    create: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
    onAlarm: { addListener: jest.fn() }
  },
  runtime: {
    sendMessage: jest.fn().mockResolvedValue(undefined),
    onMessage: { addListener: jest.fn() },
    onInstalled: { addListener: jest.fn() }
  },
  tabs: {
    query: jest.fn().mockResolvedValue([]),
    sendMessage: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue({ id: 1, url: "https://parceiros.consorciocanopus.com.br/apps/reservas", status: "complete" }),
    onRemoved: { addListener: jest.fn() },
    onUpdated: {
      addListener: jest.fn((cb) => {
        // Default mock: dispara complete imediatamente pra desbloquear espera nos testes
        setImmediate(() => cb(1, { status: "complete" }, { id: 1, url: "https://parceiros.consorciocanopus.com.br/apps/reservas", status: "complete" }));
      }),
      removeListener: jest.fn()
    }
  },
  windows: {
    update: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue({ id: 999, tabs: [{ id: 998 }] })
  },
  scripting: {
    executeScript: jest.fn().mockResolvedValue([])
  },
  sidePanel: {
    setPanelBehavior: jest.fn().mockResolvedValue(undefined)
  },
  action: {
    setBadgeText: jest.fn().mockResolvedValue(undefined),
    setBadgeBackgroundColor: jest.fn().mockResolvedValue(undefined)
  }
};
