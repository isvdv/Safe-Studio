const {
  attachDiscord,
  createLogger,
  installConsole,
  printBanner,
  shutdownLogger,
  settings: logSettings,
} = require('./utils/logger');

// Instala o logger antes de carregar qualquer outro modulo, para que
// todos os console.* antigos ja saiam com horario, nivel e escopo.
installConsole();

const { ActivityType, Client, EmbedBuilder, Events, IntentsBitField, Partials, InteractionType } = require('discord.js');
const { startTebexServer } = require('./utils/tebexServer');
const {
  getClaimSnapshotForDiscord,
  processClaimForMember,
} = require('./utils/claimFlow');
const {
  buildClaimErrorMessage,
  buildClaimResultMessage,
  buildClaimStatusMessage,
} = require('./utils/claimPanel');
const {
  handleSelfBotTrapMessage,
  startSelfBotRoleRemovalScheduler,
} = require('./utils/selfBotTrap');
const { buildTebexPanelMessage } = require('./utils/tebexPanel');
const { TEBEX_EVENTS, tebexEvents } = require('./utils/tebexEvents');
const { isGuildMemberAdmin } = require('./utils/tebexAdmin');
const config = require('./config');
const packageInfo = require('./package.json');

const log = createLogger('Bot');
const CLIENT_ROLE_COUNT_REFRESH_MS = 5 * 60 * 1000;

const client = new Client({
  intents: [
    IntentsBitField.Flags.DirectMessages,
    IntentsBitField.Flags.GuildInvites,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.GuildPresences,
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.MessageContent,
    IntentsBitField.Flags.GuildMessageReactions,
    IntentsBitField.Flags.GuildEmojisAndStickers,
    IntentsBitField.Flags.GuildVoiceStates,
  ],
  partials: [
    Partials.User,
    Partials.Message,
    Partials.Reaction,
    Partials.Channel,
    Partials.GuildMember,
  ],
});

function getRamUsageText() {
  const ramInMb = process.memoryUsage().rss / 1024 / 1024;
  return `RAM: ${ramInMb.toFixed(1)} MB`;
}

function getUptimeText() {
  const totalSeconds = Math.floor(process.uptime());
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) return `Uptime: ${hours}h ${minutes}m`;
  return `Uptime: ${minutes}m`;
}

async function resolvePresenceClientRole() {
  const roleId = config.discord.presenceClientRoleId;
  if (!roleId) return null;

  const cachedRoleRef = client.presenceClientRoleRef;
  if (cachedRoleRef) {
    const guild = client.guilds.cache.get(cachedRoleRef.guildId);
    const cachedRole = guild?.roles.cache.get(roleId)
      || await guild?.roles.fetch(roleId).catch(() => null);

    if (cachedRole) {
      return cachedRole;
    }
  }

  for (const guild of client.guilds.cache.values()) {
    const role = guild.roles.cache.get(roleId)
      || await guild.roles.fetch(roleId).catch(() => null);

    if (role) {
      client.presenceClientRoleRef = {
        guildId: guild.id,
        roleId: role.id,
      };
      return role;
    }
  }

  return null;
}

async function getClientRoleMemberCount() {
  const matchedRole = await resolvePresenceClientRole();
  if (!matchedRole) return 0;

  const now = Date.now();
  const lastSyncAt = client.presenceClientRoleMembersSyncedAt ?? 0;

  try {
    if (!lastSyncAt || (now - lastSyncAt) >= CLIENT_ROLE_COUNT_REFRESH_MS) {
      await matchedRole.guild.members.fetch();
      client.presenceClientRoleMembersSyncedAt = now;
    }
  } catch (error) {
    createLogger('Presenca').warn('Nao consegui atualizar o cache de membros para contar clientes:', error.message);
  }

  return matchedRole.members.size;
}

async function getPresenceOptions() {
  return [
    {
      name: getRamUsageText(),
      type: ActivityType.Watching,
    },
    {
      name: `${await getClientRoleMemberCount()} clientes`,
      type: ActivityType.Watching,
    },
    {
      name: getUptimeText(),
      type: ActivityType.Playing,
    },
  ];
}

async function updateBotPresence() {
  if (!client.user) return;

  if (client.presenceUpdateRunning) return;
  client.presenceUpdateRunning = true;

  try {
    const presenceOptions = await getPresenceOptions();
    client.presenceIndex = (client.presenceIndex ?? 0) % presenceOptions.length;
    const presence = presenceOptions[client.presenceIndex];

    client.user.setPresence({
      activities: [
        presence,
      ],
      status: 'online',
    });

    client.presenceIndex += 1;
  } catch (error) {
    createLogger('Presenca').error('Falha ao atualizar status do bot:', error);
  } finally {
    client.presenceUpdateRunning = false;
  }
}

