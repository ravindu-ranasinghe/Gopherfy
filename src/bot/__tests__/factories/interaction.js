/**
 * Mock factories for discord.js interaction objects.
 *
 * Hand-rolled because discord.js does not ship a mock library. Each
 * factory returns an object that:
 *   - passes the relevant isChatInputCommand/isButton/isModalSubmit
 *     type guards by stubbing them as functions returning the right
 *     boolean,
 *   - exposes jest.fn() for every Discord-side action the handlers
 *     might call (reply, deferReply, editReply, showModal, update),
 *   - lets the test override the user, guild, options, fields, and
 *     permissions per call.
 */

function buildPermissions(permissions = []) {
  return { has: (p) => permissions.includes(p) };
}

function buildOptions(values = {}) {
  return {
    getString: jest.fn((name) => values[name] ?? null),
    getUser: jest.fn((name) => values[name] ?? null),
    getRole: jest.fn((name) => values[name] ?? null),
    getInteger: jest.fn((name) => values[name] ?? null),
    getBoolean: jest.fn((name) => values[name] ?? null),
  };
}

function buildBaseInteraction({
  userId = 'user1',
  guildId = 'guild1',
  guildOverrides,
  permissions = [],
  isRepliable = true,
} = {}) {
  const guild = guildOverrides ?? {
    id: guildId,
    members: {
      fetch: jest.fn(),
      fetchMe: jest.fn().mockResolvedValue({
        roles: { highest: { position: 100 } },
      }),
    },
  };

  return {
    user: { id: userId },
    guild,
    memberPermissions: buildPermissions(permissions),
    replied: false,
    deferred: false,
    reply: jest.fn().mockResolvedValue(),
    deferReply: jest.fn().mockResolvedValue(),
    deferUpdate: jest.fn().mockResolvedValue(),
    editReply: jest.fn().mockResolvedValue(),
    update: jest.fn().mockResolvedValue(),
    showModal: jest.fn().mockResolvedValue(),
    isRepliable: () => isRepliable,
    isChatInputCommand: () => false,
    isButton: () => false,
    isModalSubmit: () => false,
  };
}

function createMockChatInputInteraction({ commandName, options = {}, ...rest } = {}) {
  const base = buildBaseInteraction(rest);
  return {
    ...base,
    commandName,
    options: buildOptions(options),
    isChatInputCommand: () => true,
  };
}

function createMockButtonInteraction({ customId, ...rest } = {}) {
  const base = buildBaseInteraction(rest);
  return {
    ...base,
    customId,
    isButton: () => true,
  };
}

function createMockModalInteraction({ customId, fieldValues = {}, ...rest } = {}) {
  const base = buildBaseInteraction(rest);
  return {
    ...base,
    customId,
    fields: {
      getTextInputValue: jest.fn((name) => fieldValues[name] ?? ''),
    },
    isModalSubmit: () => true,
  };
}

function createMockMember({ rolesArr = [], remove = jest.fn().mockResolvedValue() } = {}) {
  return {
    roles: {
      add: jest.fn().mockResolvedValue(),
      remove,
      cache: rolesArr,
    },
  };
}

function createMockGuild({
  id = 'guild1',
  members = { fetch: jest.fn() },
  ownerId = 'owner',
} = {}) {
  return { id, members, ownerId };
}

function createMockDb(overrides = {}) {
  return {
    isVerified: jest.fn(() => false),
    getByEmailHmac: jest.fn(() => null),
    getByDiscordId: jest.fn(() => null),
    addVerifiedHmac: jest.fn(),
    deleteVerified: jest.fn(),
    getGuildConfig: jest.fn(() => ({ verified_role_id: 'role1' })),
    setGuildConfig: jest.fn(),
    deleteGuildConfig: jest.fn(),
    hashEmail: jest.fn((email) => `hmac:${email}`),
    whoisCanLookup: jest.fn(() => ({ allowed: true })),
    whoisCommitLookup: jest.fn(),
    insertWhoisAudit: jest.fn(),
    getRecentWhoisByGuild: jest.fn(() => []),
    insertDeletionAudit: jest.fn(),
    ...overrides,
  };
}

function createSilentLogger() {
  const child = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  child.child = () => child;
  return child;
}

function createMockDeps(overrides = {}) {
  return {
    db: overrides.db ?? createMockDb(overrides.dbOverrides),
    log: overrides.log ?? createSilentLogger(),
    client: overrides.client ?? { guilds: { cache: new Map() } },
    postToOtpService:
      overrides.postToOtpService ??
      jest.fn().mockResolvedValue({ json: async () => ({ ok: true }) }),
    applyGuildVerificationRoles:
      overrides.applyGuildVerificationRoles ?? jest.fn().mockResolvedValue(),
    validateUmnEmail: overrides.validateUmnEmail ?? jest.fn(() => ({ valid: true })),
    normalizeEmail: overrides.normalizeEmail ?? jest.fn((e) => (e ?? '').toLowerCase().trim()),
  };
}

module.exports = {
  createMockChatInputInteraction,
  createMockButtonInteraction,
  createMockModalInteraction,
  createMockMember,
  createMockGuild,
  createMockDb,
  createMockDeps,
  createSilentLogger,
};
