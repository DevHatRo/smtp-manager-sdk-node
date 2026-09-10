import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as sdk from '../../src/index.js';
import { LIMITS, VERSION } from '../../src/index.js';

describe('LIMITS', () => {
  it('matches the API limits', () => {
    expect(LIMITS).toEqual({
      maxRecipients: 50,
      maxAttachments: 10,
      maxAttachmentsBytes: 5_242_880,
      maxTags: 10,
      maxMetadataKeys: 20,
      maxBodyLength: 1_048_576,
      maxHeaders: 25,
      maxSubjectLength: 998,
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });
});

describe('package surface', () => {
  it('VERSION matches package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });

  it('exports the public API', () => {
    expect(Object.keys(sdk).sort()).toEqual(
      [
        'AuthenticationError',
        'ConfigurationError',
        'DEFAULT_MAX_RETRIES',
        'DEFAULT_MAX_RETRY_AFTER_MS',
        'DEFAULT_TIMEOUT_MS',
        'InvalidInputError',
        'LIMITS',
        'NetworkError',
        'PayloadTooLargeError',
        'PermissionError',
        'RateLimitError',
        'ServerError',
        'SmtpManager',
        'SmtpManagerError',
        'TimeoutError',
        'UnexpectedResponseError',
        'VERSION',
        'ValidationError',
        'attachmentFromFile',
      ].sort(),
    );
  });
});
