# Safe Studio

Bot de Discord em Node.js usando `discord.js` v14. O projeto reune ferramentas de moderacao, tickets, sorteios, integracao Tebex e paineis administrativos.

> Este projeto usa a API oficial de bot do Discord. Ele nao automatiza contas de usuario e nao implementa self-bot de conta pessoal.

## Recursos

- Sistema anti self-bot/anti spam para canal protegido.
- Punicao automatica com timeout, kick ou ban.
- Cargo temporario durante castigo, com remocao automatica apos o prazo.
- Logs de punicoes em canal configurado.
- Sistema de tickets com transcript.
- Sorteios com painel interativo.
- Boas-vindas com banner.
- Integracao Tebex para produtos, pagamentos, claims e paineis.
- Registro automatico de slash commands.

## Requisitos

- Node.js 20.18 ou superior.
- Um aplicativo/bot criado no Discord Developer Portal.
- Intents habilitadas no portal:
  - Server Members Intent
  - Message Content Intent
  - Presence Intent, se usar contagem/status por cargo

## Instalacao

```bash
npm install
```

Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

No Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Preencha o `.env` com o token do bot e as chaves que for usar.

## Variaveis de ambiente

| Variavel | Obrigatoria | Descricao |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Sim | Token do bot Discord. |
| `ADMIN_ROLE_IDS` | Nao | IDs de cargos administradores, separados por virgula. |
| `DISCORD_GUILD_IDS` | Nao | IDs dos servidores onde os comandos devem ser registrados. |
| `DISCORD_COMMAND_SCOPE` | Nao | Use `guild` para comandos por servidor ou `global` para comandos globais. |
| `WELCOME_ROLE_ID` | Nao | Cargo entregue no evento de boas-vindas. |
| `PRESENCE_CLIENT_ROLE_ID` | Nao | Cargo usado para contar clientes no status do bot. |
| `TEBEX_PURCHASE_CHANNEL_ID` | Nao | Canal para notificacoes de compras Tebex. |
| `TEBEX_PUBLIC_TOKEN` | Nao | Token publico da loja Tebex. |
| `TEBEX_PRIVATE_KEY` | Nao | Chave privada Tebex, usada em fluxos especificos. |
| `TEBEX_PLUGIN_SECRET` | Nao | Secret da Tebex Plugin API. |
| `TEBEX_WEBHOOK_SECRET` | Nao | Secret para validar webhooks Tebex. |
| `TEBEX_WEBHOOK_PATH` | Nao | Caminho do webhook. Padrao: `/webhooks/tebex`. |
| `TEBEX_COMPLETE_URL` | Nao | URL de sucesso para checkout. |
| `TEBEX_CANCEL_URL` | Nao | URL de cancelamento para checkout. |
| `TEBEX_PACKAGE_ROLE_MAP` | Nao | JSON no formato `{ "package_id": "role_id" }`. |
| `LOG_LEVEL` | Nao | Nivel minimo no console: `debug`, `info`, `warn` ou `error`. Padrao: `info`. |
| `LOG_CHANNEL_ID` | Nao | Canal que recebe avisos e erros agrupados a cada 5 segundos. |
| `LOG_DISCORD_LEVEL` | Nao | Nivel minimo enviado ao canal: `warn` (padrao) ou `error`. |
| `LOG_COLORS` | Nao | `true`/`false` para forcar cores no terminal. Padrao: automatico. |
| `LOG_TO_FILE` | Nao | `true` salva logs diarios em `logs/AAAA-MM-DD.log`. |
| `HTTP_RATE_LIMIT_PER_MINUTE` | Nao | Limite de POSTs por IP por minuto nas rotas `/api`. Padrao: 20. |

> Sem `TEBEX_WEBHOOK_SECRET` o bot recusa todos os webhooks Tebex, para impedir pagamentos forjados.

## Como iniciar

```bash
npm start
```

