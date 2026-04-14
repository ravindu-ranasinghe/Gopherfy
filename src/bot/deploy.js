require('dotenv').config();
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

const commands = [
  {
    name: 'verify',
    description: 'Start UMN email verification',
    options: [
      {
        type: 3, // STRING
        name: 'email',
        description: 'Your @umn.edu email address',
        required: true,
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
    description: 'Look up what UMN email a user verified with (mods only)',
    options: [
      {
        type: 6, // USER
        name: 'user',
        description: 'The Discord user to look up',
        required: true,
      },
    ],
  },
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

rest
  .put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands })
  .then(() => console.log('Commands registered'))
  .catch(console.error);
