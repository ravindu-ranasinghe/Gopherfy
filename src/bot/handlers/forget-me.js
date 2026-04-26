const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

async function handle(interaction) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('forget_me_confirm')
      .setLabel('Confirm Delete')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('forget_me_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({
    content:
      'Are you sure? This deletes your verification record and removes verified roles from all Gopherfy-managed servers.',
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = { handle };
