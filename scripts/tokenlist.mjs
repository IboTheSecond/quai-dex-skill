// Token list validation + search for Quai (Uniswap token-list shape). Zero dependencies.
//   node scripts/tokenlist.mjs validate <list.json>
//   node scripts/tokenlist.mjs search <list.json> <query> [limit]

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

export const QUAI_CHAIN_IDS = { 9: 'Quai mainnet', 15000: 'Orchard testnet' };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

/** Returns { valid, errors[], warnings[] }. Never throws on bad input. */
export function validateTokenList(list) {
  const errors = [];
  const warnings = [];
  const done = () => ({ valid: errors.length === 0, errors, warnings });

  if (!isObj(list)) {
    errors.push('list must be a JSON object');
    return done();
  }
  if (!isStr(list.name)) errors.push('name must be a non-empty string');

  const v = list.version;
  if (!isObj(v) || !['major', 'minor', 'patch'].every((k) => Number.isInteger(v[k]) && v[k] >= 0)) {
    errors.push('version must be { major, minor, patch } with non-negative integers');
  }
  if (!isStr(list.timestamp) || Number.isNaN(Date.parse(list.timestamp))) {
    errors.push('timestamp must be a parseable ISO 8601 date string');
  }
  if (!Array.isArray(list.tokens)) {
    errors.push('tokens must be an array');
    return done();
  }

  const seen = new Map();
  list.tokens.forEach((t, i) => {
    const where = `tokens[${i}]`;
    if (!isObj(t)) { errors.push(`${where} must be an object`); return; }
    const label = isStr(t.symbol) ? `${where} (${t.symbol})` : where;

    if (!(t.chainId in QUAI_CHAIN_IDS) || typeof t.chainId !== 'number') {
      errors.push(`${label}: chainId must be 9 (Quai mainnet) or 15000 (Orchard testnet), got ${JSON.stringify(t.chainId)}`);
    }
    if (!isStr(t.symbol)) errors.push(`${label}: symbol must be a non-empty string`);
    if (!isStr(t.name)) errors.push(`${label}: name must be a non-empty string`);
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 36) {
      errors.push(`${label}: decimals must be an integer 0..36, got ${JSON.stringify(t.decimals)}`);
    }

    if (typeof t.address !== 'string' || !ADDRESS_RE.test(t.address)) {
      errors.push(`${label}: address must be 0x followed by 40 hex characters`);
    } else {
      const lower = t.address.toLowerCase();
      const key = `${t.chainId}:${lower}`;
      if (seen.has(key)) errors.push(`${label}: duplicate address on chain ${t.chainId} (also tokens[${seen.get(key)}])`);
      else seen.set(key, i);
      if (!lower.startsWith('0x00')) {
        warnings.push(`${label}: address does not start with 0x00, so it is not in the Cyprus-1 zone; check the zone prefix`);
      } else if (parseInt(lower.slice(4, 6), 16) >= 0x80) {
        warnings.push(`${label}: address looks like a Qi (UTXO) address (0x00 then a byte >= 0x80); a token contract cannot live there`);
      }
    }

    if (t.logoURI !== undefined) {
      if (typeof t.logoURI !== 'string') errors.push(`${label}: logoURI must be a string when present`);
      else if (!/^(https:\/\/|ipfs:\/\/|data:image\/)/i.test(t.logoURI)) {
        warnings.push(`${label}: logoURI should be https://, ipfs:// or data:image/ (got "${t.logoURI.slice(0, 24)}")`);
      }
    }
  });
  return done();
}

function rank(token, q, qBare) {
  const sym = String(token.symbol || '').toLowerCase();
  const name = String(token.name || '').toLowerCase();
  const addr = String(token.address || '').toLowerCase();
  if (sym === q) return 0;
  if (sym.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (addr.startsWith(q) || addr.slice(2).startsWith(qBare)) return 3;
  return -1;
}

/**
 * Search a token list (or a bare tokens array).
 * Order: exact symbol, symbol prefix, name contains, address prefix; ties by shorter symbol then symbol.
 * Empty query returns every token in list order.  opts: { limit, chainId }.
 */
export function searchTokens(list, query, opts = {}) {
  const all = Array.isArray(list) ? list : list?.tokens;
  let tokens = Array.isArray(all) ? all : [];
  if (opts.chainId !== undefined) tokens = tokens.filter((t) => t.chainId === opts.chainId);
  const q = String(query ?? '').trim().toLowerCase();
  let out;
  if (!q) {
    out = tokens.slice();
  } else {
    const qBare = q.replace(/^0x/, '');
    out = tokens
      .map((t, i) => ({ t, i, r: rank(t, q, qBare) }))
      .filter((x) => x.r >= 0)
      .sort((a, b) =>
        a.r - b.r ||
        String(a.t.symbol).length - String(b.t.symbol).length ||
        String(a.t.symbol).localeCompare(String(b.t.symbol)) ||
        a.i - b.i)
      .map((x) => x.t);
  }
  return opts.limit ? out.slice(0, opts.limit) : out;
}

async function main(argv) {
  const [cmd, file, ...rest] = argv;
  if (!cmd || !file || (cmd === 'search' && rest.length === 0) || !['validate', 'search'].includes(cmd)) {
    console.error('usage: node scripts/tokenlist.mjs validate <list.json>\n       node scripts/tokenlist.mjs search <list.json> <query> [limit]');
    return 2;
  }
  const list = JSON.parse(await readFile(file, 'utf8'));
  if (cmd === 'validate') {
    const r = validateTokenList(list);
    console.log(JSON.stringify(r, null, 2));
    return r.valid ? 0 : 1;
  }
  const limit = rest[1] ? Number(rest[1]) : undefined;
  console.log(JSON.stringify(searchTokens(list, rest[0], { limit }), null, 2));
  return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then(
    (c) => { process.exitCode = c; },
    (e) => { console.error(e.message); process.exitCode = 2; },
  );
}
