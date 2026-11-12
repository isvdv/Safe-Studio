const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { TEBEX_EVENTS, tebexEvents } = require('./tebexEvents');

const PURCHASES_COLLECTION = 'tebex_purchases';
const DATA_DIR = path.join(__dirname, '..', 'data', 'tebex');
const STORAGE_FILE = path.join(DATA_DIR, 'storage.json');
const DEFAULT_STORAGE = {
  purchases: [],
  webhooks: {},
};

let storageQueue = Promise.resolve();

function createStorageError(message, statusCode = 503, details) {
  const error = new Error(message);
  error.statusCode = statusCode;

  if (details) {
    error.details = details;
  }

  return error;
}

function normalizeStorageError(error) {
  if (error?.statusCode) return error;

  return createStorageError(
    `Local Tebex storage unavailable: ${error?.message || 'unknown error'}`,
    503,
    error?.code ? { code: error.code } : undefined,
  );
}

function normalizeDiscordId(value) {
  if (value === null || value === undefined) return null;

  const parsed = String(value).trim();
  if (!/^\d{17,20}$/.test(parsed)) return null;

  return parsed;
}

function firstValidDiscordId(values) {
  for (const value of values) {
    const discordId = normalizeDiscordId(value);
    if (discordId) return discordId;
  }

  return null;
}

function extractDiscordId(subject = {}) {
  const products = Array.isArray(subject.products) ? subject.products : [];
  const variableMatches = [];

  for (const product of products) {
    const variables = Array.isArray(product?.variables) ? product.variables : [];

    for (const variable of variables) {
      const identifier = String(variable?.identifier || '').toLowerCase();

      if (identifier === 'discord_id' || identifier === 'discordid' || identifier === 'discord') {
        variableMatches.push(variable?.option);
      }
    }
  }

  return firstValidDiscordId([
    subject?.custom?.discord_id,
    subject?.basket?.custom?.discord_id,
    ...products.map((product) => product?.custom?.discord_id),
    ...variableMatches,
    subject?.customer?.username?.id,
    subject?.username?.id,
  ]);
}

function extractPaymentId(subject = {}, fallbackId = null) {
  const candidates = [
    subject?.transaction_id,
    subject?.transactionId,
    subject?.payment_id,
    subject?.paymentId,
    subject?.reference,
    fallbackId,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const paymentId = String(candidate).trim();
    if (paymentId) return paymentId;
  }

  return null;
}

function firstNonEmptyString(values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;

    const text = String(value).trim();
    if (text) return text;
  }

  return null;
}

function extractProducts(subject = {}) {
  const products = Array.isArray(subject.products) ? subject.products : [];

  return products
    .map((product) => {
      if (!product || product.id === undefined || product.id === null) return null;

      return {
        id: String(product.id),
        name: product.name ? String(product.name) : null,
      };
    })
    .filter(Boolean);
}

function extractPlayerName(subject = {}) {
  return firstNonEmptyString([
    subject?.player?.name,
    subject?.player?.username,
    subject?.customer?.name,
    subject?.customer?.username,
    subject?.username?.name,
    subject?.username,
    subject?.basket?.username,
  ]);
}

function extractAmount(subject = {}) {
  const directValue = firstNonEmptyString([
    subject?.amount,
    subject?.price,
    subject?.total_price,
    subject?.totalPrice,
  ]);

  if (directValue) return directValue;

  if (subject?.price && typeof subject.price === 'object') {
    return firstNonEmptyString([
      subject.price.amount,
      subject.price.value,
      subject.price.gross,
      subject.price.net,
    ]);
  }

  return null;
}

function extractCurrency(subject = {}) {
  return firstNonEmptyString([
    subject?.currency?.iso_4217,
    subject?.currency?.code,
    subject?.currency,
    subject?.price?.currency,
  ]);
}

function extractPaymentDate(subject = {}) {
  const candidates = [
    subject?.date,
    subject?.created_at,
    subject?.createdAt,
    subject?.time,
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === '') continue;

    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return new Date(candidate * 1000).toISOString();
    }

    const date = new Date(candidate);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }

  return new Date().toISOString();
}

