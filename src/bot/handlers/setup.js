const { MessageFlags } = require('discord.js');

/**
 * /setup -- admin-only first-time guild configuration. Stores the
 * verified role on guild_config so verifyer/code handlers can grant it.
 */
async function handle(interaction, deps) {
  const { db } = deps;

  if (!interaction.memberPermissions || !interaction.memberPermissions.has('Administrator')) {
    return interaction.reply({
      content: '❌ Only server administrators can run `/setup`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const verifiedRole = interaction.options.getRole('verified-role');
  const botMember = await interaction.guild.members.fetchMe();
  const botHighest = botMember.roles.highest.position;

  if (verifiedRole.position >= botHighest) {
    return interaction.reply({
      content:
        "❌ The bot's role must be above the selected verified role in the server's role list. Please drag the bot's role higher and try again.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // Legacy DB compatibility: the unverified role column is no longer
  // used but we keep the schema's NOT NULL constraint satisfied by
  // re-using the verified role id.
  db.setGuildConfig(interaction.guild.id, verifiedRole.id, verifiedRole.id);

  return interaction.reply({
    content: `✅ **Setup complete!**\n- Verified role: <@&${verifiedRole.id}>\n- Everyone else remains under \`@everyone\` permissions until verified.\n\nPost a verification panel with \`/verify-panel\``,
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = { handle };
