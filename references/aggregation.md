# DEX aggregation method

Goal: given tokenIn, tokenOut and amountIn, return the route that leaves the user with the most tokenOut after fees and gas, safely. `scripts/route.mjs` holds the pure math; this file is the method around it.

## 1. Venue adapter interface
One small adapter per venue (AMM pool, router, order book). Keep them dumb and uniform.

```js
// adapter.quote must be read-only (eth_call / static call), never send anything.
{
  id: 'venue-name',
  supports(tokenIn, tokenOut): boolean,
  async quote({ tokenIn, tokenOut, amountIn /* BigInt */, blockTag }) {
    return { venue, amountOut /* BigInt */, gasUnits /* BigInt */, hops, path, feeOn: 'input'|'output', quotedAtBlock, calldata? };
  },
}
```
- Everything is BigInt base units. Convert decimals only at the UI edge.
- Checksum every address (`quais.getAddress`) before it reaches the node. See quai-facts.md.
- An adapter that cannot quote throws or returns `null`; the aggregator records why and moves on. One dead venue must never fail the whole quote.
- Mark each adapter's trust: `verified` (you read its contract), `documented`, or `inferred`. Show that confidence next to the route.

## 2. Quote normalisation
- Always quote the exact same amountIn on the same block for every venue (`blockTag`), otherwise you are comparing different moments.
- Fees: decide per venue whether the fee is taken from the input (reduces what trades) or from the output (reduces what you receive). `amountOut` handed to `bestRoute` must already be what the user receives. Never add or subtract a fee twice.
- Protocol or aggregator fee, if any, comes off at the end and is shown to the user as its own line.
- Reject `amountOut <= 0`, non-integer values and quotes that revert. `bestRoute` records them in `skipped` with a reason.

## 3. Gas is an output-token cost
Compare routes on net output, not gross:
`net = amountOut - gasUnits * gasPriceWei * gasValueInOut / 1e18`
- `gasPriceWei`: read from the node at quote time (`getFeeData(zone)`); re-read before sending.
- `gasValueInOut`: output-token base units that equal 1 native token. Get it from a price source or from a quote of native -> tokenOut. If you cannot price gas, say so, rank on gross output, and label the result low confidence.
- Multi-hop routes usually cost more gas. A route that wins gross can lose net. Ties are broken by fewer hops, then less gas, then venue name, so results are deterministic.

## 4. Splitting across venues
Only split when it pays. `evaluateSplit(quoteA, quoteB, amountIn, steps, extraGas)`:
- grid-searches `steps` splits, compares to the best single venue, subtracts `extraGas` (extra gas of the second venue, already in output units);
- returns `null` unless net gain is strictly positive.
- Small trades almost never benefit. Constant-product pools make price impact grow with size, so a split helps most when the trade is a large share of the pool and two comparable pools exist.
- More than two venues: split greedily in chunks (send each chunk to the venue with the best marginal output) and still subtract the extra gas per added venue.
- A split is two transactions or one router call with two legs. If it is two transactions, the second can fail after the first lands: prefer one atomic router call, or do not split.

## 5. Slippage, minOut, deadline
- `minOut = floor(amountOut * (10000 - slippageBps) / 10000)`, BigInt only (`minOut()`).
- Default slippage 50 bps unless the user says otherwise; warn above 1000 bps, ask at 5000 bps (50%) or more and refuse without an explicit second confirmation.
- Deadline: now + a short window (default 10 min). Use chain time (`woHeader.timestamp`) when you can, not the device clock.
- For exact-out requests (the user wants N of tokenOut) quote exact-out or iterate exact-in; show the maximum input as the bound.

## 6. Before anything is sent
1. Re-quote the chosen route on the latest block. If the new `amountOut` is worse than the shown one by more than the slippage allowance, show the new numbers and ask again.
2. Simulate with `eth_call` (state-dependent, with `from`) and `estimateGas`. If either fails: stop and diagnose. Never send "and let the wallet estimate".
3. Attach an explicit gas limit (estimate x 1.1 to 2.0). See quai-facts.md for wallet request rules (no `chainId`).
4. Show the confirmation card: amount in, expected out, minOut, route, fees, gas in QUAI, deadline. Wait for an explicit user confirm. Never auto-send, never batch several sends behind one confirm.
5. Poll the receipt yourself. Status 1 = done, status 0 = reverted (final), anything else = unknown, look up the hash before retrying.

## 7. Approvals
- Approve the exact amount needed (or a small multiple), as its own visible step. Avoid unlimited approvals by default.
- Read the current allowance first; skip the approval when it already covers the amount.
- Native-token input needs no approval. Wrapped tokens need wrap/unwrap handled explicitly and shown as a step.
- Some tokens require resetting an allowance to 0 before changing it. Detect revert on approve and handle it, do not assume.

## 8. MEV and stale quotes
- A public mempool swap can be sandwiched. The defences are tight `minOut`, short deadlines, avoiding huge slippage, and splitting very large orders. Say plainly that slippage tolerance is also the maximum an attacker can take. (general DeFi knowledge, medium confidence; Quai-specific mempool behaviour is UNVERIFIED)
- Quotes go stale quickly. Stamp each quote with its block; expire it in the UI after a few seconds; refetch on confirm.
- Fee-on-transfer and rebasing tokens break exact quotes. Detect (balance delta after a tiny test or known list) or exclude.

## 9. Failure modes checklist
| Symptom | Likely cause | Action |
|---|---|---|
| Quote works, send reverts | stale quote, allowance, deadline, fee-on-transfer token | re-quote, check allowance, simulate with `from` |
| "invalid checksum" | lowercase address from an indexer | `quais.getAddress` at the boundary |
| "could not determine gasPrice" | bare `getFeeData()` | pass the zone |
| Wallet shows huge fee reserve | tx sent with no `gas` | attach explicit gas + gasPrice |
| Wallet signs at gas price 0 | `chainId` passed in the wallet request | remove `chainId` |
| Balance never arrives | Qi-shaped (0x00 + byte >= 0x80) address | validate with `isQuaiAddress` |
| All venues fail at once | RPC batch too large or rate limited | smaller batches, shared provider, backoff |
| Best route flips between refreshes | gas price or pool state moving | quote same block, hysteresis in the UI |

## 10. Tests that matter
- Pure math: best vs gross-best, ties, split worth it vs not, `minOut` exactness at BigInt scale (see test/route.test.mjs).
- Adapters against a Quai-shaped mock (checksum-strict, real gas price, revert as `CALL_EXCEPTION`), then a read-only live smoke.
- A dry run (simulate, never send) as the last step of every change.