function formatMemoryMb() {
  return `${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`;
}

function buildConfigChecks() {
  const tebex = config.tebex || {};
  const discord = config.discord || {};
  const hasWebhookSecret = Boolean(String(tebex.webhookSecret || '').trim());

  return [
    {
      label: 'Cargos admin',
      status: discord.adminRoleIds?.length ? 'ok' : 'warn',
      value: discord.adminRoleIds?.length
        ? `${discord.adminRoleIds.length} cargo(s)`
        : 'nenhum (so quem tem Administrador usa comandos admin)',
    },
    {
      label: 'Webhook Tebex',
      status: hasWebhookSecret ? 'ok' : 'error',
      value: hasWebhookSecret
        ? 'secret configurado'
        : 'SEM TEBEX_WEBHOOK_SECRET: webhooks serao recusados',
    },
    {
      label: 'Tebex Plugin API',
      status: tebex.pluginSecret ? 'ok' : 'warn',
      value: tebex.pluginSecret ? 'configurada' : 'TEBEX_PLUGIN_SECRET vazio',
    },
    {
      label: 'Tebex Headless',
      status: tebex.publicToken ? 'ok' : 'warn',
      value: tebex.publicToken ? 'configurada' : 'TEBEX_PUBLIC_TOKEN vazio',
    },
    {
      label: 'Canal de compras',
      status: discord.tebexPurchaseChannelId ? 'ok' : 'info',
      value: discord.tebexPurchaseChannelId || 'nao definido',
    },
    {
      label: 'Canal de logs',
      status: discord.logChannelId ? 'ok' : 'info',
      value: discord.logChannelId || 'nao definido (LOG_CHANNEL_ID)',
    },
  ];
}

function printStartupPanel() {
  const httpInfo = tebexServer?.info;
  const loadedEvents = client.loadedEvents?.length ?? 0;
  const loadedCommands = client.slashCommands?.size ?? 0;

  printBanner(`Safe Studio v${packageInfo.version} online`, [
    {
      title: 'Bot',
      rows: [
        { label: 'Conta', status: 'ok', value: `${client.user.tag} (${client.user.id})` },
        { label: 'Servidores', status: 'ok', value: client.guilds.cache.size },
        { label: 'Comandos', status: loadedCommands ? 'ok' : 'warn', value: loadedCommands },
        { label: 'Eventos', status: loadedEvents ? 'ok' : 'warn', value: loadedEvents },
        {
          label: 'Servidor HTTP',
          status: httpInfo ? 'ok' : 'error',
          value: httpInfo ? `porta ${httpInfo.port}` : 'nao iniciou',
        },
        { label: 'Node / memoria', status: 'info', value: `${process.version} / ${formatMemoryMb()}` },
        {
          label: 'Logs',
          status: 'info',
          value: `nivel ${process.env.LOG_LEVEL || 'info'}${logSettings.fileEnabled ? ', salvando em logs/' : ''}`,
        },
      ],
    },
    {
      title: 'Configuracao',
      rows: buildConfigChecks(),
    },
  ]);
}

// Evento ready
client.once(Events.ClientReady, () => {
  try {
    if (attachDiscord(client, config.discord.logChannelId)) {
      log.debug(`Avisos e erros serao enviados para o canal ${config.discord.logChannelId}.`);
    }

    printStartupPanel();

    updateBotPresence();
    client.presenceInterval = setInterval(updateBotPresence, 10 * 1000);
    startSelfBotRoleRemovalScheduler(client);
  } catch (error) {
    log.error('Erro no evento ready:', error);
  }
});

client.on(Events.ShardDisconnect, (event) => {
  log.warn(`Desconectado do Discord (codigo ${event?.code ?? '?'}). Tentando reconectar...`);
});

client.on(Events.ShardReconnecting, () => {
  log.info('Reconectando ao Discord...');
});

client.on(Events.ShardResume, (_shardId, replayed) => {
  log.info(`Conexao com o Discord restabelecida (${replayed} eventos reenviados).`);
});

client.on(Events.Error, (error) => {
  log.error('Erro do cliente Discord:', error);
});

// Carrega handlers de comandos e eventos
try {
  require('./Handler/commands')(client);
  require('./Handler/events')(client);
} catch (error) {
  log.error('Erro ao carregar handlers:', error);
}

