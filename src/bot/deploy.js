require('dotenv').config();
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');
const log = require('../lib/logger').child({ module: 'deploy' });
const { loadSecrets } = require('../lib/secrets');

const { CLIENT_ID } = process.env;

const commands = [
  {
    name: 'verify',
    description: 'Start Gopherfy @umn.edu verification',
    options: [
      {
        type: 3, // STRING
        name: 'email',
        description: 'Your @umn.edu email address (omit if you already verified elsewhere)',
        required: false,
      },
    ],
  },
  {
    name: 'code',
    description: 'Submit your 6-digit verification code',
    options: [
      {
        type: 3, // STRING
        name: 'digits',
        description: 'The 6-digit code sent to your email',
        required: true,
      },
    ],
  },
  {
    name: 'whois',
    description: 'Check whether a user is verified through Gopherfy (mods only)',
    options: [
      {
        type: 6, // USER
        name: 'user',
        description: 'The Discord user to look up',
        required: true,
      },
    ],
  },
  {
    name: 'whois-audit',
    description: 'Show recent /whois activity grouped by moderator (admins only)',
  },
  {
    name: 'forget-me',
    description:
      'Delete your verification record from Gopherfy. Removes verified roles in all Gopherfy servers.',
  },
  {
    name: 'verify-panel',
    description: 'Post the Gopherfy verification panel (mods only)',
  },
  {
    name: 'setup',
    description: 'Configure Gopherfy for this server (admins only)',
    options: [
      {
        type: 8, // ROLE
        name: 'verified-role',
        description: 'Role to assign after verification (e.g. Verified Gopher)',
        required: true,
      },
    ],
  },
];

async function main() {
  const secrets = await loadSecrets();

  if (!CLIENT_ID) {
    log.error('CLIENT_ID missing. Refusing to register commands.');
    process.exit(1);
  }
  if (!secrets.DISCORD_TOKEN) {
    log.error('DISCORD_TOKEN missing. Refusing to register commands.');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(secrets.DISCORD_TOKEN);

  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  log.info('Commands registered');
}

main().catch((err) => {
  log.error({ err }, 'Command registration failed');
  process.exit(1);
});
