/**
 * Limits enforced by the SMTP Manager send API, as configured on a stock instance. The SDK
 * does not pre-validate against them (so it never drifts from the server's rules); they are
 * exported so callers can size their input before making a request.
 *
 * `maxAttachments`, `maxAttachmentsBytes` and `maxBodyLength` are per-instance configuration
 * defaults that an operator can override; the other values are fixed by the API.
 */
export const LIMITS = Object.freeze({
  /** Recipients across `to` + `cc` + `bcc`, no duplicates. */
  maxRecipients: 50,
  /** Attachments per message (stock-instance default). */
  maxAttachments: 10,
  /** Decoded size of all attachments together, 5 MiB (stock-instance default). */
  maxAttachmentsBytes: 5_242_880,
  /** Tags per message; each must match `^[A-Za-z0-9_.:-]{1,64}$`. */
  maxTags: 10,
  /** Metadata keys per message; keys match `^[A-Za-z0-9_.-]{1,64}$`, values are <= 512 chars. */
  maxMetadataKeys: 20,
  /** Characters in each of `text` and `html`, 1 MiB (stock-instance default). */
  maxBodyLength: 1_048_576,
  /** Custom headers per message. */
  maxHeaders: 25,
  /** Characters in `subject`. */
  maxSubjectLength: 998,
});

export type Limits = typeof LIMITS;
