import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAttachmentContent, renderAttachment } from '../../src/attachments.js';
import { InvalidInputError, attachmentFromFile } from '../../src/index.js';

describe('encodeAttachmentContent', () => {
  it('base64-encodes a Buffer', () => {
    expect(encodeAttachmentContent(Buffer.from('hello'))).toBe('aGVsbG8=');
  });

  it('base64-encodes a Uint8Array, honouring byteOffset and length', () => {
    const backing = new Uint8Array([0, 0, 0x68, 0x69, 0, 0]);
    const view = new Uint8Array(backing.buffer, 2, 2);
    expect(encodeAttachmentContent(view)).toBe('aGk=');
    expect(encodeAttachmentContent(new Uint8Array([]))).toBe('');
  });

  it('takes a string as already base64', () => {
    expect(encodeAttachmentContent('AQID')).toBe('AQID');
  });

  it('rejects anything else', () => {
    expect(() => encodeAttachmentContent(42 as never)).toThrow(InvalidInputError);
    expect(() => encodeAttachmentContent({} as never)).toThrow(InvalidInputError);
  });
});

describe('renderAttachment', () => {
  it('renders snake_case and omits content_id when absent', () => {
    expect(
      renderAttachment({ filename: 'a.txt', contentType: 'text/plain', content: 'YQ==' }, 0),
    ).toEqual({ filename: 'a.txt', content_type: 'text/plain', content: 'YQ==' });
  });

  it('includes content_id when present', () => {
    expect(
      renderAttachment(
        { filename: 'l.png', contentType: 'image/png', content: Buffer.alloc(0), contentId: 'l@x' },
        1,
      ),
    ).toEqual({ filename: 'l.png', content_type: 'image/png', content: '', content_id: 'l@x' });
  });

  it('rejects non-objects with the index', () => {
    expect(() => renderAttachment(null as never, 3)).toThrow('attachments[3]');
    expect(() => renderAttachment('x' as never, 0)).toThrow(InvalidInputError);
  });
});

describe('attachmentFromFile', () => {
  let dir: string;
  let file: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'smtp-sdk-'));
    file = join(dir, 'report.csv');
    await writeFile(file, 'a,b\n1,2\n');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the file with defaults', async () => {
    const attachment = await attachmentFromFile(file);
    expect(attachment.filename).toBe('report.csv');
    expect(attachment.contentType).toBe('application/octet-stream');
    expect(attachment.contentId).toBeUndefined();
    expect('contentId' in attachment).toBe(false);
    expect(Buffer.from(attachment.content as Uint8Array).toString()).toBe('a,b\n1,2\n');
    expect(renderAttachment(attachment, 0).content).toBe(
      Buffer.from('a,b\n1,2\n').toString('base64'),
    );
  });

  it('applies the overrides', async () => {
    const attachment = await attachmentFromFile(file, {
      filename: 'data.csv',
      contentType: 'text/csv',
      contentId: 'data@example.com',
    });
    expect(attachment).toMatchObject({
      filename: 'data.csv',
      contentType: 'text/csv',
      contentId: 'data@example.com',
    });
  });

  it('propagates fs errors', async () => {
    await expect(attachmentFromFile(join(dir, 'missing.bin'))).rejects.toThrow(/ENOENT/);
  });
});
