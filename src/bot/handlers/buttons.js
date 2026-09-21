const {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const { grandfatherMembers } = require('../grandfather');

// Discord rate-limits message edits; report progress in chunks rather than
// once per member.
const PROGRESS_EVERY = 100;

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

  // Defer immediately — the per-guild member.fetch + role removal loop can
  // span many guilds and will blow past Discord's 3s deadline without this.
  await interaction.deferUpdate();

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

  return interaction.editReply({
    content: 'Your verification record has been deleted. You may re-verify any time.',
    components: [],
  });
}

async function handleGrandfatherCancel(interaction) {
  return interaction.update({ content: 'Cancelled. Setup is still complete.', components: [] });
}

/**
 * Confirm-side of /setup grandfather-existing: grant the guild's verified
 * role to every current member. Nothing is written to the verified
 * database -- this only papers over the role in this one guild.
 *
 * The button carries no state: anyone who can see the setup reply can click
 * it, so the Administrator check is re-run here and the role is re-read from
 * guild config rather than trusted from the customId.
 */
async function handleGrandfatherConfirm(interaction, deps) {
  const { db, log } = deps;

  if (!interaction.memberPermissions || !interaction.memberPermissions.has('Administrator')) {
    return interaction.reply({
      content: '❌ Only server administrators can run the backfill.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const roleId = db.getGuildConfig(interaction.guild.id)?.verified_role_id;
  if (!roleId) {
    return interaction.update({
      content: "❌ This server's configuration is gone. Run `/setup` again before backfilling.",
      components: [],
    });
  }

  // Acknowledge and drop the buttons in one edit so the backfill cannot be
  // started twice by a double-click.
  await interaction.update({
    content: `⏳ Granting <@&${roleId}> to existing members…`,
    components: [],
  });

  let reportedAt = 0;
  const onProgress = (progress) => {
    const { processed = 0 } = progress ?? {};
    if (processed - reportedAt < PROGRESS_EVERY) return;
    reportedAt = processed;
    // The interaction token expires ~15 min after the first response; a dead
    // token must not take the backfill down with it.
    interaction
      .editReply({
        content: `⏳ Granting <@&${roleId}> to existing members… ${processed} processed.`,
        components: [],
      })
      .catch(() => {});
  };

  // ponytail: sequential adds, ~15min token ceiling; move to a background job if servers get large enough to need it.
  let result;
  try {
    result = await grandfatherMembers({ guild: interaction.guild, roleId, log, onProgress });
  } catch (err) {
    log.error({ err, guildId: interaction.guild.id }, 'grandfather: backfill failed');
    return interaction
      .editReply({
        content: '❌ The backfill failed partway through. Re-run `/setup` to try again.',
        components: [],
      })
      .catch(() => {});
  }

  const { granted = 0, skipped = 0, failed = 0 } = result ?? {};
  return interaction
    .editReply({
      content: `✅ Backfill complete — granted ${granted}, skipped ${skipped}, failed ${failed}. Nobody was added to the verified database.`,
      components: [],
    })
    .catch(() => {});
}

module.exports = {
  handleVerifyStart,
  handleCodePrompt,
  handleForgetMeCancel,
  handleForgetMeConfirm,
  handleGrandfatherCancel,
  handleGrandfatherConfirm,
};
