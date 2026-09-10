import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NetworkError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError,
} from '../../src/index.js';
import type { FetchLike } from '../../src/index.js';
import {
  BACKOFF_JITTER,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  retryDelayMs,
} from '../../src/transport.js';
import { accepted, fetchMock, jsonResponse, lastCall, makeClient } from './helpers.js';

const input = { from: 'a@example.com', to: 'b@example.net', subject: 'S', text: 'T' };

function dialCause(code: string, message = `connect ${code}`): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** How undici surfaces a socket error: `TypeError('fetch failed')` with the coded cause. */
function dial(code: string): TypeError {
  return new TypeError('fetch failed', { cause: dialCause(code) });
}

/** A response whose body never arrives; reading it rejects when the request signal aborts. */
function stalledBody(
  status: number,
  headers: Record<string, string> = {},
): ReturnType<typeof fetchMock> {
  return fetchMock().mockImplementation(async (_url, init) => {
    const signal = init.signal as AbortSignal;
    return {
      status,
      headers: new Headers(headers),
      text: () =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    } as unknown as Response;
  });
}

/** A fetch that never resolves on its own and rejects like undici when the signal aborts. */
function hangingFetch(): ReturnType<typeof fetchMock> {
  return fetchMock().mockImplementation(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
}

describe('retry policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // jitter factor of exactly 1.0, so backoff waits are deterministic below
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a 429 after Retry-After seconds and resolves on the 202', async () => {
    const fetch = fetchMock()
      .mockResolvedValueOnce(jsonResponse(429, { message: 'quota' }, { 'retry-after': '3' }))
      .mockResolvedValueOnce(accepted());
    const client = makeClient(fetch);

    const pending = client.messages.send(input, { requestId: 'same-id' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);

    const result = await pending;
    expect(result.message.status).toBe('queued');
    // the retry is the same request: same body, same X-Request-Id
    expect(lastCall(fetch, 1).body).toEqual(lastCall(fetch, 0).body);
    expect(lastCall(fetch, 1).headers['X-Request-Id']).toBe('same-id');
  });

  it('waits 1 s after a 429 without Retry-After', async () => {
    const fetch = fetchMock()
      .mockResolvedValueOnce(jsonResponse(429, { message: 'quota' }))
      .mockResolvedValueOnce(accepted());
    const pending = makeClient(fetch).messages.send(input);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await pending;
  });

  it('honours a Retry-After up to maxRetryAfterMs exactly (55 s)', async () => {
    const fetch = fetchMock()
      .mockResolvedValueOnce(jsonResponse(429, { message: 'quota' }, { 'retry-after': '55' }))
      .mockResolvedValueOnce(accepted());
    const pending = makeClient(fetch).messages.send(input);
    await vi.advanceTimersByTimeAsync(54_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await pending;
  });

  it('throws immediately, without sleeping, when Retry-After exceeds maxRetryAfterMs (61 s)', async () => {
    const fetch = fetchMock().mockResolvedValue(
      jsonResponse(429, { message: 'quota', request_id: 'r' }, { 'retry-after': '61' }),
    );
    const pending = makeClient(fetch).messages.send(input);
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'RateLimitError',
      retryAfter: 61,
      requestId: 'r',
    });
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies a custom maxRetryAfterMs', async () => {
    const fetch = fetchMock()
      .mockResolvedValueOnce(jsonResponse(429, { message: 'quota' }, { 'retry-after': '10' }))
      .mockResolvedValueOnce(accepted());
    await expect(
      makeClient(fetch, { maxRetryAfterMs: 9_999 }).messages.send(input),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(fetch).toHaveBeenCalledTimes(1);

    const zero = fetchMock()
      .mockResolvedValueOnce(jsonResponse(429, { message: 'quota' }))
      .mockResolvedValueOnce(accepted());
    await expect(
      makeClient(zero, { maxRetryAfterMs: 0 }).messages.send(input),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(zero).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries and throws the last RateLimitError', async () => {
    const fetch = fetchMock().mockImplementation(async () =>
      jsonResponse(429, { message: 'quota', request_id: 'last' }, { 'retry-after': '1' }),
    );
    const client = makeClient(fetch, { maxRetries: 2 });
    const pending = client.messages.send(input);
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'RateLimitError',
      retryAfter: 1,
      requestId: 'last',
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('honours maxRetries: 0', async () => {
    const fetch = fetchMock().mockResolvedValueOnce(jsonResponse(429, { message: 'quota' }));
    await expect(makeClient(fetch, { maxRetries: 0 }).messages.send(input)).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 500 by default', async () => {
    const fetch = fetchMock().mockResolvedValue(jsonResponse(500, { message: 'boom' }));
    await expect(makeClient(fetch).messages.send(input)).rejects.toBeInstanceOf(ServerError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a 500 with retryOnServerError, using exponential backoff', async () => {
    const fetch = fetchMock()
      .mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }))
      .mockResolvedValueOnce(jsonResponse(503, { message: 'boom' }))
      .mockResolvedValueOnce(accepted());
    const pending = makeClient(fetch, { retryOnServerError: true }).messages.send(input);

    await vi.advanceTimersByTimeAsync(249);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    await expect(pending).resolves.toMatchObject({ requestId: 'req-202' });
  });

  it('never retries a 4xx other than 429', async () => {
    const fetch = fetchMock().mockResolvedValue(jsonResponse(422, { message: 'bad', errors: {} }));
    await expect(
      makeClient(fetch, { retryOnServerError: true }).messages.send(input),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a dial-phase NetworkError (ECONNREFUSED) with backoff', async () => {
    const refused = new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
        code: 'ECONNREFUSED',
      }),
    });
    const fetch = fetchMock().mockRejectedValueOnce(refused).mockResolvedValueOnce(accepted());
    const pending = makeClient(fetch).messages.send(input);
    await vi.advanceTimersByTimeAsync(249);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toBeDefined();
  });

  it.each([
    ['ENOTFOUND', dial('ENOTFOUND')],
    ['EAI_AGAIN', dial('EAI_AGAIN')],
    ['ENETUNREACH', dial('ENETUNREACH')],
    ['EHOSTUNREACH', dial('EHOSTUNREACH')],
    ['UND_ERR_CONNECT_TIMEOUT', dial('UND_ERR_CONNECT_TIMEOUT')],
    [
      'AggregateError (dual-stack connect)',
      new TypeError('fetch failed', {
        cause: new AggregateError([dialCause('ECONNREFUSED'), dialCause('ECONNREFUSED')]),
      }),
    ],
    ['code on the thrown error itself', dialCause('ECONNREFUSED')],
  ])('%s is retryable and retried', async (_label, thrown) => {
    const fetch = fetchMock().mockRejectedValue(thrown);
    const pending = makeClient(fetch, { maxRetries: 1 }).messages.send(input);
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'NetworkError',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['ECONNRESET', dial('ECONNRESET')],
    ['EPIPE', dial('EPIPE')],
    ['ECONNABORTED', dial('ECONNABORTED')],
    ['UND_ERR_SOCKET', dial('UND_ERR_SOCKET')],
    ['no code at all', new TypeError('fetch failed')],
    ['a non-Error rejection', 'string reason'],
  ])(
    '%s is ambiguous: not retried by default, retried with retryOnServerError',
    async (_label, thrown) => {
      const fetch = fetchMock().mockRejectedValue(thrown);
      const error = await makeClient(fetch)
        .messages.send(input)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).retryable).toBe(false);
      expect((error as NetworkError).cause).toBe(thrown);
      expect(fetch).toHaveBeenCalledTimes(1);

      const optIn = fetchMock().mockRejectedValue(thrown);
      const pending = makeClient(optIn, { retryOnServerError: true, maxRetries: 2 }).messages.send(
        input,
      );
      const assertion = expect(pending).rejects.toBeInstanceOf(NetworkError);
      await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      expect(optIn).toHaveBeenCalledTimes(3);
    },
  );

  it('describes the failure and exposes the code', async () => {
    const cause = new TypeError('fetch failed', {
      cause: dialCause('ECONNRESET', 'read ECONNRESET'),
    });
    const error = (await makeClient(fetchMock().mockRejectedValue(cause))
      .messages.send(input)
      .catch((e: unknown) => e)) as NetworkError;
    expect(error.message).toBe(
      'Request failed before a response was received: fetch failed (read ECONNRESET)',
    );
    expect(error.code).toBe('ECONNRESET');
    expect(error.status).toBeUndefined();
  });

  it('turns a timeout into TimeoutError and does not retry it by default', async () => {
    const fetch = hangingFetch();
    const client = makeClient(fetch, { timeoutMs: 5_000 });
    const pending = client.messages.send(input);
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'Request timed out after 5000 ms',
      timeoutMs: 5_000,
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((lastCall(fetch).init.signal as AbortSignal).aborted).toBe(true);
  });

  it('retries a timeout when retryOnServerError is set', async () => {
    const hang = hangingFetch().getMockImplementation() as FetchLike;
    const fetch = fetchMock().mockImplementationOnce(hang).mockResolvedValueOnce(accepted());
    const pending = makeClient(fetch, { timeoutMs: 1_000, retryOnServerError: true }).messages.send(
      input,
    );
    await vi.advanceTimersByTimeAsync(1_000 + 250);
    await expect(pending).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a timeout while reading a 202 body is a TimeoutError that is never retried', async () => {
    const fetch = stalledBody(202, { 'x-request-id': 'r-body' });
    const pending = makeClient(fetch, { timeoutMs: 2_000, retryOnServerError: true }).messages.send(
      input,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      status: 202,
      requestId: 'r-body',
      timeoutMs: 2_000,
      message: expect.stringContaining('accepted the message (HTTP 202)'),
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    await expect(pending).rejects.toThrow('do not re-send');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a pre-response timeout is retried with retryOnServerError but a 5xx body timeout is not', async () => {
    const fetch = stalledBody(503);
    const pending = makeClient(fetch, { timeoutMs: 100, retryOnServerError: true }).messages.send(
      input,
    );
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError', status: 503 });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rethrows the caller abort reason during the request', async () => {
    const fetch = hangingFetch();
    const controller = new AbortController();
    const pending = makeClient(fetch).messages.send(input, { signal: controller.signal });
    const reason = new Error('user cancelled');
    const assertion = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('aborts with a DOMException when the caller signal has no reason', async () => {
    const fetch = hangingFetch();
    const controller = new AbortController();
    const pending = makeClient(fetch).messages.send(input, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((lastCall(fetch).init.signal as AbortSignal).aborted).toBe(true);
  });

  it('does not call fetch when the signal is already aborted', async () => {
    const fetch = fetchMock();
    const controller = new AbortController();
    controller.abort(new Error('early'));
    await expect(
      makeClient(fetch).messages.send(input, { signal: controller.signal }),
    ).rejects.toThrow('early');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('honours the caller signal while waiting between retries', async () => {
    const fetch = fetchMock().mockResolvedValue(
      jsonResponse(429, { message: 'quota' }, { 'retry-after': '10' }),
    );
    const controller = new AbortController();
    const pending = makeClient(fetch).messages.send(input, { signal: controller.signal });
    const assertion = expect(pending).rejects.toThrow('stop waiting');
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.abort(new Error('stop waiting'));
    await assertion;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects the retry wait immediately when the signal is already aborted after the response', async () => {
    const controller = new AbortController();
    const fetch = fetchMock().mockImplementation(async () => {
      controller.abort(new Error('aborted during response'));
      return jsonResponse(429, { message: 'quota' });
    });
    await expect(
      makeClient(fetch).messages.send(input, { signal: controller.signal }),
    ).rejects.toThrow('aborted during response');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('retryDelayMs', () => {
  it('honours Retry-After exactly, uncapped, and defaults to 1 s', () => {
    expect(retryDelayMs(new RateLimitError('r', { retryAfter: 3 }), 0, () => 0)).toBe(3_000);
    expect(retryDelayMs(new RateLimitError('r', { retryAfter: 0 }), 0, () => 1)).toBe(0);
    expect(retryDelayMs(new RateLimitError('r', { retryAfter: 999 }), 0)).toBe(999_000);
    expect(retryDelayMs(new RateLimitError('r'), 5)).toBe(1_000);
  });

  it('jitters the exponential backoff by +/- 20 % and caps it', () => {
    const error = new ServerError('s');
    expect(BACKOFF_JITTER).toBe(0.2);
    expect(retryDelayMs(error, 0, () => 0)).toBe(BASE_BACKOFF_MS * 0.8);
    expect(retryDelayMs(error, 0, () => 0.5)).toBe(BASE_BACKOFF_MS);
    expect(retryDelayMs(error, 0, () => 1)).toBe(BASE_BACKOFF_MS * 1.2);
    expect(retryDelayMs(error, 3, () => 0.5)).toBe(BASE_BACKOFF_MS * 8);
    expect(retryDelayMs(error, 20, () => 1)).toBe(MAX_BACKOFF_MS);
    const real = retryDelayMs(new NetworkError('n'), 1);
    expect(real).toBeGreaterThanOrEqual(400);
    expect(real).toBeLessThanOrEqual(600);
  });
});
