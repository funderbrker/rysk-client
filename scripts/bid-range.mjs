#!/usr/bin/env node
// Summarizes the maker bids in the `quotes` research stream: per instrument and product leg, the range of the bid
// (USD per contract), of our gross APR and of the HYPE spot at the time of each bid. Read-only; no dependencies.
//
//   node scripts/bid-range.mjs [--series] [--purpose sweep,pinned,...] [path ...]
//
// Paths are `quotes` JSONL files or directories of them (default: data/quotes). `--series` prints every bid as a TSV
// row (time, purpose, instrument, leg, maker, bid, spot, APR) instead of the per-instrument table.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tokenByAddress } from '../src/domain/constants.ts';

const args = process.argv.slice(2);
const series = args.includes('--series');
const purposeArg = args[args.indexOf('--purpose') + 1];
const purposes = args.includes('--purpose') && purposeArg ? new Set(purposeArg.split(',')) : null;
const paths = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--purpose');
if (paths.length === 0) paths.push('data/quotes');

/** A token symbol for a record's `*Symbol` field or, when the record lacks it (strategy RFQs), its address. */
function legOf(symbol, address) {
  return symbol ?? tokenByAddress(address)?.symbol ?? address;
}

/** Every `.jsonl` file under the given files and directories. */
function files(roots) {
  return roots.flatMap((root) =>
    statSync(root).isDirectory()
      ? readdirSync(root)
          .filter((name) => name.endsWith('.jsonl'))
          .sort()
          .map((name) => join(root, name))
      : [root],
  );
}

/** The answered RFQs: one record per maker bid, with the fields the summary reads. */
function bids(roots) {
  const out = [];
  for (const file of files(roots)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line === '') continue;
      const r = JSON.parse(line);
      if (r.outcome !== 'quote' || r.quote?.priceE18 === undefined) continue;
      if (purposes !== null && !purposes.has(r.purpose)) continue;
      const spotE8 = r.context?.spotE8;
      out.push({
        tsMs: r.respondedAtMs ?? r.tsMs,
        purpose: r.purpose,
        key: r.instrument.key,
        isPut: r.instrument.isPut,
        strikeE8: BigInt(r.instrument.strikeE8),
        expirySec: r.instrument.expirySec,
        leg: r.instrument.isPut
          ? legOf(r.instrument.usdSymbol, r.instrument.usd)
          : legOf(r.instrument.collateralSymbol, r.instrument.collateralAsset),
        maker: r.quote.maker,
        bid: Number(BigInt(r.quote.priceE18)) / 1e18,
        spot: spotE8 == null ? null : Number(BigInt(spotE8)) / 1e8,
        apr: typeof r.aprGross === 'number' ? r.aprGross : null,
      });
    }
  }
  return out.sort((a, b) => a.tsMs - b.tsMs);
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const usd = (n) => n.toFixed(4);
const pct = (n) => `${(n * 100).toFixed(1)}%`;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const range = (xs, f) => (xs.length === 0 ? '-' : `${f(Math.min(...xs))}..${f(Math.max(...xs))}`);
/** `side K strike, expiry date` for an instrument key. */
const instrument = (b) =>
  `${b.isPut ? 'put ' : 'call'} ${(Number(b.strikeE8) / 1e8).toFixed(2).padStart(7)} ${new Date(b.expirySec * 1000).toISOString().slice(0, 10)}`;

const rows = bids(paths);
if (rows.length === 0) {
  console.error('no answered RFQs found');
  process.exit(1);
}

if (series) {
  console.log(
    ['time (UTC)', 'purpose', 'instrument', 'leg', 'maker', 'bid USD', 'spot USD', 'APR'].join('\t'),
  );
  for (const b of rows) {
    const cells = [iso(b.tsMs), b.purpose, instrument(b), b.leg, b.maker.slice(0, 10), usd(b.bid)];
    cells.push(b.spot === null ? '' : b.spot.toFixed(2), b.apr === null ? '' : pct(b.apr));
    console.log(cells.join('\t'));
  }
} else {
  const groups = new Map();
  for (const b of rows) {
    const id = `${b.key}|${b.leg}`;
    const g = groups.get(id) ?? {
      first: b,
      bids: [],
      spots: [],
      aprs: [],
      makers: new Set(),
      from: b.tsMs,
      to: b.tsMs,
    };
    g.bids.push(b.bid);
    if (b.spot !== null) g.spots.push(b.spot);
    if (b.apr !== null) g.aprs.push(b.apr);
    g.makers.add(b.maker);
    g.to = b.tsMs;
    groups.set(id, g);
  }
  const sorted = [...groups.values()].sort((a, b) => {
    if (a.first.isPut !== b.first.isPut) return a.first.isPut ? -1 : 1;
    if (a.first.expirySec !== b.first.expirySec) return a.first.expirySec - b.first.expirySec;
    if (a.first.strikeE8 !== b.first.strikeE8) return a.first.strikeE8 < b.first.strikeE8 ? -1 : 1;
    return a.first.leg.localeCompare(b.first.leg);
  });
  const header = [
    'instrument',
    'leg',
    'n',
    'makers',
    'bid min..max (USD)',
    'median',
    'APR min..max',
    'spot min..max',
    'from',
    'to',
  ];
  const table = sorted.map((g) => [
    instrument(g.first),
    g.first.leg,
    String(g.bids.length),
    String(g.makers.size),
    range(g.bids, usd),
    usd(median(g.bids)),
    range(g.aprs, pct),
    range(g.spots, (n) => n.toFixed(2)),
    iso(g.from),
    iso(g.to),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(header));
  for (const row of table) console.log(line(row));
  const allSpots = rows.map((b) => b.spot).filter((s) => s !== null);
  console.log(
    `\n${rows.length} bids on ${groups.size} instrument legs, ${iso(rows[0].tsMs)} to ${iso(rows.at(-1).tsMs)} UTC; spot ${range(allSpots, (n) => n.toFixed(2))} USD`,
  );
}
