const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');

/**
 * /setup -- admin-only first-time guild configuration. Stores the
 * verified role on guild_config so verifyer/code handlers can grant it.
 *
 * The optional role-all-members flag offers a one-shot backfill that
 * grants the verified role to everyone already in the guild. Setup itself
 * always completes first; the backfill is only ever offered, never run
 * here -- the buttons hand off to grandfather_confirm / grandfather_cancel.
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
  const roleAllMembers = interaction.options.getBoolean('role-all-members');

  // fetchMe() is a network call — defer before it to stay within Discord's 3s window.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const botMember = await interaction.guild.members.fetchMe();
  const botHighest = botMember.roles.highest.position;

  if (verifiedRole.position >= botHighest) {
    return interaction.editReply({
      content:
        "❌ The bot's role must be above the selected verified role in the server's role list. Please drag the bot's role higher and try again.",
    });
  }

  // Legacy DB compatibility: the unverified role column is no longer
  // used but we keep the schema's NOT NULL constraint satisfied by
  // re-using the verified role id.
  db.setGuildConfig(interaction.guild.id, verifiedRole.id, verifiedRole.id);

  const successContent = `✅ **Setup complete!**\n- Verified role: <@&${verifiedRole.id}>\n- Everyone else remains under \`@everyone\` permissions until verified.\n\nPost a verification panel with \`/verify-panel\``;

  if (!roleAllMembers) {
    return interaction.editReply({ content: successContent });
  }

  // Setup succeeded either way; without Manage Roles the bot simply cannot
  // hand out the role, so say so rather than offering a button that fails.
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    return interaction.editReply({
      content: `${successContent}\n\n⚠️ I can't grant the role to existing members — I'm missing the **Manage Roles** permission. Grant it and run \`/setup\` again with \`role-all-members: true\`.`,
    });
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('grandfather_confirm')
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('grandfather_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.editReply({
    content: `${successContent}\n\nGrant <@&${verifiedRole.id}> to ~${interaction.guild.memberCount} existing members? They will not be added to the verified database — if they join another Gopherfy server they must verify normally.`,
    components: [row],
  });
}

module.exports = { handle };
