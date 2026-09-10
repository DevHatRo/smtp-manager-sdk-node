import { vi } from 'vitest';
import { SmtpManager } from '../../src/index.js';
import type { FetchLike, SmtpManagerOptions } from '../../src/index.js';

export const API_KEY = 'smtpk_abcdefghij.s3cr3tS3cr3t';
export const BASE_URL = 'https://smtp.example.com';

/** Wire-shaped message with every field populated. */
export const wireMessage = {
  uuid: '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  status: 'queued',
  source: 'api',
  from: 'noreply@example.com',
  from_name: 'Example App',
  to: ['Alice <alice@example.net>'],
  cc: ['bob@example.net'],
  bcc: ['audit@example.net'],
  reply_to: 'support@example.com',
  subject: 'Hello',
  message_id: '<0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b@example.com>',
  tags: ['welcome', 'v2'],
  metadata: { user_id: '42', plan: 'pro' },
  attachments: [
    { filename: 'hello.txt', content_type: 'text/plain', content_id: null, size: 18 },
    { filename: 'logo.png', content_type: 'image/png', content_id: 'logo@example.com', size: 1024 },
  ],
  attempts: 1,
  node_id: 7,
  queue_id: '4F1C2A3B9D',
  error: 'temporary failure',
  sent_at: '2026-09-10T10:00:01.000000Z',
  delivered_at: '2026-09-10T10:00:02.000000Z',
  retry_of: '0192a1b2-0000-7e5f-8a9b-0c1d2e3f4a5b',
  retried_as: '0192a1b2-1111-7e5f-8a9b-0c1d2e3f4a5b',
  created_at: '2026-09-10T10:00:00.000000Z',
  updated_at: '2026-09-10T10:00:02.000000Z',
};

/** Wire-shaped message as the API returns it right after a 202 (nullable fields null). */
export const wireQueuedMessage = {
  ...wireMessage,
  from_name: null,
  cc: [],
  bcc: [],
  reply_to: null,
  message_id: '<0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b@example.com>',
  tags: [],
  metadata: {},
  attachments: [],
  attempts: 0,
  node_id: null,
  queue_id: null,
  error: null,
  sent_at: null,
  delivered_at: null,
  retry_of: null,
  retried_as: null,
};

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function textResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/html', ...headers } });
}

export function accepted(message: unknown = wireQueuedMessage, requestId = 'req-202'): Response {
  return jsonResponse(202, { data: message }, { 'x-request-id': requestId });
}

export function fetchMock(): ReturnType<typeof vi.fn<FetchLike>> {
  return vi.fn<FetchLike>();
}

export function makeClient(
  fetchImpl: FetchLike,
  overrides: Partial<SmtpManagerOptions> = {},
): SmtpManager {
  return new SmtpManager({ apiKey: API_KEY, baseUrl: BASE_URL, fetch: fetchImpl, ...overrides });
}

export function lastCall(
  mock: ReturnType<typeof fetchMock>,
  index = 0,
): {
  url: string;
  init: RequestInit;
  headers: Record<string, string>;
  body: unknown;
} {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`fetch was not called ${index + 1} time(s)`);
  }
  const [url, init] = call;
  return {
    url,
    init,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string),
  };
}
