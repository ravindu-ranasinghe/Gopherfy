/**
 * /forget-me tests.
 *
 * Mirrors the structure of whois.test.js: data-layer assertions against
 * a :memory: SQLite, plus handler-shape tests that load the bot's
 * dispatcher with mocked discord.js + ./db.
 */
const path = require('path');
const Database = require('better-sqlite3');

const { runMigrations } = require('../../lib/migrations');

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'migrations');

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  return db;
}

describe('deletion_audit data layer', () => {
  test('insert + retrieve preserves shape', () => {
    const db = freshDb();
    const insert = db.prepare(
      'INSERT INTO deletion_audit (subject_id, reason, deleted_at) VALUES (?, ?, ?)',
    );
    insert.run('user1', 'user_request', 1_700_000_000_000);
    const rows = db.prepare('SELECT * FROM deletion_audit').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject_id: 'user1',
      reason: 'user_request',
      deleted_at: 1_700_000_000_000,
    });
  });

  test('subject index exists', () => {
    const db = freshDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='deletion_audit'")
      .all()
      .map((r) => r.name);
    expect(idx).toContain('idx_deletion_audit_subject');
  });
});

// ---- handler-shape tests ----

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

function loadBotWithMocks(dbMock, { guildsCache = new Map() } = {}) {
  let interactionHandler;
  let guildDeleteHandler;
  let guildMemberRemoveHandler;
  jest.doMock('discord.js', () => {
    class Builder {
      // covers ActionRow, Button, Modal, Embed, TextInput.
      setCustomId() {
        return this;
      }
      setLabel() {
        return this;
      }
      setStyle() {
        return this;
      }
      setColor() {
        return this;
      }
      setTitle() {
        return this;
      }
      setDescription() {
        return this;
      }
      addComponents() {
        return this;
      }
      setRequired() {
        return this;
      }
      setMinLength() {
        return this;
      }
      setMaxLength() {
        return this;
      }
    }
    return {
      ActionRowBuilder: Builder,
      ActivityType: { Watching: 3 },
      ButtonBuilder: Builder,
      ButtonStyle: { Primary: 1, Secondary: 2, Danger: 4 },
      Client: class {
        constructor() {
          this.user = { tag: 't', setPresence: () => {} };
          this.guilds = { cache: guildsCache };
        }
        once() {}
        on(event, h) {
          if (event === 'interactionCreate') interactionHandler = h;
          if (event === 'guildDelete') guildDeleteHandler = h;
          if (event === 'guildMemberRemove') guildMemberRemoveHandler = h;
        }
        login() {}
      },
      Colors: { DarkRed: 0 },
      EmbedBuilder: Builder,
      GatewayIntentBits: { Guilds: 1, GuildMembers: 2 },
      MessageFlags: { Ephemeral: 64 },
      ModalBuilder: Builder,
      TextInputBuilder: Builder,
      TextInputStyle: { Short: 1 },
    };
  });
  jest.doMock('dotenv', () => ({ config: () => {} }));
  jest.doMock('../db', () => dbMock);
  require('../index');
  return { interactionHandler, guildDeleteHandler, guildMemberRemoveHandler };
}

function makeDbMock(overrides = {}) {
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
    whoisCanLookup: jest.fn(() => ({ allowed: true })),
    whoisCommitLookup: jest.fn(),
    insertWhoisAudit: jest.fn(),
    getRecentWhoisByGuild: jest.fn(() => []),
    insertDeletionAudit: jest.fn(),
    ...overrides,
  };
}

describe('/forget-me chat-input handler', () => {
  test('shows confirmation buttons (no deletion happens up front)', async () => {
    const dbMock = makeDbMock();
    const { interactionHandler } = loadBotWithMocks(dbMock);
    const reply = jest.fn().mockResolvedValue();
    await interactionHandler({
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      commandName: 'forget-me',
      user: { id: 'user1' },
      guild: { id: 'guild1', members: { fetch: jest.fn() } },
      memberPermissions: { has: () => true },
      options: { getUser: () => null, getString: () => null, getRole: () => null },
      reply,
    });
    expect(reply).toHaveBeenCalled();
    const arg = reply.mock.calls[0][0];
    expect(arg.content).toMatch(/are you sure/i);
    expect(arg.components).toBeDefined();
    expect(dbMock.deleteVerified).not.toHaveBeenCalled();
    expect(dbMock.insertDeletionAudit).not.toHaveBeenCalled();
  });

  test('forget-me works without guild_config (DM-safe)', async () => {
    const dbMock = makeDbMock({ getGuildConfig: jest.fn(() => null) });
    const { interactionHandler } = loadBotWithMocks(dbMock);
    const reply = jest.fn().mockResolvedValue();
    await interactionHandler({
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      commandName: 'forget-me',
      user: { id: 'user1' },
      guild: { id: 'guild1', members: { fetch: jest.fn() } },
      memberPermissions: { has: () => true },
      options: { getUser: () => null, getString: () => null, getRole: () => null },
      reply,
    });
    expect(reply).toHaveBeenCalled();
    expect(reply.mock.calls[0][0].content).toMatch(/are you sure/i);
  });
});

