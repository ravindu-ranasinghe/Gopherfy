/**
 * Dispatcher branching: guild-config gate vs the bypass commands,
 * fallthrough on unknown commandName/customId.
 */
const handlers = require('../../handlers');
const {
  createMockChatInputInteraction,
  createMockButtonInteraction,
  createMockDeps,
} = require('../factories/interaction');

describe('dispatch()', () => {
  test('rejects chat command in unconfigured guild with the gate message', async () => {
    const interaction = createMockChatInputInteraction({
      commandName: 'verify',
      options: { email: 'a@umn.edu' },
    });
    const deps = createMockDeps({
      dbOverrides: { getGuildConfig: jest.fn(() => null) },
    });
    await handlers.dispatch(interaction, deps);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("hasn't been configured"),
      }),
    );
  });

  test('/setup bypasses the configured-guild gate', async () => {
    const interaction = createMockChatInputInteraction({
      commandName: 'setup',
      permissions: ['Administrator'],
      options: { 'verified-role': { id: 'r1', position: 1 } },
    });
    const deps = createMockDeps({
      dbOverrides: { getGuildConfig: jest.fn(() => null) },
    });
    await handlers.dispatch(interaction, deps);
    expect(deps.db.setGuildConfig).toHaveBeenCalled();
  });

  test('/forget-me bypasses the configured-guild gate', async () => {
    const interaction = createMockChatInputInteraction({ commandName: 'forget-me' });
    const deps = createMockDeps({
      dbOverrides: { getGuildConfig: jest.fn(() => null) },
    });
    await handlers.dispatch(interaction, deps);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringMatching(/are you sure/i) }),
    );
  });

  test('unknown command falls through silently', async () => {
    const interaction = createMockChatInputInteraction({ commandName: 'totally-unknown' });
    const deps = createMockDeps();
    await handlers.dispatch(interaction, deps);
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  test('unknown button customId falls through silently', async () => {
    const interaction = createMockButtonInteraction({ customId: 'no-such-button' });
    const deps = createMockDeps();
    await handlers.dispatch(interaction, deps);
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});
