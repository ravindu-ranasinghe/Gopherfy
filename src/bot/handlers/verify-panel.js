const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
  EmbedBuilder,
  MessageFlags,
} = require('discord.js');

async function handle(interaction) {
  if (!interaction.memberPermissions || !interaction.memberPermissions.has('ManageGuild')) {
    return interaction.reply({
      content: 'You do not have permission to use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.DarkRed)
    .setTitle('Gopherfy')
    .setDescription(
      '**Gopherfy** verifies **@umn.edu** addresses for this server.\n\n' +
        '1) Click **Start verification** and enter your **@umn.edu** email.\n' +
        '2) Check your inbox for a **6-digit code**.\n' +
        '3) Click **Submit code** and enter the code.\n\n' +
        "*Don't see the email? Check your spam/junk folder.*",
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('umn_verify_start')
      .setLabel('Start verification')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('umn_verify_code_prompt')
      .setLabel('Submit code')
      .setStyle(ButtonStyle.Secondary),
  );

  return interaction.reply({ embeds: [embed], components: [row] });
}

module.exports = { handle };