// Lida com interacoes de comandos de barra e botoes administrativos
function parseTebexPanelCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts.length !== 4) return null;

  if (parts[0] !== 'tebex' || parts[1] !== 'panel') return null;

  const action = parts[2];
  const ownerId = parts[3];

  if (!['overview', 'keys', 'refresh', 'refresh-overview', 'refresh-keys'].includes(action)) return null;

  return {
    action,
    ownerId,
  };
}

function parseClaimPanelCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts.length !== 3) return null;

  if (parts[0] !== 'claim' || parts[1] !== 'panel') return null;

  const action = parts[2];
  if (!['status', 'redeem'].includes(action)) return null;

  return {
    action,
  };
}

async function handleClaimPanelInteraction(interaction) {
  if (!interaction.isButton()) return false;

  const parsed = parseClaimPanelCustomId(interaction.customId);
  if (!parsed) return false;

  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'Use o painel de claim dentro de um servidor.',
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  const botAvatarUrl = interaction.client.user?.displayAvatarURL({ size: 256 }) || '';

  await interaction.deferReply({ ephemeral: true });

  try {
    if (parsed.action === 'status') {
      const snapshot = await getClaimSnapshotForDiscord(interaction.user.id);

      await interaction.editReply(
        await buildClaimStatusMessage(snapshot, {
          ephemeral: true,
          includeBanner: false,
          botAvatarUrl,
        }),
      );
      return true;
    }

    const result = await processClaimForMember({
      guild: interaction.guild,
      userId: interaction.user.id,
      member: interaction.member,
    });

    await interaction.editReply(
      await buildClaimResultMessage(result, {
        ephemeral: true,
        includeBanner: false,
        botAvatarUrl,
      }),
    );
  } catch (error) {
    createLogger('Claim').error('Falha ao processar interacao do painel:', error);
    await interaction.editReply(
      await buildClaimErrorMessage(
        'Nao consegui consultar seu claim agora. Tente novamente em alguns segundos.',
        {
          ephemeral: true,
          includeBanner: false,
          botAvatarUrl,
        },
      ),
    ).catch(() => {});
  }

  return true;
}

async function handleTebexPanelInteraction(interaction) {
  if (!interaction.isButton()) return false;

  const parsed = parseTebexPanelCustomId(interaction.customId);
  if (!parsed) return false;

  if (parsed.ownerId && parsed.ownerId !== interaction.user.id) {
    await interaction.reply({
      content: 'Este painel pertence a outro administrador. Rode /tebex-panel para abrir o seu.',
      ephemeral: true,
    }).catch(() => {});
    return true;
  }

  const mode = (parsed.action === 'keys' || parsed.action === 'refresh-keys') ? 'keys' : 'overview';

  try {
    const panelMessage = await buildTebexPanelMessage(interaction.user.id, {
      mode,
      ephemeral: false,
    });

    await interaction.update(panelMessage);
  } catch (error) {
    createLogger('Tebex').error('Erro ao atualizar painel:', error);

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: 'Falha ao atualizar painel Tebex agora.',
        components: [],
      }).catch(() => {});
    } else {
      await interaction.reply({
        content: 'Falha ao atualizar painel Tebex agora.',
        ephemeral: true,
      }).catch(() => {});
    }
  }

  return true;
}

client.on(Events.InteractionCreate, async (interaction) => {
  const handledClaimPanel = await handleClaimPanelInteraction(interaction);
  if (handledClaimPanel) return;

  const handledTebexPanel = await handleTebexPanelInteraction(interaction);
  if (handledTebexPanel) return;

  if (interaction.type === InteractionType.ApplicationCommand) {
    const command = client.slashCommands.get(interaction.commandName);
    if (!command) {
      await interaction.reply({ content: 'Algo deu errado! Comando nao encontrado.', ephemeral: true }).catch(() => {});
      return;
    }

    try {
      await command.run(client, interaction);
    } catch (error) {
      createLogger('Comandos').error(`Erro ao executar /${interaction.commandName} (por ${interaction.user?.tag}):`, error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Erro ao executar o comando!', ephemeral: true }).catch(() => {});
      }
    }
  }
});
function formatNotificationDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '-');
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function truncateText(value, maxLength = 1024) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

