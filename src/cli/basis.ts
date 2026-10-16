import { formatUnits } from 'viem';
import { type AppConfig, createLogger, wireDaemon } from '../daemon/index.ts';
import { deriveState, isBasisRelevant } from '../strategy/wheel/index.ts';
import type { BasisSuggestAnchorCommand } from './args.ts';

/**
 * `rysk basis suggest-anchor` (spec §8.4): prints `{ ts, qtyWhype }` for `basis.anchor`: the block time of one
 * snapshot and the HYPE held then, wallet WHYPE plus the WHYPE locked in open calls, as the basis ledger observes it.
 * The cost (`basisUsd`) is the operator's to fill in. While a basis-relevant position awaits settlement the held
 * amount is about to change, so a warning says to wait.
 */
export async function basisSuggestAnchorCommand(
  _cmd: BasisSuggestAnchorCommand,
  config: AppConfig,
): Promise<number> {
  const log = createLogger({ level: 'warn', rpcUrl: config.rpcUrl, destination: process.stderr });
  const wired = wireDaemon(config, { account: null, log, signal: new AbortController().signal });
  const s = await wired.loopDeps.snapshot();
  const st = deriveState(s, config.wheel);
  if (st.rows.some((row) => row.phase === 'pendingSettlement' && isBasisRelevant(row.cls))) {
    process.stderr.write(
      'warning: a position that moves WHYPE awaits settlement; suggest the anchor again once it settles\n',
    );
  }
  const qtyE18 = s.chain.whypeE18 + st.capital.call.locked;
  process.stdout.write(`${JSON.stringify({ ts: s.chain.blockTs, qtyWhype: formatUnits(qtyE18, 18) })}\n`);
  return 0;
}
