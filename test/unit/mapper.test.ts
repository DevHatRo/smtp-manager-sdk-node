import { describe, expect, it } from 'vitest';
import { mapMessage, unwrapEnvelope } from '../../src/mapper.js';
import { UnexpectedResponseError } from '../../src/index.js';
import { wireMessage, wireQueuedMessage } from './helpers.js';

describe('mapMessage', () => {
  it('maps every field of a fully populated message', () => {
    expect(mapMessage(wireMessage)).toEqual({
      uuid: '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      status: 'queued',
      source: 'api',
      from: 'noreply@example.com',
      fromName: 'Example App',
      to: ['Alice <alice@example.net>'],
      cc: ['bob@example.net'],
      bcc: ['audit@example.net'],
      replyTo: 'support@example.com',
      subject: 'Hello',
      messageId: '<0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b@example.com>',
      tags: ['welcome', 'v2'],
      metadata: { user_id: '42', plan: 'pro' },
      attachments: [
        { filename: 'hello.txt', contentType: 'text/plain', contentId: null, size: 18 },
        {
          filename: 'logo.png',
          contentType: 'image/png',
          contentId: 'logo@example.com',
          size: 1024,
        },
      ],
      attempts: 1,
      nodeId: 7,
      queueId: '4F1C2A3B9D',
      error: 'temporary failure',
      sentAt: '2026-09-10T10:00:01.000000Z',
      deliveredAt: '2026-09-10T10:00:02.000000Z',
      retryOf: '0192a1b2-0000-7e5f-8a9b-0c1d2e3f4a5b',
      retriedAs: '0192a1b2-1111-7e5f-8a9b-0c1d2e3f4a5b',
      createdAt: '2026-09-10T10:00:00.000000Z',
      updatedAt: '2026-09-10T10:00:02.000000Z',
    });
  });

  it('keeps nulls, empty arrays and empty objects of a freshly queued message', () => {
    const mapped = mapMessage(wireQueuedMessage);
    expect(mapped).toMatchObject({
      fromName: null,
      cc: [],
      bcc: [],
      replyTo: null,
      tags: [],
      metadata: {},
      attachments: [],
      attempts: 0,
      nodeId: null,
      queueId: null,
      error: null,
      sentAt: null,
      deliveredAt: null,
      retryOf: null,
      retriedAs: null,
    });
    expect(mapped.messageId).toBe('<0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b@example.com>');
  });

  it('does not leak snake_case keys', () => {
    const keys = Object.keys(mapMessage(wireMessage));
    expect(keys.some((key) => key.includes('_'))).toBe(false);
    expect(keys).toHaveLength(24);
  });

  it('tolerates missing or oddly typed fields', () => {
    const mapped = mapMessage({
      uuid: 'u-1',
      status: 'sent',
      attempts: '3',
      node_id: '9',
      tags: 'x',
      metadata: null,
      attachments: [null, 'x'],
    });
    expect(mapped.uuid).toBe('u-1');
    expect(mapped.attempts).toBe(3);
    expect(mapped.nodeId).toBe(9);
    expect(mapped.tags).toEqual([]);
    expect(mapped.metadata).toEqual({});
    expect(mapped.attachments).toEqual([
      { filename: '', contentType: '', contentId: null, size: 0 },
      { filename: '', contentType: '', contentId: null, size: 0 },
    ]);
    expect(mapped.subject).toBe('');
    expect(mapped.messageId).toBeNull();
    expect(mapped.createdAt).toBe('');
    expect(
      mapMessage({
        uuid: 'u',
        status: 'failed',
        metadata: { n: 1 },
        to: [1, 'b'],
        attempts: 'nope',
      }),
    ).toMatchObject({
      metadata: { n: '1' },
      to: ['1', 'b'],
      attempts: 0,
    });
  });

  it('requires a string uuid', () => {
    expect(() => mapMessage({})).toThrow(UnexpectedResponseError);
    expect(() => mapMessage({ status: 'queued' })).toThrow('no uuid');
    expect(() => mapMessage({ uuid: '', status: 'queued' })).toThrow('no uuid');
    expect(() => mapMessage({ uuid: 123, status: 'queued' })).toThrow('no uuid');
  });

  it('passes any status through: the server owns the enum', () => {
    for (const status of ['queued', 'sending', 'sent', 'failed', 'bounced', 'deferred']) {
      expect(mapMessage({ uuid: 'u', status }).status).toBe(status);
    }
    expect(mapMessage({ uuid: 'u' }).status).toBe('');
  });

  it('throws UnexpectedResponseError for a non-object', () => {
    expect(() => mapMessage(null)).toThrow(UnexpectedResponseError);
    expect(() => mapMessage('text')).toThrow(UnexpectedResponseError);
    expect(() => mapMessage([wireMessage])).toThrow(UnexpectedResponseError);
  });
});

describe('unwrapEnvelope', () => {
  it('returns data', () => {
    expect(unwrapEnvelope({ data: { a: 1 } })).toEqual({ a: 1 });
    expect(unwrapEnvelope({ data: null })).toBeNull();
  });

  it('throws for anything that is not an envelope', () => {
    expect(() => unwrapEnvelope(undefined)).toThrow(UnexpectedResponseError);
    expect(() => unwrapEnvelope('<html>')).toThrow(UnexpectedResponseError);
    expect(() => unwrapEnvelope({ message: 'ok' })).toThrow(UnexpectedResponseError);
    expect(() => unwrapEnvelope([])).toThrow(UnexpectedResponseError);
  });
});
