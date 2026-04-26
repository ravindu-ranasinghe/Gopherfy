const { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');

async function handleVerifyStart(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('umn_verify_email_modal')
    .setTitle('Gopherfy — UMN email');

  const emailInput = new TextInputBuilder()
    .setCustomId('umn_email')
    .setLabel('UMN email (@umn.edu)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(6)
    .setMaxLength(100);

  modal.addComponents(new ActionRowBuilder().addComponents(emailInput));
  return interaction.showModal(modal);
}

async function handleCodePrompt(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('umn_verify_code_modal')
    .setTitle('Verification code');

  const codeInput = new TextInputBuilder()
    .setCustomId('umn_code')
    .setLabel('6-digit code')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(6)
    .setMaxLength(6);

  modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
  return interaction.showModal(modal);
}

async function handleForgetMeCancel(interaction) {
  return interaction.update({ content: 'Cancelled.', components: [] });
}

/**
 * Confirm-side of /forget-me: hard-delete the verification record,
 * write the deletion-audit row, then iterate every guild the bot is in
 * to drop the verified role. One guild's failure must not stop the
 * others (warn + continue).
 */
async function handleForgetMeConfirm(interaction, deps) {
  const { db, log, client } = deps;
  const userId = interaction.user.id;

  db.deleteVerified(userId);
  db.insertDeletionAudit(userId, 'user_request');

  for (const [, guild] of client.guilds.cache) {
    const cfg = db.getGuildConfig(guild.id);
    if (!cfg) continue;
    try {
      const member = await guild.members.fetch(userId).catch(() => null);
      if (member) {
        await member.roles.remove(cfg.verified_role_id).catch((err) => {
          log.warn({ err, guildId: guild.id, userId }, 'forget-me: role remove failed');
        });
      }
    } catch (err) {
      log.warn({ err, guildId: guild.id, userId }, 'forget-me: per-guild cleanup failed');
    }
  }

  return interaction.update({
    content: 'Your verification record has been deleted. You may re-verify any time.',
    components: [],
  });
}

module.exports = {
  handleVerifyStart,
  handleCodePrompt,
  handleForgetMeCancel,
  handleForgetMeConfirm,
};
