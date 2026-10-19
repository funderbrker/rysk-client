#!/usr/bin/env node
// How maker bids move over short horizons, from the `quotes` research stream: for pairs of bids on the same
// instrument about H minutes apart, the change in the bid against the change in HYPE spot over the same gap, the part
// of the bid change spot does not explain, and the effect of a different maker winning. Read-only; no dependencies.
//
//   node scripts/bid-moves.mjs [--horizons 5,15,60] [--min-obs 3] [path ...]
//
// Paths are `quotes` JSONL files or directories of them (default: data/quotes). A pair is two bids on one instrument
// whose gap is within half the horizon of it (the nearest such later bid is taken).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const horizonsMin = option('--horizons', '5,15,60').split(',').map(Number);
const minObs = Number(option('--min-obs', '3'));
const paths = args.filter(
  (a, i) => !a.startsWith('--') && !['--horizons', '--min-obs'].includes(args[i - 1]),
);
if (paths.length === 0) paths.push('data/quotes');

const MINUTE_MS = 60_000;

function files(roots) {
  return roots.flatMap((root) =>
    statSync(root).isDirectory()
      ? readdirSync(root)
          .filter((f) => f.endsWith('.jsonl'))
          .sort()
          .map((f) => join(root, f))
      : [root],
  );
}

/** Every answered RFQ with a spot, oldest first, grouped by instrument. */
function observations(roots) {
  const all = [];
  for (const file of files(roots)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line === '') continue;
      const r = JSON.parse(line);
      if (r.outcome !== 'quote' || r.quote?.priceE18 === undefined || r.context?.spotE8 == null) continue;
      all.push({
        tMs: r.respondedAtMs ?? r.tsMs,
        key: r.instrument.key,
        side: r.side,
        purpose: r.purpose,
        strike: Number(BigInt(r.instrument.strikeE8)) / 1e8,
        expirySec: r.instrument.expirySec,
        maker: r.quote.maker,
        bid: Number(BigInt(r.quote.priceE18)) / 1e18,
        spot: Number(BigInt(r.context.spotE8)) / 1e8,
      });
    }
  }
  all.sort((a, b) => a.tMs - b.tMs);
  const byKey = new Map();
  for (const o of all) (byKey.get(o.key) ?? byKey.set(o.key, []).get(o.key)).push(o);
  return { all, byKey };
}

