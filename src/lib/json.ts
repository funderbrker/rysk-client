/** `JSON.stringify` that encodes every `bigint` as its decimal string. */
export function stringifyBig(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), space);
}
