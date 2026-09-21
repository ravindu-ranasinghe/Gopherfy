const code = require('../../handlers/code');
const {
  createMockChatInputInteraction,
  createMockMember,
  createMockDeps,
} = require('../factories/interaction');

function makeInteraction({ digits = '123456', ...rest } = {}) {
  return createMockChatInputInteraction({
    commandName: 'code',
    options: { digits },
    ...rest,
  });
}

describe('/code handler', () => {
  test('correct code -> addVerifiedHmac, role granted, success reply', async () => {
    const member = createMockMember();
    const interaction = makeInteraction();
    interaction.guild.members.fetch = jest.fn().mockResolvedValue(member);

    const deps = createMockDeps({
      postToOtpService: jest
        .fn()
        .mockResolvedValue({ json: async () => ({ ok: true, email: 'a@umn.edu' }) }),
    });
    await code.handle(interaction, deps);
    expect(deps.db.addVerifiedHmac).toHaveBeenCalledWith('user1', 'hmac:a@umn.edu', 'a@umn.edu');
    expect(deps.applyGuildVerificationRoles).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Verified! Welcome') }),
    );
  });

  test('wrong code -> "Wrong code" reply', async () => {
    const interaction = makeInteraction();
    const deps = createMockDeps({
      postToOtpService: jest
        .fn()
        .mockResolvedValue({ json: async () => ({ ok: false, reason: 'wrong_code' }) }),
    });
    await code.handle(interaction, deps);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Wrong code') }),
    );
    expect(deps.db.addVerifiedHmac).not.toHaveBeenCalled();
  });

  test('expired -> "Code expired"', async () => {
    const interaction = makeInteraction();
    const deps = createMockDeps({
      postToOtpService: jest
        .fn()
        .mockResolvedValue({ json: async () => ({ ok: false, reason: 'expired' }) }),
    });
    await code.handle(interaction, deps);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('expired') }),
    );
  });

  test('too_many_attempts -> dedicated message', async () => {
    const interaction = makeInteraction();
    const deps = createMockDeps({
      postToOtpService: jest
        .fn()
        .mockResolvedValue({ json: async () => ({ ok: false, reason: 'too_many_attempts' }) }),
    });
    await code.handle(interaction, deps);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Too many wrong codes') }),
    );
  });

  test('role assignment fails -> "Verified but role failed"', async () => {
    const member = createMockMember();
    const interaction = makeInteraction();
    interaction.guild.members.fetch = jest.fn().mockResolvedValue(member);

    const deps = createMockDeps({
      postToOtpService: jest
        .fn()
        .mockResolvedValue({ json: async () => ({ ok: true, email: 'a@umn.edu' }) }),
      applyGuildVerificationRoles: jest.fn().mockRejectedValue(new Error('forbidden')),
    });
    await code.handle(interaction, deps);
    expect(deps.db.addVerifiedHmac).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('role assignment failed'),
      }),
    );
  });

  test('user not in guild -> fallback message', async () => {
    const interaction = makeInteraction();
    interaction.guild.members.fetch = jest.fn().mockResolvedValue(null);

    const deps = createMockDeps({
      postToOtpService: jest
        .fn()
        .mockResolvedValue({ json: async () => ({ ok: true, email: 'a@umn.edu' }) }),
    });
    await code.handle(interaction, deps);
    expect(deps.db.addVerifiedHmac).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('could not fetch your member record'),
      }),
    );
  });

  test('OTP service unreachable -> dedicated message', async () => {
    const interaction = makeInteraction();
    const deps = createMockDeps({
      postToOtpService: jest.fn().mockRejectedValue(new Error('econnrefused')),
    });
    await code.handle(interaction, deps);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('Failed to reach') }),
    );
  });

  test('already-verified (per db.isVerified) short-circuits OTP call', async () => {
    const member = createMockMember();
    const interaction = makeInteraction();
    interaction.guild.members.fetch = jest.fn().mockResolvedValue(member);

    const deps = createMockDeps({
      dbOverrides: { isVerified: jest.fn(() => true) },
    });
    await code.handle(interaction, deps);
    expect(deps.postToOtpService).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already verified') }),
    );
  });
});
