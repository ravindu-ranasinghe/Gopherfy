const { MessageFlags } = require('discord.js');

/**
 * umn_verify_email_modal -- the modal-version of /verify. Mirrors the
 * chat command's branching but ends with an editReply telling the user
 * to use the panel's "Submit code" button.
 */
async function handleEmailModal(interaction, deps) {
  const {
    db,
    log,
    postToOtpService,
    applyGuildVerificationRoles,
    validateUmnEmail,
    normalizeEmail,
  } = deps;
  const userId = interaction.user.id;

  const email = normalizeEmail(interaction.fields.getTextInputValue('umn_email'));

  if (!validateUmnEmail(email).valid) {
    return interaction.reply({
      content: 'Must be a @umn.edu address.',
      flags: MessageFlags.Ephemeral,
    });
  }
  const guildConfig = interaction.guild ? db.getGuildConfig(interaction.guild.id) : null;
  if (interaction.guild && !guildConfig) {
    return interaction.reply({
      content: "⚠️ This server hasn't been configured yet. Ask an admin to run `/setup` first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const existingRow = db.getByDiscordId(userId);
  if (existingRow) {
    if (existingRow.email_hmac && db.hashEmail(email) !== existingRow.email_hmac) {
      return interaction.reply({
        content:
          'You have verified before with a different address. Enter that same @umn.edu address, or ask a mod for help.',
        flags: MessageFlags.Ephemeral,
      });
    }
    // member.fetch is async — defer before it to stay within Discord's 3s window.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) {
      return interaction.editReply({
        content:
          'You have verified before! Thank you.\nCould not fetch your member record — contact a mod for roles.',
      });
    }
    try {
      await applyGuildVerificationRoles(member, guildConfig);
    } catch {
      return interaction.editReply({
        content: 'You have verified before! Thank you.\nRole assignment failed — contact a mod.',
      });
    }
    return interaction.editReply({ content: 'You have verified before! Thank you.' });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (db.getByEmailHmac(db.hashEmail(email))) {
    log.info({ discordId: userId }, 'modal verify: email collision, generic response');
    return interaction.editReply(
      'If that email is eligible, a code has been sent. Run /code with the 6-digit code. Expires in 10 minutes.',
    );
  }

  try {
    const res = await postToOtpService('/send', { discordId: userId, email });
    const data = await res.json();

    if (!data.ok) {
      if (data.reason === 'rate_limited') {
        return interaction.editReply({ content: 'Too many attempts. Try again in an hour.' });
      }
      return interaction.editReply({
        content: 'Failed to send email. Try again or contact a mod.',
      });
    }
  } catch {
    return interaction.editReply({
      content: 'Failed to send email. Try again or contact a mod.',
    });
  }

  return interaction.editReply({
    content: `Code sent to **${email}**. Go back to the verification panel message in this channel and click **Submit code** (expires in 10 minutes).`,
  });
}

async function handleCodeModal(interaction, deps) {
  const { db, postToOtpService, applyGuildVerificationRoles } = deps;
  const userId = interaction.user.id;

  const input = interaction.fields.getTextInputValue('umn_code').trim();

  const config = interaction.guild ? db.getGuildConfig(interaction.guild.id) : null;
  if (!config) {
    return interaction.reply({
      content: "⚠️ This server hasn't been configured yet. Ask an admin to run `/setup` first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // Defer before any async work — OTP service + member fetch exceed Discord's 3s deadline.
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
      await applyGuildVerificationRoles(member, config);
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
      no_pending: 'No pending verification. Start verification again from the panel.',
      expired: 'Code expired. Start verification again from the panel.',
      wrong_code: 'Wrong code. Try again.',
      too_many_attempts: 'Too many wrong codes. Start verification again from the panel.',
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
    await applyGuildVerificationRoles(member, config);
  } catch {
    return interaction.editReply({
      content: 'Verified in DB but role assignment failed — contact a mod.',
    });
  }

  return interaction.editReply({ content: 'Verified! Welcome to the server.' });
}

module.exports = { handleEmailModal, handleCodeModal };
