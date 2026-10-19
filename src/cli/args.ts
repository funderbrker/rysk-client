import { type ParseArgsConfig, parseArgs } from 'node:util';
import type { ConfigFlags } from '../daemon/config.ts';
import type { Side } from '../domain/types.ts';
import { e18FromDecimal, usdE8FromDecimal } from '../domain/units.ts';

export const USAGE = `Usage: rysk <command> [options]

Commands:
  run [--live] [--max-trades N] [--config path] [--no-sampler]
      Run the daemon: dry-run unless --live is given and the config says mode "live".
  state [--config path]
      Print the derived wheel state and each side's gates.
  quote --side put|call --strike 78.5 --expiry <sec> [--qty 25]
        [--collateral whype] [--usd usdc|usdt0] [--config path]
      Request one quote and print it; never trades.
  history --from <sec> --to <sec> --out <file> [--config path]
      Write the public fills in the window to a JSONL file.
  wallet [--config path]
      Print the wallet's balances, MarginPool allowances and vault counter.
  basis suggest-anchor [--config path]
      Print a basis anchor: the block time and the WHYPE held, wallet plus open calls.

--config defaults to config.json.

Exit codes: 0 done; 1 failed (config, startup or the command); 2 usage error;
3 forced exit when a stop (SIGINT or SIGTERM) does not finish within 20 s.`;

/** A command line that does not parse; the message ends with the usage text. */
export class UsageError extends Error {
  constructor(problem: string) {
    super(`${problem}\n\n${USAGE}`);
    this.name = 'UsageError';
  }
}

export type UsdSymbol = 'usdc' | 'usdt0';
/** WHYPE only: the liquid-staking collaterals were dropped (no makers quote them). */
export type CallCollateralSymbol = 'whype';

export type RunCommand = { cmd: 'run'; live: boolean; maxTrades?: number; sampler: boolean; config: string };
export type StateCommand = { cmd: 'state'; config: string };
export type QuoteCommand = {
  cmd: 'quote';
  side: Side;
  strikeE8: bigint;
  expirySec: number;
  quantityE18: bigint;
  /** A put's collateral is its stable (`usd`); a call's is WHYPE or a liquid-staked HYPE. */
  collateral: UsdSymbol | CallCollateralSymbol;
  usd: UsdSymbol;
  config: string;
};
export type HistoryCommand = { cmd: 'history'; fromSec: number; toSec: number; out: string; config: string };
export type WalletCommand = { cmd: 'wallet'; config: string };
export type BasisSuggestAnchorCommand = { cmd: 'basis-suggest-anchor'; config: string };

export type CliCommand =
  | RunCommand
  | StateCommand
  | QuoteCommand
  | HistoryCommand
  | WalletCommand
  | BasisSuggestAnchorCommand;

type Options = NonNullable<ParseArgsConfig['options']>;
type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

const DEFAULT_CONFIG = 'config.json';
const DEFAULT_QUANTITY = '25';
const USD_SYMBOLS: readonly string[] = ['usdc', 'usdt0'];
const CALL_COLLATERALS: readonly string[] = ['whype'];
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const INTEGER = /^[0-9]+$/;
const STRIKE = /^[0-9]+(?:\.[0-9]{1,8})?$/;
const QUANTITY = /^[0-9]+(?:\.[0-9]{1,18})?$/;
const CONFIG_OPTION: Options = { config: { type: 'string' } };

/**
 * Parses the command line after `node main.ts` (spec §9.6): the command in the first positional, then that
 * command's flags under `parseArgs`' strict mode. Pure: never reads files or the environment. Decimal flags (the
 * strike, the quantity) are converted by string arithmetic, never through floats. Throws `UsageError`.
 */
export function parseCli(argv: string[]): CliCommand {
  const [command, ...rest] = argv;
  switch (command) {
    case 'run':
      return parseRun(rest);
    case 'state':
      return { cmd: 'state', config: configOf(parse(rest, CONFIG_OPTION, 0).values) };
    case 'quote':
      return parseQuote(rest);
    case 'history':
      return parseHistory(rest);
    case 'wallet':
      return { cmd: 'wallet', config: configOf(parse(rest, CONFIG_OPTION, 0).values) };
    case 'basis':
      return parseBasis(rest);
    case undefined:
      throw new UsageError('no command given');
    default:
      throw new UsageError(`unknown command '${command}'`);
  }
}

/**
 * How `command` reads its config: live only for `run --live`, and the basis anchor rule only for `run` (in both
 * modes). The read-only commands work with a zero anchor while calls are enabled, so `basis suggest-anchor` can
 * suggest the anchor that the rule asks for.
 */
export function configFlags(command: CliCommand): Required<ConfigFlags> {
  const run = command.cmd === 'run';
  return { live: run && command.live, requireAnchor: run };
}

function parseRun(args: string[]): RunCommand {
  const { values } = parse(
    args,
    {
      ...CONFIG_OPTION,
      live: { type: 'boolean' },
      'max-trades': { type: 'string' },
      'no-sampler': { type: 'boolean' },
    },
    0,
  );
  const command: RunCommand = {
    cmd: 'run',
    live: values.live === true,
    sampler: values['no-sampler'] !== true,
    config: configOf(values),
  };
  const maxTrades = stringOf(values, 'max-trades');
  if (maxTrades === undefined) return command;
  if (!POSITIVE_INTEGER.test(maxTrades)) {
    throw new UsageError(`--max-trades must be a positive integer, not '${maxTrades}'`);
  }
  return { ...command, maxTrades: safeInteger(maxTrades, '--max-trades') };
}

