import { describe, expect, it } from 'vitest';
import { stringifyBig } from './json.ts';

describe('stringifyBig', () => {
  it('encodes bigints as decimal strings, nested in objects and arrays', () => {
    expect(stringifyBig({ a: 25n * 10n ** 18n, b: [1n], c: 'x' })).toBe(
      '{"a":"25000000000000000000","b":["1"],"c":"x"}',
    );
  });
});
