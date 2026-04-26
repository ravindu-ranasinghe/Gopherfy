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

  if (db.isVerified(userId)) {
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) {
      return interaction.reply({
        content:
          'You are already verified.\nCould not fetch your member record — contact a mod for roles.',
        flags: MessageFlags.Ephemeral,
      });
    }
    try {
      await applyGuildVerificationRoles(member, guildConfig);
    } catch {
      return interaction.reply({
        content: 'You are already verified.\nRole assignment failed — contact a mod.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({
      content: 'You are already verified.',
      flags: MessageFlags.Ephemeral,
    });
  }

  let data;
  try {
    const res = await postToOtpService('/verify', { discordId: userId, code: input });
    data = await res.json();
  } catch {
    return interaction.reply({
      content: 'Failed to reach verification service. Try again later.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!data.ok) {
    const messages = {
      no_pending: 'No pending verification. Run `/verify` first.',
      expired: 'Code expired. Run `/verify` again.',
      wrong_code: 'Wrong code. Try again.',
      too_many_attempts: 'Too many wrong codes. Run `/verify` again to get a new code.',
    };
    return interaction.reply({
      content: messages[data.reason] ?? 'Verification failed. Try again.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const { email } = data;
  db.addVerifiedHmac(userId, db.hashEmail(email));

  const member = await interaction.guild.members.fetch(userId).catch(() => null);
  if (!member) {
    return interaction.reply({
      content: 'Verified in DB but could not fetch your member record — contact a mod.',
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    await applyGuildVerificationRoles(member, guildConfig);
  } catch {
    return interaction.reply({
      content: 'Verified in DB but role assignment failed — contact a mod.',
      flags: MessageFlags.Ephemeral,
    });
  }

  return interaction.reply({
    content: 'Verified! Welcome to the server.',
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = { handle };
