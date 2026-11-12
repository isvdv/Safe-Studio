require('dotenv').config({ quiet: true });

function parseNumberEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJsonEnv(value, fallback) {
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn(`[Config] JSON invalido em variavel de ambiente: ${error.message}`);
    return fallback;
  }
}

function parseIdListEnv(value, fallback = []) {
  if (!value) return fallback;

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => /^\d{17,20}$/.test(item));
}

function sanitizePackageRoleMap(rawMap) {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    return {};
  }

  const sanitized = {};

  for (const [packageId, roleId] of Object.entries(rawMap)) {
    const packageKey = String(packageId).trim();
    const roleValue = String(roleId).trim();

    if (!packageKey || !roleValue) continue;
    sanitized[packageKey] = roleValue;
  }

  return sanitized;
}

const config = {
  discord: {
    token: process.env.DISCORD_BOT_TOKEN,
    color: '00FF7F',
    adminRoleIds: parseIdListEnv(
      process.env.ADMIN_ROLE_IDS || process.env.DISCORD_ADMIN_ROLE_IDS,
      [],
    ),
    presenceClientRoleId: String(
      process.env.PRESENCE_CLIENT_ROLE_ID || '1461496253245423843',
    ).trim(),
    tebexPurchaseChannelId: String(process.env.TEBEX_PURCHASE_CHANNEL_ID || '').trim(),
    logChannelId: String(process.env.LOG_CHANNEL_ID || '').trim(),
  },
  tebex: {
    publicToken: process.env.TEBEX_PUBLIC_TOKEN || '',
    privateKey: process.env.TEBEX_PRIVATE_KEY || '',
    pluginSecret: process.env.TEBEX_PLUGIN_SECRET || process.env.TEBEX_SECRET || '',
    webhookSecret: process.env.TEBEX_WEBHOOK_SECRET || '',
    webhookPath: process.env.TEBEX_WEBHOOK_PATH || '/webhooks/tebex',
    completeUrl: process.env.TEBEX_COMPLETE_URL || '',
    cancelUrl: process.env.TEBEX_CANCEL_URL || '',
    host: process.env.WEB_HOST || '0.0.0.0',
    port: parseNumberEnv(process.env.PORT, parseNumberEnv(process.env.WEB_PORT, 3000)),
    packageRoleMap: sanitizePackageRoleMap(
      parseJsonEnv(process.env.TEBEX_PACKAGE_ROLE_MAP, {}),
    ),
  },
};

module.exports = config;
