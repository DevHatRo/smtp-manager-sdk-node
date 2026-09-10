import { inspect } from 'node:util';
import { renderAddress, renderAddressList } from './address.js';
import { renderAttachment } from './attachments.js';
import type { WireAttachment } from './attachments.js';
import { ConfigurationError, InvalidInputError, UnexpectedResponseError } from './errors.js';
import { mapMessage, unwrapEnvelope } from './mapper.js';
import { DEFAULT_MAX_RETRY_AFTER_MS, performRequest } from './transport.js';
import type {
  FetchLike,
  SendMessageInput,
  SendOptions,
  SendResult,
  SmtpManagerOptions,
} from './types.js';
import { VERSION } from './version.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const MESSAGES_PATH = '/api/v1/messages';
export const API_KEY_PREFIX = 'smtpk_';
/** What the server accepts as an inbound `X-Request-Id`; anything else is replaced server-side. */
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Wire (snake_case) shape of `POST /api/v1/messages`. */
export interface WireSendMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: WireAttachment[];
  tags?: string[];
  metadata?: Record<string, string>;
}

interface ResolvedConfig {
  apiKey: string;
  messagesUrl: string;
  timeoutMs: number;
  maxRetries: number;
  maxRetryAfterMs: number;
  retryOnServerError: boolean;
  userAgent: string;
  fetch: FetchLike;
}

/** Everything a resolved config exposes when serialized or inspected: never the key. */
export interface PublicConfig {
  /** Redacted: `smtpk_xxxx…`. */
  apiKey: string;
  messagesUrl: string;
  timeoutMs: number;
  maxRetries: number;
  maxRetryAfterMs: number;
  retryOnServerError: boolean;
  userAgent: string;
}

/** `smtpk_abcdefghij.secret` -> `smtpk_abcd…` */
export function redactApiKey(apiKey: string): string {
  return `${apiKey.slice(0, API_KEY_PREFIX.length + 4)}…`;
}

function publicConfig(config: ResolvedConfig): PublicConfig {
  return {
    apiKey: redactApiKey(config.apiKey),
    messagesUrl: config.messagesUrl,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    maxRetryAfterMs: config.maxRetryAfterMs,
    retryOnServerError: config.retryOnServerError,
    userAgent: config.userAgent,
  };
}

/**
 * Resolves the send endpoint from either the bare origin (plus any path prefix) or the full
 * "Endpoint" the console shows next to a new key (`https://host/api/v1/messages`): a path
 * already ending in `/api/v1/messages`, `/api/v1` or `/api` (case-insensitively) is completed
 * rather than doubled. Trailing slashes are ignored.
 */
