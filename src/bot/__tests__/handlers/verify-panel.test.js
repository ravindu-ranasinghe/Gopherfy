const verifyPanel = require('../../handlers/verify-panel');
const { createMockChatInputInteraction, createMockDeps } = require('../factories/interaction');

describe('/verify-panel handler', () => {
  test('rejects callers without ManageGuild', async () => {
    const interaction = createMockChatInputInteraction({
      commandName: 'verify-panel',
      permissions: [],
    });
    await verifyPanel.handle(interaction, createMockDeps());
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('do not have permission') }),
    );
  });

  test('happy path returns embed + components', async () => {
    const interaction = createMockChatInputInteraction({
      commandName: 'verify-panel',
      permissions: ['ManageGuild'],
    });
    await verifyPanel.handle(interaction, createMockDeps());
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.any(Array),
        components: expect.any(Array),
      }),
    );
  });
});
