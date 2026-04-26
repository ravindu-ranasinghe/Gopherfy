require('dotenv').config();
const {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Colors,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const {
  isVerified,
  getByEmailHmac,
  getByDiscordId,
  addVerifiedHmac,
  getGuildConfig,
  setGuildConfig,
  hashEmail,
} = require('./db');
const { sign: signRequest } = require('../lib/http-signing');
const { validateUmnEmail, normalize: normalizeEmail } = require('../lib/email');
const log = require('../lib/logger').child({ module: 'bot' });

const { DISCORD_TOKEN, OTP_SERVICE_URL = 'http://localhost:3001', OTP_SERVICE_KEY } = process.env;

if (!OTP_SERVICE_KEY || OTP_SERVICE_KEY.length < 32) {
  log.error('OTP_SERVICE_KEY missing or too short (need >=32 chars). Refusing to start.');
  process.exit(1);
}

/**
 * POST a JSON body to the OTP service with HMAC-SHA256 request signing.
 *
 * Headers sent:
 *   X-Timestamp: <Date.now()>
 *   X-Signature: <hex of HMAC-SHA256(OTP_SERVICE_KEY, ts + '.' + body)>
 *
 * The exact serialized body bytes are signed and re-used as the request
 * body so the receiver sees the same payload it verified.
 */
async function postToOtpService(routePath, payload) {
  const body = JSON.stringify(payload);
  const timestamp = Date.now();
  const signature = signRequest({ secret: OTP_SERVICE_KEY, timestamp, body });
  const res = await fetch(`${OTP_SERVICE_URL}${routePath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': String(timestamp),
      'X-Signature': signature,
    },
    body,
  });
  return res;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

async function applyGuildVerificationRoles(member, config) {
  try {
    await member.roles.add(config.verified_role_id);
  } catch (err) {
    log.error({ err, guildId: member.guild.id }, 'role assignment failed');
    throw err;
  }
}

function setVerificationPresence() {
  client.user.setPresence({
    status: 'online',
    activities: [
      {
        // Discord activity names don't support Markdown bold; use Unicode bold letters instead.
        name: '𝗚𝗼𝗽𝗵𝗲𝗿𝗳𝘆 — verifying @umn.edu',
        type: ActivityType.Watching,
      },
    ],
  });
}

client.once('clientReady', () => {
  log.info({ tag: client.user.tag }, 'bot ready');
  setVerificationPresence();
});

client.on('shardResume', () => {
  setVerificationPresence();
});

client.on('guildMemberAdd', async (member) => {
  const config = getGuildConfig(member.guild.id);
  if (!config) return;
  if (isVerified(member.id)) {
    member.roles.add(config.verified_role_id).catch(() => {});
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName, user } = interaction;
      const userId = user.id;
      const config = interaction.guild ? getGuildConfig(interaction.guild.id) : null;

      if (commandName !== 'setup' && !config) {
        return interaction.reply({
          content: "⚠️ This server hasn't been configured yet. Ask an admin to run `/setup` first.",
          flags: MessageFlags.Ephemeral,
        });
      }

      if (commandName === 'setup') {
        if (!interaction.memberPermissions.has('Administrator')) {
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

        // Keep DB compatibility: legacy unverified role column is no longer used.
        setGuildConfig(interaction.guild.id, verifiedRole.id, verifiedRole.id);

        return interaction.reply({
          content: `✅ **Setup complete!**\n- Verified role: <@&${verifiedRole.id}>\n- Everyone else remains under \`@everyone\` permissions until verified.\n\nPost a verification panel with \`/verify-panel\``,
          flags: MessageFlags.Ephemeral,
        });
      }

      if (commandName === 'verify-panel') {
        if (!interaction.memberPermissions.has('ManageGuild')) {
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
              '3) Click **Submit code** and enter the code.',
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

      if (commandName === 'verify') {
        const emailOpt = interaction.options.getString('email');
        const email = emailOpt ? normalizeEmail(emailOpt) : '';

        const existingRow = getByDiscordId(userId);
        if (existingRow) {
          // Compare HMACs only -- plaintext email is gone after 004.
          if (email && existingRow.email_hmac && hashEmail(email) !== existingRow.email_hmac) {
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
            await applyGuildVerificationRoles(member, config);
          } catch {
            return interaction.reply({
              content:
                'You have verified before! Thank you.\nRole assignment failed — contact a mod.',
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

        // Email-collision is handled with a generic success message and
        // no OTP service call. The attacker can't tell whether the
        // address is "free", "already linked to a different Discord
        // account", or "already linked to your own account" -- they all
        // look identical from outside.
        if (getByEmailHmac(hashEmail(email))) {
          log.info({ discordId: userId }, 'verify: email collision, generic response');
          return interaction.editReply(
            'If that email is eligible, a code has been sent. Run /code with the 6-digit code. Expires in 10 minutes.',
          );
        }

        try {
          const res = await postToOtpService('/send', { discordId: userId, email });
          const data = await res.json();

          if (data.ok) {
            await interaction.editReply(
              'If that email is eligible, a code has been sent. Run /code with the 6-digit code. Expires in 10 minutes.',
            );
          } else if (data.reason === 'rate_limited') {
            await interaction.editReply('Too many attempts. Try again in an hour.');
          } else {
            await interaction.editReply('Failed to send email. Try again or contact a mod.');
          }
        } catch {
          await interaction.editReply('Failed to send email. Try again or contact a mod.');
        }

        return;
      }

      if (commandName === 'code') {
        const input = interaction.options.getString('digits').trim();

        if (isVerified(userId)) {
          const member = await interaction.guild.members.fetch(userId).catch(() => null);
          if (!member) {
            return interaction.reply({
              content:
                'You are already verified.\nCould not fetch your member record — contact a mod for roles.',
              flags: MessageFlags.Ephemeral,
            });
          }
          try {
            await applyGuildVerificationRoles(member, config);
          } catch {
            return interaction.reply({
              content: 'You are already verified.\nRole assignment failed — contact a mod.',
              flags: MessageFlags.Ephemeral,
            });
          }
          return interaction.reply({
            content: 'You are already verified.',
            flags: MessageFlags.Ephemeral,
          });
        }

        let data;
        try {
          const res = await postToOtpService('/verify', { discordId: userId, code: input });
          data = await res.json();
        } catch {
          return interaction.reply({
            content: 'Failed to reach verification service. Try again later.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (!data.ok) {
          const messages = {
            no_pending: 'No pending verification. Run `/verify` first.',
            expired: 'Code expired. Run `/verify` again.',
            wrong_code: 'Wrong code. Try again.',
            too_many_attempts: 'Too many wrong codes. Run `/verify` again to get a new code.',
          };
          return interaction.reply({
            content: messages[data.reason] ?? 'Verification failed. Try again.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const { email } = data;
        addVerifiedHmac(userId, hashEmail(email));

        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (!member) {
          return interaction.reply({
            content: 'Verified in DB but could not fetch your member record — contact a mod.',
            flags: MessageFlags.Ephemeral,
          });
        }

        try {
          await applyGuildVerificationRoles(member, config);
        } catch {
          return interaction.reply({
            content: 'Verified in DB but role assignment failed — contact a mod.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.reply({
          content: 'Verified! Welcome to the server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      if (commandName === 'whois') {
        if (!interaction.memberPermissions.has('ManageGuild')) {
          return interaction.reply({
            content: 'You do not have permission to use this command.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const target = interaction.options.getUser('user');
        const row = getByDiscordId(target.id);

        if (!row) {
          return interaction.reply({
            content: `❌ <@${target.id}> is not verified.`,
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

        // Plaintext email is no longer at rest; the minimum-disclosure
        // redesign in Prompt 12 will harden this further.
        return interaction.reply({
          content: `🔍 **User:** <@${target.id}>\n✅ **Verified:** ${verifiedAt}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'umn_verify_start') {
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

      if (interaction.customId === 'umn_verify_code_prompt') {
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

      return;
    }

    if (interaction.isModalSubmit()) {
      const userId = interaction.user.id;

      if (interaction.customId === 'umn_verify_email_modal') {
        const email = normalizeEmail(interaction.fields.getTextInputValue('umn_email'));

        if (!validateUmnEmail(email).valid) {
          return interaction.reply({
            content: 'Must be a @umn.edu address.',
            flags: MessageFlags.Ephemeral,
          });
        }
        const guildConfig = interaction.guild ? getGuildConfig(interaction.guild.id) : null;
        if (interaction.guild && !guildConfig) {
          return interaction.reply({
            content:
              "⚠️ This server hasn't been configured yet. Ask an admin to run `/setup` first.",
            flags: MessageFlags.Ephemeral,
          });
        }

        const existingRow = getByDiscordId(userId);
        if (existingRow) {
          if (existingRow.email_hmac && hashEmail(email) !== existingRow.email_hmac) {
            return interaction.reply({
              content:
                'You have verified before with a different address. Enter that same @umn.edu address, or ask a mod for help.',
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
              content:
                'You have verified before! Thank you.\nRole assignment failed — contact a mod.',
              flags: MessageFlags.Ephemeral,
            });
          }
          return interaction.reply({
            content: 'You have verified before! Thank you.',
            flags: MessageFlags.Ephemeral,
          });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Same enumeration-protection contract as in /verify above.
        if (getByEmailHmac(hashEmail(email))) {
          log.info({ discordId: userId }, 'modal verify: email collision, generic response');
          return interaction.editReply(
            'If that email is eligible, a code has been sent. Run /code with the 6-digit code. Expires in 10 minutes.',
          );
        }

        try {
          const res = await postToOtpService('/send', { discordId: userId, email });
          const data = await res.json();

          if (!data.ok) {
            if (data.reason === 'rate_limited') {
              return interaction.editReply({ content: 'Too many attempts. Try again in an hour.' });
            }
            return interaction.editReply({
              content: 'Failed to send email. Try again or contact a mod.',
            });
          }
        } catch {
          return interaction.editReply({
            content: 'Failed to send email. Try again or contact a mod.',
          });
        }

        return interaction.editReply({
          content: `Code sent to **${email}**. Go back to the verification panel message in this channel and click **Submit code** (expires in 10 minutes).`,
        });
      }

      if (interaction.customId === 'umn_verify_code_modal') {
        const input = interaction.fields.getTextInputValue('umn_code').trim();

        const config = interaction.guild ? getGuildConfig(interaction.guild.id) : null;
        if (!config) {
          return interaction.reply({
            content:
              "⚠️ This server hasn't been configured yet. Ask an admin to run `/setup` first.",
            flags: MessageFlags.Ephemeral,
          });
        }

        if (isVerified(userId)) {
          const member = await interaction.guild.members.fetch(userId).catch(() => null);
          if (!member) {
            return interaction.reply({
              content:
                'You are already verified.\nCould not fetch your member record — contact a mod for roles.',
              flags: MessageFlags.Ephemeral,
            });
          }
          try {
            await applyGuildVerificationRoles(member, config);
          } catch {
            return interaction.reply({
              content: 'You are already verified.\nRole assignment failed — contact a mod.',
              flags: MessageFlags.Ephemeral,
            });
          }
          return interaction.reply({
            content: 'You are already verified.',
            flags: MessageFlags.Ephemeral,
          });
        }

        let data;
        try {
          const res = await postToOtpService('/verify', { discordId: userId, code: input });
          data = await res.json();
        } catch {
          return interaction.reply({
            content: 'Failed to reach verification service. Try again later.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (!data.ok) {
          const messages = {
            no_pending: 'No pending verification. Start verification again from the panel.',
            expired: 'Code expired. Start verification again from the panel.',
            wrong_code: 'Wrong code. Try again.',
            too_many_attempts: 'Too many wrong codes. Start verification again from the panel.',
          };
          return interaction.reply({
            content: messages[data.reason] ?? 'Verification failed. Try again.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const { email } = data;
        addVerifiedHmac(userId, hashEmail(email));

        const member = await interaction.guild.members.fetch(userId).catch(() => null);
        if (!member) {
          return interaction.reply({
            content: 'Verified in DB but could not fetch your member record — contact a mod.',
            flags: MessageFlags.Ephemeral,
          });
        }

        try {
          await applyGuildVerificationRoles(member, config);
        } catch {
          return interaction.reply({
            content: 'Verified in DB but role assignment failed — contact a mod.',
            flags: MessageFlags.Ephemeral,
          });
        }

        return interaction.reply({
          content: 'Verified! Welcome to the server.',
          flags: MessageFlags.Ephemeral,
        });
      }

      return;
    }
  } catch (err) {
    log.error({ err }, 'interactionCreate failed');

    try {
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: 'Something went wrong. Try again in a moment.',
          flags: MessageFlags.Ephemeral,
        });
      } else if (interaction.deferred) {
        await interaction.editReply({
          content: 'Something went wrong. Try again in a moment.',
          components: [],
        });
      }
    } catch {
      // ignore
    }
  }
});

client.login(DISCORD_TOKEN);