export function resolveMessagesUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigurationError(`baseUrl must be an absolute http(s) URL, got "${baseUrl}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigurationError(`baseUrl must use http or https, got "${parsed.protocol}"`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ConfigurationError(
      'baseUrl must not carry credentials; the API key is the only credential',
    );
  }
  const path = parsed.pathname.replace(/\/+$/, '');
  const lower = path.toLowerCase();
  if (lower.endsWith(MESSAGES_PATH)) {
    return `${parsed.origin}${path}`;
  }
  if (lower.endsWith('/api/v1')) {
    return `${parsed.origin}${path}/messages`;
  }
  if (lower.endsWith('/api')) {
    return `${parsed.origin}${path}/v1/messages`;
  }
  return `${parsed.origin}${path}${MESSAGES_PATH}`;
}

function resolveConfig(options: SmtpManagerOptions): ResolvedConfig {
  if (options === null || typeof options !== 'object') {
    throw new ConfigurationError('SmtpManager requires an options object');
  }
  const { apiKey, baseUrl } = options;
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new ConfigurationError('apiKey is required');
  }
  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    throw new ConfigurationError(`apiKey must start with "${API_KEY_PREFIX}"`);
  }
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    throw new ConfigurationError('baseUrl is required');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ConfigurationError('timeoutMs must be a positive number');
  }
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new ConfigurationError('maxRetries must be a non-negative integer');
  }
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  if (!Number.isFinite(maxRetryAfterMs) || maxRetryAfterMs < 0) {
    throw new ConfigurationError('maxRetryAfterMs must be a non-negative number');
  }
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof fetchImpl !== 'function') {
    throw new ConfigurationError(
      'No fetch implementation available: pass one via the fetch option',
    );
  }
  const suffix = options.userAgentSuffix?.trim();
  return {
    apiKey,
    messagesUrl: resolveMessagesUrl(baseUrl),
    timeoutMs,
    maxRetries,
    maxRetryAfterMs,
    retryOnServerError: options.retryOnServerError ?? false,
    userAgent: `smtp-manager-sdk-node/${VERSION}${suffix ? ` ${suffix}` : ''}`,
    fetch: fetchImpl,
  };
}

/** Builds the wire body. Only shape/encoding is done here; validation belongs to the API. */
export function buildWireMessage(input: SendMessageInput): WireSendMessage {
  if (input === null || typeof input !== 'object') {
    throw new InvalidInputError('send() requires a message object');
  }
  const wire: WireSendMessage = {
    from: renderAddress(input.from, 'from'),
    to: renderAddressList(input.to, 'to') ?? [],
    subject: input.subject,
  };
  const cc = renderAddressList(input.cc, 'cc');
  if (cc !== undefined) {
    wire.cc = cc;
  }
  const bcc = renderAddressList(input.bcc, 'bcc');
  if (bcc !== undefined) {
    wire.bcc = bcc;
  }
  if (input.replyTo !== undefined) {
    wire.reply_to = renderAddress(input.replyTo, 'replyTo');
  }
  if (input.text !== undefined) {
    wire.text = input.text;
  }
  if (input.html !== undefined) {
    wire.html = input.html;
  }
  if (input.headers !== undefined) {
    wire.headers = input.headers;
  }
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments)) {
      throw new InvalidInputError('attachments must be an array');
    }
    wire.attachments = input.attachments.map(renderAttachment);
  }
  if (input.tags !== undefined) {
    wire.tags = input.tags;
  }
  if (input.metadata !== undefined) {
    wire.metadata = input.metadata;
  }
  return wire;
}

function validateRequestId(requestId: unknown): string {
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new InvalidInputError(
      `requestId must match ${REQUEST_ID_PATTERN} (the server replaces anything else)`,
    );
  }
  return requestId;
}

/** `client.messages`. Not constructible by callers; obtained from `SmtpManager`. */
export class MessagesResource {
  readonly #config: ResolvedConfig;

  constructor(config: ResolvedConfig) {
    this.#config = config;
  }

  /** `POST /api/v1/messages`. Resolves once the API has accepted the message (HTTP 202). */
  async send(input: SendMessageInput, options: SendOptions = {}): Promise<SendResult> {
    const config = this.#config;
    const requestId =
      options.requestId === undefined ? undefined : validateRequestId(options.requestId);
    const body = JSON.stringify(buildWireMessage(input));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': config.userAgent,
    };
    if (requestId !== undefined) {
      headers['X-Request-Id'] = requestId;
    }
    const response = await performRequest({
      url: config.messagesUrl,
      headers,
      body,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
      maxRetryAfterMs: config.maxRetryAfterMs,
      retryOnServerError: config.retryOnServerError,
      fetch: config.fetch,
      signal: options.signal,
    });
    let message;
    try {
      message = mapMessage(unwrapEnvelope(response.body));
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      // A 2xx already arrived: the message is queued, so a re-send would duplicate it.
      throw new UnexpectedResponseError(
        `The server accepted the message (HTTP ${response.status}) but the response could not be interpreted (${reason}); do not re-send it.`,
        { status: response.status, requestId: response.requestId, body: response.body, cause },
      );
    }
    return { message, requestId: response.requestId ?? requestId };
  }

  /** Serializes to the endpoint only; never the key. */
  toJSON(): { messagesUrl: string } {
    return { messagesUrl: this.#config.messagesUrl };
  }

  [inspect.custom](): string {
    return `MessagesResource ${inspect(this.toJSON())}`;
  }
}

/** Client for the SMTP Manager transactional send API. */
export class SmtpManager {
  readonly #config: ResolvedConfig;
  readonly messages: MessagesResource;

  constructor(options: SmtpManagerOptions) {
    this.#config = resolveConfig(options);
    this.messages = new MessagesResource(this.#config);
  }

  /** Fully resolved URL of the send endpoint. */
  get messagesUrl(): string {
    return this.#config.messagesUrl;
  }

  /** The exact `User-Agent` sent with each request. */
  get userAgent(): string {
    return this.#config.userAgent;
  }

  /** Serializes without the API key (it is shown redacted as `smtpk_xxxx…`). */
  toJSON(): PublicConfig {
    return publicConfig(this.#config);
  }

  [inspect.custom](): string {
    return `SmtpManager ${inspect(this.toJSON())}`;
  }
}
