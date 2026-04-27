/**
 * Smoke tests for the panel buttons (umn_verify_start,
 * umn_verify_code_prompt). Both just open a modal; we just confirm
 * showModal is called once.
 */
const buttons = require('../../handlers/buttons');
const { createMockButtonInteraction, createMockDeps } = require('../factories/interaction');

describe('button handlers', () => {
  test('umn_verify_start shows the email-input modal', async () => {
    const interaction = createMockButtonInteraction({ customId: 'umn_verify_start' });
    await buttons.handleVerifyStart(interaction, createMockDeps());
    expect(interaction.showModal).toHaveBeenCalledTimes(1);
  });

  test('umn_verify_code_prompt shows the code-input modal', async () => {
    const interaction = createMockButtonInteraction({ customId: 'umn_verify_code_prompt' });
    await buttons.handleCodePrompt(interaction, createMockDeps());
    expect(interaction.showModal).toHaveBeenCalledTimes(1);
  });
});
