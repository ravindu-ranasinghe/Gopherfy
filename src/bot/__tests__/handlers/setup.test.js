const setup = require('../../handlers/setup');
const { createMockChatInputInteraction, createMockDeps } = require('../factories/interaction');

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
    expect(interaction.reply).toHaveBeenCalledWith(
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
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Setup complete') }),
    );
  });
});
