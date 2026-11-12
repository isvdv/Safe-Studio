const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const config = require('../config');
const {
  createBasket,
  createCheckoutForPackage,
  getBasket,
  getCategories,
  getPackages,
} = require('./tebexClient');
const {
  processWebhook,
  verifyWebhookSignature,
} = require('./tebexPurchases');

const { createLogger } = require('./logger');

const log = createLogger('HTTP');

const STORE_PAGE = path.join(__dirname, '..', 'assets', 'tebex-store.html');
const MAX_BODY_BYTES = 1024 * 1024;
const DISCORD_ID_REGEX = /^\d{17,20}$/;

// Limite simples por IP para as rotas publicas que criam cestas/checkout.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = Number.parseInt(process.env.HTTP_RATE_LIMIT_PER_MINUTE, 10) || 20;
const rateLimitHits = new Map();

function getClientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'desconhecido';
}

function isRateLimited(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = rateLimitHits.get(ip);

  if (!entry || now - entry.start >= RATE_LIMIT_WINDOW_MS) {
    rateLimitHits.set(ip, { start: now, count: 1 });
    return false;
  }

  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX_REQUESTS;
}

const rateLimitCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitHits) {
    if (now - entry.start >= RATE_LIMIT_WINDOW_MS) rateLimitHits.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS);
rateLimitCleanup.unref?.();

function normalizePath(pathname) {
  if (!pathname) return '/';
  if (pathname === '/') return '/';
  return `/${String(pathname).replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);

  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });

  res.end(body);
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });

  res.end(html);
}

function sendNotFound(res) {
  sendJson(res, 404, { error: 'Not found' });
}

function parseIncludePackages(searchParams) {
  const value = searchParams.get('includePackages');
  if (value === null || value === undefined || value === '') return 1;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 1;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;

      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (error) => {
      reject(error);
    });
  });
}

function parseJsonBody(rawBuffer) {
  if (!rawBuffer || rawBuffer.length === 0) return {};

  const rawString = rawBuffer.toString('utf8');

  try {
    return JSON.parse(rawString);
  } catch (error) {
    const nextError = new Error('Invalid JSON body.' );
    nextError.statusCode = 400;
    throw nextError;
  }
}

function handleHttpError(res, error) {
  const statusCode = error?.statusCode || 500;

  if (statusCode >= 500) {
    log.error('Erro ao processar requisicao:', error);
  }

  const payload = {
    error: error?.message || 'Unexpected server error.',
  };

  if (error?.details) {
    payload.details = error.details;
  }

  sendJson(res, statusCode, payload);
}

async function handleWebhook(req, res) {
  if (!String(config.tebex?.webhookSecret || '').trim()) {
    log.warn(`Webhook recusado de ${getClientIp(req)}: TEBEX_WEBHOOK_SECRET nao configurado.`);
    sendJson(res, 503, { error: 'Webhook disabled: secret not configured.' });
    return;
  }

  const rawBuffer = await readRawBody(req);
  const rawBody = rawBuffer.toString('utf8');
  const signatureHeader = req.headers['x-signature'] || req.headers['X-Signature'];
  const signatureCheck = verifyWebhookSignature(rawBody, signatureHeader);

  if (!signatureCheck.valid) {
    log.warn(`Webhook com assinatura invalida recusado (${signatureCheck.reason}) de ${getClientIp(req)}.`);
    sendJson(res, 401, {
      error: 'Invalid webhook signature.',
      reason: signatureCheck.reason,
    });
    return;
  }

  const payload = parseJsonBody(rawBuffer);

  if (payload?.type === 'validation.webhook') {
    sendJson(res, 200, {
      id: payload.id || null,
    });
    return;
  }

  const summary = await processWebhook(payload);
  sendJson(res, 200, {
    ok: true,
    summary,
  });
}

async function handleApiRequest(req, res, requestUrl) {
  const pathname = normalizePath(requestUrl.pathname);

  if (req.method === 'POST' && pathname.startsWith('/api/') && isRateLimited(req)) {
    sendJson(res, 429, { error: 'Too many requests. Try again in a minute.' });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/tebex/categories') {
    const includePackages = parseIncludePackages(requestUrl.searchParams);
    const data = await getCategories({ includePackages });
    sendJson(res, 200, { data });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/tebex/packages') {
    const data = await getPackages();
    sendJson(res, 200, { data });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/tebex/baskets') {
    const payload = parseJsonBody(await readRawBody(req));
    const data = await createBasket(payload);
    sendJson(res, 200, { data });
    return true;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/tebex/baskets/')) {
    const basketIdent = decodeURIComponent(pathname.replace('/api/tebex/baskets/', ''));
    const data = await getBasket(basketIdent);
    sendJson(res, 200, { data });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/tebex/checkout') {
    const payload = parseJsonBody(await readRawBody(req));
    const packageId = payload.package_id || payload.packageId;
    const discordId = payload.discord_id || payload.discordId;

    if (!packageId) {
      sendJson(res, 400, { error: 'package_id is required.' });
      return true;
    }

    if (!discordId) {
      sendJson(res, 400, { error: 'discord_id is required.' });
      return true;
    }

    if (!DISCORD_ID_REGEX.test(String(discordId).trim())) {
      sendJson(res, 400, { error: 'discord_id is invalid.' });
      return true;
    }

    const checkout = await createCheckoutForPackage({
      packageId,
      quantity: payload.quantity || 1,
      complete_url: payload.complete_url || payload.completeUrl || config.tebex.completeUrl,
      cancel_url: payload.cancel_url || payload.cancelUrl || config.tebex.cancelUrl,
      custom: {
        ...(payload.custom || {}),
        discord_id: String(discordId),
      },
      variable_data: {
        ...(payload.variable_data || {}),
        discord_id: String(discordId),
      },
    });

    sendJson(res, 200, {
      basket_ident: checkout.basketIdent,
      checkout_url: checkout.checkoutUrl,
      basket: checkout.basket,
    });
    return true;
  }

  return false;
}

function buildStorePage() {
  if (fs.existsSync(STORE_PAGE)) {
    return fs.readFileSync(STORE_PAGE, 'utf8');
  }

  return [
    '<!doctype html>',
    '<html><body><h1>Store page not found.</h1></body></html>',
  ].join('');
}

function startTebexServer() {
  const webhookPath = normalizePath(config.tebex?.webhookPath || '/webhooks/tebex');
  const host = config.tebex?.host || '0.0.0.0';
  const port = Number(config.tebex?.port || 3000);

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = normalizePath(requestUrl.pathname);

      if (req.method === 'GET' && pathname === '/') {
        sendHtml(res, 200, buildStorePage());
        return;
      }

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === webhookPath && req.method === 'POST') {
        await handleWebhook(req, res);
        return;
      }

      const handledApi = await handleApiRequest(req, res, requestUrl);

      if (handledApi) return;

      sendNotFound(res);
    } catch (error) {
      handleHttpError(res, error);
    }
  });

  server.on('error', (error) => {
    log.error('Erro no servidor HTTP:', error);
  });

  server.listen(port, host, () => {
    log.info(`Servidor ouvindo em http://${host}:${port} (webhook em ${webhookPath})`);
  });

  server.info = { host, port, webhookPath };

  return server;
}

module.exports = {
  startTebexServer,
};



