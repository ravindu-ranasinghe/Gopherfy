const setup = require('../../handlers/setup');
const { createMockChatInputInteraction, createMockDeps } = require('../factories/interaction');

/**
 * The shared factory's guild stub has no memberCount and its bot member has
 * no permissions, both of which the grandfather path reads. Override the
 * whole guild for those cases.
 */
function grandfatherGuild({ manageRoles = true, memberCount = 412 } = {}) {
  return {
    id: 'guild1',
    memberCount,
    members: {
      fetch: jest.fn(),
      fetchMe: jest.fn().mockResolvedValue({
        roles: { highest: { position: 100 } },
        permissions: { has: jest.fn(() => manageRoles) },
      }),
    },
  };
}

describe('/setup handler', () => {
  test('non-administrator is rejected', async () => {
    const interaction = createMockChatInputInteraction({
      commandName: 'setup',
      options: { 'verified-role': { id: 'r1', position: 1 } },
      permissions: [],
    });
    const deps = createMockDeps();
    await setup.handle(interaction, deps);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('administrators') }),
    );
    expect(deps.db.setGuildConfig).not.toHaveBeenCalled();
  });

  test('rejects when verified role >= bot highest role position', async () => {
    const interaction = createMockChatInputInteraction({
      commandName: 'setup',
      options: { 'verified-role': { id: 'r1', position: 200 } },
      permissions: ['Administrator'],
    });
    const deps = createMockDeps();
    await setup.handle(interaction, deps);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("bot's role") }),
    );
    expect(deps.db.setGuildConfig).not.toHaveBeenCalled();
  });

  test('happy path -> setGuildConfig called, success reply', async () => {
    const interaction = createMockChatInputInteraction({
      commandName: 'setup',
      options: { 'verified-role': { id: 'r1', position: 1 } },
      permissions: ['Administrator'],
    });
    const deps = createMockDeps();
    await setup.handle(interaction, deps);
    expect(deps.db.setGuildConfig).toHaveBeenCalledWith('guild1', 'r1', 'r1');
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Setup complete') }),
    );
  });
});

describe('/setup role-all-members flag', () => {
  test('flag omitted -> success reply carries no buttons', async () => {
    const interaction = createMockChatInputInteraction({
      commandName: 'setup',
      options: { 'verified-role': { id: 'r1', position: 1 } },
      permissions: ['Administrator'],
    });
    const deps = createMockDeps();
    await setup.handle(interaction, deps);

    expect(deps.db.setGuildConfig).toHaveBeenCalledWith('guild1', 'r1', 'r1');
    const arg = interaction.editReply.mock.calls[0][0];
    expect(arg.content).toContain('Setup complete');
    expect(arg.components).toBeUndefined();
  });

  test('flag true -> success reply carries confirm/cancel buttons and the member count', async () => {
    const interaction = createMockChatInputInteraction({
      commandName: 'setup',
      options: { 'verified-role': { id: 'r1', position: 1 }, 'role-all-members': true },
      permissions: ['Administrator'],
      guildOverrides: grandfatherGuild({ memberCount: 412 }),
    });
    const deps = createMockDeps();
    await setup.handle(interaction, deps);

    expect(deps.db.setGuildConfig).toHaveBeenCalledWith('guild1', 'r1', 'r1');
    const arg = interaction.editReply.mock.calls[0][0];
    expect(arg.content).toContain('Setup complete');
    expect(arg.content).toContain('~412 existing members');
    expect(arg.content).toContain('not be added to the verified database');
    const ids = arg.components[0].components.map((c) => c.data.custom_id);
    expect(ids).toEqual(['grandfather_confirm', 'grandfather_cancel']);
  });

  test('flag true but bot lacks ManageRoles -> no buttons, says the backfill cannot run', async () => {
    const interaction = createMockChatInputInteraction({
      commandName: 'setup',
      options: { 'verified-role': { id: 'r1', position: 1 }, 'role-all-members': true },
      permissions: ['Administrator'],
      guildOverrides: grandfatherGuild({ manageRoles: false }),
    });
    const deps = createMockDeps();
    await setup.handle(interaction, deps);

    expect(deps.db.setGuildConfig).toHaveBeenCalledWith('guild1', 'r1', 'r1');
    const arg = interaction.editReply.mock.calls[0][0];
    expect(arg.content).toContain('Setup complete');
    expect(arg.content).toMatch(/Manage Roles/);
    expect(arg.components).toBeUndefined();
  });
});
