const { MessageFlags } = require('discord.js');

/**
 * /code -- submit the 6-digit OTP. Hits the OTP service, then on
 * success persists the email_hmac and grants the verified role.
 */
async function handle(interaction, deps) {
  const { db, postToOtpService, applyGuildVerificationRoles } = deps;
  const userId = interaction.user.id;
  const guildConfig = db.getGuildConfig(interaction.guild.id);

  const input = interaction.options.getString('digits').trim();

  // Defer immediately — the OTP service HTTP round-trip + HMAC signing
  // easily exceeds Discord's 3-second initial-response deadline.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (db.isVerified(userId)) {
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) {
      return interaction.editReply({
        content:
          'You are already verified.\nCould not fetch your member record — contact a mod for roles.',
      });
    }
    try {
      await applyGuildVerificationRoles(member, guildConfig);
    } catch {
      return interaction.editReply({
        content: 'You are already verified.\nRole assignment failed — contact a mod.',
      });
    }
    return interaction.editReply({ content: 'You are already verified.' });
  }

  let data;
  try {
    const res = await postToOtpService('/verify', { discordId: userId, code: input });
    data = await res.json();
  } catch {
    return interaction.editReply({
      content: 'Failed to reach verification service. Try again later.',
    });
  }

  if (!data.ok) {
    const messages = {
      no_pending: 'No pending verification. Run `/verify` first.',
      expired: 'Code expired. Run `/verify` again.',
      wrong_code: 'Wrong code. Try again.',
      too_many_attempts: 'Too many wrong codes. Run `/verify` again to get a new code.',
    };
    return interaction.editReply({
      content: messages[data.reason] ?? 'Verification failed. Try again.',
    });
  }

  const { email } = data;
  db.addVerifiedHmac(userId, db.hashEmail(email));

  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  if (!member) {
    return interaction.editReply({
      content: 'Verified in DB but could not fetch your member record — contact a mod.',
    });
  }

  try {
    await applyGuildVerificationRoles(member, guildConfig);
  } catch {
    return interaction.editReply({
      content: 'Verified in DB but role assignment failed — contact a mod.',
    });
  }

  return interaction.editReply({ content: 'Verified! Welcome to the server.' });
}

module.exports = { handle };
