import { describe, expect, it } from 'vitest';
import { renderAddress, renderAddressList } from '../../src/address.js';
import { InvalidInputError } from '../../src/index.js';

describe('renderAddress', () => {
  it('passes strings through untouched', () => {
    expect(renderAddress('a@example.com', 'from')).toBe('a@example.com');
    expect(renderAddress('Name <a@example.com>', 'from')).toBe('Name <a@example.com>');
    expect(renderAddress('  spaced@example.com ', 'from')).toBe('  spaced@example.com ');
  });

  it('renders objects with and without a name', () => {
    expect(renderAddress({ email: 'a@example.com' }, 'from')).toBe('a@example.com');
    expect(renderAddress({ email: 'a@example.com', name: '' }, 'from')).toBe('a@example.com');
    expect(renderAddress({ email: 'a@example.com', name: undefined }, 'from')).toBe(
      'a@example.com',
    );
    expect(renderAddress({ email: 'a@example.com', name: 'Ada Lovelace' }, 'from')).toBe(
      'Ada Lovelace <a@example.com>',
    );
    expect(renderAddress({ email: 'a@example.com', name: 'Doe, John' }, 'from')).toBe(
      'Doe, John <a@example.com>',
    );
  });

  it.each(['Evil <x@y>', 'Close > me', 'CR\rhere', 'LF\nhere', '<'])(
    'rejects a name containing %j',
    (name) => {
      expect(() => renderAddress({ email: 'a@example.com', name }, 'to[0]')).toThrow(
        InvalidInputError,
      );
      expect(() => renderAddress({ email: 'a@example.com', name }, 'to[0]')).toThrow('to[0]');
    },
  );

  it('rejects malformed inputs with the field name', () => {
    expect(() => renderAddress(42 as never, 'from')).toThrow(InvalidInputError);
    expect(() => renderAddress(null as never, 'from')).toThrow('from: expected a string');
    expect(() => renderAddress({} as never, 'from')).toThrow(InvalidInputError);
    expect(() => renderAddress({ email: 'a@b', name: 5 } as never, 'cc[1]')).toThrow(
      'cc[1]: name must be a string',
    );
  });
});

describe('renderAddressList', () => {
  it('returns undefined for undefined', () => {
    expect(renderAddressList(undefined, 'cc')).toBeUndefined();
  });

  it('wraps a single value and renders arrays element-wise', () => {
    expect(renderAddressList('a@example.com', 'to')).toEqual(['a@example.com']);
    expect(renderAddressList({ email: 'a@example.com', name: 'A' }, 'to')).toEqual([
      'A <a@example.com>',
    ]);
    expect(
      renderAddressList(['a@example.com', { email: 'b@example.com', name: 'B' }], 'to'),
    ).toEqual(['a@example.com', 'B <b@example.com>']);
    expect(renderAddressList([], 'to')).toEqual([]);
  });

  it('reports the index of the offending element', () => {
    expect(() =>
      renderAddressList(['ok@example.com', { email: 'x@example.com', name: '<' }], 'bcc'),
    ).toThrow('bcc[1]');
  });
});