/** Pairs of observations of one instrument about `horizonMs` apart, each with the nearest later match. */
function pairsAt(byKey, horizonMs) {
  const tolMs = horizonMs / 2;
  const pairs = [];
  for (const obs of byKey.values()) {
    for (let i = 0; i < obs.length; i++) {
      const a = obs[i];
      let b = null;
      for (let j = i + 1; j < obs.length && obs[j].tMs - a.tMs <= horizonMs + tolMs; j++) {
        const off = Math.abs(obs[j].tMs - a.tMs - horizonMs);
        if (off <= tolMs && (b === null || off < Math.abs(b.tMs - a.tMs - horizonMs))) b = obs[j];
      }
      if (b === null) continue;
      pairs.push({
        side: a.side,
        dBid: b.bid / a.bid - 1,
        dSpot: b.spot / a.spot - 1,
        sameMaker: a.maker === b.maker,
        gapMin: (b.tMs - a.tMs) / MINUTE_MS,
      });
    }
  }
  return pairs;
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;
const quantile = (xs, p) => {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const quantiles = (xs) =>
  `median ${pct(quantile(xs, 0.5))}  p75 ${pct(quantile(xs, 0.75))}  p90 ${pct(quantile(xs, 0.9))}  max ${pct(Math.max(...xs))}`;
/** Least-squares slope through the origin of Δbid on Δspot: how many % the bid moves per 1 % of spot. */
const elasticity = (pairs) => {
  const den = pairs.reduce((n, p) => n + p.dSpot ** 2, 0);
  return den === 0 ? Number.NaN : pairs.reduce((n, p) => n + p.dBid * p.dSpot, 0) / den;
};

function report(horizonMin, pairs) {
  console.log(
    `\n== ${horizonMin}-minute horizon: ${pairs.length} pairs, gap median ${quantile(
      pairs.map((p) => p.gapMin),
      0.5,
    ).toFixed(1)} min ==`,
  );
  if (pairs.length === 0) return;
  const beta = {
    put: elasticity(pairs.filter((p) => p.side === 'put')),
    call: elasticity(pairs.filter((p) => p.side === 'call')),
  };
  const residual = pairs.map((p) =>
    Math.abs(p.dBid - (Number.isNaN(beta[p.side]) ? 0 : beta[p.side]) * p.dSpot),
  );
  const flat = pairs.filter((p) => Math.abs(p.dSpot) < 0.001);
  const same = pairs.filter((p) => p.sameMaker);
  const switched = pairs.filter((p) => !p.sameMaker);
  console.log(`  |Δbid|    ${quantiles(pairs.map((p) => Math.abs(p.dBid)))}`);
  console.log(`  |Δspot|   ${quantiles(pairs.map((p) => Math.abs(p.dSpot)))}`);
  console.log(
    `  bid % per 1 % of spot: puts ${beta.put.toFixed(1)}, calls ${beta.call.toFixed(1)}; left unexplained by spot: median ${pct(quantile(residual, 0.5))}, p90 ${pct(quantile(residual, 0.9))}`,
  );
  console.log(
    `  spot flat (under 0.1 %): ${flat.length} pairs, bid moved anyway by median ${pct(
      quantile(
        flat.map((p) => Math.abs(p.dBid)),
        0.5,
      ),
    )}; more than 2 % in ${flat.filter((p) => Math.abs(p.dBid) > 0.02).length} of them`,
  );
  console.log(
    `  same maker both times: ${same.length} pairs, median |Δbid| ${pct(
      quantile(
        same.map((p) => Math.abs(p.dBid)),
        0.5,
      ),
    )}; a different maker won: ${switched.length} pairs, median |Δbid| ${pct(
      quantile(
        switched.map((p) => Math.abs(p.dBid)),
        0.5,
      ),
    )}`,
  );
}

const { all, byKey } = observations(paths);
if (all.length === 0) {
  console.error('no answered RFQs with a spot found');
  process.exit(1);
}
const hhmm = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const spots = all.map((o) => o.spot);
console.log(
  `${all.length} bids on ${byKey.size} instruments, ${hhmm(all[0].tMs)} to ${hhmm(all.at(-1).tMs)} UTC; spot ${Math.min(...spots).toFixed(2)} to ${Math.max(...spots).toFixed(2)} USD`,
);
const wins = new Map();
for (const o of all) wins.set(o.maker, (wins.get(o.maker) ?? 0) + 1);
console.log(
  `makers and bids won: ${[...wins]
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `${m.slice(0, 10)} ${n}`)
    .join(', ')}`,
);
for (const h of horizonsMin) report(h, pairsAt(byKey, h * MINUTE_MS));

console.log(`\n== instruments with at least ${minObs} bids: range over the window ==`);
const rows = [...byKey.values()].filter((obs) => obs.length >= minObs).sort((a, b) => b.length - a.length);
for (const obs of rows) {
  const o = obs[0];
  const bids = obs.map((x) => x.bid);
  const sp = obs.map((x) => x.spot);
  const instrument = `${o.side.padEnd(4)} ${o.strike.toFixed(2).padStart(7)} ${new Date(o.expirySec * 1000).toISOString().slice(0, 10)}`;
  console.log(
    `  ${instrument}  n=${String(obs.length).padStart(3)}  bid ${Math.min(...bids).toFixed(3)}..${Math.max(...bids).toFixed(3)} USD (${pct(Math.max(...bids) / Math.min(...bids) - 1)} span)  spot ${Math.min(...sp).toFixed(2)}..${Math.max(...sp).toFixed(2)} (${pct(Math.max(...sp) / Math.min(...sp) - 1)})  makers ${new Set(obs.map((x) => x.maker)).size}`,
  );
}
