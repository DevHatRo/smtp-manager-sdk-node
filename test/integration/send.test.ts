import { beforeAll, describe, expect, it } from 'vitest';
import { SmtpManager, ValidationError } from '../../src/index.js';

// SMTP_MANAGER_BASE_URL is optional: unset means the hosted platform (DEFAULT_BASE_URL).
const REQUIRED = ['SMTP_MANAGER_API_KEY', 'SMTP_MANAGER_FROM', 'SMTP_MANAGER_TO'] as const;
const configured = REQUIRED.every((name) => Boolean(process.env[name]));

/** Reads a required environment variable (string, not string | undefined). */
function env(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

/** Second recipient for the cc: `SMTP_MANAGER_CC`, else the `to` mailbox with a `+cc` sub-address. */
function ccAddress(to: string): string {
  if (process.env.SMTP_MANAGER_CC) {
    return process.env.SMTP_MANAGER_CC;
  }
  const [local, domain] = to.split('@');
  return `${local}+cc@${domain}`;
}

describe.skipIf(!configured)('POST /api/v1/messages (live)', () => {
  let client: SmtpManager;

  beforeAll(() => {
    client = new SmtpManager({
      apiKey: env('SMTP_MANAGER_API_KEY'), // smtpk_xxxxxxxxxx.<secret>
      // self-hosted only: the console's Endpoint, or just https://host
      baseUrl: process.env.SMTP_MANAGER_BASE_URL || undefined,
      userAgentSuffix: 'integration-test',
    });
  });

  it('accepts a fully composed message', async () => {
    const runId = `run-${Date.now()}`;

    const { message, requestId } = await client.messages.send(
      {
        from: env('SMTP_MANAGER_FROM'), // an active alias on a verified domain
        to: { email: env('SMTP_MANAGER_TO'), name: 'SDK Integration' },
        cc: ccAddress(env('SMTP_MANAGER_TO')),
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

    expect(requestId).toBeTruthy();
    expect(message.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(['queued', 'sending', 'sent']).toContain(message.status);
    expect(message.source).toBe('api');
    expect(message.from).toBe(env('SMTP_MANAGER_FROM'));
    expect(message.to).toEqual([`SDK Integration <${env('SMTP_MANAGER_TO')}>`]);
    expect(message.cc).toEqual([ccAddress(env('SMTP_MANAGER_TO'))]);
    expect(message.bcc).toEqual([]);
    expect(message.subject).toBe(`SDK integration ${runId}`);
    expect(message.messageId).toMatch(/^<.+@.+>$/);
    expect(message.tags).toEqual(['sdk', 'integration']);
    expect(message.metadata).toEqual({ suite: 'integration', run_id: runId });
    expect(message.attachments).toEqual([
      {
        filename: 'hello.txt',
        contentType: 'text/plain',
        contentId: null,
        size: Buffer.byteLength(`hello from ${runId}\n`),
      },
    ]);
    expect(message.error).toBeNull();
    expect(message.retryOf).toBeNull();
    expect(message.retriedAs).toBeNull();
    expect(message.createdAt).toBeTruthy();
    expect(message.updatedAt).toBeTruthy();
  });

  it('rejects an unknown sender with a 422 ValidationError on `from`', async () => {
    const error = await client.messages
      .send({
        from: 'nobody@invalid.example',
        to: env('SMTP_MANAGER_TO'),
        subject: 'should not send',
        text: 'nope',
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    const validation = error as ValidationError;
    expect(validation.status).toBe(422);
    expect(validation.requestId).toBeTruthy();
    expect(validation.errors.from).toBeDefined();
    expect(validation.errors.from.length).toBeGreaterThan(0);
  });
});
