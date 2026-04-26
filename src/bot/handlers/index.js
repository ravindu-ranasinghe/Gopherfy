/**
 * Lookup tables that map Discord interaction identifiers (commandName,
 * customId) to the pure handler functions in this directory. The
 * dispatcher in src/bot/index.js uses dispatch(interaction, deps) to
 * route an incoming interaction to the right handler.
 */
const { MessageFlags } = require('discord.js');

const setup = require('./setup');
const verifyPanel = require('./verify-panel');
const verify = require('./verify');
const code = require('./code');
const whois = require('./whois');
const whoisAudit = require('./whois-audit');
const forgetMe = require('./forget-me');
const buttons = require('./buttons');
const modals = require('./modals');

const chatHandlers = {
  setup: setup.handle,
  'verify-panel': verifyPanel.handle,
  verify: verify.handle,
  code: code.handle,
  whois: whois.handle,
  'whois-audit': whoisAudit.handle,
  'forget-me': forgetMe.handle,
};

const buttonHandlers = {
  umn_verify_start: buttons.handleVerifyStart,
  umn_verify_code_prompt: buttons.handleCodePrompt,
  forget_me_cancel: buttons.handleForgetMeCancel,
  forget_me_confirm: buttons.handleForgetMeConfirm,
};

const modalHandlers = {
  umn_verify_email_modal: modals.handleEmailModal,
  umn_verify_code_modal: modals.handleCodeModal,
};

// Commands that must run regardless of whether the guild has been
// configured: /setup configures it, /forget-me is a user-data action
// that works in any guild (and DMs).
const COMMANDS_BYPASSING_CONFIG_GATE = new Set(['setup', 'forget-me']);

async function dispatch(interaction, deps) {
  const { db } = deps;

  if (interaction.isChatInputCommand?.()) {
    const { commandName } = interaction;
    const handler = chatHandlers[commandName];
    if (!handler) return;

    if (!COMMANDS_BYPASSING_CONFIG_GATE.has(commandName)) {
      const guildConfig = interaction.guild ? db.getGuildConfig(interaction.guild.id) : null;
      if (!guildConfig) {
        return interaction.reply({
          content: "⚠️ This server hasn't been configured yet. Ask an admin to run `/setup` first.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    return handler(interaction, deps);
  }

  if (interaction.isButton?.()) {
    const handler = buttonHandlers[interaction.customId];
    if (!handler) return;
    return handler(interaction, deps);
  }

  if (interaction.isModalSubmit?.()) {
    const handler = modalHandlers[interaction.customId];
    if (!handler) return;
    return handler(interaction, deps);
  }
}

module.exports = {
  dispatch,
  chatHandlers,
  buttonHandlers,
  modalHandlers,
};
