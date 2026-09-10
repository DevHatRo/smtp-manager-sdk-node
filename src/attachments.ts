import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { InvalidInputError } from './errors.js';
import type { AttachmentInput } from './types.js';

export interface WireAttachment {
  filename: string;
  content_type: string;
  content: string;
  content_id?: string;
}

/** Base64-encodes the content unless it is already a (base64) string. */
export function encodeAttachmentContent(content: AttachmentInput['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content instanceof Uint8Array) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength).toString('base64');
  }
  throw new InvalidInputError('attachment content must be a Uint8Array, Buffer or base64 string');
}

export function renderAttachment(input: AttachmentInput, index: number): WireAttachment {
  if (input === null || typeof input !== 'object') {
    throw new InvalidInputError(`attachments[${index}]: expected an object`);
  }
  const wire: WireAttachment = {
    filename: input.filename,
    content_type: input.contentType,
    content: encodeAttachmentContent(input.content),
  };
  if (input.contentId !== undefined) {
    wire.content_id = input.contentId;
  }
  return wire;
}

export interface AttachmentFromFileOptions {
  /** Defaults to the file's basename. */
  filename?: string;
  /** Defaults to `application/octet-stream`. */
  contentType?: string;
  contentId?: string;
}

/** Reads a file from disk into an `AttachmentInput`. */
export async function attachmentFromFile(
  path: string,
  options: AttachmentFromFileOptions = {},
): Promise<AttachmentInput> {
  const content = await readFile(path);
  const attachment: AttachmentInput = {
    filename: options.filename ?? basename(path),
    contentType: options.contentType ?? 'application/octet-stream',
    content,
  };
  if (options.contentId !== undefined) {
    attachment.contentId = options.contentId;
  }
  return attachment;
}
