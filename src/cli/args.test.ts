import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../daemon/config.ts';
import { configFlags, parseCli, USAGE, UsageError } from './args.ts';

const E18 = 10n ** 18n;

/** The usage error `parseCli` throws for `argv`. */
function usageError(argv: string[]): UsageError {
  try {
    parseCli(argv);
  } catch (error) {
    if (error instanceof UsageError) return error;
    throw error;
  }
  throw new Error(`expected a UsageError for ${argv.join(' ')}`);
}

describe('parseCli: run', () => {
  it('parses --live and --max-trades with the sampler on and the default config', () => {
    expect(parseCli(['run', '--live', '--max-trades', '1'])).toEqual({
      cmd: 'run',
      live: true,
      maxTrades: 1,
      sampler: true,
      config: 'config.json',
    });
  });

  it('defaults to dry-run without a trade limit', () => {
    const command = parseCli(['run']);
    expect(command).toEqual({ cmd: 'run', live: false, sampler: true, config: 'config.json' });
    expect(command).not.toHaveProperty('maxTrades');
  });

  it('takes --no-sampler and --config', () => {
    expect(parseCli(['run', '--no-sampler', '--config', 'conf/live.json'])).toEqual({
      cmd: 'run',
      live: false,
      sampler: false,
      config: 'conf/live.json',
    });
  });

  it.each(['0', '-1', '1.5', 'two', ''])('rejects --max-trades %j', (value) => {
    expect(usageError(['run', '--max-trades', value]).message).toContain('--max-trades');
  });
});

describe('parseCli: quote', () => {
  it("parses a put with the default quantity, its usd as collateral and the strike's decimal string exactly", () => {
    expect(parseCli(['quote', '--side', 'put', '--strike', '78.5', '--expiry', '1793347200'])).toEqual({
      cmd: 'quote',
      side: 'put',
      strikeE8: 7850000000n,
      expirySec: 1793347200,
      quantityE18: 25n * E18,
      collateral: 'usdc',
      usd: 'usdc',
      config: 'config.json',
    });
  });

  it('defaults a call to WHYPE collateral paid in USDC', () => {
    const command = parseCli(['quote', '--side', 'call', '--strike', '95', '--expiry', '1793347200']);
    expect(command).toMatchObject({ side: 'call', strikeE8: 9500000000n, collateral: 'whype', usd: 'usdc' });
  });

  it('takes the quantity, an LST collateral, the stable and the config, in any case', () => {
    const command = parseCli([
      'quote',
      '--side',
      'call',
      '--strike',
      '0.1',
      '--expiry',
      '1793347200',
      '--qty',
      '50',
      '--collateral',
      'kHYPE',
      '--usd',
      'USDT0',
      '--config',
      'other.json',
    ]);
    expect(command).toEqual({
      cmd: 'quote',
      side: 'call',
      strikeE8: 10000000n,
      expirySec: 1793347200,
      quantityE18: 50n * E18,
      collateral: 'khype',
      usd: 'usdt0',
      config: 'other.json',
    });
  });

  it('parses an 8-decimal strike and a fractional quantity without floats', () => {
    const command = parseCli([
      'quote',
      '--side',
      'put',
      '--strike',
      '78.12345678',
      '--expiry',
      '1',
      '--qty',
      '0.000000000000000001',
      '--usd',
      'usdt0',
    ]);
    expect(command).toMatchObject({
      strikeE8: 7812345678n,
      quantityE18: 1n,
      collateral: 'usdt0',
      usd: 'usdt0',
    });
  });

  it.each([
    [['--strike', '78.5', '--expiry', '1793347200'], '--side'],
    [['--side', 'sideways', '--strike', '78.5', '--expiry', '1793347200'], '--side'],
    [['--side', 'put', '--expiry', '1793347200'], '--strike'],
    [['--side', 'put', '--strike', '78.5x', '--expiry', '1793347200'], '--strike'],
    [['--side', 'put', '--strike', '0', '--expiry', '1793347200'], '--strike'],
    [['--side', 'put', '--strike', '1.123456789', '--expiry', '1793347200'], '--strike'],
    [['--side', 'put', '--strike', '78.5'], '--expiry'],
    [['--side', 'put', '--strike', '78.5', '--expiry', '17933472.5'], '--expiry'],
    [['--side', 'put', '--strike', '78.5', '--expiry', '1793347200', '--qty', '0'], '--qty'],
    [
      ['--side', 'put', '--strike', '78.5', '--expiry', '1793347200', '--collateral', 'whype'],
      '--collateral',
    ],
    [
      ['--side', 'put', '--strike', '78.5', '--expiry', '1793347200', '--collateral', 'usdt0'],
      '--collateral',
    ],
    [['--side', 'call', '--strike', '95', '--expiry', '1793347200', '--collateral', 'usdc'], '--collateral'],
    [['--side', 'call', '--strike', '95', '--expiry', '1793347200', '--usd', 'usdh'], '--usd'],
  ])('rejects %j naming %s', (args, flag) => {
    expect(usageError(['quote', ...args]).message).toContain(flag);
  });
});

