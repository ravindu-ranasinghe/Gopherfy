/**
 * /whois + /whois-audit unit tests.
 *
 * The bot's interactionCreate dispatcher is one giant function in
 * src/bot/index.js (Prompt 15 will extract handlers). Until then we test
 * the data-layer primitives the handler depends on (audit insert, mod
 * rate limit, recent-by-guild aggregation) against a :memory: SQLite
 * with the migrations folder applied. The handler-shape contract
 * (permission gates, response strings) is covered by a thin
 * jest.isolateModules harness that exercises the `whois` branch with
 * mocked discord.js interactions.
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

// Recreate just the prepared statements + helpers under test, against the
// per-test in-memory DB. This mirrors src/bot/db.js exactly so we don't
// have to spin up a file-backed verified.db for unit tests.
function makeWhoisLayer(db, { now: clockNow = () => Date.now() } = {}) {
  const stmtInsertWhoisAudit = db.prepare(
    'INSERT INTO whois_audit (actor_id, target_id, guild_id, looked_up_at) VALUES (?, ?, ?, ?)',
  );
  const stmtRecentByGuild = db.prepare(
    `SELECT actor_id, COUNT(*) AS lookups, MAX(looked_up_at) AS most_recent
       FROM whois_audit
      WHERE guild_id = ?
      GROUP BY actor_id
      ORDER BY most_recent DESC
      LIMIT ?`,
  );
  const stmtGetCounter = db.prepare('SELECT * FROM otp_send_counter WHERE scope_key = ?');
  const stmtResetCounter = db.prepare(
    `INSERT INTO otp_send_counter (scope_key, count, reset_at)
       VALUES (@scopeKey, 1, @resetAt)
     ON CONFLICT(scope_key) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
  );
  const stmtIncrementCounter = db.prepare(
    `INSERT INTO otp_send_counter (scope_key, count, reset_at)
       VALUES (@scopeKey, 1, @resetAt)
     ON CONFLICT(scope_key) DO UPDATE SET count = count + 1`,
  );

  const WINDOW_MS = 60 * 60 * 1000;
  const LIMIT = 30;

  function whoisCanLookup(actorId, { limit = LIMIT } = {}) {
    const now = clockNow();
    const row = stmtGetCounter.get(`whois:${actorId}`);
    if (!row || row.reset_at <= now) return { allowed: true };
    if (row.count >= limit) return { allowed: false, retryAfterMs: row.reset_at - now };
    return { allowed: true };
  }

  function whoisCommitLookup(actorId, { windowMs = WINDOW_MS } = {}) {
    const now = clockNow();
    const scopeKey = `whois:${actorId}`;
    const existing = stmtGetCounter.get(scopeKey);
    if (!existing || existing.reset_at <= now) {
      stmtResetCounter.run({ scopeKey, resetAt: now + windowMs });
    } else {
      stmtIncrementCounter.run({ scopeKey, resetAt: existing.reset_at });
    }
  }

  function insertWhoisAudit(actorId, targetId, guildId) {
    return stmtInsertWhoisAudit.run(actorId, targetId, guildId, clockNow());
  }

  function getRecentWhoisByGuild(guildId, limit = 25) {
    return stmtRecentByGuild.all(guildId, limit);
  }

  return { whoisCanLookup, whoisCommitLookup, insertWhoisAudit, getRecentWhoisByGuild };
}

describe('/whois data layer (audit + rate limit)', () => {
  test('insertWhoisAudit persists a row with the right shape', () => {
    const db = freshDb();
    const layer = makeWhoisLayer(db);
    layer.insertWhoisAudit('mod1', 'target1', 'guild1');
    const rows = db.prepare('SELECT * FROM whois_audit').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_id: 'mod1',
      target_id: 'target1',
      guild_id: 'guild1',
    });
    expect(typeof rows[0].looked_up_at).toBe('number');
    expect(rows[0].looked_up_at).toBeGreaterThan(0);
  });

  test('getRecentWhoisByGuild groups by actor and sorts by most-recent desc', () => {
    const db = freshDb();
    let now = 1_700_000_000_000;
    const layer = makeWhoisLayer(db, { now: () => now });

    layer.insertWhoisAudit('modA', 't1', 'g1');
    now += 1000;
    layer.insertWhoisAudit('modA', 't2', 'g1');
    now += 1000;
    layer.insertWhoisAudit('modB', 't3', 'g1');
    // a different guild's lookups must not bleed in:
    now += 1000;
    layer.insertWhoisAudit('modA', 't4', 'g2');

    const rows = layer.getRecentWhoisByGuild('g1', 25);
    expect(rows).toHaveLength(2);
    // modB's last lookup is most recent in g1, so it leads.
    expect(rows[0].actor_id).toBe('modB');
    expect(rows[0].lookups).toBe(1);
    expect(rows[1].actor_id).toBe('modA');
    expect(rows[1].lookups).toBe(2);
  });

  test('rate limit allows up to LIMIT lookups, blocks the next, with sane retryAfterMs', () => {
    const db = freshDb();
    let now = 1_700_000_000_000;
    const layer = makeWhoisLayer(db, { now: () => now });

    for (let i = 0; i < 30; i++) {
      const gate = layer.whoisCanLookup('modA');
      expect(gate.allowed).toBe(true);
      layer.whoisCommitLookup('modA');
      now += 100;
    }

    const blocked = layer.whoisCanLookup('modA');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  test('rate limit is per-actor: a different mod is unaffected', () => {
    const db = freshDb();
    const layer = makeWhoisLayer(db);
    for (let i = 0; i < 30; i++) layer.whoisCommitLookup('modA');
    expect(layer.whoisCanLookup('modA').allowed).toBe(false);
    expect(layer.whoisCanLookup('modB').allowed).toBe(true);
  });

  test('window resets when reset_at has passed', () => {
    const db = freshDb();
    let now = 1_700_000_000_000;
    const layer = makeWhoisLayer(db, { now: () => now });
    for (let i = 0; i < 30; i++) layer.whoisCommitLookup('modA');
    expect(layer.whoisCanLookup('modA').allowed).toBe(false);
    now += 60 * 60 * 1000 + 1;
    expect(layer.whoisCanLookup('modA').allowed).toBe(true);
  });
});

// Handler-level test: load src/bot/index.js with mocked ./db, mocked
// dotenv, and minimal env. We re-implement just enough of discord.js to
// drive the dispatcher, intercept interaction.reply, and assert.
describe('/whois handler responses', () => {
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

  function loadHandler(dbMock) {
    let interactionHandler;
    jest.doMock('discord.js', () => ({
      ActionRowBuilder: class {
        addComponents() {
          return this;
        }
      },
      ActivityType: { Watching: 3 },
      ButtonBuilder: class {
        setCustomId() {
          return this;
        }
        setLabel() {
          return this;
        }
        setStyle() {
          return this;
        }
      },
      ButtonStyle: { Primary: 1, Secondary: 2 },
      Client: class {
        constructor() {
          this.user = { tag: 'TestBot#0000', setPresence: () => {} };
        }
        once() {}
        on(event, handler) {
          if (event === 'interactionCreate') interactionHandler = handler;
        }
        login() {}
      },
      Colors: { DarkRed: 0 },
      EmbedBuilder: class {
        setColor() {
          return this;
        }
        setTitle() {
          return this;
        }
        setDescription() {
          return this;
        }
      },
      GatewayIntentBits: { Guilds: 1, GuildMembers: 2 },
      MessageFlags: { Ephemeral: 64 },
      ModalBuilder: class {
        setCustomId() {
          return this;
        }
        setTitle() {
          return this;
        }
        addComponents() {
          return this;
        }
      },
      TextInputBuilder: class {
        setCustomId() {
          return this;
        }
        setLabel() {
          return this;
        }
        setStyle() {
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
      },
      TextInputStyle: { Short: 1 },
    }));
    jest.doMock('dotenv', () => ({ config: () => {} }));
    jest.doMock('../db', () => dbMock);
    require('../index');
    return interactionHandler;
  }

  function makeDbMock(overrides = {}) {
    return {
      isVerified: jest.fn(() => false),
      getByEmailHmac: jest.fn(() => null),
      getByDiscordId: jest.fn(() => null),
      addVerifiedHmac: jest.fn(),
      getGuildConfig: jest.fn(() => ({ verified_role_id: 'role1' })),
      setGuildConfig: jest.fn(),
      hashEmail: jest.fn(() => 'hmac'),
      whoisCanLookup: jest.fn(() => ({ allowed: true })),
      whoisCommitLookup: jest.fn(),
      insertWhoisAudit: jest.fn(),
      getRecentWhoisByGuild: jest.fn(() => []),
      ...overrides,
    };
  }

  function makeInteraction({
    permissions = ['ManageGuild'],
    targetId = 'target1',
    actorId = 'mod1',
    guildId = 'guild1',
  } = {}) {
    const reply = jest.fn().mockResolvedValue();
    const memberPermissions = {
      has: (p) => permissions.includes(p),
    };
    return {
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      commandName: 'whois',
      user: { id: actorId },
      guild: { id: guildId, members: { fetch: jest.fn() } },
      memberPermissions,
      options: {
        getUser: () => ({ id: targetId }),
        getString: () => null,
        getRole: () => null,
      },
      reply,
    };
  }

  test('denies callers without ManageGuild and without ModerateMembers', async () => {
    const dbMock = makeDbMock();
    const handler = loadHandler(dbMock);
    const interaction = makeInteraction({ permissions: [] });
    await handler(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('do not have permission'),
      }),
    );
    expect(dbMock.insertWhoisAudit).not.toHaveBeenCalled();
    expect(dbMock.whoisCommitLookup).not.toHaveBeenCalled();
  });

  test('allows callers with only ModerateMembers (defense in depth)', async () => {
    const dbMock = makeDbMock();
    const handler = loadHandler(dbMock);
    const interaction = makeInteraction({ permissions: ['ModerateMembers'] });
    await handler(interaction);
    expect(dbMock.insertWhoisAudit).toHaveBeenCalledWith('mod1', 'target1', 'guild1');
  });

  test('verified target → minimum-disclosure response, no email leaked', async () => {
    const dbMock = makeDbMock({
      getByDiscordId: jest.fn(() => ({ verified_at: 1_700_000_000_000 })),
    });
    const handler = loadHandler(dbMock);
    const interaction = makeInteraction();
    await handler(interaction);
    const arg = interaction.reply.mock.calls[0][0];
    expect(arg.content).toContain('✅ Verified');
    expect(arg.content).toContain('UMN affiliation confirmed');
    expect(arg.content).not.toMatch(/@umn\.edu/i);
    expect(arg.content).not.toMatch(/email:/i);
  });

  test('unverified target → not-verified response', async () => {
    const dbMock = makeDbMock({ getByDiscordId: jest.fn(() => null) });
    const handler = loadHandler(dbMock);
    const interaction = makeInteraction();
    await handler(interaction);
    const arg = interaction.reply.mock.calls[0][0];
    expect(arg.content).toContain('Not verified');
    expect(dbMock.insertWhoisAudit).toHaveBeenCalled();
  });

  test('audit row inserted with correct actor, target, guild', async () => {
    const dbMock = makeDbMock({
      getByDiscordId: jest.fn(() => ({ verified_at: 1_700_000_000_000 })),
    });
    const handler = loadHandler(dbMock);
    const interaction = makeInteraction({
      actorId: 'modX',
      targetId: 'targetY',
      guildId: 'guildZ',
    });
    await handler(interaction);
    expect(dbMock.insertWhoisAudit).toHaveBeenCalledWith('modX', 'targetY', 'guildZ');
    expect(dbMock.whoisCommitLookup).toHaveBeenCalledWith('modX');
  });

  test('rate-limit gate blocks before any audit insert', async () => {
    const dbMock = makeDbMock({
      whoisCanLookup: jest.fn(() => ({ allowed: false, retryAfterMs: 1000 })),
    });
    const handler = loadHandler(dbMock);
    const interaction = makeInteraction();
    await handler(interaction);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Lookup limit'),
      }),
    );
    expect(dbMock.insertWhoisAudit).not.toHaveBeenCalled();
    expect(dbMock.whoisCommitLookup).not.toHaveBeenCalled();
  });
});

describe('/whois-audit handler', () => {
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

  function loadAndDispatch(commandName, dbMock, interactionOverrides = {}) {
    let handler;
    jest.doMock('discord.js', () => ({
      ActionRowBuilder: class {
        addComponents() {
          return this;
        }
      },
      ActivityType: { Watching: 3 },
      ButtonBuilder: class {},
      ButtonStyle: {},
      Client: class {
        constructor() {
          this.user = { tag: 't', setPresence: () => {} };
        }
        once() {}
        on(event, h) {
          if (event === 'interactionCreate') handler = h;
        }
        login() {}
      },
      Colors: { DarkRed: 0 },
      EmbedBuilder: class {},
      GatewayIntentBits: { Guilds: 1, GuildMembers: 2 },
      MessageFlags: { Ephemeral: 64 },
      ModalBuilder: class {},
      TextInputBuilder: class {},
      TextInputStyle: { Short: 1 },
    }));
    jest.doMock('dotenv', () => ({ config: () => {} }));
    jest.doMock('../db', () => dbMock);
    require('../index');
    const reply = jest.fn().mockResolvedValue();
    const interaction = {
      isChatInputCommand: () => true,
      isButton: () => false,
      isModalSubmit: () => false,
      commandName,
      user: { id: 'mod1' },
      guild: { id: 'guild1', members: { fetch: jest.fn() } },
      memberPermissions: { has: (p) => p === 'ManageGuild' },
      options: { getUser: () => null, getString: () => null, getRole: () => null },
      reply,
      ...interactionOverrides,
    };
    return { dispatch: () => handler(interaction), reply };
  }

  test('lists recent activity grouped by actor', async () => {
    const dbMock = {
      isVerified: jest.fn(() => false),
      getByEmailHmac: jest.fn(),
      getByDiscordId: jest.fn(),
      addVerifiedHmac: jest.fn(),
      getGuildConfig: jest.fn(() => ({ verified_role_id: 'role1' })),
      setGuildConfig: jest.fn(),
      hashEmail: jest.fn(),
      whoisCanLookup: jest.fn(() => ({ allowed: true })),
      whoisCommitLookup: jest.fn(),
      insertWhoisAudit: jest.fn(),
      getRecentWhoisByGuild: jest.fn(() => [
        { actor_id: 'modA', lookups: 5, most_recent: 1_700_000_000_000 },
        { actor_id: 'modB', lookups: 1, most_recent: 1_699_999_000_000 },
      ]),
    };
    const { dispatch, reply } = loadAndDispatch('whois-audit', dbMock);
    await dispatch();
    const content = reply.mock.calls[0][0].content;
    expect(content).toContain('<@modA>');
    expect(content).toContain('5 lookups');
    expect(content).toContain('<@modB>');
    expect(content).toContain('1 lookup');
  });

  test('empty guild → no-activity message', async () => {
    const dbMock = {
      isVerified: jest.fn(() => false),
      getByEmailHmac: jest.fn(),
      getByDiscordId: jest.fn(),
      addVerifiedHmac: jest.fn(),
      getGuildConfig: jest.fn(() => ({ verified_role_id: 'role1' })),
      setGuildConfig: jest.fn(),
      hashEmail: jest.fn(),
      whoisCanLookup: jest.fn(() => ({ allowed: true })),
      whoisCommitLookup: jest.fn(),
      insertWhoisAudit: jest.fn(),
      getRecentWhoisByGuild: jest.fn(() => []),
    };
    const { dispatch, reply } = loadAndDispatch('whois-audit', dbMock);
    await dispatch();
    expect(reply.mock.calls[0][0].content).toContain('No /whois lookups');
  });

  test('non-admin caller is denied', async () => {
    const dbMock = {
      isVerified: jest.fn(() => false),
      getByEmailHmac: jest.fn(),
      getByDiscordId: jest.fn(),
      addVerifiedHmac: jest.fn(),
      getGuildConfig: jest.fn(() => ({ verified_role_id: 'role1' })),
      setGuildConfig: jest.fn(),
      hashEmail: jest.fn(),
      whoisCanLookup: jest.fn(() => ({ allowed: true })),
      whoisCommitLookup: jest.fn(),
      insertWhoisAudit: jest.fn(),
      getRecentWhoisByGuild: jest.fn(() => []),
    };
    const { dispatch, reply } = loadAndDispatch('whois-audit', dbMock, {
      memberPermissions: { has: () => false },
    });
    await dispatch();
    expect(reply.mock.calls[0][0].content).toContain('do not have permission');
    expect(dbMock.getRecentWhoisByGuild).not.toHaveBeenCalled();
  });
});
