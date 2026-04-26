/**
 * Tests for the non-interaction listeners registered by src/bot/index.js
 * (guildDelete, guildMemberRemove). Loads the bot module under
 * jest.isolateModules with mocked discord.js so we can capture the
 * registered callbacks without booting a real client.
 */
let originalEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.DISCORD_TOKEN = 'x'.repeat(40);
  process.env.OTP_SERVICE_KEY = 'y'.repeat(40);
  process.env.OTP_HMAC_KEY = 'z'.repeat(40);
  jest.resetModules();
});
afterEach(() => {
  process.env = originalEnv;
});

function loadBotWithMocks(dbMock) {
  const handlers = {};
  jest.doMock('discord.js', () => ({
    ActivityType: { Watching: 3 },
    Client: class {
      constructor() {
        this.user = { tag: 't', setPresence: () => {} };
        this.guilds = { cache: new Map() };
      }
      once() {}
      on(event, h) {
        handlers[event] = h;
      }
      login() {}
    },
    GatewayIntentBits: { Guilds: 1, GuildMembers: 2 },
  }));
  jest.doMock('dotenv', () => ({ config: () => {} }));
  jest.doMock('../db', () => dbMock);
  jest.doMock('../handlers', () => ({ dispatch: jest.fn() }));
  require('../index');
  return handlers;
}

function makeDbMock() {
  return {
    isVerified: jest.fn(() => false),
    getByEmailHmac: jest.fn(),
    getByDiscordId: jest.fn(),
    addVerifiedHmac: jest.fn(),
    deleteVerified: jest.fn(),
    getGuildConfig: jest.fn(() => ({ verified_role_id: 'role1' })),
    setGuildConfig: jest.fn(),
    deleteGuildConfig: jest.fn(),
    hashEmail: jest.fn(),
    insertDeletionAudit: jest.fn(),
  };
}

describe('guildDelete listener', () => {
  test('deletes guild_config and never touches verified_users', async () => {
    const dbMock = makeDbMock();
    const handlers = loadBotWithMocks(dbMock);
    expect(typeof handlers.guildDelete).toBe('function');
    await handlers.guildDelete({ id: 'gZ' });
    expect(dbMock.deleteGuildConfig).toHaveBeenCalledWith('gZ');
    expect(dbMock.deleteVerified).not.toHaveBeenCalled();
    expect(dbMock.insertDeletionAudit).not.toHaveBeenCalled();
  });
});

describe('guildMemberRemove listener', () => {
  test('does NOT delete the verified record (info-only)', async () => {
    const dbMock = makeDbMock();
    const handlers = loadBotWithMocks(dbMock);
    expect(typeof handlers.guildMemberRemove).toBe('function');
    await handlers.guildMemberRemove({ id: 'user1', guild: { id: 'g1' } });
    expect(dbMock.deleteVerified).not.toHaveBeenCalled();
    expect(dbMock.insertDeletionAudit).not.toHaveBeenCalled();
  });
});
