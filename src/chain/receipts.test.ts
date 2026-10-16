import { readFileSync } from 'node:fs';
import {
  type Address,
  encodeAbiParameters,
  encodeEventTopics,
  formatTransactionReceipt,
  getAddress,
  type Hex,
  isAddressEqual,
  pad,
  type TransactionReceipt,
  toEventSelector,
  toHex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { ADDRESSES, TOKENS } from '../domain/index.ts';
import { transferEventAbi } from './abi.ts';
import { type FillExpectation, verifyFillReceipt } from './receipts.ts';

const SELF = getAddress('0x000000000000000000000000000000000000beef');
const STRANGER = getAddress('0x000000000000000000000000000000000000cafe');

type ReceiptLog = TransactionReceipt['logs'][number];

// Positions of the fill's own logs in receipt.json.
const VAULT_OPENED_LOG = 0;
const COLLATERAL_TRANSFER_LOG = 1;
const SHORT_MINTED_LOG = 5;
const PREMIUM_TRANSFER_LOG = 13;
// Topic positions: Transfer(from, to, value) and ShortOtokenMinted(otoken, AccountOwner, to, ...).
const TRANSFER_FROM = 1;
const TRANSFER_TO = 2;
const SHORT_ACCOUNT_OWNER = 2;

const EXPECTED: FillExpectation = {
  self: SELF,
  collateralToken: TOKENS.USDC.address,
  collateralAmount: 1962500000n,
  premium6: 47486300n,
  gasFee6: 0n,
  counterBefore: 86n,
  quantityE18: 25n * 10n ** 18n,
};

function fixtureReceipt(): TransactionReceipt {
  const raw = JSON.parse(readFileSync(new URL('../../test/fixtures/receipt.json', import.meta.url), 'utf8'));
  return formatTransactionReceipt(raw);
}

function withLogs(receipt: TransactionReceipt, ...logs: ReceiptLog[]): TransactionReceipt {
  return { ...receipt, logs: [...receipt.logs, ...logs] };
}

/** A log shaped like the fixture's, carrying the given emitter, topics and data. */
function extraLog(
  receipt: TransactionReceipt,
  fields: Pick<ReceiptLog, 'address' | 'topics' | 'data'>,
): ReceiptLog {
  const template = receipt.logs[0];
  if (template === undefined) throw new Error('fixture receipt has no logs');
  return { ...template, ...fields };
}

function transferLog(receipt: TransactionReceipt, token: Address, from: Address, to: Address, value: bigint) {
  const topics = encodeEventTopics({ abi: transferEventAbi, eventName: 'Transfer', args: { from, to } });
  const data = encodeAbiParameters([{ type: 'uint256' }], [value]);
  return extraLog(receipt, { address: token, topics: topics as ReceiptLog['topics'], data });
}

function fixtureLog(receipt: TransactionReceipt, index: number): ReceiptLog {
  const log = receipt.logs[index];
  if (log === undefined) throw new Error(`fixture receipt has no log ${index}`);
  return log;
}

/** The fixture receipt with log `index` replaced by `edit(log)`. */
function editedReceipt(index: number, edit: (log: ReceiptLog) => ReceiptLog): TransactionReceipt {
  const receipt = fixtureReceipt();
  return { ...receipt, logs: receipt.logs.map((log, i) => (i === index ? edit(log) : log)) };
}

function withTopic(log: ReceiptLog, position: number, topic: Hex): ReceiptLog {
  const topics = [...log.topics];
  topics[position] = topic;
  return { ...log, topics: topics as ReceiptLog['topics'] };
}

/** The fixture receipt with log `index` emitted a second time. */
function duplicatedReceipt(index: number): TransactionReceipt {
  const receipt = fixtureReceipt();
  return withLogs(receipt, fixtureLog(receipt, index));
}

function problemsOf(receipt: TransactionReceipt, overrides: Partial<FillExpectation> = {}) {
  const result = verifyFillReceipt(receipt, { ...EXPECTED, ...overrides });
  if (result.ok) throw new Error('expected the receipt to fail verification');
  return result.problems;
}

describe('verifyFillReceipt', () => {
  it('accepts the recorded fill and reports the vault and premium', () => {
    expect(verifyFillReceipt(fixtureReceipt(), EXPECTED)).toEqual({
      ok: true,
      vaultId: 87n,
      premiumReceived6: 47486300n,
    });
  });

  it('flags a collateral transfer for a different amount', () => {
    expect(problemsOf(fixtureReceipt(), { collateralAmount: 1962500001n })).toContain('collateral-transfer');
  });

  it('flags a collateral transfer in a different token', () => {
    expect(problemsOf(fixtureReceipt(), { collateralToken: TOKENS.WHYPE.address })).toContain(
      'collateral-transfer',
    );
  });

  it('flags a vault id that does not follow the counter', () => {
    expect(problemsOf(fixtureReceipt(), { counterBefore: 80n })).toContain('vault-opened');
  });

  it('flags a vault opened for another owner', () => {
    expect(problemsOf(fixtureReceipt(), { self: STRANGER })).toContain('vault-opened');
  });

  it('flags a vault opening not emitted by the vault store', () => {
    const receipt = fixtureReceipt();
    const logs = receipt.logs.map((log) =>
      isAddressEqual(log.address, ADDRESSES.vaultStore) ? { ...log, address: STRANGER } : log,
    );

    expect(problemsOf({ ...receipt, logs })).toEqual(['vault-opened']);
  });

  it('reports only the revert for a reverted receipt', () => {
    const reverted: TransactionReceipt = { ...fixtureReceipt(), status: 'reverted' };

    expect(verifyFillReceipt(reverted, EXPECTED)).toEqual({ ok: false, problems: ['reverted'] });
  });

  it('flags a minted short amount that does not match the quantity', () => {
    expect(problemsOf(fixtureReceipt(), { quantityE18: 50n * 10n ** 18n })).toContain('short-minted');
  });

  it('flags a transaction sent to a contract other than Rysk', () => {
    expect(problemsOf({ ...fixtureReceipt(), to: ADDRESSES.mmarket })).toEqual(['wrong-to']);
  });

  it('accepts a premium within one unit of premium minus gas fee', () => {
    const result = verifyFillReceipt(fixtureReceipt(), {
      ...EXPECTED,
      premium6: 47586301n,
      gasFee6: 100000n,
    });

    expect(result).toEqual({ ok: true, vaultId: 87n, premiumReceived6: 47486300n });
  });

  it.each([
    ['two units low', 47486302n],
    ['two units high', 47486298n],
  ])('flags a premium transfer %s', (_label, premium6) => {
    expect(problemsOf(fixtureReceipt(), { premium6 })).toEqual(['premium-transfer']);
  });

  it('flags any other transfer out of the seller', () => {
    const receipt = fixtureReceipt();
    const leak = transferLog(receipt, TOKENS.WHYPE.address, SELF, STRANGER, 1n);

    expect(problemsOf(withLogs(receipt, leak))).toEqual(['extra-transfer-from-self']);
  });

  it('flags a second collateral transfer to the margin pool', () => {
    const receipt = fixtureReceipt();
    const duplicate = transferLog(receipt, TOKENS.USDC.address, SELF, ADDRESSES.marginPool, 1962500000n);

    expect(problemsOf(withLogs(receipt, duplicate))).toEqual(['collateral-transfer']);
  });

  it('collects every problem instead of stopping at the first', () => {
    const receipt = { ...fixtureReceipt(), to: ADDRESSES.mmarket };
    const overrides = { collateralAmount: 1n, premium6: 1n, counterBefore: 1n, quantityE18: 1n };

    expect(problemsOf(receipt, overrides)).toEqual([
      'wrong-to',
      'collateral-transfer',
      'premium-transfer',
      'vault-opened',
      'short-minted',
    ]);
  });

  it('flags collateral sent somewhere other than the margin pool', () => {
    const receipt = editedReceipt(COLLATERAL_TRANSFER_LOG, (log) =>
      withTopic(log, TRANSFER_TO, pad(STRANGER)),
    );

    expect(problemsOf(receipt)).toEqual(['collateral-transfer', 'extra-transfer-from-self']);
  });

  it('flags collateral paid by someone other than the seller', () => {
    const receipt = editedReceipt(COLLATERAL_TRANSFER_LOG, (log) =>
      withTopic(log, TRANSFER_FROM, pad(STRANGER)),
    );

    expect(problemsOf(receipt)).toEqual(['collateral-transfer']);
  });

  it('flags a premium paid by someone other than MMarket', () => {
    const receipt = editedReceipt(PREMIUM_TRANSFER_LOG, (log) =>
      withTopic(log, TRANSFER_FROM, pad(STRANGER)),
    );

    expect(problemsOf(receipt)).toEqual(['premium-transfer']);
  });

  it('flags a premium paid in a token other than USDC', () => {
    const receipt = editedReceipt(PREMIUM_TRANSFER_LOG, (log) => ({ ...log, address: TOKENS.WHYPE.address }));

    expect(problemsOf(receipt)).toEqual(['premium-transfer']);
  });

  it('flags a short minted for another account owner', () => {
    const receipt = editedReceipt(SHORT_MINTED_LOG, (log) =>
      withTopic(log, SHORT_ACCOUNT_OWNER, pad(STRANGER)),
    );

    expect(problemsOf(receipt)).toEqual(['short-minted']);
  });

  it('flags a short minted into a vault other than the one opened', () => {
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [88n, 2500000000n]);
    const receipt = editedReceipt(SHORT_MINTED_LOG, (log) => ({ ...log, data }));

    expect(problemsOf(receipt)).toEqual(['short-minted']);
  });

  it.each([
    ['premium transfer', PREMIUM_TRANSFER_LOG, 'premium-transfer'],
    ['vault opening', VAULT_OPENED_LOG, 'vault-opened'],
    ['short mint', SHORT_MINTED_LOG, 'short-minted'],
  ])('flags a second %s as ambiguous', (_label, index, problem) => {
    expect(problemsOf(duplicatedReceipt(index))).toEqual([problem]);
  });

  it('flags a transfer out of the seller that does not decode as ERC-20', () => {
    const receipt = fixtureReceipt();
    const topics: ReceiptLog['topics'] = [
      toEventSelector(transferEventAbi[0]),
      pad(SELF),
      pad(STRANGER),
      pad(toHex(7n)),
    ];
    const nft = extraLog(receipt, { address: TOKENS.WHYPE.address, topics, data: '0x' });

    expect(problemsOf(withLogs(receipt, nft))).toEqual(['extra-transfer-from-self']);
  });

  it('ignores anonymous and undecodable logs', () => {
    const receipt = fixtureReceipt();
    const transfer = transferLog(receipt, TOKENS.USDC.address, STRANGER, STRANGER, 1n);
    const anonymous = extraLog(receipt, { address: STRANGER, topics: [], data: '0x' });
    const truncated = { ...transfer, data: '0x' as const };

    expect(verifyFillReceipt(withLogs(receipt, anonymous, truncated), EXPECTED)).toMatchObject({ ok: true });
  });
});