function parseQuote(args: string[]): QuoteCommand {
  const { values } = parse(
    args,
    {
      ...CONFIG_OPTION,
      side: { type: 'string' },
      strike: { type: 'string' },
      expiry: { type: 'string' },
      qty: { type: 'string' },
      collateral: { type: 'string' },
      usd: { type: 'string' },
    },
    0,
  );
  const side = required(values, 'side');
  if (side !== 'put' && side !== 'call') throw new UsageError(`--side must be put or call, not '${side}'`);
  const strike = required(values, 'strike');
  if (!STRIKE.test(strike) || usdE8FromDecimal(strike) <= 0n) {
    throw new UsageError(`--strike must be a positive USD price with at most 8 decimals, not '${strike}'`);
  }
  const expiry = required(values, 'expiry');
  if (!POSITIVE_INTEGER.test(expiry)) {
    throw new UsageError(`--expiry must be the expiry in epoch seconds, not '${expiry}'`);
  }
  const qty = stringOf(values, 'qty') ?? DEFAULT_QUANTITY;
  if (!QUANTITY.test(qty) || e18FromDecimal(qty) <= 0n) {
    throw new UsageError(`--qty must be a positive number of contracts, not '${qty}'`);
  }
  const usd = (stringOf(values, 'usd') ?? 'usdc').toLowerCase();
  if (!isUsdSymbol(usd)) throw new UsageError(`--usd must be usdc or usdt0, not '${usd}'`);
  return {
    cmd: 'quote',
    side,
    strikeE8: usdE8FromDecimal(strike),
    expirySec: safeInteger(expiry, '--expiry'),
    quantityE18: e18FromDecimal(qty),
    collateral: collateralOf(side, usd, stringOf(values, 'collateral')),
    usd,
    config: configOf(values),
  };
}

/** A put is collateralized in its own stable; a call in WHYPE (the default) or a liquid-staked HYPE. */
function collateralOf(side: Side, usd: UsdSymbol, flag: string | undefined): QuoteCommand['collateral'] {
  const collateral = flag?.toLowerCase();
  if (side === 'put') {
    if (collateral === undefined || collateral === usd) return usd;
    throw new UsageError(`--collateral of a put is its --usd stable (${usd}), not '${collateral}'`);
  }
  if (collateral === undefined) return 'whype';
  if (isCallCollateral(collateral)) return collateral;
  throw new UsageError(`--collateral of a call must be whype, not '${collateral}'`);
}

function parseHistory(args: string[]): HistoryCommand {
  const { values } = parse(
    args,
    { ...CONFIG_OPTION, from: { type: 'string' }, to: { type: 'string' }, out: { type: 'string' } },
    0,
  );
  const fromSec = epochSeconds(values, 'from');
  const toSec = epochSeconds(values, 'to');
  if (toSec < fromSec) throw new UsageError(`--to ${toSec} is before --from ${fromSec}`);
  return { cmd: 'history', fromSec, toSec, out: required(values, 'out'), config: configOf(values) };
}

function parseBasis(args: string[]): BasisSuggestAnchorCommand {
  const { values, positionals } = parse(args, CONFIG_OPTION, 1);
  if (positionals[0] !== 'suggest-anchor') {
    const got = positionals[0] === undefined ? 'nothing' : `'${positionals[0]}'`;
    throw new UsageError(`basis takes the subcommand suggest-anchor, not ${got}`);
  }
  return { cmd: 'basis-suggest-anchor', config: configOf(values) };
}

/** `parseArgs` in strict mode with at most `maxPositionals` positionals; its errors become `UsageError`s. */
function parse(
  args: string[],
  options: Options,
  maxPositionals: number,
): { values: Values; positionals: string[] } {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const stray = parsed.positionals[maxPositionals];
  if (stray !== undefined) throw new UsageError(`unexpected argument '${stray}'`);
  return parsed;
}

function stringOf(values: Values, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

function required(values: Values, name: string): string {
  const value = stringOf(values, name);
  if (value === undefined) throw new UsageError(`--${name} is required`);
  return value;
}

function configOf(values: Values): string {
  return stringOf(values, 'config') ?? DEFAULT_CONFIG;
}

function epochSeconds(values: Values, name: string): number {
  const value = required(values, name);
  if (!INTEGER.test(value)) throw new UsageError(`--${name} must be epoch seconds, not '${value}'`);
  return safeInteger(value, `--${name}`);
}

function safeInteger(digits: string, flag: string): number {
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) throw new UsageError(`${flag} ${digits} is too large`);
  return value;
}

function isUsdSymbol(symbol: string): symbol is UsdSymbol {
  return USD_SYMBOLS.includes(symbol);
}

function isCallCollateral(symbol: string): symbol is CallCollateralSymbol {
  return CALL_COLLATERALS.includes(symbol);
}
