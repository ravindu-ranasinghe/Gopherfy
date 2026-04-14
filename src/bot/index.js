require('dotenv').config();
const { Client, GatewayIntentBits, MessageFlags } = require('discord.js');
const db = require('./db');

const { DISCORD_TOKEN, VERIFIED_ROLE_ID, UNVERIFIED_ROLE_ID, OTP_SERVICE_URL = 'http://localhost:3001' } = process.env;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('ready', () => {
  console.log(`Bot ready: ${client.user.tag}`);
});

client.on('guildMemberAdd', (member) => {
  if (db.isVerified(member.id)) {
    member.roles.add(VERIFIED_ROLE_ID).catch(() => {});
  } else {
    member.roles.add(UNVERIFIED_ROLE_ID).catch(() => {});
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;
  const userId = user.id;

  if (commandName === 'verify') {
    const email = interaction.options.getString('email').trim().toLowerCase();

    if (!email.endsWith('@umn.edu')) {
      return interaction.reply({ content: 'Must be a @umn.edu address.', flags: MessageFlags.Ephemeral });
    }
    if (db.isVerified(userId)) {
      return interaction.reply({ content: 'You are already verified.', flags: MessageFlags.Ephemeral });
    }
    if (db.getByEmail(email)) {
      return interaction.reply({ content: 'That email is already linked to another account.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const res = await fetch(`${OTP_SERVICE_URL}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordId: userId, email }),
      });
      const data = await res.json();

      if (data.ok) {
        await interaction.editReply(`Code sent to **${email}**. Run /code with the 6-digit code. Expires in 10 minutes.`);
      } else if (data.reason === 'rate_limited') {
        await interaction.editReply('Too many attempts. Try again in an hour.');
      } else {
        await interaction.editReply('Failed to send email. Try again or contact a mod.');
      }
    } catch {
      await interaction.editReply('Failed to send email. Try again or contact a mod.');
    }
  }

  if (commandName === 'code') {
    const input = interaction.options.getString('digits').trim();

    let data;
    try {
      const res = await fetch(`${OTP_SERVICE_URL}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordId: userId, code: input }),
      });
      data = await res.json();
    } catch {
      return interaction.reply({ content: 'Failed to reach verification service. Try again later.', flags: MessageFlags.Ephemeral });
    }

    if (!data.ok) {
      const messages = {
        no_pending: 'No pending verification. Run `/verify` first.',
        expired: 'Code expired. Run `/verify` again.',
        wrong_code: 'Wrong code. Try again.',
      };
      return interaction.reply({
        content: messages[data.reason] ?? 'Verification failed. Try again.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const { email } = data;
    db.addVerified(userId, email);

    const member = await interaction.guild.members.fetch(userId).catch(() => null);
    if (!member) {
      return interaction.reply({ content: 'Verified in DB but could not fetch your member record — contact a mod.', flags: MessageFlags.Ephemeral });
    }

    try {
      await member.roles.add(VERIFIED_ROLE_ID);
    } catch (err) {
      console.error('Role assignment failed:', err);
      return interaction.reply({ content: 'Verified in DB but role assignment failed — contact a mod.', flags: MessageFlags.Ephemeral });
    }

    member.roles.remove(UNVERIFIED_ROLE_ID).catch(() => {});

    return interaction.reply({ content: 'Verified! Welcome to the server.', flags: MessageFlags.Ephemeral });
  }

  if (commandName === 'whois') {
    if (!interaction.memberPermissions.has('ManageGuild')) {
      return interaction.reply({ content: 'You do not have permission to use this command.', flags: MessageFlags.Ephemeral });
    }

    const target = interaction.options.getUser('user');
    const row = db.getByDiscordId(target.id);

    if (!row) {
      return interaction.reply({ content: `❌ <@${target.id}> is not verified.`, flags: MessageFlags.Ephemeral });
    }

    const x500 = row.email.split('@')[0];
    const verifiedAt = new Date(row.verified_at).toLocaleString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });

    return interaction.reply({
      content: `🔍 **User:** <@${target.id}>\n📧 **Email:** ${row.email}\n🪪 **x500:** ${x500}\n✅ **Verified:** ${verifiedAt}`,
      flags: MessageFlags.Ephemeral,
    });
  }
});

client.login(DISCORD_TOKEN);