function buildCompletedPaymentEvent(webhookPayload, result) {
  const subject = webhookPayload?.subject || {};
  const packages = extractProducts(subject);

  return {
    webhookId: webhookPayload?.id ? String(webhookPayload.id) : null,
    paymentId: result?.paymentId || extractPaymentId(subject, webhookPayload?.id),
    discordId: result?.discordId || extractDiscordId(subject),
    playerName: extractPlayerName(subject),
    amount: extractAmount(subject),
    currency: extractCurrency(subject),
    date: extractPaymentDate(subject),
    packages,
    created: Number(result?.created || 0),
    updated: Number(result?.updated || 0),
  };
}

function emitCompletedPayment(webhookPayload, result) {
  if (result?.ignored) return;

  tebexEvents.emit(
    TEBEX_EVENTS.PAYMENT_COMPLETED,
    buildCompletedPaymentEvent(webhookPayload, result),
  );
}

function mapEventTypeToStatus(type) {
  if (type === 'payment.completed') return 'completed';
  if (type === 'payment.refunded') return 'refunded';
  if (String(type || '').startsWith('payment.dispute')) return 'disputed';
  return 'unknown';
}

function normalizeSignature(signatureHeader) {
  if (!signatureHeader) return '';

  return String(signatureHeader)
    .trim()
    .toLowerCase()
    .replace(/^sha256=/, '');
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left), 'utf8');
  const rightBuffer = Buffer.from(String(right), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function verifyWebhookSignature(rawBody, signatureHeader) {
  const webhookSecret = String(config.tebex?.webhookSecret || '').trim();

  if (!webhookSecret) {
    // Sem secret nao ha como provar que o webhook veio da Tebex.
    // Antes isso era aceito, o que permitia forjar pagamentos.
    return {
      valid: false,
      skipped: false,
      reason: 'webhook_secret_not_configured',
    };
  }

  const signature = normalizeSignature(signatureHeader);

  if (!signature) {
    return {
      valid: false,
      skipped: false,
      reason: 'missing_signature',
    };
  }

  const bodyHash = crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex');
  const expectedSignature = crypto.createHmac('sha256', webhookSecret).update(bodyHash).digest('hex');

  return {
    valid: safeCompare(expectedSignature, signature),
    skipped: false,
    reason: 'invalid_signature',
  };
}

function toBoolean(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function normalizeStorageShape(rawData) {
  const purchases = Array.isArray(rawData?.purchases)
    ? rawData.purchases.filter((item) => item && typeof item === 'object').map((item) => ({ ...item }))
    : [];

  const webhooks = rawData?.webhooks && typeof rawData.webhooks === 'object' && !Array.isArray(rawData.webhooks)
    ? { ...rawData.webhooks }
    : {};

  return {
    purchases,
    webhooks,
  };
}

function ensureStorageDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function writeStorageFile(data) {
  ensureStorageDir();

  const normalized = normalizeStorageShape(data);
  const tempFile = `${STORAGE_FILE}.tmp`;

  fs.writeFileSync(tempFile, JSON.stringify(normalized, null, 2));
  fs.renameSync(tempFile, STORAGE_FILE);
}

function ensureStorageFile() {
  ensureStorageDir();

  if (!fs.existsSync(STORAGE_FILE)) {
    writeStorageFile(DEFAULT_STORAGE);
  }
}

function readStorageFile() {
  ensureStorageFile();

  try {
    const rawText = fs.readFileSync(STORAGE_FILE, 'utf8');
    if (!rawText.trim()) return normalizeStorageShape(DEFAULT_STORAGE);
    return normalizeStorageShape(JSON.parse(rawText));
  } catch (error) {
    throw createStorageError(
      `Failed to read Tebex local storage: ${error?.message || 'unknown error'}`,
      500,
    );
  }
}

function enqueueStorageTask(task) {
  const nextTask = storageQueue.catch(() => {}).then(task);
  storageQueue = nextTask.catch(() => {});
  return nextTask;
}

async function mutateStorage(mutator) {
  return enqueueStorageTask(async () => {
    try {
      const storage = readStorageFile();
      const result = await mutator(storage);
      writeStorageFile(storage);
      return result;
    } catch (error) {
      throw normalizeStorageError(error);
    }
  });
}

async function readStorage() {
  return enqueueStorageTask(async () => {
    try {
      return readStorageFile();
    } catch (error) {
      throw normalizeStorageError(error);
    }
  });
}

function findExistingPurchase(purchases, paymentId, packageId, discordId) {
  return purchases.find((purchase) => {
    if (String(purchase?.payment_id || '') !== paymentId) return false;
    if (String(purchase?.package_id || '') !== packageId) return false;

    const recordDiscordId = normalizeDiscordId(purchase?.discord_id);

    if (discordId) {
      return recordDiscordId === discordId || recordDiscordId === null;
    }

    return recordDiscordId === null;
  });
}

function upsertCompletedPaymentRecordsLocal(storage, webhook) {
  const purchases = Array.isArray(storage.purchases) ? storage.purchases : [];
  const subject = webhook.subject || {};
  const paymentId = extractPaymentId(subject, webhook.id);
  const discordId = extractDiscordId(subject);
  const products = extractProducts(subject);

  if (!paymentId || products.length === 0) {
    return {
      created: 0,
      updated: 0,
      paymentId,
      discordId,
      products: 0,
      ignored: true,
    };
  }

  let created = 0;
  let updated = 0;

  for (const product of products) {
    const existing = findExistingPurchase(purchases, paymentId, product.id, discordId);

    if (!existing) {
      purchases.push({
        discord_id: discordId,
        package_id: product.id,
        package_name: product.name,
        payment_id: paymentId,
        claimed: false,
        status: 'completed',
        first_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      created += 1;
      continue;
    }

    existing.discord_id = normalizeDiscordId(existing.discord_id) || discordId;
    existing.package_name = product.name || existing.package_name || null;
    existing.payment_id = paymentId;
    existing.package_id = product.id;
    existing.status = 'completed';
    existing.claimed = toBoolean(existing.claimed);
    existing.first_seen_at = existing.first_seen_at || new Date().toISOString();
    existing.updated_at = new Date().toISOString();
    updated += 1;
  }

  storage.purchases = purchases;

  return {
    created,
    updated,
    paymentId,
    discordId,
    products: products.length,
    ignored: false,
  };
}

function sortPurchasesByMostRecent(left, right) {
  const leftUpdatedAt = new Date(left?.updated_at || 0).getTime() || 0;
  const rightUpdatedAt = new Date(right?.updated_at || 0).getTime() || 0;

  if (rightUpdatedAt !== leftUpdatedAt) {
    return rightUpdatedAt - leftUpdatedAt;
  }

  const leftFirstSeen = new Date(left?.first_seen_at || 0).getTime() || 0;
  const rightFirstSeen = new Date(right?.first_seen_at || 0).getTime() || 0;

  if (rightFirstSeen !== leftFirstSeen) {
    return rightFirstSeen - leftFirstSeen;
  }

  return String(right?.payment_id || '').localeCompare(String(left?.payment_id || ''));
}

async function processWebhook(webhookPayload) {
  const outcome = await mutateStorage((storage) => {
    const webhookId = webhookPayload?.id ? String(webhookPayload.id) : null;
    const type = String(webhookPayload?.type || '');

    if (webhookId && storage.webhooks[webhookId]) {
      return {
        response: {
          duplicate: true,
          type,
          processedAt: storage.webhooks[webhookId]?.processed_at || null,
        },
        shouldEmit: false,
      };
    }

    let result;

    if (type === 'payment.completed') {
      result = upsertCompletedPaymentRecordsLocal(storage, webhookPayload);
    } else if (type === 'payment.refunded' || type.startsWith('payment.dispute')) {
      const paymentId = extractPaymentId(webhookPayload?.subject || {}, webhookId);
      const status = mapEventTypeToStatus(type);
      let updated = 0;

      if (paymentId) {
        for (const purchase of storage.purchases) {
          if (String(purchase?.payment_id || '') !== paymentId) continue;

          purchase.status = status;
          purchase.updated_at = new Date().toISOString();
          updated += 1;
        }
      }

      result = {
        paymentId,
        status,
        updated,
      };
    } else {
      result = {
        ignored: true,
        type,
      };
    }

    if (webhookId) {
      storage.webhooks[webhookId] = {
        type,
        processed_at: new Date().toISOString(),
      };
    }

    return {
      response: result,
      shouldEmit: type === 'payment.completed' && !result?.ignored,
    };
  });

  if (outcome.shouldEmit) {
    emitCompletedPayment(webhookPayload, outcome.response);
  }

  return outcome.response;
}

async function getPendingClaimsForDiscord(discordId) {
  const normalizedDiscordId = normalizeDiscordId(discordId);
  if (!normalizedDiscordId) return [];

  const storage = await readStorage();

  return storage.purchases.filter((purchase) => (
    normalizeDiscordId(purchase?.discord_id) === normalizedDiscordId
    && String(purchase?.status || '') === 'completed'
    && !toBoolean(purchase?.claimed)
  ));
}

async function markClaimsAsClaimed(records, metadata = {}) {
  if (!Array.isArray(records) || records.length === 0) return 0;

  const keys = new Set(
    records
      .map((record) => {
        if (!record?.payment_id || !record?.package_id) return null;

        const discordId = normalizeDiscordId(record.discord_id);
        if (!discordId) return null;

        return `${String(record.payment_id)}::${String(record.package_id)}::${discordId}`;
      })
      .filter(Boolean),
  );

  if (keys.size === 0) return 0;

  return mutateStorage((storage) => {
    let modifiedCount = 0;

    for (const purchase of storage.purchases) {
      const discordId = normalizeDiscordId(purchase?.discord_id);
      if (!discordId) continue;

      const compositeKey = `${String(purchase?.payment_id || '')}::${String(purchase?.package_id || '')}::${discordId}`;
      if (!keys.has(compositeKey)) continue;

      purchase.claimed = true;
      purchase.claimed_at = new Date().toISOString();
      purchase.claimed_by = metadata.claimedBy || null;
      purchase.claimed_in_guild = metadata.guildId || null;
      purchase.updated_at = new Date().toISOString();
      modifiedCount += 1;
    }

    return modifiedCount;
  });
}

function clamp(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

async function getTebexDashboardData(options = {}) {
  const storage = await readStorage();
  const purchases = Array.isArray(storage.purchases) ? storage.purchases : [];
  const limit = clamp(options.limit ?? 7, 1, 20);

  const counts = {
    total: purchases.length,
    pendingClaims: purchases.filter((item) => item?.status === 'completed' && !toBoolean(item?.claimed)).length,
    claimed: purchases.filter((item) => item?.status === 'completed' && toBoolean(item?.claimed)).length,
    refunded: purchases.filter((item) => item?.status === 'refunded').length,
    disputed: purchases.filter((item) => item?.status === 'disputed').length,
  };

  const latestPurchases = [...purchases]
    .sort(sortPurchasesByMostRecent)
    .slice(0, limit);

  const topPackagesMap = new Map();

  for (const purchase of purchases) {
    if (purchase?.status !== 'completed') continue;

    const packageId = String(purchase?.package_id || '').trim();
    if (!packageId) continue;

    const current = topPackagesMap.get(packageId) || {
      package_id: packageId,
      package_name: purchase?.package_name || null,
      count: 0,
    };

    current.package_name = current.package_name || purchase?.package_name || null;
    current.count += 1;
    topPackagesMap.set(packageId, current);
  }

  const topPackages = [...topPackagesMap.values()]
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      return String(left.package_id).localeCompare(String(right.package_id));
    })
    .slice(0, 5);

  return {
    counts,
    latestPurchases,
    topPackages,
  };
}

function getTebexStoragePath() {
  return STORAGE_FILE;
}

module.exports = {
  PURCHASES_COLLECTION,
  getPendingClaimsForDiscord,
  getTebexDashboardData,
  getTebexStoragePath,
  markClaimsAsClaimed,
  processWebhook,
  verifyWebhookSignature,
};
