export {
  SmtpManager,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
} from './client.js';
export type { PublicConfig } from './client.js';
export { DEFAULT_MAX_RETRY_AFTER_MS } from './transport.js';
export { attachmentFromFile } from './attachments.js';
export type { AttachmentFromFileOptions } from './attachments.js';
export { LIMITS } from './limits.js';
export type { Limits } from './limits.js';
export { VERSION } from './version.js';
export {
  SmtpManagerError,
  ConfigurationError,
  InvalidInputError,
  AuthenticationError,
  PermissionError,
  ValidationError,
  RateLimitError,
  PayloadTooLargeError,
  ServerError,
  NetworkError,
  TimeoutError,
  UnexpectedResponseError,
} from './errors.js';
export type { SmtpManagerErrorOptions } from './errors.js';
export type {
  AddressInput,
  AttachmentInput,
  FetchLike,
  Message,
  MessageAttachment,
  MessageSource,
  MessageStatus,
  SendMessageInput,
  SendOptions,
  SendResult,
  SmtpManagerOptions,
} from './types.js';
