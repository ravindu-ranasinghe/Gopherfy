const verify = require('../../handlers/verify');
const {
  createMockChatInputInteraction,
  createMockMember,
  createMockDeps,
} = require('../factories/interaction');

function makeInteraction({ email, ...rest } = {}) {
  return createMockChatInputInteraction({
    commandName: 'verify',
    options: { email: email ?? null },
    ...rest,
  });
}

describe('/verify handler', () => {
  test('already-verified user (no email arg) -> friendly message, no OTP send', async () => {
    const member = createMockMember();
    const interaction = makeInteraction();
    interaction.guild.members.fetch = jest.fn().mockResolvedValue(member);

    const deps = createMockDeps({
      dbOverrides: {
        getByDiscordId: jest.fn(() => ({ email_hmac: 'hmac:a@umn.edu' })),
      },
    });
    await verify.handle(interaction, deps);
    expect(deps.postToOtpService).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('verified before') }),
    );
  });

  test('already-verified with mismatched email -> "different address" message', async () => {
    const interaction = makeInteraction({ email: 'b@umn.edu' });

    const deps = createMockDeps({
      dbOverrides: {
        getByDiscordId: jest.fn(() => ({ email_hmac: 'hmac:a@umn.edu' })),
        hashEmail: jest.fn((e) => `hmac:${e}`),
      },
    });
    await verify.handle(interaction, deps);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('different address'),
      }),
    );
    expect(deps.postToOtpService).not.toHaveBeenCalled();
  });

  test('non-UMN email -> rejected, no OTP service call', async () => {
    const interaction = makeInteraction({ email: 'a@gmail.com' });
    const deps = createMockDeps({
      validateUmnEmail: jest.fn(() => ({ valid: false, reason: 'not_umn' })),
    });
    await verify.handle(interaction, deps);
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('@umn.edu') }),
    );
    expect(deps.postToOtpService).not.toHaveBeenCalled();
  });

  test('email collision -> generic success, no OTP service call', async () => {
    const interaction = makeInteraction({ email: 'a@umn.edu' });
    const deps = createMockDeps({
      dbOverrides: {
        getByEmailHmac: jest.fn(() => ({ discord_id: 'someoneelse' })),
      },
    });
    await verify.handle(interaction, deps);
    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('If that email is eligible'),
    );
    expect(deps.postToOtpService).not.toHaveBeenCalled();
  });

  test('happy path -> POST /send + ok message', async () => {
    const interaction = makeInteraction({ email: 'a@umn.edu' });
    const deps = createMockDeps();
    await verify.handle(interaction, deps);
    expect(deps.postToOtpService).toHaveBeenCalledWith('/send', {
      discordId: 'user1',
      email: 'a@umn.edu',
    });
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('If that email is eligible'),
    );
  });

  test('OTP service rate_limited -> "too many attempts"', async () => {
    const interaction = makeInteraction({ email: 'a@umn.edu' });
    const deps = createMockDeps({
      postToOtpService: jest
        .fn()
        .mockResolvedValue({ json: async () => ({ ok: false, reason: 'rate_limited' }) }),
    });
    await verify.handle(interaction, deps);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Too many attempts'),
    );
  });

  test('OTP service unreachable -> "failed to send email"', async () => {
    const interaction = makeInteraction({ email: 'a@umn.edu' });
    const deps = createMockDeps({
      postToOtpService: jest.fn().mockRejectedValue(new Error('network')),
    });
    await verify.handle(interaction, deps);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('Failed to send email'),
    );
  });
});