Ao iniciar, o bot:

- Faz login no Discord.
- Registra slash commands.
- Carrega eventos da pasta `Events`.
- Inicializa o servidor HTTP usado pelas APIs/webhooks Tebex.
- Inicia o agendador de remocao de cargos temporarios do anti self-bot.

## Console e logs

Toda linha do console sai com horario, nivel e modulo, por exemplo:

```txt
20:31:04 INFO  [HTTP] Servidor ouvindo em http://0.0.0.0:3000 (webhook em /webhooks/tebex)
20:31:06 AVISO [Boas-vindas] Canal 123... nao encontrado ou invalido em Meu Servidor.
```

Quando o bot conecta, aparece um painel com a conta, servidores, comandos e eventos carregados, a porta HTTP e um checklist da configuracao (o webhook sem secret aparece em vermelho).

Em codigo novo, use o logger em vez de `console.log`:

```js
const { createLogger } = require('./utils/logger');
const log = createLogger('MeuModulo');
log.info('Tudo certo');
log.error('Falhou:', error);
```

O bot tambem desliga de forma limpa com Ctrl+C ou restart da hospedagem: fecha o servidor HTTP, para os agendadores e envia os ultimos erros ao canal de logs.

## Comandos principais

| Comando | Descricao |
| --- | --- |
| `/selfbot configurar` | Configura canal protegido, punicao, logs e cargo temporario. |
| `/selfbot painel` | Reenvia o aviso do canal protegido. |
| `/selfbot status` | Mostra a configuracao atual do anti self-bot. |
| `/selfbot desativar` | Desativa o monitoramento do canal protegido. |
| `/ticket` | Abre o editor/painel de tickets. |
| `/trascript` | Gera transcript e fecha o ticket atual. |
| `/sorteio` | Abre o painel de sorteios. |
| `/claim` | Resgata compras Tebex pendentes. |
| `/claim-panel` | Publica o painel de claim. |
| `/tebex-panel` | Abre painel administrativo Tebex. |
| `/products` | Lista produtos Tebex. |
| `/recentpayments` | Lista pagamentos recentes. |
| `/verify` | Consulta uma transacao Tebex. |
| `/createurl` | Cria URL de pagamento Tebex. |
| `/updateproduct` | Atualiza produto Tebex. |

## Anti self-bot

O sistema monitora um canal protegido. Quando um usuario envia mensagem nesse canal, o bot:

1. Apaga a mensagem.
2. Aplica a punicao configurada.
3. Adiciona o cargo temporario de castigo, quando configurado.
4. Registra a acao no canal de logs.
5. Remove o cargo automaticamente quando o prazo termina.

Exemplo:

```txt
/selfbot configurar canal:#canal punicao:Timeout duracao_minutos:10080 canal_logs:#logs cargo_castigo:@Castigo
```

Para funcionar corretamente, o cargo do bot precisa estar acima do cargo temporario e dos membros que ele vai moderar.

Permissoes recomendadas:

- Ver canal
- Enviar mensagens
- Gerenciar mensagens
- Moderar membros
- Gerenciar cargos
- Expulsar membros, se usar kick
- Banir membros, se usar ban

## Dados locais

Arquivos em `data/` guardam estado de tickets, sorteios, compras e castigos pendentes. Eles ficam ignorados no Git para evitar publicar dados de servidores e usuarios.

O `.env` tambem fica ignorado. Nunca publique token do bot, secrets Tebex ou chaves privadas.

## Estrutura

```txt
Commands/     Slash commands
Events/       Eventos carregados pelo handler
Handler/      Carregadores de comandos e eventos
services/     Servicos externos
utils/        Modulos de negocio e builders de mensagens
assets/       Imagens e arquivos estaticos
data/         Estado local em runtime, ignorado pelo Git
```

## Scripts

```bash
npm start
```

O script acima executa `node index.js`.

## Licenca

ISC
