const axios = require('axios');
require('dotenv').config({ quiet: true });

const TEBEX_BASE_URL = 'https://plugin.tebex.io';
const TEBEX_TIMEOUT_MS = 10_000;
const DEFAULT_NEXT_CHECK_SECONDS = 60;

const tebexHttp = axios.create({
  baseURL: TEBEX_BASE_URL,
  timeout: TEBEX_TIMEOUT_MS,
  validateStatus: () => true,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'safe-studio-tebex-plugin-api/1.0',
  },
});

const queueState = {
  lastResult: null,
  nextAllowedAt: 0,
};

let activeQueueWorker = null;

class TebexApiError extends Error {
  constructor({
    message,
    statusCode = 500,
    endpoint = '',
    details = null,
    code = 'TEBEX_API_ERROR',
    cause = null,
    retryAfterSeconds = null,
  } = {}) {
    super(message || 'Tebex API request failed.');
    this.name = 'TebexApiError';
    this.statusCode = statusCode;
    this.endpoint = endpoint;
    this.details = details;
    this.code = code;
    this.cause = cause;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function getPluginSecret() {
  return String(process.env.TEBEX_PLUGIN_SECRET || '').trim();
}

function maskSecret(value) {
  const secret = getPluginSecret();
  const text = String(value ?? '');

  if (!secret) return text;
  if (!text.includes(secret)) return text;

  return text.split(secret).join('[REDACTED]');
}

function toSafeString(value) {
  if (typeof value === 'string') {
    return maskSecret(value);
  }

  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'object') {
    try {
      return maskSecret(JSON.stringify(value));
    } catch (error) {
      return '[unserializable-object]';
    }
  }

  return maskSecret(String(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function ensurePluginSecret(endpoint = '') {
  const secret = getPluginSecret();

  if (!secret) {
    throw new TebexApiError({
      statusCode: 500,
      endpoint,
      message: 'TEBEX_PLUGIN_SECRET is not configured.',
      code: 'TEBEX_PLUGIN_SECRET_MISSING',
    });
  }

  return secret;
}

function extractErrorMessage(payload, fallbackMessage) {
  if (typeof payload === 'string' && payload.trim()) {
    return toSafeString(payload.trim());
  }

  if (Array.isArray(payload)) {
    return payload.length > 0
      ? toSafeString(payload[0])
      : fallbackMessage;
  }

  if (isPlainObject(payload)) {
    const candidates = [
      payload.message,
      payload.error_message,
      payload.error,
      payload.detail,
      payload.title,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return toSafeString(candidate.trim());
      }
    }
  }

  return fallbackMessage;
}

function buildStatusMessage(statusCode, endpoint, payload) {
  const fallbackByStatus = {
    401: 'Unauthorized request to Tebex Plugin API. Check the plugin secret.',
    403: 'Forbidden request to Tebex Plugin API. Check plugin permissions and secret.',
    404: `Endpoint ${endpoint} was not found in the Tebex Plugin API.`,
    405: `Endpoint ${endpoint} is not available for this Tebex Plugin API implementation.`,
    429: 'Tebex Plugin API rate limit reached. Respect next_check before polling again.',
    500: 'Tebex Plugin API returned an internal server error.',
    502: 'Tebex Plugin API is temporarily unavailable.',
    503: 'Tebex Plugin API is temporarily unavailable.',
    504: 'Timed out while waiting for Tebex Plugin API.',
  };

  const fallbackMessage = fallbackByStatus[statusCode]
    || `Tebex Plugin API request failed with status ${statusCode}.`;

  return extractErrorMessage(payload, fallbackMessage);
}

function normalizeNextCheckSeconds(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_NEXT_CHECK_SECONDS;
  }

  return Math.max(1, Math.ceil(parsed));
}

function getRetryAfterSeconds(headers = {}) {
  const retryAfterHeader = headers['retry-after'] ?? headers['Retry-After'];
  const parsed = Number.parseInt(retryAfterHeader, 10);

  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  return null;
}

function normalizeArray(payload, candidateKeys = []) {
  if (Array.isArray(payload)) return payload;

  if (isPlainObject(payload)) {
    for (const key of candidateKeys) {
      if (Array.isArray(payload[key])) {
        return payload[key];
      }
    }
  }

  return [];
}

function buildSafeCause(error) {
  if (!error) {
    return null;
  }

  return {
    name: toSafeString(error.name || 'Error'),
    message: toSafeString(error.message || 'Unknown error'),
    code: toSafeString(error.code || ''),
  };
}

function pickFirst(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }

  return null;
}

function truncate(value, maxLength = 120) {
  const text = String(value ?? '');

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatQueueCommand(command) {
  const id = pickFirst(command?.id, command?.command_id, command?.queue_id);
  const paymentId = pickFirst(
    command?.payment,
    command?.payment_id,
    command?.paymentId,
    command?.txn_id,
  );
  const packageName = pickFirst(
    command?.package?.name,
    command?.package_name,
    command?.packageName,
    command?.package,
  );
  const playerName = pickFirst(
    command?.player?.name,
    command?.player?.username,
    command?.ign,
    command?.username,
    command?.name,
  );
  const playerUuid = pickFirst(command?.player?.uuid, command?.uuid);
  const delay = pickFirst(command?.delay, command?.delay_seconds, 0);
  const commandText = pickFirst(command?.command, command?.text, command?.cmd) || '';

  return {
    id,
    payment_id: paymentId,
    package_name: packageName,
    player_name: playerName,
    player_uuid: playerUuid,
    delay,
    command: commandText,
    summary: [
      id ? `#${id}` : null,
      paymentId ? `payment ${paymentId}` : null,
      packageName ? `package ${packageName}` : null,
      playerName ? `player ${playerName}` : null,
      `delay ${delay}s`,
      truncate(commandText, 80),
    ].filter(Boolean).join(' | '),
    raw: command,
  };
}

function buildQueueResult(payload, offlinePayload = null) {
  const players = normalizeArray(payload, ['players', 'data']);
  const offlineCommands = normalizeArray(
    offlinePayload || payload,
    ['commands', 'offline_commands', 'data'],
  );
  const formattedOfflineCommands = offlineCommands.map((command) => formatQueueCommand(command));
  const nextCheck = normalizeNextCheckSeconds(
    payload?.meta?.next_check ?? payload?.next_check ?? offlinePayload?.meta?.next_check,
  );
  const waitMs = Math.max(0, queueState.nextAllowedAt - Date.now());

  return {
    raw: payload,
    next_check: nextCheck,
    wait_ms: waitMs,
    next_allowed_at: new Date(queueState.nextAllowedAt).toISOString(),
    players,
    player_count: players.length,
    execute_offline: Boolean(payload?.meta?.execute_offline),
    offline_commands_raw: offlineCommands,
    offline_commands: formattedOfflineCommands,
    offline_command_count: formattedOfflineCommands.length,
    from_cache: false,
  };
}

function getPublicErrorMessage(error) {
  if (error instanceof TebexApiError) {
    return toSafeString(error.message);
  }

  return toSafeString(error?.message || 'Unknown Tebex API error.');
}

function createWorkerLogger(customLogger) {
  if (typeof customLogger === 'function') {
    return customLogger;
  }

  return (level, message, meta = {}) => {
    const writer = typeof console[level] === 'function' ? console[level] : console.log;
    const suffix = Object.keys(meta).length > 0 ? ` ${toSafeString(meta)}` : '';
    writer(`[TebexQueueWorker] ${message}${suffix}`);
  };
}

function summarizeCommandForLog(command) {
  return {
    id: command?.id ?? null,
    payment_id: command?.payment_id ?? null,
    package_name: command?.package_name ?? null,
    player_name: command?.player_name ?? null,
    delay: command?.delay ?? 0,
    command: truncate(command?.command || '', 120),
  };
}

async function tebexRequest(path, options = {}) {
  const endpoint = String(path || '/').trim().startsWith('/')
    ? String(path || '/').trim()
    : `/${String(path || '').trim()}`;
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    ...(options.headers || {}),
    Accept: 'application/json',
    'X-Tebex-Secret': ensurePluginSecret(endpoint),
  };

  try {
    const response = await tebexHttp.request({
      url: endpoint,
      method,
      headers,
      params: options.params,
      data: options.data,
      timeout: Number.isFinite(options.timeout) ? options.timeout : TEBEX_TIMEOUT_MS,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new TebexApiError({
        statusCode: response.status,
        endpoint,
        message: buildStatusMessage(response.status, endpoint, response.data),
        details: response.data,
        code: 'TEBEX_HTTP_ERROR',
        retryAfterSeconds: getRetryAfterSeconds(response.headers),
      });
    }

    return {
      statusCode: response.status,
      endpoint,
      headers: response.headers || {},
      data: response.data ?? null,
    };
  } catch (error) {
    if (error instanceof TebexApiError) {
      throw error;
    }

    if (error?.response) {
      throw new TebexApiError({
        statusCode: error.response.status || 500,
        endpoint,
        message: buildStatusMessage(
          error.response.status || 500,
          endpoint,
          error.response.data,
        ),
        details: error.response.data,
        code: 'TEBEX_HTTP_ERROR',
        cause: buildSafeCause(error),
        retryAfterSeconds: getRetryAfterSeconds(error.response.headers || {}),
      });
    }

    if (error?.code === 'ECONNABORTED' || /timeout/i.test(String(error?.message || ''))) {
      throw new TebexApiError({
        statusCode: 504,
        endpoint,
        message: `Timed out after ${TEBEX_TIMEOUT_MS}ms while calling Tebex Plugin API.`,
        code: 'TEBEX_TIMEOUT',
        cause: buildSafeCause(error),
      });
    }

    throw new TebexApiError({
      statusCode: 503,
      endpoint,
      message: toSafeString(error?.message || 'Could not reach Tebex Plugin API.'),
      code: 'TEBEX_NETWORK_ERROR',
      cause: buildSafeCause(error),
    });
  }
}

async function getTebexInformation() {
  const response = await tebexRequest('/information');
  return response.data ?? {};
}

async function getOfflineCommands() {
  const response = await tebexRequest('/queue/offline-commands');
  return response.data ?? {};
}

async function getTebexQueue() {
  const now = Date.now();

  if (queueState.lastResult && queueState.nextAllowedAt > now) {
    return {
      ...queueState.lastResult,
      from_cache: true,
      wait_ms: queueState.nextAllowedAt - now,
      next_allowed_at: new Date(queueState.nextAllowedAt).toISOString(),
    };
  }

  const queuePayload = await tebexRequest('/queue');
  const queueData = queuePayload.data ?? {};
  const nextCheck = normalizeNextCheckSeconds(
    queueData?.meta?.next_check ?? queueData?.next_check,
  );

  queueState.nextAllowedAt = Date.now() + (nextCheck * 1000);

  let offlinePayload = null;
  const inlineOfflineCommands = normalizeArray(queueData, ['commands', 'offline_commands']);

  if (inlineOfflineCommands.length > 0) {
    offlinePayload = {
      commands: inlineOfflineCommands,
    };
  } else if (queueData?.meta?.execute_offline) {
    // The official Plugin API exposes offline commands in a dedicated endpoint.
    offlinePayload = await getOfflineCommands();
  }

  const result = buildQueueResult(queueData, offlinePayload);
  queueState.lastResult = result;

  return result;
}

async function deleteTebexCommand(commandId) {
  const normalizedId = String(commandId || '').trim();

  if (!normalizedId) {
    throw new TebexApiError({
      statusCode: 400,
      endpoint: '/queue',
      message: 'commandId is required to delete a Tebex queue command.',
      code: 'TEBEX_COMMAND_ID_REQUIRED',
    });
  }

  // Tebex documents deletion through DELETE /queue with an array of ids.
  const response = await tebexRequest('/queue', {
    method: 'DELETE',
    data: {
      ids: [normalizedId],
    },
  });

  if (queueState.lastResult) {
    queueState.lastResult = {
      ...queueState.lastResult,
      offline_commands_raw: queueState.lastResult.offline_commands_raw.filter((command) => {
        const candidateId = String(
          command?.id ?? command?.command_id ?? command?.queue_id ?? '',
        ).trim();
        return candidateId !== normalizedId;
      }),
      offline_commands: queueState.lastResult.offline_commands.filter((command) => {
        const candidateId = String(command?.id ?? '').trim();
        return candidateId !== normalizedId;
      }),
    };
    queueState.lastResult.offline_command_count = queueState.lastResult.offline_commands.length;
  }

  return {
    ok: true,
    commandId: normalizedId,
    statusCode: response.statusCode,
  };
}

async function getTebexPayments() {
  try {
    const response = await tebexRequest('/payments');
    return response.data ?? {};
  } catch (error) {
    if (
      error instanceof TebexApiError
      && [404, 405, 501, 503].includes(error.statusCode)
    ) {
      // Keep the endpoint official, but surface unsupported implementations cleanly.
      throw new TebexApiError({
        statusCode: error.statusCode,
        endpoint: '/payments',
        message: 'The /payments endpoint is unavailable in this Tebex Plugin API environment.',
        details: error.details,
        code: 'TEBEX_PAYMENTS_UNAVAILABLE',
        cause: buildSafeCause(error),
      });
    }

    throw error;
  }
}

function extractStoreName(info) {
  return pickFirst(
    info?.account?.name,
    info?.store?.name,
    info?.server?.name,
    info?.account?.domain,
    info?.store_name,
    'Unknown store',
  );
}

function extractCurrency(info) {
  return pickFirst(
    info?.account?.currency?.iso_4217,
    info?.account?.currency,
    info?.store?.currency,
    info?.currency?.iso_4217,
    info?.currency,
    'Unknown currency',
  );
}

async function testTebexConnection() {
  try {
    const info = await getTebexInformation();

    return {
      ok: true,
      store: extractStoreName(info),
      currency: extractCurrency(info),
      information: info,
    };
  } catch (error) {
    return {
      ok: false,
      error: getPublicErrorMessage(error),
    };
  }
}

function getWorkerDelayMs(queuePayload, error) {
  if (queuePayload && Number.isFinite(queuePayload.wait_ms) && queuePayload.wait_ms > 0) {
    return queuePayload.wait_ms;
  }

  if (error instanceof TebexApiError) {
    if (Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds > 0) {
      return error.retryAfterSeconds * 1000;
    }

    if (error.statusCode === 429) {
      return DEFAULT_NEXT_CHECK_SECONDS * 1000;
    }
  }

  return 15_000;
}

function startTebexQueueWorker(options = {}) {
  const onCommand = options.onCommand;

  if (typeof onCommand !== 'function') {
    throw new TebexApiError({
      statusCode: 500,
      endpoint: '/queue',
      message: 'startTebexQueueWorker requires an onCommand(command) callback.',
      code: 'TEBEX_WORKER_CALLBACK_REQUIRED',
    });
  }

  if (activeQueueWorker && !activeQueueWorker.stopped) {
    return activeQueueWorker;
  }

  const logger = createWorkerLogger(options.logger);

  const worker = {
    stopped: false,
    timer: null,
    stop() {
      this.stopped = true;

      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }

      if (activeQueueWorker === this) {
        activeQueueWorker = null;
      }
    },
  };

  async function runCycle() {
    if (worker.stopped) {
      return;
    }

    let queuePayload = null;
    let error = null;

    try {
      queuePayload = await getTebexQueue();

      logger('info', 'Checked Tebex queue.', {
        from_cache: queuePayload.from_cache,
        next_check: queuePayload.next_check,
        wait_ms: queuePayload.wait_ms,
        player_count: queuePayload.player_count,
        offline_command_count: queuePayload.offline_command_count,
      });

      for (const command of queuePayload.offline_commands) {
        if (worker.stopped) break;

        logger('info', 'Processing Tebex command.', summarizeCommandForLog(command));

        let callbackResult = null;

        try {
          callbackResult = await onCommand(command);
        } catch (callbackError) {
          logger('error', 'Tebex command callback failed; command will stay queued.', {
            command_id: command.id,
            error: getPublicErrorMessage(callbackError),
          });
          continue;
        }

        const shouldDelete = callbackResult === true
          || callbackResult?.ok === true
          || callbackResult?.success === true;

        if (!shouldDelete) {
          logger('warn', 'Tebex command callback did not confirm success; command kept in queue.', {
            command_id: command.id,
          });
          continue;
        }

        try {
          await deleteTebexCommand(command.id);
          logger('info', 'Removed Tebex command from queue after successful callback.', {
            command_id: command.id,
          });
        } catch (deleteError) {
          logger('error', 'Failed to remove Tebex command from queue after successful callback.', {
            command_id: command.id,
            error: getPublicErrorMessage(deleteError),
          });
        }
      }
    } catch (workerError) {
      error = workerError;

      logger('error', 'Tebex queue worker iteration failed.', {
        endpoint: workerError?.endpoint || '/queue',
        statusCode: workerError?.statusCode || 500,
        error: getPublicErrorMessage(workerError),
      });
    } finally {
      if (worker.stopped) {
        return;
      }

      const nextDelayMs = getWorkerDelayMs(queuePayload, error);

      worker.timer = setTimeout(() => {
        void runCycle();
      }, nextDelayMs);
    }
  }

  activeQueueWorker = worker;
  void runCycle();

  return worker;
}

module.exports = {
  TebexApiError,
  deleteTebexCommand,
  getTebexInformation,
  getTebexPayments,
  getTebexQueue,
  startTebexQueueWorker,
  testTebexConnection,
};