describe('forget_me_confirm button', () => {
  test('deletes verified row, audits, removes role per guild, edits reply', async () => {
    const role = { remove: jest.fn().mockResolvedValue() };
    const member = { roles: role };
    const guild1 = {
      id: 'g1',
      members: { fetch: jest.fn().mockResolvedValue(member) },
    };
    const guildsCache = new Map([['g1', guild1]]);

    const dbMock = makeDbMock({
      getGuildConfig: jest.fn((gid) => (gid === 'g1' ? { verified_role_id: 'role-g1' } : null)),
    });
    const { interactionHandler } = loadBotWithMocks(dbMock, { guildsCache });

    const update = jest.fn().mockResolvedValue();
    await interactionHandler({
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      customId: 'forget_me_confirm',
      user: { id: 'user1' },
      update,
    });

    expect(dbMock.deleteVerified).toHaveBeenCalledWith('user1');
    expect(dbMock.insertDeletionAudit).toHaveBeenCalledWith('user1', 'user_request');
    expect(guild1.members.fetch).toHaveBeenCalledWith('user1');
    expect(role.remove).toHaveBeenCalledWith('role-g1');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('has been deleted'),
        components: [],
      }),
    );
  });

  test('one guild failing does not abort the rest', async () => {
    const goodMember = { roles: { remove: jest.fn().mockResolvedValue() } };
    const guildBad = {
      id: 'gBad',
      members: { fetch: jest.fn().mockRejectedValue(new Error('500')) },
    };
    const guildGood = {
      id: 'gGood',
      members: { fetch: jest.fn().mockResolvedValue(goodMember) },
    };
    const guildsCache = new Map([
      ['gBad', guildBad],
      ['gGood', guildGood],
    ]);

    const dbMock = makeDbMock({
      getGuildConfig: jest.fn(() => ({ verified_role_id: 'r' })),
    });
    const { interactionHandler } = loadBotWithMocks(dbMock, { guildsCache });

    const update = jest.fn().mockResolvedValue();
    await interactionHandler({
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      customId: 'forget_me_confirm',
      user: { id: 'user1' },
      update,
    });
    expect(dbMock.deleteVerified).toHaveBeenCalled();
    expect(dbMock.insertDeletionAudit).toHaveBeenCalled();
    expect(goodMember.roles.remove).toHaveBeenCalled();
    expect(update).toHaveBeenCalled();
  });
});

describe('forget_me_cancel button', () => {
  test('does not delete; edits reply to "Cancelled."', async () => {
    const dbMock = makeDbMock();
    const { interactionHandler } = loadBotWithMocks(dbMock);
    const update = jest.fn().mockResolvedValue();
    await interactionHandler({
      isChatInputCommand: () => false,
      isButton: () => true,
      isModalSubmit: () => false,
      customId: 'forget_me_cancel',
      user: { id: 'user1' },
      update,
    });
    expect(dbMock.deleteVerified).not.toHaveBeenCalled();
    expect(dbMock.insertDeletionAudit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ content: 'Cancelled.', components: [] });
  });
});

describe('guildDelete listener', () => {
  test('deletes guild_config and never touches verified_users', async () => {
    const dbMock = makeDbMock();
    const { guildDeleteHandler } = loadBotWithMocks(dbMock);
    expect(typeof guildDeleteHandler).toBe('function');
    await guildDeleteHandler({ id: 'gZ' });
    expect(dbMock.deleteGuildConfig).toHaveBeenCalledWith('gZ');
    expect(dbMock.deleteVerified).not.toHaveBeenCalled();
    expect(dbMock.insertDeletionAudit).not.toHaveBeenCalled();
  });
});

describe('guildMemberRemove listener', () => {
  test('does NOT delete the verified record (info-only)', async () => {
    const dbMock = makeDbMock();
    const { guildMemberRemoveHandler } = loadBotWithMocks(dbMock);
    expect(typeof guildMemberRemoveHandler).toBe('function');
    await guildMemberRemoveHandler({ id: 'user1', guild: { id: 'g1' } });
    expect(dbMock.deleteVerified).not.toHaveBeenCalled();
    expect(dbMock.insertDeletionAudit).not.toHaveBeenCalled();
  });
});
