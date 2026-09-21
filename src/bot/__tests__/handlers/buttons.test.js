/**
 * Smoke tests for the panel buttons (umn_verify_start,
 * umn_verify_code_prompt). Both just open a modal; we just confirm
 * showModal is called once. The grandfather_* pair below is the real
 * suite: it is a mass role grant behind a button anyone can click.
 */
// virtual: src/bot/grandfather.js is owned by another worker and may not be
// on disk yet; drop the flag once it lands.
jest.mock('../../grandfather', () => ({ grandfatherMembers: jest.fn() }), { virtual: true });

const buttons = require('../../handlers/buttons');
const { grandfatherMembers } = require('../../grandfather');
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

describe('grandfather_confirm button', () => {
  beforeEach(() => {
    grandfatherMembers.mockResolvedValue({ granted: 0, skipped: 0, failed: 0 });
  });

  test('non-administrator is refused and no backfill runs', async () => {
    const interaction = createMockButtonInteraction({
      customId: 'grandfather_confirm',
      permissions: [],
    });
    const deps = createMockDeps();
    await buttons.handleGrandfatherConfirm(interaction, deps);

    expect(grandfatherMembers).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('administrators') }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });

  test('missing guild config -> says so, no backfill', async () => {
    const interaction = createMockButtonInteraction({
      customId: 'grandfather_confirm',
      permissions: ['Administrator'],
    });
    const deps = createMockDeps({ dbOverrides: { getGuildConfig: jest.fn(() => null) } });
    await buttons.handleGrandfatherConfirm(interaction, deps);

    expect(grandfatherMembers).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('configuration is gone'),
        components: [],
      }),
    );
  });

  test('happy path -> backfills with the configured role and reports counts', async () => {
    grandfatherMembers.mockResolvedValue({ granted: 7, skipped: 2, failed: 1 });
    const interaction = createMockButtonInteraction({
      customId: 'grandfather_confirm',
      permissions: ['Administrator'],
    });
    const deps = createMockDeps({
      dbOverrides: { getGuildConfig: jest.fn(() => ({ verified_role_id: 'role-x' })) },
    });
    await buttons.handleGrandfatherConfirm(interaction, deps);

    expect(grandfatherMembers).toHaveBeenCalledWith(
      expect.objectContaining({ guild: interaction.guild, roleId: 'role-x' }),
    );
    // Buttons are cleared on the acknowledging edit so it cannot be run twice.
    expect(interaction.update).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
    const final = interaction.editReply.mock.calls.at(-1)[0];
    expect(final.content).toContain('granted 7');
    expect(final.content).toContain('skipped 2');
    expect(final.content).toContain('failed 1');
    // A grandfathered member is not a verified member.
    expect(deps.db.addVerifiedHmac).not.toHaveBeenCalled();
  });

  test('progress edits are throttled to roughly every 100 members', async () => {
    grandfatherMembers.mockImplementation(async ({ onProgress }) => {
      for (const processed of [25, 50, 100, 150, 200]) onProgress({ processed });
      return { granted: 200, skipped: 0, failed: 0 };
    });
    const interaction = createMockButtonInteraction({
      customId: 'grandfather_confirm',
      permissions: ['Administrator'],
    });
    await buttons.handleGrandfatherConfirm(interaction, createMockDeps());

    const progressEdits = interaction.editReply.mock.calls.filter(([arg]) =>
      arg.content.includes('processed'),
    );
    expect(progressEdits).toHaveLength(2);
  });

  test('an expired interaction token does not crash the handler', async () => {
    grandfatherMembers.mockImplementation(async ({ onProgress }) => {
      onProgress({ processed: 100 });
      return { granted: 1, skipped: 0, failed: 0 };
    });
    const interaction = createMockButtonInteraction({
      customId: 'grandfather_confirm',
      permissions: ['Administrator'],
    });
    interaction.editReply = jest.fn().mockRejectedValue(new Error('Unknown Webhook'));

    await expect(
      buttons.handleGrandfatherConfirm(interaction, createMockDeps()),
    ).resolves.toBeUndefined();
    expect(grandfatherMembers).toHaveBeenCalled();
  });
});

describe('grandfather_cancel button', () => {
  test('clears the components and runs no backfill', async () => {
    const interaction = createMockButtonInteraction({
      customId: 'grandfather_cancel',
      permissions: ['Administrator'],
    });
    await buttons.handleGrandfatherCancel(interaction, createMockDeps());

    expect(grandfatherMembers).not.toHaveBeenCalled();
    expect(interaction.update).toHaveBeenCalledWith({
      content: 'Cancelled. Setup is still complete.',
      components: [],
    });
  });
});
