import { describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  ConfigurationError,
  InvalidInputError,
  NetworkError,
  PayloadTooLargeError,
  PermissionError,
  RateLimitError,
  ServerError,
  SmtpManagerError,
  TimeoutError,
  UnexpectedResponseError,
  ValidationError,
} from '../../src/index.js';
import { parseRetryAfter } from '../../src/transport.js';
import { fetchMock, jsonResponse, makeClient, textResponse } from './helpers.js';

const input = { from: 'a@example.com', to: 'b@example.net', subject: 'S', text: 'T' };

async function sendExpecting<T extends SmtpManagerError>(
  response: Response,
  cls: new (...args: never[]) => T,
): Promise<T> {
  const fetch = fetchMock().mockResolvedValueOnce(response);
  const client = makeClient(fetch, { maxRetries: 0 });
  const error = await client.messages.send(input).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SmtpManagerError);
  expect(error).toBeInstanceOf(cls);
  return error as T;
}

describe('error classes', () => {
  it('carry name, status, requestId, body and cause', () => {
    const cause = new Error('root');
    const error = new SmtpManagerError('msg', {
      status: 418,
      requestId: 'r',
      body: { a: 1 },
      cause,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SmtpManagerError');
    expect(error.message).toBe('msg');
    expect(error.status).toBe(418);
    expect(error.requestId).toBe('r');
    expect(error.body).toEqual({ a: 1 });
    expect(error.cause).toBe(cause);
    expect(new SmtpManagerError('bare').cause).toBeUndefined();
  });

  it.each([
    [new ConfigurationError('c'), 'ConfigurationError'],
    [new InvalidInputError('i'), 'InvalidInputError'],
    [new AuthenticationError('a'), 'AuthenticationError'],
    [new PermissionError('p'), 'PermissionError'],
    [new ValidationError('v', {}), 'ValidationError'],
    [new RateLimitError('r'), 'RateLimitError'],
    [new PayloadTooLargeError('p'), 'PayloadTooLargeError'],
    [new ServerError('s'), 'ServerError'],
    [new NetworkError('n'), 'NetworkError'],
    [new TimeoutError('t', 5), 'TimeoutError'],
    [new UnexpectedResponseError('u'), 'UnexpectedResponseError'],
  ])('%s has name %s and extends SmtpManagerError', (error, name) => {
    expect(error).toBeInstanceOf(SmtpManagerError);
    expect(error.name).toBe(name);
  });

  it('TimeoutError exposes timeoutMs', () => {
    expect(new TimeoutError('t', 1234).timeoutMs).toBe(1234);
  });
});

describe('HTTP status mapping', () => {
  it('401 -> AuthenticationError', async () => {
    const error = await sendExpecting(
      jsonResponse(
        401,
        { message: 'Unauthenticated.', request_id: 'r401' },
        { 'x-request-id': 'r401' },
      ),
      AuthenticationError,
    );
    expect(error.status).toBe(401);
    expect(error.message).toBe('Unauthenticated.');
    expect(error.requestId).toBe('r401');
    expect(error.body).toEqual({ message: 'Unauthenticated.', request_id: 'r401' });
  });

  it('403 -> PermissionError', async () => {
    const error = await sendExpecting(
      jsonResponse(403, { message: 'This API key cannot send.', request_id: 'r403' }),
      PermissionError,
    );
    expect(error.status).toBe(403);
    expect(error.message).toBe('This API key cannot send.');
    // request_id from the body when the header is absent
    expect(error.requestId).toBe('r403');
  });

  it('422 -> ValidationError with errors', async () => {
    const body = {
      message: 'The given data was invalid.',
      errors: { from: ['The from address is not a known alias.'], 'to.0': ['Invalid.', 'Dup.'] },
      request_id: 'r422',
    };
    const error = await sendExpecting(jsonResponse(422, body), ValidationError);
    expect(error.status).toBe(422);
    expect(error.message).toBe('The given data was invalid.');
    expect(error.requestId).toBe('r422');
    expect(error.errors).toEqual({
      from: ['The from address is not a known alias.'],
      'to.0': ['Invalid.', 'Dup.'],
    });
    expect(error.body).toEqual(body);
  });

  it('422 without an errors object still yields ValidationError', async () => {
    const error = await sendExpecting(jsonResponse(422, { message: 'Nope' }), ValidationError);
    expect(error.errors).toEqual({});
    const odd = await sendExpecting(
      jsonResponse(422, { errors: { a: 'single', b: null, c: [1, 2] } }),
      ValidationError,
    );
    expect(odd.errors).toEqual({ a: ['single'], b: [], c: ['1', '2'] });
    expect(odd.message).toBe('The given data was invalid');
  });

  it('429 -> RateLimitError with numeric Retry-After', async () => {
    const error = await sendExpecting(
      jsonResponse(
        429,
        { message: 'Too Many Attempts.', request_id: 'r429' },
        { 'retry-after': '17' },
      ),
      RateLimitError,
    );
    expect(error.status).toBe(429);
    expect(error.retryAfter).toBe(17);
    expect(error.requestId).toBe('r429');
  });

  it('429 -> RateLimitError with HTTP-date Retry-After', async () => {
    const date = new Date(Date.now() + 42_000).toUTCString();
    const error = await sendExpecting(
      jsonResponse(429, { message: 'Quota exceeded' }, { 'retry-after': date }),
      RateLimitError,
    );
    expect(error.retryAfter).toBeGreaterThanOrEqual(41);
    expect(error.retryAfter).toBeLessThanOrEqual(43);
  });

  it('429 without Retry-After leaves retryAfter undefined', async () => {
    const error = await sendExpecting(jsonResponse(429, { message: 'slow down' }), RateLimitError);
    expect(error.retryAfter).toBeUndefined();
  });

  it('413 with a non-JSON body -> PayloadTooLargeError', async () => {
    const error = await sendExpecting(
      textResponse(413, '<html><body>413 Request Entity Too Large</body></html>'),
      PayloadTooLargeError,
    );
    expect(error.status).toBe(413);
    expect(error.message).toBe('Request body too large');
    expect(error.body).toBe('<html><body>413 Request Entity Too Large</body></html>');
    expect(error.requestId).toBeUndefined();
  });

  it('500 / 503 -> ServerError', async () => {
    const error = await sendExpecting(
      jsonResponse(500, { message: 'Server Error', request_id: 'r500' }),
      ServerError,
    );
    expect(error.status).toBe(500);
    expect(error.message).toBe('Server Error');
    expect(error.requestId).toBe('r500');

    const empty = await sendExpecting(new Response(null, { status: 503 }), ServerError);
    expect(empty.message).toBe('Server error (HTTP 503)');
    expect(empty.body).toBeUndefined();
  });

  it('502 with an HTML body -> ServerError carrying the raw text', async () => {
    const error = await sendExpecting(textResponse(502, '<h1>Bad Gateway</h1>'), ServerError);
    expect(error.status).toBe(502);
    expect(error.body).toBe('<h1>Bad Gateway</h1>');
    expect(error.message).toBe('Server error (HTTP 502)');
  });

  it('unknown statuses -> UnexpectedResponseError', async () => {
    const error = await sendExpecting(textResponse(418, "I'm a teapot"), UnexpectedResponseError);
    expect(error.status).toBe(418);
    expect(error.message).toBe('Unexpected response (HTTP 418)');
    expect(error.body).toBe("I'm a teapot");
  });

  it('3xx is not followed and names the Location', async () => {
    const redirect = await sendExpecting(
      textResponse(302, '', { location: 'https://smtp.example.com/login' }),
      UnexpectedResponseError,
    );
    expect(redirect.status).toBe(302);
    expect(redirect.message).toBe(
      'Unexpected redirect (HTTP 302) to https://smtp.example.com/login; check baseUrl',
    );

    const bare = await sendExpecting(
      jsonResponse(301, { message: 'Moved' }),
      UnexpectedResponseError,
    );
    expect(bare.message).toBe('Unexpected redirect (HTTP 301); check baseUrl');
  });

  it('2xx with a non-JSON or non-envelope body -> UnexpectedResponseError', async () => {
    const html = await sendExpecting(
      textResponse(200, '<html>login</html>'),
      UnexpectedResponseError,
    );
    expect(html.body).toBe('<html>login</html>');
    expect(html.message).toContain('envelope');

    const noData = await sendExpecting(
      jsonResponse(202, { message: 'ok' }),
      UnexpectedResponseError,
    );
    expect(noData.message).toContain('envelope');

    const badData = await sendExpecting(
      jsonResponse(202, { data: 'string' }, { 'x-request-id': 'r-bad' }),
      UnexpectedResponseError,
    );
    expect(badData.message).toBe(
      'The server accepted the message (HTTP 202) but the response could not be interpreted (Expected a message object in the response body); do not re-send it.',
    );
    expect(badData.status).toBe(202);
    expect(badData.requestId).toBe('r-bad');
    expect(badData.body).toEqual({ data: 'string' });
    expect(badData.cause).toBeInstanceOf(UnexpectedResponseError);

    const nullData = await sendExpecting(
      jsonResponse(202, { data: null }),
      UnexpectedResponseError,
    );
    expect(nullData.message).toContain('do not re-send');

    const noUuid = await sendExpecting(
      jsonResponse(202, { data: { status: 'queued' } }),
      UnexpectedResponseError,
    );
    expect(noUuid.message).toContain('no uuid');
    expect(noUuid.message).toContain('do not re-send');
  });

  it('a 202 body that fails to read -> UnexpectedResponseError saying not to re-send, never retried', async () => {
    const broken = {
      status: 202,
      headers: new Headers({ 'x-request-id': 'r-broken' }),
      text: () => Promise.reject(new Error('stream reset')),
    } as unknown as Response;
    const fetch = fetchMock().mockResolvedValue(broken);
    const client = makeClient(fetch, { maxRetries: 2, retryOnServerError: true });
    const error = (await client.messages.send(input).catch((e: unknown) => e)) as SmtpManagerError;
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error.message).toBe(
      'Failed to read the response body (HTTP 202): stream reset. The server accepted the message (HTTP 202) but the response could not be read; do not re-send it.',
    );
    expect(error.status).toBe(202);
    expect(error.requestId).toBe('r-broken');
    expect(error.cause).toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a 5xx body that fails to read -> UnexpectedResponseError without the accepted hint', async () => {
    const broken = {
      status: 502,
      headers: new Headers(),
      text: () => Promise.reject(new Error('stream reset')),
    } as unknown as Response;
    const fetch = fetchMock().mockResolvedValue(broken);
    const error = (await makeClient(fetch, { retryOnServerError: true })
      .messages.send(input)
      .catch((e: unknown) => e)) as SmtpManagerError;
    expect(error).toBeInstanceOf(UnexpectedResponseError);
    expect(error.message).toBe('Failed to read the response body (HTTP 502): stream reset.');
    expect(error.status).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.UTC(2026, 8, 10, 12, 0, 0);

  it('parses delta-seconds', () => {
    expect(parseRetryAfter('0', now)).toBe(0);
    expect(parseRetryAfter(' 30 ', now)).toBe(30);
  });

  it('parses HTTP-dates relative to now, never negative', () => {
    expect(parseRetryAfter('Thu, 10 Sep 2026 12:00:45 GMT', now)).toBe(45);
    expect(parseRetryAfter('Thu, 10 Sep 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('returns undefined for missing or garbage values', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
  });
});
