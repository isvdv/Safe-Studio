const {
  MessageFlags,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../config');

function extractRoleIds(interaction) {
  const roles = interaction.member?.roles;

  if (Array.isArray(roles)) {
    return roles.map((roleId) => String(roleId));
  }

  if (roles?.cache) {
    return [...roles.cache.keys()].map((roleId) => String(roleId));
  }

  return [];
}

function canUseTebexAdminCommands(interaction) {
  if (!interaction.inGuild()) return false;

  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const configuredRoleIds = config.discord?.adminRoleIds || [];
  if (configuredRoleIds.length === 0) return false;

  const memberRoleIds = new Set(extractRoleIds(interaction));
  return configuredRoleIds.some((roleId) => memberRoleIds.has(String(roleId)));
}

// Mesma regra dos comandos admin, mas para mensagens comuns (ex.: !say).
function isGuildMemberAdmin(member) {
  if (!member) return false;

  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) {
    return true;
  }

  const configuredRoleIds = config.discord?.adminRoleIds || [];
  if (configuredRoleIds.length === 0) return false;

  const memberRoleIds = member.roles?.cache
    ? new Set([...member.roles.cache.keys()].map(String))
    : new Set();

  return configuredRoleIds.some((roleId) => memberRoleIds.has(String(roleId)));
}

async function requireTebexAdmin(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'Use este comando dentro de um servidor.',
      flags: MessageFlags.Ephemeral,
    }).catch(() => {});
    return false;
  }

  if (canUseTebexAdminCommands(interaction)) {
    return true;
  }

  await interaction.reply({
    content: 'Sem permissao para usar este comando.',
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});

  return false;
}

function truncate(text, maxLength = 1024) {
  const value = String(text ?? '');
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatIsoUtc(value) {
  if (!value) return '-';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function formatUnixUtc(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';

  return new Date(timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function chunkArray(items, size) {
  const list = Array.isArray(items) ? items : [];
  const chunkSize = Number.isFinite(size) && size > 0 ? size : 1;
  const chunks = [];

  for (let index = 0; index < list.length; index += chunkSize) {
    chunks.push(list.slice(index, index + chunkSize));
  }

  return chunks;
}

function buildTebexFooter() {
  return {
    text: 'Tebex admin',
  };
}

function formatCommandError(error, fallbackMessage) {
  const message = String(error?.message || '').trim();

  if (message === 'TEBEX_PLUGIN_SECRET is not configured.') {
    return 'Configure TEBEX_PLUGIN_SECRET no .env para usar estes comandos.';
  }

  if (message) {
    return truncate(message, 1900);
  }

  return fallbackMessage;
}

module.exports = {
  buildTebexFooter,
  chunkArray,
  formatCommandError,
  formatIsoUtc,
  formatUnixUtc,
  isGuildMemberAdmin,
  requireTebexAdmin,
  truncate,
};
