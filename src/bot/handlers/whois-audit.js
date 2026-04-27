const { MessageFlags } = require('discord.js');

async function handle(interaction, deps) {
  const { db } = deps;

  if (!interaction.memberPermissions || !interaction.memberPermissions.has('ManageGuild')) {
    return interaction.reply({
      content: 'You do not have permission to use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const rows = db.getRecentWhoisByGuild(interaction.guild.id, 25);
  if (rows.length === 0) {
    return interaction.reply({
      content: 'No /whois lookups recorded in this guild yet.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const lines = rows.map((r) => {
    const when = new Date(r.most_recent).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    return `<@${r.actor_id}> — ${r.lookups} lookup${r.lookups === 1 ? '' : 's'} (last: ${when})`;
  });
  return interaction.reply({
    content: `**Recent /whois activity (last 25 actors):**\n${lines.join('\n')}`,
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = { handle };
