/**
 * Modal handlers mirror the chat-input handlers but reach the user via
 * the panel's "Submit code" button. We don't re-test every branch (the
 * chat-input verify/code tests already cover the logic); these are the
 * shape contracts: validateUmnEmail gate, OTP service call, response
 * pattern.
 */
const modals = require('../../handlers/modals');
const {
  createMockModalInteraction,
  createMockMember,
  createMockDeps,
} = require('../factories/interaction');

describe('umn_verify_email_modal', () => {
  test('non-UMN email -> rejected, no OTP call', async () => {
    const interaction = createMockModalInteraction({
      customId: 'umn_verify_email_modal',
      fieldValues: { umn_email: 'a@gmail.com' },
    });
    const deps = createMockDeps({ validateUmnEmail: jest.fn(() => ({ valid: false })) });
    await modals.handleEmailModal(interaction, deps);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('@umn.edu') }),
    );
    expect(deps.postToOtpService).not.toHaveBeenCalled();
  });

  test('happy path -> POST /send + "Code sent" editReply', async () => {
    const interaction = createMockModalInteraction({
      customId: 'umn_verify_email_modal',
      fieldValues: { umn_email: 'a@umn.edu' },
    });
    const deps = createMockDeps();
    await modals.handleEmailModal(interaction, deps);
    expect(deps.postToOtpService).toHaveBeenCalledWith('/send', expect.any(Object));
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Code sent') }),
    );
  });

  test('email collision -> generic message, no OTP call', async () => {
    const interaction = createMockModalInteraction({
      customId: 'umn_verify_email_modal',
      fieldValues: { umn_email: 'a@umn.edu' },
    });
    const deps = createMockDeps({
      dbOverrides: { getByEmailHmac: jest.fn(() => ({})) },
    });
    await modals.handleEmailModal(interaction, deps);
    expect(deps.postToOtpService).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('If that email is eligible'),
    );
  });

  test('guild present but unconfigured -> "not configured" reply', async () => {
    const interaction = createMockModalInteraction({
      customId: 'umn_verify_email_modal',
      fieldValues: { umn_email: 'a@umn.edu' },
    });
    const deps = createMockDeps({
      dbOverrides: { getGuildConfig: jest.fn(() => null) },
    });
    await modals.handleEmailModal(interaction, deps);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("hasn't been configured") }),
    );
  });

  test('already-verified user with same email -> friendly success reply', async () => {
    const interaction = createMockModalInteraction({
      customId: 'umn_verify_email_modal',
      fieldValues: { umn_email: 'a@umn.edu' },
    });
    interaction.guild.members.fetch = jest
      .fn()
      .mockResolvedValue({ roles: { add: jest.fn().mockResolvedValue() } });
    const deps = createMockDeps({
      dbOverrides: {
        getByDiscordId: jest.fn(() => ({ email_hmac: 'hmac:a@umn.edu' })),
      },
    });
    await modals.handleEmailModal(interaction, deps);
    expect(deps.postToOtpService).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('verified before') }),
    );
  });

  test('already-verified with different stored hmac -> "different address" reply', async () => {
    const interaction = createMockModalInteraction({
      customId: 'umn_verify_email_modal',
      fieldValues: { umn_email: 'b@umn.edu' },
    });
    const deps = createMockDeps({
      dbOverrides: {
        getByDiscordId: jest.fn(() => ({ email_hmac: 'hmac:a@umn.edu' })),
      },
    });
    await modals.handleEmailModal(interaction, deps);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('different address'),
      }),
    );
    expect(deps.postToOtpService).not.toHaveBeenCalled();
  });

  test('OTP service rate-limited -> editReply rate-limited message', async () => {
    const interaction = createMockModalInteraction({
      customId: 'umn_verify_email_modal',
      fieldValues: { umn_email: 'a@umn.edu' },
    });
    const deps = createMockDeps({
      postToOtpService: jest
        .fn()
        .mockResolvedValue({ json: async () => ({ ok: false, reason: 'rate_limited' }) }),
    });
    await modals.handleEmailModal(interaction, deps);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Too many attempts') }),
    );
  });

  test('OTP service throws -> editReply send-failure', async () => {
    const interaction = createMockModalInteraction({
      customId: 'umn_verify_email_modal',
      fieldValues: { umn_email: 'a@umn.edu' },
    });
    const deps = createMockDeps({
      postToOtpService: jest.fn().mockRejectedValue(new Error('econn')),
    });
    await modals.handleEmailModal(interaction, deps);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Failed to send email') }),
    );
  });
});

describe('umn_verify_code_modal', () => {
  test('correct code -> addVerifiedHmac + role grant + success reply', async () => {
    const interaction = createMockModalInteraction({
      customId: 'umn_verify_code_modal',
      fieldValues: { umn_code: '123456' },
    });
    const member = createMockMember();
    interaction.guild.members.fetch = jest.fn().mockResolvedValue(member);
    const deps = createMockDeps({
      postToOtpService: jest
        .fn()
        .mockResolvedValue({ json: async () => ({ ok: true, email: 'a@umn.edu' }) }),
    });
    await modals.handleCodeModal(interaction, deps);
    expect(deps.db.addVerifiedHmac).toHaveBeenCalled();
    expect(deps.applyGuildVerificationRoles).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Verified! Welcome') }),
    );
  });

  test('wrong code -> wrong-code reply', async () => {
    const interaction = createMockModalInteraction({
      customId: 'umn_verify_code_modal',
      fieldValues: { umn_code: '999999' },
    });
    const deps = createMockDeps({
      postToOtpService: jest
        .fn()
        .mockResolvedValue({ json: async () => ({ ok: false, reason: 'wrong_code' }) }),
    });
    await modals.handleCodeModal(interaction, deps);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Wrong code') }),
    );
  });

  test('already-verified -> "already verified" reply, no OTP call', async () => {
    const interaction = createMockModalInteraction({
      customId: 'umn_verify_code_modal',
      fieldValues: { umn_code: '123456' },
    });
    interaction.guild.members.fetch = jest
      .fn()
      .mockResolvedValue({ roles: { add: jest.fn().mockResolvedValue() } });
    const deps = createMockDeps({
      dbOverrides: { isVerified: jest.fn(() => true) },
    });
    await modals.handleCodeModal(interaction, deps);
    expect(deps.postToOtpService).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already verified') }),
    );
  });

  test('no guild_config -> "not configured" message, no OTP call', async () => {
    const interaction = createMockModalInteraction({
      customId: 'umn_verify_code_modal',
      fieldValues: { umn_code: '123456' },
    });
    const deps = createMockDeps({
      dbOverrides: { getGuildConfig: jest.fn(() => null) },
    });
    await modals.handleCodeModal(interaction, deps);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("hasn't been configured") }),
    );
    expect(deps.postToOtpService).not.toHaveBeenCalled();
  });
});
