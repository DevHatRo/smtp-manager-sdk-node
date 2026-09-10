import { UnexpectedResponseError } from './errors.js';
import type { Message, MessageAttachment, MessageSource, MessageStatus } from './types.js';
import { isRecord } from './util.js';

type Raw = Record<string, unknown>;

function str(raw: Raw, key: string): string {
  const value = raw[key];
  return typeof value === 'string'
    ? value
    : value === undefined || value === null
      ? ''
      : String(value);
}

function nullableStr(raw: Raw, key: string): string | null {
  const value = raw[key];
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'string' ? value : String(value);
}

function num(raw: Raw, key: string): number {
  const value = raw[key];
  return typeof value === 'number' ? value : Number(value ?? 0) || 0;
}

function nullableNum(raw: Raw, key: string): number | null {
  const value = raw[key];
  if (value === undefined || value === null) {
    return null;
  }
  return typeof value === 'number' ? value : Number(value);
}

function strArray(raw: Raw, key: string): string[] {
  const value = raw[key];
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function strRecord(raw: Raw, key: string): Record<string, string> {
  const value = raw[key];
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = typeof v === 'string' ? v : String(v);
  }
  return out;
}

function mapAttachment(raw: unknown): MessageAttachment {
  const item = isRecord(raw) ? raw : {};
  return {
    filename: str(item, 'filename'),
    contentType: str(item, 'content_type'),
    contentId: nullableStr(item, 'content_id'),
    size: num(item, 'size'),
  };
}

/** Maps the wire (snake_case) `Message` to the SDK's camelCase `Message`. */
export function mapMessage(raw: unknown): Message {
  if (!isRecord(raw)) {
    throw new UnexpectedResponseError('Expected a message object in the response body', {
      body: raw,
    });
  }
  const uuid = raw['uuid'];
  if (typeof uuid !== 'string' || uuid === '') {
    throw new UnexpectedResponseError('Response message has no uuid', { body: raw });
  }
  const attachments = raw['attachments'];
  return {
    uuid,
    // The server owns this enum: unknown values pass through rather than failing the call.
    status: str(raw, 'status') as MessageStatus,
    source: str(raw, 'source') as MessageSource,
    from: str(raw, 'from'),
    fromName: nullableStr(raw, 'from_name'),
    to: strArray(raw, 'to'),
    cc: strArray(raw, 'cc'),
    bcc: strArray(raw, 'bcc'),
    replyTo: nullableStr(raw, 'reply_to'),
    subject: str(raw, 'subject'),
    messageId: nullableStr(raw, 'message_id'),
    tags: strArray(raw, 'tags'),
    metadata: strRecord(raw, 'metadata'),
    attachments: Array.isArray(attachments) ? attachments.map(mapAttachment) : [],
    attempts: num(raw, 'attempts'),
    nodeId: nullableNum(raw, 'node_id'),
    queueId: nullableStr(raw, 'queue_id'),
    error: nullableStr(raw, 'error'),
    sentAt: nullableStr(raw, 'sent_at'),
    deliveredAt: nullableStr(raw, 'delivered_at'),
    retryOf: nullableStr(raw, 'retry_of'),
    retriedAs: nullableStr(raw, 'retried_as'),
    createdAt: str(raw, 'created_at'),
    updatedAt: str(raw, 'updated_at'),
  };
}

/** Extracts `data` from a `{ data: ... }` envelope. */
export function unwrapEnvelope(body: unknown): unknown {
  if (!isRecord(body) || !('data' in body)) {
    throw new UnexpectedResponseError('Expected a { data: ... } envelope in the response body', {
      body,
    });
  }
  return body['data'];
}
