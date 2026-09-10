import { InvalidInputError } from './errors.js';
import type { AddressInput } from './types.js';

const FORBIDDEN_IN_NAME = /[<>\r\n]/;

/** Renders an `AddressInput` to the `a@b` / `Name <a@b>` form the API expects. */
export function renderAddress(input: AddressInput, field: string): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input === null || typeof input !== 'object' || typeof input.email !== 'string') {
    throw new InvalidInputError(`${field}: expected a string or { email, name? } object`);
  }
  const { email, name } = input;
  if (name === undefined || name === null || name === '') {
    return email;
  }
  if (typeof name !== 'string') {
    throw new InvalidInputError(`${field}: name must be a string`);
  }
  if (FORBIDDEN_IN_NAME.test(name)) {
    throw new InvalidInputError(`${field}: name must not contain '<', '>' or line breaks`);
  }
  return `${name} <${email}>`;
}

/** Renders a single address or a list to a list. */
export function renderAddressList(
  input: AddressInput | AddressInput[] | undefined,
  field: string,
): string[] | undefined {
  if (input === undefined) {
    return undefined;
  }
  const list = Array.isArray(input) ? input : [input];
  return list.map((item, index) => renderAddress(item, `${field}[${index}]`));
}
