/** Writes `name  value` lines to stdout, the values aligned in one column. */
export function printFields(fields: [name: string, value: string][]): void {
  const width = Math.max(0, ...fields.map(([name]) => name.length));
  for (const [name, value] of fields) process.stdout.write(`${name.padEnd(width)}  ${value}\n`);
}
