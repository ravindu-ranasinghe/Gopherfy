const { MessageFlags } = require('discord.js');

/**
 * /verify -- the chat-input version. Modal flow lives in modal-email.js.
 *
 * Branches:
 *   1. Already-verified discord ID with a different stored email_hmac
 *      -> "verified before with different address" message.
 *   2. Already-verified discord ID with same/no email arg -> attempt to
 *      grant the verified role and return a "verified before" message.
 *   3. New user, missing or non-UMN email -> "must be @umn.edu".
 *   4. New user, valid email, email already linked to another discord
 *      -> generic enumeration-protection success message, no OTP send.
 *   5. New user, valid email, free email -> POST /send to OTP service,
 *      respond based on the OTP service's reply (ok / rate_limited /
 *      send_failed).
 */
async function handle(interaction, deps) {
  const {
    db,
    log,
    postToOtpService,
    applyGuildVerificationRoles,
    validateUmnEmail,
    normalizeEmail,
  } = deps;
  const userId = interaction.user.id;
  const guildConfig = db.getGuildConfig(interaction.guild.id);

  const emailOpt = interaction.options.getString('email');
  const email = emailOpt ? normalizeEmail(emailOpt) : '';

  const existingRow = db.getByDiscordId(userId);
  if (existingRow) {
    if (email && existingRow.email_hmac && db.hashEmail(email) !== existingRow.email_hmac) {
      return interaction.reply({
        content:
          'You have verified before with a different address. Run `/verify` with no email, or use that same address.',
        flags: MessageFlags.Ephemeral,
      });
    }
    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) {
      return interaction.reply({
        content:
          'You have verified before! Thank you.\nCould not fetch your member record — contact a mod for roles.',
        flags: MessageFlags.Ephemeral,
      });
    }
    try {
      await applyGuildVerificationRoles(member, guildConfig);
    } catch {
      return interaction.reply({
        content: 'You have verified before! Thank you.\nRole assignment failed — contact a mod.',
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({
      content: 'You have verified before! Thank you.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!email || !validateUmnEmail(email).valid) {
    return interaction.reply({
      content: 'Must be a @umn.edu address.',
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Email-collision is handled with a generic success message and no
  // OTP service call. The attacker can't tell whether the address is
  // "free", "already linked to a different Discord account", or
  // "already linked to your own account" -- they all look identical
  // from outside.
  if (db.getByEmailHmac(db.hashEmail(email))) {
    log.info({ discordId: userId }, 'verify: email collision, generic response');
    return interaction.editReply(
      'If that email is eligible, a code has been sent. Run /code with the 6-digit code. Expires in 10 minutes.',
    );
  }

  try {
    const res = await postToOtpService('/send', { discordId: userId, email });
    const data = await res.json();

    if (data.ok) {
      return interaction.editReply(
        'If that email is eligible, a code has been sent. Run /code with the 6-digit code. Expires in 10 minutes.',
      );
    }
    if (data.reason === 'rate_limited') {
      return interaction.editReply('Too many attempts. Try again in an hour.');
    }
    return interaction.editReply('Failed to send email. Try again or contact a mod.');
  } catch {
    return interaction.editReply('Failed to send email. Try again or contact a mod.');
  }
}

module.exports = { handle };
