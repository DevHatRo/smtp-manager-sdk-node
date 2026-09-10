export interface SmtpManagerErrorOptions {
  /** HTTP status of the response, when one was received. */
  status?: number;
  /** `X-Request-Id` of the response (or `request_id` from the error body). */
  requestId?: string;
  /** Parsed JSON body, or the raw text when the body was not JSON. */
  body?: unknown;
  cause?: unknown;
}

/** Base class of every error thrown by the SDK. */
export class SmtpManagerError extends Error {
  readonly status?: number;
  readonly requestId?: string;
  readonly body?: unknown;

  constructor(message: string, options: SmtpManagerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SmtpManagerError';
    this.status = options.status;
    this.requestId = options.requestId;
    this.body = options.body;
  }
}

/** Client construction failed: missing/invalid `apiKey` or `baseUrl`. Thrown synchronously. */
export class ConfigurationError extends SmtpManagerError {
  constructor(message: string, options: SmtpManagerErrorOptions = {}) {
    super(message, options);
    this.name = 'ConfigurationError';
  }
}

/** The input could not be rendered onto the wire (e.g. a display name containing `<`). */
export class InvalidInputError extends SmtpManagerError {
  constructor(message: string, options: SmtpManagerErrorOptions = {}) {
    super(message, options);
    this.name = 'InvalidInputError';
  }
}

/** HTTP 401: the API key is missing, malformed or revoked. */
export class AuthenticationError extends SmtpManagerError {
  constructor(message: string, options: SmtpManagerErrorOptions = {}) {
    super(message, options);
    this.name = 'AuthenticationError';
  }
}

/** HTTP 403: the API key lacks the `send` ability. */
export class PermissionError extends SmtpManagerError {
  constructor(message: string, options: SmtpManagerErrorOptions = {}) {
    super(message, options);
    this.name = 'PermissionError';
  }
}

/** HTTP 422: the message was rejected by validation. `errors` maps wire field names to messages. */
export class ValidationError extends SmtpManagerError {
  readonly errors: Record<string, string[]>;

  constructor(
    message: string,
    errors: Record<string, string[]>,
    options: SmtpManagerErrorOptions = {},
  ) {
    super(message, options);
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/** HTTP 429: the organization's send quota (or the failed-auth burst limit) was hit. */
export class RateLimitError extends SmtpManagerError {
  /** Seconds to wait before retrying, parsed from `Retry-After` (delta-seconds or HTTP-date). */
  readonly retryAfter?: number;

  constructor(message: string, options: SmtpManagerErrorOptions & { retryAfter?: number } = {}) {
    super(message, options);
    this.name = 'RateLimitError';
    this.retryAfter = options.retryAfter;
  }
}

/** HTTP 413: the request body exceeded the proxy's 12 MB limit. The body is usually not JSON. */
export class PayloadTooLargeError extends SmtpManagerError {
  constructor(message: string, options: SmtpManagerErrorOptions = {}) {
    super(message, options);
    this.name = 'PayloadTooLargeError';
  }
}

/** HTTP 5xx. Not retried unless `retryOnServerError` is set. */
export class ServerError extends SmtpManagerError {
  constructor(message: string, options: SmtpManagerErrorOptions = {}) {
    super(message, options);
    this.name = 'ServerError';
  }
}

/**
 * `fetch` rejected before any response arrived. `retryable` is true only when the failure
 * happened before a connection existed (DNS, refused, unreachable, connect timeout), i.e. the
 * request provably never reached the server; those are retried automatically. Anything else
 * (reset, broken pipe, socket errors mid-request) is ambiguous and is only retried with
 * `retryOnServerError`.
 */
export class NetworkError extends SmtpManagerError {
  readonly retryable: boolean;
  /** The OS / undici error code that was classified, when one was found (e.g. `ECONNREFUSED`). */
  readonly code?: string;

  constructor(
    message: string,
    options: SmtpManagerErrorOptions & { retryable?: boolean; code?: string } = {},
  ) {
    super(message, options);
    this.name = 'NetworkError';
    this.retryable = options.retryable ?? false;
    this.code = options.code;
  }
}

/** The request exceeded `timeoutMs`. Not retried unless `retryOnServerError` is set. */
export class TimeoutError extends SmtpManagerError {
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, options: SmtpManagerErrorOptions = {}) {
    super(message, options);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** Any other response the SDK could not interpret (unknown status, non-JSON success body...). */
export class UnexpectedResponseError extends SmtpManagerError {
  constructor(message: string, options: SmtpManagerErrorOptions = {}) {
    super(message, options);
    this.name = 'UnexpectedResponseError';
  }
}