async function sendTebexPurchaseNotification(payload) {
  const channelId = String(config.discord?.tebexPurchaseChannelId || '').trim();
  if (!channelId) return;

  const channel = client.channels.cache.get(channelId)
    || await client.channels.fetch(channelId).catch(() => null);

  if (!channel || !channel.isTextBased()) {
    createLogger('Tebex').warn(`Canal de compras invalido ou inacessivel: ${channelId}`);
    return;
  }

  const packageNames = Array.isArray(payload?.packages) && payload.packages.length > 0
    ? payload.packages.map((item) => item.name || item.id).filter(Boolean).join(', ')
    : '-';
  const amountLabel = [payload?.amount || '-', payload?.currency || ''].filter(Boolean).join(' ');

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('Nova compra Tebex')
    .setDescription('Uma nova compra foi confirmada e registrada no armazenamento local.')
    .addFields(
      {
        name: 'Player',
        value: truncateText(payload?.playerName || '-', 1024),
        inline: true,
      },
      {
        name: 'Pagamento',
        value: truncateText(payload?.paymentId || '-', 1024),
        inline: true,
      },
      {
        name: 'Valor',
        value: truncateText(amountLabel || '-', 1024),
        inline: true,
      },
      {
        name: 'Discord ID',
        value: truncateText(payload?.discordId || '-', 1024),
        inline: true,
      },
      {
        name: 'Pacotes',
        value: truncateText(packageNames, 1024),
        inline: false,
      },
      {
        name: 'Registro local',
        value: `Novos: ${Number(payload?.created || 0)} | Atualizados: ${Number(payload?.updated || 0)}`,
        inline: false,
      },
      {
        name: 'Data UTC',
        value: formatNotificationDate(payload?.date),
        inline: false,
      },
    )
    .setTimestamp(new Date());

  await channel.send({
    embeds: [embed],
    allowedMentions: {
      parse: [],
    },
  });
}

tebexEvents.on(TEBEX_EVENTS.PAYMENT_COMPLETED, (payload) => {
  void sendTebexPurchaseNotification(payload).catch((error) => {
    createLogger('Tebex').error('Falha ao enviar notificacao de compra:', error);
  });
});

// Inicializa o servidor HTTP (site + APIs + webhook Tebex)
let tebexServer = null;

try {
  tebexServer = startTebexServer();
} catch (error) {
  log.error('Erro ao iniciar servidor HTTP/Tebex:', error);
}

// Login do bot
if (!config.discord.token) {
  log.error('DISCORD_BOT_TOKEN nao definido no .env. O bot nao vai conectar.');
} else {
  log.info('Conectando ao Discord...');
  client.login(config.discord.token).catch((error) => {
    log.error('Erro ao fazer login (token invalido ou intents desativadas no portal?):', error);
  });
}

// Tratamento de erros globais
process.on('unhandledRejection', (reason) => {
  log.error('Promise rejeitada sem tratamento:', reason);
});

process.on('uncaughtException', (err, origin) => {
  log.error(`Excecao nao tratada (${origin}):`, err);
});

// Desligamento limpo (Ctrl+C, restart da Discloud, etc.)
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`Recebido ${signal}. Desligando com seguranca...`);

  const forceExit = setTimeout(() => process.exit(1), 10 * 1000);
  forceExit.unref();

  for (const key of ['presenceInterval', 'giveawayWatcher', 'selfBotRoleRemovalInterval']) {
    if (client[key]) clearInterval(client[key]);
  }

  if (tebexServer) {
    await new Promise((resolve) => tebexServer.close(() => resolve()));
  }

  await shutdownLogger();
  await client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  try {
    const handledSelfBotTrap = await handleSelfBotTrapMessage(message, client);
    if (handledSelfBotTrap) return;
  } catch (error) {
    createLogger('Selfbot').error('Falha ao processar canal anti self-bot:', error);
  }

  if (/^!say(\s|$)/.test(message.content)) {
    // Apenas administradores (permissao Administrador ou ADMIN_ROLE_IDS).
    if (!message.inGuild() || !isGuildMemberAdmin(message.member)) return;

    const text = message.content.slice(4).trim();

    // Deleta a mensagem original
    await message.delete().catch(() => {});

    if (!text && message.attachments.size === 0) {
      return message.channel.send({
        content: 'Por favor, envie um texto ou uma imagem junto com o comando.',
      });
    }

    const attachment = message.attachments.first();
    // Nunca deixa o !say marcar @everyone, @here, cargos ou pessoas.
    const allowedMentions = { parse: [] };

    try {
      if (attachment && attachment.contentType?.startsWith('image/')) {
        await message.channel.send({
          content: text || undefined,
          files: [attachment.url],
          allowedMentions,
        });
      } else {
        await message.channel.send({ content: text, allowedMentions });
      }

      createLogger('Say').info(`${message.author.tag} usou !say em #${message.channel.name}.`);
    } catch (err) {
      createLogger('Say').error('Erro ao reenviar a mensagem:', err);
      return message.channel.send('Ocorreu um erro ao tentar reenviar a mensagem.');
    }
  }
});

module.exports = { client, tebexServer };

client.transcripts = new Map();
client.jogadorNaFila = null; // Depois de criar o client





