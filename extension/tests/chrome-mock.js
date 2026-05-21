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
    update: jest.fn().mockResolvedValue(undefined)
  },
  windows: {
    update: jest.fn().mockResolvedValue(undefined)
  },
  scripting: {
    executeScript: jest.fn().mockResolvedValue([])
  },
  sidePanel: {
    setPanelBehavior: jest.fn().mockResolvedValue(undefined)
  }
};
