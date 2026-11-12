const fs = require('fs');
const path = require('path');
const util = require('util');

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_LABELS = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'AVISO',
  error: 'ERRO ',
};

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

const LEVEL_COLORS = {
  debug: ANSI.gray,
  info: ANSI.cyan,
  warn: ANSI.yellow,
  error: ANSI.red,
};

// Guardamos as funcoes originais antes de qualquer interceptacao do console.
const rawConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  debug: console.debug.bind(console),
};

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(value).trim().toLowerCase());
}

function resolveMinLevel() {
  const configured = String(process.env.LOG_LEVEL || 'info').trim().toLowerCase();
  return LEVELS[configured] ?? LEVELS.info;
}

const settings = {
  minLevel: resolveMinLevel(),
  colors: parseBoolean(process.env.LOG_COLORS, Boolean(process.stdout.isTTY)),
  fileEnabled: parseBoolean(process.env.LOG_TO_FILE, false),
  fileDir: path.resolve(process.env.LOG_DIR || './logs'),
};

function paint(color, text) {
  if (!settings.colors || !color) return text;
  return `${color}${text}${ANSI.reset}`;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTime(date = new Date()) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatDay(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatArgs(args) {
  return args.map((arg) => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return arg.stack || arg.message;
    return util.inspect(arg, { depth: 4, colors: false, breakLength: 120 });
  }).join(' ');
}

// ---------- Arquivo de log (opcional) ----------

let fileStream = null;
let fileStreamDay = null;

function writeToFile(line) {
  if (!settings.fileEnabled) return;

  try {
    const day = formatDay();

    if (!fileStream || fileStreamDay !== day) {
      if (fileStream) fileStream.end();
      fs.mkdirSync(settings.fileDir, { recursive: true });
      fileStream = fs.createWriteStream(path.join(settings.fileDir, `${day}.log`), { flags: 'a' });
      fileStreamDay = day;
    }

    fileStream.write(`${line}\n`);
  } catch (error) {
    settings.fileEnabled = false;
    rawConsole.error(`[Logger] Arquivo de log desativado: ${error.message}`);
  }
}

// ---------- Envio de avisos/erros para o Discord ----------

const DISCORD_FLUSH_MS = 5000;
const DISCORD_MAX_DESCRIPTION = 3900;
const DISCORD_MAX_QUEUE = 50;

const discordSink = {
  client: null,
  channelId: '',
  minLevel: LEVELS.warn,
  queue: [],
  timer: null,
  sending: false,
};

function enqueueDiscord(level, scope, message) {
  if (!discordSink.client || !discordSink.channelId) return;
  if (LEVELS[level] < discordSink.minLevel) return;

  if (discordSink.queue.length >= DISCORD_MAX_QUEUE) {
    discordSink.queue.shift();
  }

  discordSink.queue.push({
    level,
    scope,
    message,
    time: formatTime(),
  });

  if (!discordSink.timer) {
    discordSink.timer = setTimeout(() => {
      discordSink.timer = null;
      void flushDiscord();
    }, DISCORD_FLUSH_MS);
    discordSink.timer.unref?.();
  }
}

async function flushDiscord() {
  if (discordSink.sending || discordSink.queue.length === 0) return;
  discordSink.sending = true;

  const entries = discordSink.queue.splice(0, discordSink.queue.length);

  try {
    const client = discordSink.client;
    if (!client?.isReady?.()) return;

    const channel = client.channels.cache.get(discordSink.channelId)
      || await client.channels.fetch(discordSink.channelId).catch(() => null);

    if (!channel || !channel.isTextBased?.()) return;

    const hasError = entries.some((entry) => entry.level === 'error');
    let description = entries.map((entry) => {
      const icon = entry.level === 'error' ? '🔴' : '🟡';
      const scope = entry.scope ? `[${entry.scope}] ` : '';
      const message = entry.message.length > 900
        ? `${entry.message.slice(0, 897)}...`
        : entry.message;
      return `${icon} \`${entry.time}\` ${scope}${message}`;
    }).join('\n');

    if (description.length > DISCORD_MAX_DESCRIPTION) {
      description = `${description.slice(0, DISCORD_MAX_DESCRIPTION - 3)}...`;
    }

    await channel.send({
      embeds: [{
        color: hasError ? 0xe74c3c : 0xf1c40f,
        title: hasError ? 'Erros no bot' : 'Avisos do bot',
        description,
        footer: { text: `${entries.length} registro(s)` },
        timestamp: new Date().toISOString(),
      }],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    // Nunca logar por meio do logger aqui para nao criar loop.
    rawConsole.error(`[Logger] Falha ao enviar logs para o Discord: ${error.message}`);
  } finally {
    discordSink.sending = false;
  }
}

function attachDiscord(client, channelId, options = {}) {
  const id = String(channelId || '').trim();
  if (!client || !/^\d{17,20}$/.test(id)) return false;

  discordSink.client = client;
  discordSink.channelId = id;

  const minLevelName = String(options.minLevel || process.env.LOG_DISCORD_LEVEL || 'warn').toLowerCase();
  discordSink.minLevel = LEVELS[minLevelName] ?? LEVELS.warn;
  return true;
}

// ---------- Nucleo ----------

function write(level, scope, args) {
  if (LEVELS[level] < settings.minLevel) return;

  const now = new Date();
  const message = formatArgs(args);
  const scopeText = scope ? `[${scope}] ` : '';
  const plainLine = `${formatDay(now)} ${formatTime(now)} ${LEVEL_LABELS[level]} ${scopeText}${message}`;

  const coloredLine = [
    paint(ANSI.gray, formatTime(now)),
    paint(LEVEL_COLORS[level], LEVEL_LABELS[level]),
    scope ? paint(ANSI.magenta, `[${scope}]`) : null,
    message,
  ].filter(Boolean).join(' ');

  const writer = level === 'error'
    ? rawConsole.error
    : level === 'warn'
      ? rawConsole.warn
      : rawConsole.log;

  writer(coloredLine);
  writeToFile(plainLine);
  enqueueDiscord(level, scope, message);
}

function createLogger(scope = '') {
  return {
    scope,
    debug: (...args) => write('debug', scope, args),
    info: (...args) => write('info', scope, args),
    warn: (...args) => write('warn', scope, args),
    error: (...args) => write('error', scope, args),
    child: (childScope) => createLogger(scope ? `${scope}:${childScope}` : childScope),
  };
}

// Extrai um prefixo "[Escopo]" do inicio da primeira mensagem, usado
// para manter compativel o codigo antigo que ainda chama console.*.
function splitLegacyScope(args) {
  if (typeof args[0] !== 'string') return { scope: '', args };

  const match = args[0].match(/^\[([^\]]{1,40})\]:?\s*(.*)$/s);
  if (!match) return { scope: '', args };

  const rest = match[2];
  const nextArgs = rest ? [rest, ...args.slice(1)] : args.slice(1);
  return { scope: match[1], args: nextArgs };
}

let consoleInstalled = false;

function installConsole() {
  if (consoleInstalled) return;
  consoleInstalled = true;

  const map = {
    log: 'info',
    info: 'info',
    warn: 'warn',
    error: 'error',
    debug: 'debug',
  };

  for (const [method, level] of Object.entries(map)) {
    console[method] = (...args) => {
      const legacy = splitLegacyScope(args);
      write(level, legacy.scope, legacy.args);
    };
  }
}

// ---------- Painel de inicializacao ----------

function printBanner(title, sections) {
  const lines = [];
  const width = 56;
  const rule = '─'.repeat(width);

  lines.push(paint(ANSI.green, `┌${rule}┐`));
  lines.push(paint(ANSI.green, '│ ') + paint(ANSI.bold, title.padEnd(width - 2)) + paint(ANSI.green, ' │'));
  lines.push(paint(ANSI.green, `└${rule}┘`));

  for (const section of sections) {
    if (section.title) {
      lines.push('');
      lines.push(paint(ANSI.bold, section.title));
    }

    for (const row of section.rows || []) {
      const status = row.status || 'info';
      const icon = status === 'ok'
        ? paint(ANSI.green, '✔')
        : status === 'warn'
          ? paint(ANSI.yellow, '!')
          : status === 'error'
            ? paint(ANSI.red, '✖')
            : paint(ANSI.gray, '•');
      const label = String(row.label).padEnd(22);
      lines.push(`  ${icon} ${label} ${row.value ?? ''}`);
    }
  }

  lines.push('');
  rawConsole.log(lines.join('\n'));

  const plain = sections
    .flatMap((section) => (section.rows || []).map((row) => `${row.status || 'info'} ${row.label}: ${row.value ?? ''}`))
    .join(' | ');
  writeToFile(`${formatDay()} ${formatTime()} INFO  [Inicio] ${title} | ${plain}`);
}

async function shutdownLogger() {
  if (discordSink.timer) {
    clearTimeout(discordSink.timer);
    discordSink.timer = null;
  }

  await flushDiscord().catch(() => {});

  if (fileStream) {
    await new Promise((resolve) => fileStream.end(resolve));
    fileStream = null;
  }
}

const rootLogger = createLogger('');

module.exports = {
  attachDiscord,
  createLogger,
  installConsole,
  logger: rootLogger,
  printBanner,
  shutdownLogger,
  settings,
};
