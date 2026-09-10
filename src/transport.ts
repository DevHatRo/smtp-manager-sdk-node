import {
  AuthenticationError,
  NetworkError,
  PayloadTooLargeError,
  PermissionError,
  RateLimitError,
  ServerError,
  SmtpManagerError,
  TimeoutError,
  UnexpectedResponseError,
  ValidationError,
} from './errors.js';
import type { FetchLike } from './types.js';
import { isRecord } from './util.js';

export interface RequestOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxRetries: number;
  maxRetryAfterMs: number;
  retryOnServerError: boolean;
  fetch: FetchLike;
  signal?: AbortSignal;
}

export interface ParsedResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON, the raw text for non-JSON bodies, or `undefined` for an empty body. */
  body: unknown;
  requestId?: string;
}

/** Cap of the exponential backoff (network / server errors). `Retry-After` is never capped here. */
export const MAX_BACKOFF_MS = 30_000;
/** Wait after a 429 without a usable `Retry-After`. */
export const DEFAULT_RATE_LIMIT_DELAY_MS = 1_000;
/** Default `maxRetryAfterMs`: the send quota is per minute. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;
/** Base of the exponential backoff used for network / server errors. */
export const BASE_BACKOFF_MS = 250;
/** Backoff waits are spread by +/- this fraction so clients do not retry in lockstep. */
export const BACKOFF_JITTER = 0.2;

/**
 * Error codes that cannot occur after bytes were written to a socket: the request provably
 * never reached the server, so retrying cannot send twice. Only these are retried
 * automatically. Everything else (`ECONNRESET`, `EPIPE`, `ECONNABORTED`, socket errors,
 * errors without a code) may have happened after the request was sent and is ambiguous.
 */
export const DIAL_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function isSuccess(status: number | undefined): status is number {
  return status !== undefined && status >= 200 && status < 300;
}

/** Wording for failures after a 2xx arrived: the message is queued, a re-send would duplicate it. */
function acceptedHint(status: number): string {
  return `The server accepted the message (HTTP ${status}) but the response could not be read; do not re-send it.`;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/** Parses `Retry-After` (delta-seconds or HTTP-date) into seconds, never negative. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  // Every HTTP-date form (IMF-fixdate, RFC 850, asctime) spells the month, which keeps
  // Date.parse from reading junk such as "-5" as a year.
  const at = /[A-Za-z]/.test(trimmed) ? Date.parse(trimmed) : Number.NaN;
  if (Number.isNaN(at)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Finds the first error code in a fetch failure. undici wraps the socket error as
 * `TypeError('fetch failed', { cause })`, and a dual-stack connect failure arrives as an
 * `AggregateError` whose `errors` all carry the code.
 */
export function findErrorCode(error: unknown, depth = 0): string | undefined {
  if (depth > 4 || error === null || typeof error !== 'object') {
    return undefined;
  }
  const record = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof record.code === 'string' && record.code !== '') {
    return record.code;
  }
  if (Array.isArray(record.errors)) {
    for (const inner of record.errors) {
      const code = findErrorCode(inner, depth + 1);
      if (code !== undefined) {
        return code;
      }
    }
  }
  return findErrorCode(record.cause, depth + 1);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function parseResponse(response: Response): Promise<ParsedResponse> {
  const text = await response.text();
  let body: unknown = text === '' ? undefined : text;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      // keep the raw text
    }
  }
  const headerId = response.headers.get('x-request-id') ?? undefined;
  const bodyId =
    isRecord(body) && typeof body['request_id'] === 'string' ? body['request_id'] : undefined;
  return {
    status: response.status,
    headers: response.headers,
    body,
    requestId: headerId ?? bodyId,
  };
}

function messageOf(parsed: ParsedResponse, fallback: string): string {
  if (
    isRecord(parsed.body) &&
    typeof parsed.body['message'] === 'string' &&
    parsed.body['message'] !== ''
  ) {
    return parsed.body['message'];
  }
  return fallback;
}

function validationErrors(body: unknown): Record<string, string[]> {
  if (!isRecord(body) || !isRecord(body['errors'])) {
    return {};
  }
  const out: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(body['errors'])) {
    out[field] = Array.isArray(messages)
      ? messages.map((m) => String(m))
      : messages === undefined || messages === null
        ? []
        : [String(messages)];
  }
  return out;
}

/** Turns a non-2xx response into the matching error class. */
export function errorFromResponse(parsed: ParsedResponse): SmtpManagerError {
  const { status, body, requestId } = parsed;
  const common = { status, body, requestId };
  switch (status) {
    case 401:
      return new AuthenticationError(messageOf(parsed, 'Invalid or missing API key'), common);
    case 403:
      return new PermissionError(messageOf(parsed, 'API key lacks the send ability'), common);
    case 413:
      return new PayloadTooLargeError(messageOf(parsed, 'Request body too large'), common);
    case 422:
      return new ValidationError(
        messageOf(parsed, 'The given data was invalid'),
        validationErrors(body),
        common,
      );
    case 429:
      return new RateLimitError(messageOf(parsed, 'Rate limit exceeded'), {
        ...common,
        retryAfter: parseRetryAfter(parsed.headers.get('retry-after')),
      });
    default:
      if (status >= 500 && status <= 599) {
        return new ServerError(messageOf(parsed, `Server error (HTTP ${status})`), common);
      }
      if (status >= 300 && status <= 399) {
        // Redirects are never followed (`redirect: 'manual'`): a redirected POST would be
        // replayed as a GET and lose its Authorization header on a scheme change.
        const location = parsed.headers.get('location');
        return new UnexpectedResponseError(
          `Unexpected redirect (HTTP ${status})${location ? ` to ${location}` : ''}; check baseUrl`,
          common,
        );
      }
      return new UnexpectedResponseError(
        messageOf(parsed, `Unexpected response (HTTP ${status})`),
        common,
      );
  }
}

