import { writeFileSync } from 'node:fs';
import type { AppConfig } from '../daemon/index.ts';
import { RyskRest } from '../rysk/rest.ts';
import type { HistoryCommand } from './args.ts';

/** `rysk history`: the public fills between `--from` and `--to` (epoch seconds), one JSON row a line in `--out`. */
export async function historyCommand(cmd: HistoryCommand, config: AppConfig): Promise<number> {
  const rest = new RyskRest({ baseUrl: config.rysk.restUrl });
  const rows = await rest.publicHistory(cmd.fromSec, cmd.toSec);
  if (!Array.isArray(rows)) throw new Error('public history: the response is not an array');
  writeFileSync(cmd.out, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  process.stdout.write(`wrote ${rows.length} public fills (${cmd.fromSec} to ${cmd.toSec}) to ${cmd.out}\n`);
  return 0;
}
