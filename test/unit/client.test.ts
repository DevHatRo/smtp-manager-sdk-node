import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ConfigurationError,
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  InvalidInputError,
  SmtpManager,
  VERSION,
} from '../../src/index.js';
import { resolveMessagesUrl } from '../../src/client.js';
import {
  API_KEY,
  BASE_URL,
  accepted,
  fetchMock,
  jsonResponse,
  lastCall,
  makeClient,
  wireQueuedMessage,
} from './helpers.js';

describe('SmtpManager configuration', () => {
  it('exposes the defaults', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_MAX_RETRIES).toBe(2);
  });

  it.each([
    [{}, 'apiKey is required'],
    [{ apiKey: '' }, 'apiKey is required'],
    [{ apiKey: 42 }, 'apiKey is required'],
    [{ apiKey: 'sk_live_nope' }, 'apiKey must start with "smtpk_"'],
    [{ apiKey: API_KEY }, 'baseUrl is required'],
    [{ apiKey: API_KEY, baseUrl: '' }, 'baseUrl is required'],
    [{ apiKey: API_KEY, baseUrl: 'smtp.example.com' }, 'baseUrl must be an absolute http(s) URL'],
    [{ apiKey: API_KEY, baseUrl: 'ftp://smtp.example.com' }, 'baseUrl must use http or https'],
    [{ apiKey: API_KEY, baseUrl: BASE_URL, timeoutMs: 0 }, 'timeoutMs must be a positive number'],
    [{ apiKey: API_KEY, baseUrl: BASE_URL, timeoutMs: -5 }, 'timeoutMs must be a positive number'],
    [{ apiKey: API_KEY, baseUrl: BASE_URL, maxRetries: -1 }, 'maxRetries must be a non-negative'],
    [{ apiKey: API_KEY, baseUrl: BASE_URL, maxRetries: 1.5 }, 'maxRetries must be a non-negative'],
    [{ apiKey: API_KEY, baseUrl: BASE_URL, maxRetryAfterMs: -1 }, 'maxRetryAfterMs must be'],
    [{ apiKey: API_KEY, baseUrl: BASE_URL, maxRetryAfterMs: NaN }, 'maxRetryAfterMs must be'],
    [
      { apiKey: API_KEY, baseUrl: 'https://user:pass@smtp.example.com' },
      'baseUrl must not carry credentials; the API key is the only credential',
    ],
    [
      { apiKey: API_KEY, baseUrl: 'https://user@smtp.example.com/api' },
      'must not carry credentials',
    ],
    [{ apiKey: API_KEY, baseUrl: 'https://:pw@smtp.example.com' }, 'must not carry credentials'],
  ])('rejects %j synchronously with a ConfigurationError', (options, message) => {
    expect(() => new SmtpManager(options as never)).toThrow(ConfigurationError);
    expect(() => new SmtpManager(options as never)).toThrow(message);
  });

  it('rejects a missing options object', () => {
    expect(() => new SmtpManager(undefined as never)).toThrow(ConfigurationError);
    expect(() => new SmtpManager(null as never)).toThrow(ConfigurationError);
  });

  it('requires a fetch implementation when the global one is missing', () => {
    const original = globalThis.fetch;
    // @ts-expect-error simulating an environment without fetch
    globalThis.fetch = undefined;
    try {
      expect(() => new SmtpManager({ apiKey: API_KEY, baseUrl: BASE_URL })).toThrow(
        'No fetch implementation available',
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it('accepts a valid configuration with the global fetch', () => {
    const client = new SmtpManager({ apiKey: API_KEY, baseUrl: BASE_URL });
    expect(client.messages).toBeDefined();
    expect(client.messagesUrl).toBe('https://smtp.example.com/api/v1/messages');
    expect(client.userAgent).toBe(`smtp-manager-sdk-node/${VERSION}`);
  });

  it('appends the user agent suffix', () => {
    const client = makeClient(fetchMock(), { userAgentSuffix: ' my-app/1.2.3 ' });
    expect(client.userAgent).toBe(`smtp-manager-sdk-node/${VERSION} my-app/1.2.3`);
  });
});

describe('baseUrl normalization', () => {
  it.each([
    ['https://smtp.example.com', 'https://smtp.example.com/api/v1/messages'],
    ['https://smtp.example.com/', 'https://smtp.example.com/api/v1/messages'],
    ['https://smtp.example.com///', 'https://smtp.example.com/api/v1/messages'],
    ['http://localhost:8080', 'http://localhost:8080/api/v1/messages'],
    ['https://example.com/manager', 'https://example.com/manager/api/v1/messages'],
    ['https://example.com/manager/', 'https://example.com/manager/api/v1/messages'],
    ['https://example.com/a/b/', 'https://example.com/a/b/api/v1/messages'],
    ['https://example.com/?x=1#f', 'https://example.com/api/v1/messages'],
    // the console's "Endpoint" (full URL) and its prefixes are completed, never doubled
    ['https://smtp.example.com/api/v1/messages', 'https://smtp.example.com/api/v1/messages'],
    ['https://smtp.example.com/api/v1/messages/', 'https://smtp.example.com/api/v1/messages'],
    ['https://smtp.example.com/api/v1', 'https://smtp.example.com/api/v1/messages'],
    ['https://smtp.example.com/api/v1/', 'https://smtp.example.com/api/v1/messages'],
    ['https://smtp.example.com/api', 'https://smtp.example.com/api/v1/messages'],
    ['https://smtp.example.com/api/', 'https://smtp.example.com/api/v1/messages'],
    ['https://example.com/manager/api/v1/messages', 'https://example.com/manager/api/v1/messages'],
    ['https://example.com/manager/api/', 'https://example.com/manager/api/v1/messages'],
    // suffix matching is case-insensitive; the caller's casing is kept
    ['https://smtp.example.com/API/v1/Messages', 'https://smtp.example.com/API/v1/Messages'],
    ['https://smtp.example.com/Api/V1/', 'https://smtp.example.com/Api/V1/messages'],
    ['https://smtp.example.com/API', 'https://smtp.example.com/API/v1/messages'],
    // only exact path segments count
    ['https://example.com/myapi', 'https://example.com/myapi/api/v1/messages'],
    ['https://example.com/api/v2', 'https://example.com/api/v2/api/v1/messages'],
  ])('%s -> %s', (baseUrl, expected) => {
    expect(resolveMessagesUrl(baseUrl)).toBe(expected);
    expect(makeClient(fetchMock(), { baseUrl }).messagesUrl).toBe(expected);
  });
});

describe('messages.send request shape', () => {
  it('POSTs JSON with every header to the messages URL', async () => {
    const fetch = fetchMock().mockResolvedValueOnce(accepted());
    const client = makeClient(fetch, { baseUrl: 'https://smtp.example.com/' });

    await client.messages.send({
      from: 'a@example.com',
      to: 'b@example.net',
      subject: 'S',
      text: 'T',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const { url, init, headers } = lastCall(fetch);
    expect(url).toBe('https://smtp.example.com/api/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': `smtp-manager-sdk-node/${VERSION}`,
    });
    expect(typeof init.body).toBe('string');
  });

  it('sends X-Request-Id only when the caller passes one, and returns it', async () => {
    const fetch = fetchMock()
      .mockResolvedValueOnce(accepted(undefined, 'srv-1'))
      .mockResolvedValueOnce(jsonResponse(202, { data: wireQueuedMessage }));
    const client = makeClient(fetch, { userAgentSuffix: 'app/2' });

    const first = await client.messages.send(
      { from: 'a@example.com', to: 'b@example.net', subject: 'S', text: 'T' },
      { requestId: 'client-req-1' },
    );
    expect(lastCall(fetch, 0).headers['X-Request-Id']).toBe('client-req-1');
    expect(lastCall(fetch, 0).headers['User-Agent']).toBe(`smtp-manager-sdk-node/${VERSION} app/2`);
    expect(first.requestId).toBe('srv-1');

    const second = await client.messages.send(
      { from: 'a@example.com', to: 'b@example.net', subject: 'S', text: 'T' },
      { requestId: 'client-req-2' },
    );
    expect(lastCall(fetch, 1).headers['X-Request-Id']).toBe('client-req-2');
    // no header from the server: falls back to the caller's id
    expect(second.requestId).toBe('client-req-2');
  });

  it('leaves requestId undefined when neither side provides one', async () => {
    const fetch = fetchMock().mockResolvedValueOnce(jsonResponse(202, { data: wireQueuedMessage }));
    const result = await makeClient(fetch).messages.send({
      from: 'a@example.com',
      to: 'b@example.net',
      subject: 'S',
      text: 'T',
    });
    expect(result.requestId).toBeUndefined();
    expect('X-Request-Id' in lastCall(fetch).headers).toBe(false);
  });

  it.each(['', 'has space', 'a'.repeat(65), 'semi;colon', 'slash/x', 'ünïcode'])(
    'rejects requestId %j client-side',
    async (requestId) => {
      const fetch = fetchMock();
      await expect(
        makeClient(fetch).messages.send(
          { from: 'a@example.com', to: 'b@example.net', subject: 'S', text: 'T' },
          { requestId },
        ),
      ).rejects.toThrow(InvalidInputError);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['a', 'A-b_c.d', 'a'.repeat(64), '0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'])(
    'accepts requestId %j',
    async (requestId) => {
      const fetch = fetchMock().mockResolvedValueOnce(accepted());
      await makeClient(fetch).messages.send(
        { from: 'a@example.com', to: 'b@example.net', subject: 'S', text: 'T' },
        { requestId },
      );
      expect(lastCall(fetch).headers['X-Request-Id']).toBe(requestId);
    },
  );

  it('renders the minimal body in snake_case with `to` as an array', async () => {
    const fetch = fetchMock().mockResolvedValueOnce(accepted());
    await makeClient(fetch).messages.send({
      from: 'a@example.com',
      to: 'b@example.net',
      subject: 'Subject',
      html: '<p>Hi</p>',
    });
    expect(lastCall(fetch).body).toEqual({
      from: 'a@example.com',
      to: ['b@example.net'],
      subject: 'Subject',
      html: '<p>Hi</p>',
    });
  });

  it('renders a full composition in snake_case', async () => {
    const fetch = fetchMock().mockResolvedValueOnce(accepted());
    await makeClient(fetch).messages.send({
      from: { email: 'noreply@example.com', name: 'Example App' },
      to: [
        { email: 'alice@example.net', name: 'Alice' },
        'bob@example.net',
        'Carol <carol@example.net>',
      ],
      cc: { email: 'cc@example.net' },
      bcc: ['bcc1@example.net', { email: 'bcc2@example.net', name: 'B Two' }],
      replyTo: { email: 'support@example.com', name: 'Support' },
      subject: 'Subject',
      text: 'Text',
      html: '<img src="cid:logo@example.com">',
      headers: { 'X-Campaign': 'spring', 'X-Priority': '3' },
      attachments: [
        { filename: 'hello.txt', contentType: 'text/plain', content: Buffer.from('hello') },
        {
          filename: 'logo.png',
          contentType: 'image/png',
          content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          contentId: 'logo@example.com',
        },
        { filename: 'pre.bin', contentType: 'application/octet-stream', content: 'AQID' },
      ],
      tags: ['welcome', 'v2'],
      metadata: { user_id: '42' },
    });
    expect(lastCall(fetch).body).toEqual({
      from: 'Example App <noreply@example.com>',
      to: ['Alice <alice@example.net>', 'bob@example.net', 'Carol <carol@example.net>'],
      cc: ['cc@example.net'],
      bcc: ['bcc1@example.net', 'B Two <bcc2@example.net>'],
      reply_to: 'Support <support@example.com>',
      subject: 'Subject',
      text: 'Text',
      html: '<img src="cid:logo@example.com">',
      headers: { 'X-Campaign': 'spring', 'X-Priority': '3' },
      attachments: [
        { filename: 'hello.txt', content_type: 'text/plain', content: 'aGVsbG8=' },
        {
          filename: 'logo.png',
          content_type: 'image/png',
          content: 'iVBORw==',
          content_id: 'logo@example.com',
        },
        { filename: 'pre.bin', content_type: 'application/octet-stream', content: 'AQID' },
      ],
      tags: ['welcome', 'v2'],
      metadata: { user_id: '42' },
    });
  });

  it('passes through strings and empty arrays untouched so the API validates them', async () => {
    const fetch = fetchMock().mockResolvedValueOnce(accepted());
    await makeClient(fetch).messages.send({
      from: 'Not An Email',
      to: [],
      cc: [],
      subject: '',
      text: '',
      tags: [],
      metadata: {},
      headers: {},
      attachments: [],
    });
    expect(lastCall(fetch).body).toEqual({
      from: 'Not An Email',
      to: [],
      cc: [],
      subject: '',
      text: '',
      tags: [],
      metadata: {},
      headers: {},
      attachments: [],
    });
  });

  it('rejects invalid input client-side without calling fetch', async () => {
    const fetch = fetchMock();
    const client = makeClient(fetch);
    const base = { from: 'a@example.com', to: 'b@example.net', subject: 'S', text: 'T' };

    await expect(
      client.messages.send({ ...base, from: { email: 'a@example.com', name: 'Evil <x>' } }),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      client.messages.send({ ...base, to: [{ email: 'b@example.net', name: 'Line\nBreak' }] }),
    ).rejects.toThrow(InvalidInputError);
    await expect(client.messages.send({ ...base, attachments: 'nope' as never })).rejects.toThrow(
      'attachments must be an array',
    );
    await expect(client.messages.send(null as never)).rejects.toThrow(InvalidInputError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps the 202 envelope into a SendResult', async () => {
    const fetch = fetchMock().mockResolvedValueOnce(accepted());
    const { message, requestId } = await makeClient(fetch).messages.send({
      from: 'a@example.com',
      to: 'b@example.net',
      subject: 'S',
      text: 'T',
    });
    expect(requestId).toBe('req-202');
    expect(message.uuid).toBe('0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b');
    expect(message.status).toBe('queued');
    expect(message.messageId).toMatch(/^<.+@.+>$/);
  });
});

describe('secret handling', () => {
  const client = makeClient(fetchMock(), { userAgentSuffix: 'app/1', timeoutMs: 1234 });
  const secret = API_KEY.split('.')[1] as string;

  it.each([
    ['JSON.stringify(client)', () => JSON.stringify(client)],
    ['JSON.stringify(client.messages)', () => JSON.stringify(client.messages)],
    ['inspect(client)', () => inspect(client, { depth: 10, showHidden: true })],
    ['inspect(client.messages)', () => inspect(client.messages, { depth: 10, showHidden: true })],
    ['nested inspect', () => inspect([client, { nested: client.messages }], { depth: 10 })],
  ])('%s never contains the API key', (_label, render) => {
    const out = render();
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain(secret);
  });

  it('shows the key redacted on the client, and only the endpoint on messages', () => {
    expect(JSON.stringify(client)).toContain('smtpk_abcd…');
    expect(inspect(client)).toContain('smtpk_abcd…');
    expect(inspect(client.messages)).toBe(
      "MessagesResource { messagesUrl: 'https://smtp.example.com/api/v1/messages' }",
    );
  });

  it('serializes the public configuration', () => {
    expect(JSON.parse(JSON.stringify(client))).toEqual({
      apiKey: 'smtpk_abcd…',
      messagesUrl: 'https://smtp.example.com/api/v1/messages',
      timeoutMs: 1234,
      maxRetries: 2,
      maxRetryAfterMs: 60_000,
      retryOnServerError: false,
      userAgent: `smtp-manager-sdk-node/${VERSION} app/1`,
    });
    expect(JSON.parse(JSON.stringify(client.messages))).toEqual({
      messagesUrl: 'https://smtp.example.com/api/v1/messages',
    });
    expect(Object.keys(client)).toEqual(['messages']);
    expect(Object.keys(client.messages)).toEqual([]);
  });
});
