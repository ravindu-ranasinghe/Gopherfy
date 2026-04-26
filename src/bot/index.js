require('dotenv').config();
const { ActivityType, Client, GatewayIntentBits } = require('discord.js');

const db = require('./db');
const { sign: signRequest } = require('../lib/http-signing');
const { validateUmnEmail, normalize: normalizeEmail } = require('../lib/email');
const log = require('../lib/logger').child({ module: 'bot' });
const handlers = require('./handlers');

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

// guildMemberRemove is intentionally info-only: a user leaving guild A
// does not mean they want to be forgotten from guild B's role grants.
// The verified_users row is the user's identity, not a per-guild
// artifact, so we never delete it here. (A future "user is in 0
// Gopherfy guilds → schedule deletion" pass is documented as a TODO in
// the runbook.)
client.on('guildMemberRemove', (member) => {
  log.info({ event: 'member_left_guild', guildId: member.guild.id, userId: member.id });
});

// guildDelete fires when the bot is kicked or the guild is deleted.
// Only the per-guild config is meaningless without the bot — verified
// records are user-scoped, never touched here.
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

client.login(DISCORD_TOKEN);
