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
    }
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
  }
};
