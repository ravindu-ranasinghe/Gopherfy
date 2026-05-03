const { MessageFlags } = require('discord.js');

/**
 * /whois -- verified lookup with audit + a 30/hour per-mod rate limit.
 * Permission gate accepts ManageGuild OR ModerateMembers (defense in
 * depth beyond setDefaultMemberPermissions).
 */
async function handle(interaction, deps) {
  const { db } = deps;
  const userId = interaction.user.id;

  const perms = interaction.memberPermissions;
  if (!perms || (!perms.has('ManageGuild') && !perms.has('ModerateMembers'))) {
    return interaction.reply({
      content: 'You do not have permission to use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const gate = db.whoisCanLookup(userId);
  if (!gate.allowed) {
    return interaction.reply({
      content: 'Lookup limit reached — try again later.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const target = interaction.options.getUser('user');
  const row = db.getByDiscordId(target.id);

  // Audit + counter debit happen on every permitted invocation,
  // regardless of whether the target was verified.
  db.whoisCommitLookup(userId);
  db.insertWhoisAudit(userId, target.id, interaction.guild.id);

  if (!row) {
    return interaction.reply({
      content: `<@${target.id}> · ❌ Not verified through Gopherfy.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const verifiedAt = new Date(row.verified_at).toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });

  return interaction.reply({
    content:
      `<@${target.id}> · ✅ Verified (UMN affiliation confirmed)\n` +
      `Email: ${row.email ? `**${row.email}**` : '*Unavailable (legacy record)*'}\n` +
      `Verified at: ${verifiedAt}\n` +
      'x500: ' +
      (row.email ? row.email.split('@')[0] : 'Unavailable'),
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = { handle };
