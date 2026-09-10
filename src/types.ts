/** A recipient or sender: a bare `a@b`, a preformatted `Name <a@b>`, or an object. */
export type AddressInput = string | { email: string; name?: string };

export interface AttachmentInput {
  filename: string;
  /** MIME type, e.g. `application/pdf`. */
  contentType: string;
  /** Raw bytes (base64-encoded by the SDK) or a string that is already base64. */
  content: Uint8Array | Buffer | string;
  /** Marks an inline part; reference it from `html` as `cid:<contentId>`. Must look like `local@domain`. */
  contentId?: string;
}

export interface SendMessageInput {
  /** Must be an active alias on a verified domain of the API key's organization. */
  from: AddressInput;
  to: AddressInput | AddressInput[];
  cc?: AddressInput | AddressInput[];
  bcc?: AddressInput | AddressInput[];
  replyTo?: AddressInput;
  subject: string;
  /** Plain-text body. At least one of `text` / `html` is required. */
  text?: string;
  /** HTML body. At least one of `text` / `html` is required. */
  html?: string;
  /** Extra headers. Addressing, `Received`, `Message-ID` and `DKIM-*` names are refused by the API. */
  headers?: Record<string, string>;
  attachments?: AttachmentInput[];
  tags?: string[];
  /** String values only. Key order is not preserved server-side. */
  metadata?: Record<string, string>;
}

export interface SendOptions {
  /**
   * Sent as `X-Request-Id`, echoed back by the API and attached to every error. Must match
   * `^[A-Za-z0-9._-]{1,64}$` (the server replaces anything else); `InvalidInputError` otherwise.
   */
  requestId?: string;
  /** Aborts the request (and any retry wait). The abort reason is rethrown as-is. */
  signal?: AbortSignal;
}

/**
 * Known statuses, plus any newer value the server may introduce (the server owns the enum;
 * the SDK passes unknown values through as strings).
 */
export type MessageStatus = 'queued' | 'sending' | 'sent' | 'failed' | (string & {});
export type MessageSource = 'api' | 'smtp';

export interface MessageAttachment {
  filename: string;
  contentType: string;
  contentId: string | null;
  /** Decoded size in bytes. */
  size: number;
}

export interface Message {
  uuid: string;
  status: MessageStatus;
  source: MessageSource;
  from: string;
  fromName: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string | null;
  subject: string;
  /** RFC 5322 Message-ID, e.g. `<uuid@domain>`. */
  messageId: string | null;
  tags: string[];
  metadata: Record<string, string>;
  attachments: MessageAttachment[];
  attempts: number;
  nodeId: number | null;
  queueId: string | null;
  error: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  /** UUID of the message this one retries, if any. */
  retryOf: string | null;
  /** UUID of the message that retried this one, if any. */
  retriedAs: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SendResult {
  message: Message;
  /** `X-Request-Id` from the response (falls back to the one you passed in). */
  requestId?: string;
}

/** A `fetch`-compatible function. Defaults to the global `fetch` (Node >= 20). */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SmtpManagerOptions {
  /** API key as shown once in the console when it was created: `smtpk_xxxxxxxxxx.<secret>`. */
  apiKey: string;
  /**
   * Where the API lives. Defaults to the hosted platform, `https://api.your-email.eu`
   * (`DEFAULT_BASE_URL`), so it is only needed for a self-hosted instance: pass the Endpoint the
   * console shows with a new key (`https://host/api/v1/messages`) or the bare origin
   * (`https://host`, optionally with a path prefix). `http://` is accepted for local
   * development only: the key travels in clear.
   */
  baseUrl?: string;
  /**
   * Per-attempt timeout (connect + response body). Default 30 000. Worst-case wall time of a
   * `send()` is `(1 + maxRetries) * timeoutMs` plus the waits between attempts.
   */
  timeoutMs?: number;
  /** Retries after the first attempt on 429 and dial-phase network errors. Default 2. */
  maxRetries?: number;
  /**
   * Longest `Retry-After` the SDK will sleep for on a 429. Default 60 000 (the send quota is
   * per minute). A longer `Retry-After` throws the `RateLimitError` immediately, without
   * sleeping, so the caller can decide.
   */
  maxRetryAfterMs?: number;
  /**
   * Also retry on 5xx, timeouts and ambiguous network errors (connection reset, broken pipe,
   * socket errors after the request was sent). Off by default: the API has no idempotency key
   * yet, so a retried POST whose first attempt did reach the server can send the message twice.
   */
  retryOnServerError?: boolean;
  /** Appended to the `User-Agent` header, e.g. `my-app/1.2.3`. */
  userAgentSuffix?: string;
  /** Custom fetch implementation (tests, proxies, instrumentation). */
  fetch?: FetchLike;
}
