/**
 * /forget-me handler suite -- replaces the dispatcher-based
 * forget-me.test.js. Data-layer assertions for deletion_audit live in
 * src/bot/__tests__/db.deletion-audit.test.js.
 */
const forgetMe = require('../../handlers/forget-me');
const buttons = require('../../handlers/buttons');
const {
  createMockChatInputInteraction,
  createMockButtonInteraction,
  createMockDeps,
} = require('../factories/interaction');

describe('/forget-me chat handler', () => {
  test('shows confirmation buttons; nothing deleted up front', async () => {
    const interaction = createMockChatInputInteraction({ commandName: 'forget-me' });
    const deps = createMockDeps();
    await forgetMe.handle(interaction, deps);
    const arg = interaction.reply.mock.calls[0][0];
    expect(arg.content).toMatch(/are you sure/i);
    expect(arg.components).toBeDefined();
    expect(deps.db.deleteVerified).not.toHaveBeenCalled();
    expect(deps.db.insertDeletionAudit).not.toHaveBeenCalled();
  });
});

describe('forget_me_confirm button', () => {
  function buildGuildsCache(guildIds) {
    const map = new Map();
    for (const id of guildIds) {
      const member = { roles: { remove: jest.fn().mockResolvedValue() } };
      const guild = {
        id,
        members: { fetch: jest.fn().mockResolvedValue(member) },
        _member: member,
      };
      map.set(id, guild);
    }
    return map;
  }

  test('deletes row, audits, removes role per guild, edits reply', async () => {
    const cache = buildGuildsCache(['g1']);
    const deps = createMockDeps({
      client: { guilds: { cache } },
      dbOverrides: {
        getGuildConfig: jest.fn((gid) => (gid === 'g1' ? { verified_role_id: 'role-g1' } : null)),
      },
    });

    const interaction = createMockButtonInteraction({ customId: 'forget_me_confirm' });
    await buttons.handleForgetMeConfirm(interaction, deps);

    expect(deps.db.deleteVerified).toHaveBeenCalledWith('user1');
    expect(deps.db.insertDeletionAudit).toHaveBeenCalledWith('user1', 'user_request');
    const g1 = cache.get('g1');
    expect(g1.members.fetch).toHaveBeenCalledWith('user1');
    expect(g1._member.roles.remove).toHaveBeenCalledWith('role-g1');
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('has been deleted'),
        components: [],
      }),
    );
  });

  test('one guild failing does not abort the rest', async () => {
    const goodMember = { roles: { remove: jest.fn().mockResolvedValue() } };
    const cache = new Map([
      [
        'gBad',
        {
          id: 'gBad',
          members: { fetch: jest.fn().mockRejectedValue(new Error('500')) },
        },
      ],
      [
        'gGood',
        {
          id: 'gGood',
          members: { fetch: jest.fn().mockResolvedValue(goodMember) },
        },
      ],
    ]);
    const deps = createMockDeps({
      client: { guilds: { cache } },
      dbOverrides: {
        getGuildConfig: jest.fn(() => ({ verified_role_id: 'r' })),
      },
    });

    const interaction = createMockButtonInteraction({ customId: 'forget_me_confirm' });
    await buttons.handleForgetMeConfirm(interaction, deps);

    expect(deps.db.deleteVerified).toHaveBeenCalled();
    expect(deps.db.insertDeletionAudit).toHaveBeenCalled();
    expect(goodMember.roles.remove).toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalled();
  });
});

describe('forget_me_cancel button', () => {
  test('does not delete; edits reply to "Cancelled."', async () => {
    const deps = createMockDeps();
    const interaction = createMockButtonInteraction({ customId: 'forget_me_cancel' });
    await buttons.handleForgetMeCancel(interaction, deps);
    expect(deps.db.deleteVerified).not.toHaveBeenCalled();
    expect(deps.db.insertDeletionAudit).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith({ content: 'Cancelled.', components: [] });
  });
});
