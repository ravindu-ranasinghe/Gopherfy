require('dotenv').config();
const { ActivityType, Client, GatewayIntentBits } = require('discord.js');

const createBotDb = require('./db');
const { sign: signRequest } = require('../lib/http-signing');
const { validateUmnEmail, normalize: normalizeEmail } = require('../lib/email');
const log = require('../lib/logger').child({ module: 'bot' });
const { loadSecrets } = require('../lib/secrets');
const handlers = require('./handlers');

/**
 * POST a JSON body to the OTP service with HMAC-SHA256 request signing.
 */
const OTP_FETCH_TIMEOUT_MS = 8000;

function makePostToOtpService(otpServiceUrl, otpServiceKey) {
  return async function postToOtpService(routePath, payload) {
    const body = JSON.stringify(payload);
    const timestamp = Date.now();
    const signature = signRequest({ secret: otpServiceKey, timestamp, body });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OTP_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${otpServiceUrl}${routePath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Timestamp': String(timestamp),
          'X-Signature': signature,
        },
        body,
        signal: controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  };
}

async function main() {
  const secrets = await loadSecrets();

  if (!secrets.OTP_SERVICE_KEY || secrets.OTP_SERVICE_KEY.length < 32) {
    log.error('OTP_SERVICE_KEY missing or too short (need >=32 chars). Refusing to start.');
    process.exit(1);
  }
  if (!secrets.DISCORD_TOKEN) {
    log.error('DISCORD_TOKEN missing. Refusing to start.');
    process.exit(1);
  }

  const db = createBotDb(secrets.OTP_HMAC_KEY);
  const OTP_SERVICE_URL = process.env.OTP_SERVICE_URL ?? 'http://localhost:3001';
  const postToOtpService = makePostToOtpService(OTP_SERVICE_URL, secrets.OTP_SERVICE_KEY);

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
          name: '𝗚𝗼𝗽𝗵𝗲𝗿𝗳𝘆 — verifying @umn.edu',
          type: ActivityType.Watching,
        },
      ],
    });
  }

  const deps = {
    db,
    log,
    client,
    postToOtpService,
    applyGuildVerificationRoles,
    validateUmnEmail,
    normalizeEmail,
  };

  client.once('clientReady', () => {
    log.info({ tag: client.user.tag }, 'bot ready');
    setVerificationPresence();
  });

  client.on('shardResume', () => {
    setVerificationPresence();
  });

  client.on('guildMemberAdd', async (member) => {
    const config = db.getGuildConfig(member.guild.id);
    if (!config) return;
    if (db.isVerified(member.id)) {
      member.roles.add(config.verified_role_id).catch(() => {});
    }
  });

  client.on('guildMemberRemove', (member) => {
    log.info({ event: 'member_left_guild', guildId: member.guild.id, userId: member.id });
  });

  client.on('guildDelete', (guild) => {
    db.deleteGuildConfig(guild.id);
    log.info({ event: 'guild_removed', guildId: guild.id });
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      await handlers.dispatch(interaction, deps);
    } catch (err) {
      log.error({ err }, 'interactionCreate failed');

      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: 'Something went wrong. Try again in a moment.',
            flags: 64,
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

  await client.login(secrets.DISCORD_TOKEN);
}

main().catch((err) => {
  log.error({ err }, 'bot failed to start');
  process.exit(1);
});