describe('parseCli: the other commands', () => {
  it('parses basis suggest-anchor', () => {
    expect(parseCli(['basis', 'suggest-anchor'])).toEqual({
      cmd: 'basis-suggest-anchor',
      config: 'config.json',
    });
  });

  it('parses state and wallet with their config', () => {
    expect(parseCli(['state'])).toEqual({ cmd: 'state', config: 'config.json' });
    expect(parseCli(['wallet', '--config', 'w.json'])).toEqual({ cmd: 'wallet', config: 'w.json' });
  });

  it('parses history with its window and output file', () => {
    expect(
      parseCli(['history', '--from', '1792000000', '--to', '1792086400', '--out', 'fills.jsonl']),
    ).toEqual({
      cmd: 'history',
      fromSec: 1792000000,
      toSec: 1792086400,
      out: 'fills.jsonl',
      config: 'config.json',
    });
  });

  it('rejects a history window that ends before it starts, or a missing --out', () => {
    expect(usageError(['history', '--from', '2', '--to', '1', '--out', 'f.jsonl']).message).toContain('--to');
    expect(usageError(['history', '--from', '1', '--to', '2']).message).toContain('--out');
  });

  it('rejects basis without suggest-anchor', () => {
    expect(usageError(['basis']).message).toContain('suggest-anchor');
    expect(usageError(['basis', 'reset']).message).toContain('suggest-anchor');
  });
});

describe('parseCli: usage errors', () => {
  it('throws the usage text for an unknown command', () => {
    const error = usageError(['trade']);
    expect(error.message).toContain("unknown command 'trade'");
    expect(error.message).toContain(USAGE);
  });

  it('throws the usage text without a command', () => {
    expect(usageError([]).message).toContain(USAGE);
  });

  it('throws the usage text for an unknown flag or a stray argument', () => {
    expect(usageError(['run', '--bogus']).message).toContain(USAGE);
    expect(usageError(['wallet', 'extra']).message).toContain("unexpected argument 'extra'");
    expect(usageError(['state', '--config']).message).toContain(USAGE);
  });
});

describe('configFlags', () => {
  it('applies the anchor rule to run in both modes and live only for run --live', () => {
    expect(configFlags(parseCli(['run']))).toEqual({ live: false, requireAnchor: true });
    expect(configFlags(parseCli(['run', '--live']))).toEqual({ live: true, requireAnchor: true });
  });

  it.each([
    [['state']],
    [['wallet']],
    [['quote', '--side', 'put', '--strike', '78.5', '--expiry', '1793347200']],
    [['history', '--from', '1', '--to', '2', '--out', 'f.jsonl']],
    [['basis', 'suggest-anchor']],
  ])('reads the config without the anchor rule for %j', (argv) => {
    expect(configFlags(parseCli(argv))).toEqual({ live: false, requireAnchor: false });
  });

  it('points run at basis suggest-anchor, which loads the same zero-anchor config', () => {
    const raw = JSON.parse(readFileSync(new URL('../../config.example.json', import.meta.url), 'utf8'));
    raw.basis.anchor = { ts: 0, qtyWhype: '0', basisUsd: '0' };
    expect(raw.call.enabled).toBe(true);

    const run = () => parseConfig(raw, configFlags(parseCli(['run'])));
    expect(run).toThrow(ConfigError);
    expect(run).toThrow('rysk basis suggest-anchor');
    const suggest = parseConfig(raw, configFlags(parseCli(['basis', 'suggest-anchor'])));
    expect(suggest.wheel.basis.anchor.ts).toBe(0);
  });
});

describe('USAGE', () => {
  it('documents the exit codes, the usage error and the forced exit after a stop', () => {
    expect(USAGE).toContain('2 usage error');
    expect(USAGE).toContain('3 forced exit');
  });
});