/** One attempt: fetch + read body, mapping failures to `TimeoutError` / `NetworkError`. */
async function attemptOnce(options: RequestOptions): Promise<ParsedResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);

  const { signal } = options;
  const onCallerAbort = (): void => controller.abort(abortReason(signal as AbortSignal));
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw abortReason(signal);
    }
    signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  /** Set once response headers arrived: from then on the request has reached the server. */
  let status: number | undefined;
  let requestId: string | undefined;
  try {
    const response = await options.fetch(options.url, {
      method: 'POST',
      headers: options.headers,
      body: options.body,
      redirect: 'manual',
      signal: controller.signal,
    });
    status = response.status;
    requestId = response.headers.get('x-request-id') ?? undefined;
    return await parseResponse(response);
  } catch (cause) {
    if (timedOut) {
      const hint = isSuccess(status)
        ? ` while reading the response body. ${acceptedHint(status)}`
        : '';
      throw new TimeoutError(
        `Request timed out after ${options.timeoutMs} ms${hint}`,
        options.timeoutMs,
        { cause, status, requestId },
      );
    }
    if (signal?.aborted) {
      throw cause;
    }
    if (status === undefined) {
      const code = findErrorCode(cause);
      const retryable = code !== undefined && DIAL_ERROR_CODES.has(code);
      throw new NetworkError(`Request failed before a response was received: ${describe(cause)}`, {
        cause,
        code,
        retryable,
      });
    }
    const hint = isSuccess(status) ? ` ${acceptedHint(status)}` : '';
    throw new UnexpectedResponseError(
      `Failed to read the response body (HTTP ${status}): ${describe(cause)}.${hint}`,
      { cause, status, requestId },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = cause.cause instanceof Error ? ` (${cause.cause.message})` : '';
    return `${cause.message}${inner}`;
  }
  return String(cause);
}

/** Milliseconds a 429 asks us to wait: `Retry-After` exactly, 1 s when absent. */
function rateLimitWaitMs(error: RateLimitError): number {
  return error.retryAfter === undefined ? DEFAULT_RATE_LIMIT_DELAY_MS : error.retryAfter * 1000;
}

function isRetryable(error: SmtpManagerError, options: RequestOptions): boolean {
  if (error instanceof RateLimitError) {
    // A wait longer than the caller allows is surfaced immediately rather than slept through.
    return rateLimitWaitMs(error) <= options.maxRetryAfterMs;
  }
  if (error instanceof NetworkError) {
    return error.retryable || options.retryOnServerError;
  }
  if (error instanceof TimeoutError) {
    // A status means headers arrived: the server has the request, never replay it.
    return options.retryOnServerError && error.status === undefined;
  }
  if (error instanceof ServerError) {
    return options.retryOnServerError;
  }
  return false;
}

/**
 * Wait before the next attempt. `Retry-After` is honoured exactly (the caller's
 * `maxRetryAfterMs` decides whether to wait at all); the exponential backoff for everything
 * else is jittered by +/- `BACKOFF_JITTER` and capped at `MAX_BACKOFF_MS`.
 */
export function retryDelayMs(
  error: SmtpManagerError,
  attempt: number,
  random: () => number = Math.random,
): number {
  if (error instanceof RateLimitError) {
    return rateLimitWaitMs(error);
  }
  const base = BASE_BACKOFF_MS * 2 ** attempt;
  const factor = 1 - BACKOFF_JITTER + random() * 2 * BACKOFF_JITTER;
  return Math.min(Math.round(base * factor), MAX_BACKOFF_MS);
}

/**
 * Performs the request with the retry policy: 429 (when `Retry-After` fits `maxRetryAfterMs`)
 * and dial-phase network errors are always retried; 5xx, pre-response timeouts and ambiguous
 * network errors only with `retryOnServerError`; anything else never. Resolves with the parsed 2xx response; rejects with the mapped error of the last
 * attempt (or the caller's abort reason).
 */
export async function performRequest(options: RequestOptions): Promise<ParsedResponse> {
  for (let attempt = 0; ; attempt++) {
    let error: SmtpManagerError;
    try {
      const parsed = await attemptOnce(options);
      if (parsed.status >= 200 && parsed.status < 300) {
        return parsed;
      }
      error = errorFromResponse(parsed);
    } catch (thrown) {
      if (!(thrown instanceof SmtpManagerError)) {
        throw thrown;
      }
      error = thrown;
    }
    if (attempt >= options.maxRetries || !isRetryable(error, options)) {
      throw error;
    }
    await sleep(retryDelayMs(error, attempt), options.signal);
  }
}
