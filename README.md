# @devhatro/smtp-manager-sdk

Zero-dependency Node.js / TypeScript SDK for the **SMTP Manager** transactional send API
(`POST /api/v1/messages`). SMTP Manager is [DevHat](https://github.com/DevHatRo)'s multi-tenant
SMTP platform: you register your domains and sender aliases in the console, create an API key,
and send mail through the platform's Postfix fleet over HTTPS instead of running an SMTP client.

- Works against the hosted platform (`https://api.your-email.eu`) out of the box, or a
  self-hosted instance via `baseUrl`
- Node >= 20, native `fetch`, no runtime dependencies
- ESM + CommonJS + type definitions
- Typed errors for every API outcome, automatic retry on `429` and network failures
- Explicit camelCase mapping of the API's snake_case wire format

## Installation

```sh
npm install @devhatro/smtp-manager-sdk
# or
pnpm add @devhatro/smtp-manager-sdk
```

## Quick start

This is the composition the [integration test](test/integration/send.test.ts) sends (identical
except for the `cc` literal, which the test derives from `SMTP_MANAGER_TO`), so it is known to
run against a live instance.

```ts
import { SmtpManager } from '@devhatro/smtp-manager-sdk';

/** Reads a required environment variable (string, not string | undefined). */
function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const client = new SmtpManager({
  apiKey: env('SMTP_MANAGER_API_KEY'), // smtpk_xxxxxxxxxx.<secret>
  // hosted platform by default; self-hosted instances add baseUrl (see Configuration)
});

const runId = `run-${Date.now()}`;

const { message, requestId } = await client.messages.send(
  {
    from: env('SMTP_MANAGER_FROM'), // an active alias on a verified domain
    to: { email: env('SMTP_MANAGER_TO'), name: 'SDK Integration' },
    cc: 'second-recipient@example.net',
    subject: `SDK integration ${runId}`,
    text: `Hello from @devhatro/smtp-manager-sdk (${runId}).`,
    html: `<p>Hello from <strong>@devhatro/smtp-manager-sdk</strong> (${runId}).</p>`,
    tags: ['sdk', 'integration'],
    metadata: { suite: 'integration', run_id: runId },
    attachments: [
      {
        filename: 'hello.txt',
        contentType: 'text/plain',
        content: Buffer.from(`hello from ${runId}\n`),
      },
    ],
  },
  { requestId: runId },
);

console.log(message.uuid, message.status, message.messageId, requestId);
// 0192a1b2-... queued <0192a1b2-...@example.com> run-1757500000000
```

`send()` resolves once the API has **accepted** the message (HTTP 202) and queued it for
delivery; `message.status` is `queued` at that point. Delivery happens asynchronously on the
platform's nodes.

## Full composition

```ts
import { readFile } from 'node:fs/promises';
import { SmtpManager, attachmentFromFile } from '@devhatro/smtp-manager-sdk';

const client = new SmtpManager({ apiKey, baseUrl, userAgentSuffix: 'billing-service/3.1.0' });
const logoBytes = await readFile('./assets/logo.png');

const { message } = await client.messages.send({
  from: { email: 'billing@example.com', name: 'Example Billing' },
  to: [
    { email: 'ada@example.net', name: 'Ada Lovelace' },
    'charles@example.net',
    'Grace Hopper <grace@example.net>', // preformatted strings pass through untouched
  ],
  cc: { email: 'accounts@example.com', name: 'Accounts' },
  bcc: ['audit@example.com'],
  replyTo: { email: 'support@example.com', name: 'Support' },
  subject: 'Your invoice #1042',
  text: 'Your invoice is attached. Thank you for your business.',
  html: `
    <p><img src="cid:logo@example.com" alt="Example"></p>
    <p>Your invoice is attached. Thank you for your business.</p>
  `,
  headers: { 'X-Invoice-Id': '1042' },
  attachments: [
    await attachmentFromFile('./invoices/1042.pdf', { contentType: 'application/pdf' }),
    {
      filename: 'logo.png',
      contentType: 'image/png',
      content: logoBytes, // Uint8Array | Buffer | base64 string
      contentId: 'logo@example.com', // inline part, referenced as cid:logo@example.com above
    },
  ],
  tags: ['invoice', 'billing:monthly'],
  metadata: { customer_id: 'cus_8841', invoice_id: '1042' },
});
```

Addresses can be a bare `a@b`, a preformatted `Name <a@b>`, or `{ email, name? }`. Objects are
rendered as `Name <email>` (bare email when `name` is empty); a name containing `<`, `>` or a
line break is rejected client-side with `InvalidInputError`. **Everything else is validated by
the API**, so the SDK never drifts from the server's rules — a rejected message surfaces as a
`ValidationError` with the field-level messages.

Attachment `content` may be raw bytes (`Uint8Array` / `Buffer`, base64-encoded by the SDK) or a
string that is already base64. `attachmentFromFile(path, { filename?, contentType?, contentId? })`
reads a file from disk; `filename` defaults to the basename and `contentType` to
`application/octet-stream`. Setting `contentId` (which must look like `local@domain`) marks the
attachment as an inline part that `html` can reference as `cid:<contentId>`.

## Error handling

Every error extends `SmtpManagerError`, which carries `message`, `status` (HTTP status when a
response was received), `requestId` (from the `X-Request-Id` header or the error body) and `body`
(parsed JSON, or the raw text for non-JSON bodies). `ConfigurationError` is thrown synchronously
by the constructor; everything else rejects the `send()` promise.

| Class                     | When                                                                                  | Extra fields                    |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------- |
| `ConfigurationError`      | `apiKey` missing / not `smtpk_…`, `baseUrl` given but not http(s) / carrying credentials, bad numeric option | –                               |
| `InvalidInputError`       | Input that cannot be rendered (display name with `<`, `>`, CR, LF; bad address shape) | –                               |
| `AuthenticationError`     | `401` – invalid, missing or revoked key                                               | –                               |
| `PermissionError`         | `403` – the key lacks the `send` ability                                              | –                               |
| `ValidationError`         | `422` – rejected by validation, including an unknown `from`                           | `errors: Record<string,string[]>` |
| `RateLimitError`          | `429` – organization send quota, or a burst of failed authentications                 | `retryAfter?: number` (seconds) |
| `PayloadTooLargeError`    | `413` – request body over the proxy's 12 MB limit (body is usually HTML, not JSON)    | –                               |
| `ServerError`             | `5xx`                                                                                 | –                               |
| `NetworkError`            | `fetch` rejected before any response headers; `cause` holds the original error        | `retryable` (dial-phase failure, see below), `code` (e.g. `ECONNREFUSED`) |
| `TimeoutError`            | The attempt exceeded `timeoutMs`. `status` is set when headers had already arrived    | `timeoutMs`                     |
| `UnexpectedResponseError` | Anything else: unknown status, a `3xx`, or a **`2xx` whose body could not be read or interpreted** — the message then says *"The server accepted the message (HTTP 202) … do not re-send it"*, because the message is already queued | –                               |

```ts
import {
  AuthenticationError,
  NetworkError,
  PermissionError,
  RateLimitError,
  ServerError,
  SmtpManagerError,
  TimeoutError,
  ValidationError,
} from '@devhatro/smtp-manager-sdk';

try {
  await client.messages.send(input);
} catch (error) {
  if (error instanceof ValidationError) {
    // error.errors === { from: ['The from address is not an active alias ...'], 'to.0': [...] }
    console.error(error.status, error.requestId, error.errors);
  } else if (error instanceof RateLimitError) {
    console.error(`quota exceeded, retry in ${error.retryAfter ?? '?'} s`);
  } else if (error instanceof AuthenticationError || error instanceof PermissionError) {
    console.error('check the API key and its abilities', error.requestId);
  } else if (error instanceof TimeoutError || error instanceof NetworkError) {
    console.error('could not reach SMTP Manager', error.cause);
  } else if (error instanceof ServerError) {
    console.error('SMTP Manager is unhealthy', error.status, error.requestId);
  } else if (error instanceof SmtpManagerError) {
    console.error('unexpected response', error.status, error.body);
  } else {
    throw error; // an AbortSignal reason, or a bug
  }
}
```

Keep `requestId` in your logs: it is the `X-Request-Id` the API attaches to its own logs, so
support can find the request from either side. Pass your own via `send(input, { requestId })` to
correlate it with your traces; the same id is reused on every retry of that call. It must match
`^[A-Za-z0-9._-]{1,64}$` — the server silently replaces anything else, so the SDK rejects other
values up front with `InvalidInputError`.

The client never leaks the key: `JSON.stringify(client)` and `util.inspect(client)` show it
redacted (`smtpk_abcd…`), and `client.messages` serializes to `{ messagesUrl }` only.

**Dual ESM/CJS caveat:** the package ships both builds. If your process loads the SDK twice
(one dependency `import`s it, another `require`s it), the two copies have different class
identities and `instanceof` across them is `false`. Where that can happen, check `error.name`
instead — every SDK error sets it to its class name:

```ts
if (error instanceof Error && error.name === 'ValidationError') {
  const { errors } = error as ValidationError;
}
```

## Retries and rate limits

Each `send()` makes up to `1 + maxRetries` attempts (default `2` retries). Between attempts the
SDK waits:

- **`429`** – exactly `Retry-After` seconds (delta-seconds or HTTP-date), 1 s when the header
  is absent. The send quota is per minute, so `Retry-After` runs up to 60. If it exceeds
  `maxRetryAfterMs` (default `60000`) the SDK does **not** sleep: it throws the `RateLimitError`
  immediately with `retryAfter` populated so you can decide (queue it, shed load, wait
  yourself). Within the cap it is always retried.
- **`NetworkError` with `retryable: true`** – a *dial-phase* failure, one of the codes that
  cannot occur after bytes were written: DNS (`ENOTFOUND`, `EAI_AGAIN`), `ECONNREFUSED`,
  `ENETUNREACH`, `EHOSTUNREACH`, undici's `UND_ERR_CONNECT_TIMEOUT`. The request provably never
  reached the server. Always retried, exponential backoff from 250 ms with ±20 % jitter, capped
  at 30 s.
- **`NetworkError` with `retryable: false`** – anything that may have failed *after* the request
  was written or that the SDK cannot classify (`ECONNRESET`, `EPIPE`, `ECONNABORTED`,
  `UND_ERR_SOCKET`, errors without a code). **Not retried by default.**
- **`5xx` and `TimeoutError` without a `status`** – the request reached the server (or may
  have). **Not retried by default.**
- **Never retried, whatever the options:** a `TimeoutError` or `UnexpectedResponseError` raised
  *after* a `2xx` arrived (body read timed out, body unreadable, envelope not understood). The
  message is queued; its error text says so and tells you not to re-send.

Opt in to retrying the ambiguous network errors, `5xx` and pre-response timeouts with
`retryOnServerError: true` (same jittered backoff).
Why the default: the API has **no idempotency key yet**. A `429` or a dial-phase failure is
proven not to have sent anything, but a `5xx`, a timeout or a mid-request socket error may have
been raised *after* the message was accepted and queued — retrying that request can deliver the
message twice. Enable `retryOnServerError` only where a duplicate is acceptable, and dedupe on
your side using `metadata` if you need to. `NetworkError.code` carries the classified error
code so you can make your own call in a catch block.

`timeoutMs` is **per attempt** (connect through body). The worst-case wall time of one `send()`
is `(1 + maxRetries) × timeoutMs` plus the waits between attempts — with defaults and a 60 s
`Retry-After`, up to 90 s of requests plus 120 s of waiting. Lower `maxRetries`,
`maxRetryAfterMs` or `timeoutMs`, or pass a `signal`, if your caller cannot wait that long.

`send()` is never retried after a `4xx` other than `429`, and redirects are never followed: a
`3xx` is an `UnexpectedResponseError` naming the `Location` (a followed `POST` would be replayed
as a `GET` and drop the `Authorization` header on a scheme change — check `baseUrl`). The waits
honour the `signal` you pass in `send(input, { signal })`: aborting rejects immediately with your
abort reason, both during a request and while waiting for the next attempt.

## Configuration

```ts
new SmtpManager(options);
```

| Option               | Type                        | Default              | Notes                                                                                             |
| -------------------- | --------------------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `apiKey`             | `string`                    | **required**         | Must start with `smtpk_`. Sent as `Authorization: Bearer`.                                        |
| `baseUrl`            | `string`                    | `https://api.your-email.eu` | Optional — the default is the hosted platform (`DEFAULT_BASE_URL`), so only **self-hosted** instances set it: either the **Endpoint** the console shows with a new key (`https://host/api/v1/messages`) or the bare origin (`https://host`, optionally with a path prefix). A path ending in `/api/v1/messages`, `/api/v1` or `/api` (any case) is completed, anything else gets `/api/v1/messages` appended; trailing slashes are ignored. `http://` is for local development only — the key travels in clear. Must not carry credentials (`https://user:pass@host` is a `ConfigurationError`): the API key is the only credential. |
| `timeoutMs`          | `number`                    | `30000`              | **Per attempt**, covers connect + response body. Total wall time = attempts × timeout + waits.    |
| `maxRetries`         | `number`                    | `2`                  | Retries after the first attempt.                                                                  |
| `maxRetryAfterMs`    | `number`                    | `60000`              | Longest `Retry-After` the SDK sleeps for on a `429`; a longer one throws `RateLimitError` immediately. |
| `retryOnServerError` | `boolean`                   | `false`              | Also retry `5xx`, timeouts and ambiguous (non-dial-phase) network errors. See the idempotency caveat above. |
| `userAgentSuffix`    | `string`                    | –                    | Appended to `User-Agent: smtp-manager-sdk-node/<version>`.                                        |
| `fetch`              | `(url, init) => Promise<Response>` | `globalThis.fetch` | Custom implementation for tests, proxies or instrumentation.                                      |

Per call:

```ts
client.messages.send(input, { requestId?: string, signal?: AbortSignal });
```

`requestId` must match `^[A-Za-z0-9._-]{1,64}$`.

The client exposes `messagesUrl` and `userAgent` as read-only properties for logging.

## Limits

Enforced by the API (a violation is a `ValidationError`) and exported as `LIMITS` so you can size
input before sending. `maxAttachments`, `maxAttachmentsBytes` and `maxBodyLength` are the
**defaults of a stock instance** — they are per-instance configuration an operator can override,
so treat them as a guide and the `ValidationError` as the truth. The other values are fixed by
the API.

| Constant              | Value       | Applies to                                                                  |
| --------------------- | ----------- | --------------------------------------------------------------------------- |
| `maxRecipients`       | `50`        | `to` + `cc` + `bcc` together, no duplicates                                 |
| `maxAttachments`      | `10`        | attachments per message (stock default); executable extensions are refused  |
| `maxAttachmentsBytes` | `5242880`   | decoded size of all attachments together, 5 MiB (stock default)             |
| `maxTags`             | `10`        | each tag `^[A-Za-z0-9_.:-]{1,64}$`                                          |
| `maxMetadataKeys`     | `20`        | keys `^[A-Za-z0-9_.-]{1,64}$`, string values <= 512 chars, order not kept   |
| `maxBodyLength`       | `1048576`   | characters in each of `text` and `html`, 1 MiB (stock default; one required) |
| `maxHeaders`          | `25`        | custom headers; addressing, `Received`, `Message-ID`, `DKIM-*` are refused  |
| `maxSubjectLength`    | `998`       | characters in `subject`                                                     |

The whole request body must also stay under the proxy's 12 MB limit (`PayloadTooLargeError`).

## Where the base URL and key come from

In the SMTP Manager console, open your organization's **API keys** and create a key with the
`send` ability. The console shows the **Endpoint and the full key exactly once**, on creation —
the key looks like `smtpk_xxxxxxxxxx.<secret>` and is **never retrievable afterwards**. Store it
in a secret manager; if you lose it, revoke it and create a new one.

- **Hosted platform** (`https://api.your-email.eu`): nothing to configure — the SDK targets it
  by default; only the key is needed.
- **Self-hosted instance**: pass `baseUrl`. Paste the Endpoint the console showed as-is
  (`https://host/api/v1/messages`); the bare origin (`https://host`) works too — the SDK
  completes either form and never doubles the path.

The `from` address must be an active alias on a verified domain of the organization that owns the
key; anything else is a `422` with `errors.from`.

## Testing

```sh
pnpm install
pnpm test:unit          # stubbed fetch, no network
pnpm test:coverage      # same, with a coverage report in coverage/
pnpm test:integration   # live, skipped unless configured (below)
```

The integration suite sends a real message and is skipped unless the three required variables
are set. In CI it runs only on a manual `workflow_dispatch` of the CI workflow, never on pushes
to `main`:

| Variable                | Meaning                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `SMTP_MANAGER_API_KEY`  | A key with the `send` ability                              |
| `SMTP_MANAGER_FROM`     | An active alias on a verified domain of that organization  |
| `SMTP_MANAGER_TO`       | A mailbox you control                                      |
| `SMTP_MANAGER_CC`       | Optional second mailbox; defaults to `<to-local>+cc@<domain>` |
| `SMTP_MANAGER_BASE_URL` | Optional; self-hosted only — the console's Endpoint or the origin. Unset = the hosted platform |

Other scripts: `pnpm typecheck`, `pnpm lint` / `pnpm lint:fix`, `pnpm build`.

## Contributing

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`docs:`, `chore:`…). [release-please](https://github.com/googleapis/release-please) turns them
into the changelog, the version bump (package.json, the manifest and `src/version.ts` together)
and the GitHub release; merging the release PR publishes to npm. The first `feat:` on `main`
cuts `v0.1.0`. Please open an issue before large changes and keep `pnpm lint`, `pnpm typecheck` and
`pnpm test:unit` green.

## License

[MIT](LICENSE) © DevHat
