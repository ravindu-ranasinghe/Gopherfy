/**
 * Re-tests /whois against the extracted handler module. Replaces the
 * dispatcher-based whois.test.js file from Prompt 12; the data-layer
 * portion (audit insertion + per-actor rate limit semantics) lives in
 * src/bot/__tests__/db.whois.test.js.
 */
const whois = require('../../handlers/whois');
const whoisAudit = require('../../handlers/whois-audit');
const { createMockChatInputInteraction, createMockDeps } = require('../factories/interaction');

describe('/whois handler', () => {
  function makeInteraction(opts = {}) {
    const target = { id: opts.targetId ?? 'target1' };
    return createMockChatInputInteraction({
      commandName: 'whois',
      options: { user: target },
      permissions: opts.permissions ?? ['ManageGuild'],
      userId: opts.actorId ?? 'mod1',
      guildId: opts.guildId ?? 'guild1',
    });
  }

  test('denies callers without ManageGuild and without ModerateMembers', async () => {
    const interaction = makeInteraction({ permissions: [] });
    const deps = createMockDeps();
    await whois.handle(interaction, deps);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('do not have permission') }),
    );
    expect(deps.db.insertWhoisAudit).not.toHaveBeenCalled();
    expect(deps.db.whoisCommitLookup).not.toHaveBeenCalled();
  });

  test('ModerateMembers alone is sufficient (defense in depth)', async () => {
    const interaction = makeInteraction({ permissions: ['ModerateMembers'] });
    const deps = createMockDeps();
    await whois.handle(interaction, deps);
    expect(deps.db.insertWhoisAudit).toHaveBeenCalled();
  });

  test('verified target -> minimum-disclosure response, no email leaked', async () => {
    const interaction = makeInteraction();
    const deps = createMockDeps({
      dbOverrides: {
        getByDiscordId: jest.fn(() => ({ verified_at: 1_700_000_000_000 })),
      },
    });
    await whois.handle(interaction, deps);
    const arg = interaction.reply.mock.calls[0][0];
    expect(arg.content).toContain('Verified (UMN affiliation confirmed)');
    expect(arg.content).not.toMatch(/@umn\.edu/i);
  });

  test('unverified target -> not-verified response', async () => {
    const interaction = makeInteraction();
    const deps = createMockDeps();
    await whois.handle(interaction, deps);
    expect(interaction.reply.mock.calls[0][0].content).toContain('Not verified');
  });

  test('audit row inserted with correct actor/target/guild', async () => {
    const interaction = makeInteraction({
      actorId: 'modX',
      targetId: 'targetY',
      guildId: 'guildZ',
    });
    const deps = createMockDeps();
    await whois.handle(interaction, deps);
    expect(deps.db.insertWhoisAudit).toHaveBeenCalledWith('modX', 'targetY', 'guildZ');
    expect(deps.db.whoisCommitLookup).toHaveBeenCalledWith('modX');
  });

  test('rate limit blocks before any audit insert', async () => {
    const interaction = makeInteraction();
    const deps = createMockDeps({
      dbOverrides: {
        whoisCanLookup: jest.fn(() => ({ allowed: false, retryAfterMs: 1000 })),
      },
    });
    await whois.handle(interaction, deps);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Lookup limit') }),
    );
    expect(deps.db.insertWhoisAudit).not.toHaveBeenCalled();
    expect(deps.db.whoisCommitLookup).not.toHaveBeenCalled();
  });
});

describe('/whois-audit handler', () => {
  function makeInteraction(opts = {}) {
    return createMockChatInputInteraction({
      commandName: 'whois-audit',
      permissions: opts.permissions ?? ['ManageGuild'],
    });
  }

  test('lists recent activity grouped by actor', async () => {
    const interaction = makeInteraction();
    const deps = createMockDeps({
      dbOverrides: {
        getRecentWhoisByGuild: jest.fn(() => [
          { actor_id: 'modA', lookups: 5, most_recent: 1_700_000_000_000 },
          { actor_id: 'modB', lookups: 1, most_recent: 1_699_999_000_000 },
        ]),
      },
    });
    await whoisAudit.handle(interaction, deps);
    const content = interaction.reply.mock.calls[0][0].content;
    expect(content).toContain('<@modA>');
    expect(content).toContain('5 lookups');
    expect(content).toContain('<@modB>');
    expect(content).toContain('1 lookup');
  });

  test('empty guild -> no-activity message', async () => {
    const interaction = makeInteraction();
    const deps = createMockDeps();
    await whoisAudit.handle(interaction, deps);
    expect(interaction.reply.mock.calls[0][0].content).toContain('No /whois lookups');
  });

  test('non-admin caller is denied', async () => {
    const interaction = makeInteraction({ permissions: [] });
    const deps = createMockDeps();
    await whoisAudit.handle(interaction, deps);
    expect(interaction.reply.mock.calls[0][0].content).toContain('do not have permission');
    expect(deps.db.getRecentWhoisByGuild).not.toHaveBeenCalled();
  });
});
