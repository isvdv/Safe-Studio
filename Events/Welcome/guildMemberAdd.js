const { Events, PermissionFlagsBits } = require('discord.js');
const {
  WELCOME_CHANNEL_ID,
  WELCOME_ROLE_ID,
  buildWelcomeMessage,
} = require('../../utils/welcome');

module.exports = {
  name: Events.GuildMemberAdd,
  async execute(member) {
    if (!member?.guild || member.user?.bot) return;

    const botMember = member.guild.members.me
      || await member.guild.members.fetchMe().catch(() => null);

    const autoRole = member.guild.roles.cache.get(WELCOME_ROLE_ID)
      || await member.guild.roles.fetch(WELCOME_ROLE_ID).catch(() => null);

    if (!autoRole) {
      console.warn(`[Boas-vindas] Cargo ${WELCOME_ROLE_ID} nao encontrado em ${member.guild.name}.`);
    } else if (!botMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
      console.warn(`[Boas-vindas] Sem permissao "Gerenciar cargos" para dar ${autoRole.name} (${autoRole.id}).`);
    } else if (botMember.roles.highest.comparePositionTo(autoRole) <= 0) {
      console.warn(`[Boas-vindas] Nao posso dar ${autoRole.name} (${autoRole.id}): cargo acima do bot na hierarquia.`);
    } else if (!member.roles.cache.has(autoRole.id)) {
      await member.roles.add(autoRole, 'Automatic welcome role assignment').catch((error) => {
        console.error(`[Boas-vindas] Falha ao dar o cargo ${autoRole.id} para ${member.user.tag}:`, error);
      });
    }

    const welcomeChannel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID)
      || await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(() => null);

    if (!welcomeChannel?.isTextBased()) {
      console.warn(`[Boas-vindas] Canal ${WELCOME_CHANNEL_ID} nao encontrado ou invalido em ${member.guild.name}.`);
      return;
    }

    const permissions = welcomeChannel.permissionsFor(botMember);
    if (!permissions?.has(PermissionFlagsBits.SendMessages)) {
      console.warn(`[Boas-vindas] Sem permissao para enviar mensagens em #${welcomeChannel.name} (${welcomeChannel.id}).`);
      return;
    }

    await welcomeChannel.send(
      buildWelcomeMessage(member),
    ).catch((error) => {
      console.error(`[Boas-vindas] Falha ao enviar boas-vindas para ${member.user.tag}:`, error);
    });
  },
};
