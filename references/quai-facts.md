# Quai facts for DEX builders

Every line carries a source label. Labels:
- `docs.qu.ai` - read on docs.qu.ai (pages named inline)
- `qu.ai` / `dominant-strategies` - the official site and the dominant-strategies GitHub organisation (go-quai, quais.js)
- `observed in production` - behaviour seen shipping real Quai dapps; not in the docs, re-test when wallets update
- `UNVERIFIED` - not sourced here. Read it from chain or from the source before relying on it. Never hard-code it.

Confidence key for your own claims: verified by reading code or chain = high; from docs = medium; inferred = low and labelled.

## Networks
| Fact | Value | Source |
|---|---|---|
| Mainnet chainId | 9 | docs.qu.ai/build/networks |
| Orchard testnet chainId | 15000 | docs.qu.ai/build/networks |
| Mainnet RPC (Cyprus-1) | https://rpc.quai.network/cyprus1 | docs.qu.ai/build/networks |
| Orchard RPC (Cyprus-1) | https://orchard.rpc.quai.network/cyprus1 | docs.qu.ai/build/networks |
| Active zone | Cyprus-1 is the only active zone as of the docs read | docs.qu.ai/build/networks (re-check; this can change) |
| JS library | npm package `quais` (quais.js); wallets connect with `new quais.BrowserProvider(window.pelagus)` style injected providers | docs.qu.ai/build/apis/javascript-libraries |
| Block time | UNVERIFIED. Measure it from `woHeader.timestamp` deltas; do not hard-code a number in deadlines or UI copy |
| Gas price | UNVERIFIED as a constant. Read `quai_gasPrice` (or `getFeeData(zone)`) at quote time and again at send time |

## Addresses and zones
- The first 9 bits of an address identify the chain: 4 bits region, 4 bits zone, 1 bit ledger. `isQuaiAddress` and `isQiAddress` exist in the SDK. (docs.qu.ai/sdk/static/address)
- Cyprus-1 addresses start with `0x00`. (dominant-strategies; consistent with the bit layout above)
- Ledger bit: `0x00` followed by a byte `0x80` or higher is a Qi (UTXO) address, not a Quai (account) address. Sending QUAI to it appears to succeed, the balance stays 0 and contract calls from it fail with "missing revert data". Validate with `quais.isQuaiAddress` or `/^0x00[0-7][0-9a-f]{37}$/i`. (docs.qu.ai for the bit layout; the failure behaviour is observed in production)
- Checksum every address at the RPC boundary and before every wallet write with `quais.getAddress`. All-lowercase addresses are rejected by getCode, getBalance, getLogs and at signing ("invalid checksum"). Data from indexers and databases is often lowercase. (observed in production)
- A token must live in the same zone as the pool and the user. Treat any token address that is not `0x00...` as another zone and warn. (inferred from the zone prefix rule: low confidence on the exact UX consequence)

## Transactions and wallets
- Browser-wallet requests carry NO `chainId`. A Pelagus build (1.0.62) signed with gas price 0 when `chainId` was supplied and its fee type was not Auto, and the node answered "tx has incorrect or low gas price, have 0". Check the wallet chain yourself (`quai_chainId` = 9) right before the request. This applies to dapp-to-wallet requests only; a local signer (CLI, server) keeps `chainId` inside the signed transaction. (observed in production)
- The wallet only signs. Estimate gas on your own read provider, attach an explicit gas limit (estimate x 1.1 to 2.0; 1.3 is a sane default), send, then poll the receipt yourself. Do not let `accountsChanged` or `chainChanged` events hide the receipt of a transaction in flight. (observed in production)
- Raw provider sends (`quai_sendTransaction` built by hand) with no `gas` field make some wallets reserve their own large default and show a huge "preparation reserve". Always attach `gas` and the live `gasPrice`. (observed in production)
- Estimate WITHOUT `from` for plain value transfers when the payer may be unfunded: the node rejects an unfunded sender. For swaps, approvals and anything that depends on the sender's state, estimate WITH `from`; if the estimate fails, stop and diagnose before opening the wallet. Never send unchanged and let the wallet guess. (observed in production)
- `getFeeData` takes the zone: pass `quais.Zone.Cyprus1` (or `'0x00'`). A bare `provider.getFeeData()` throws "could not determine gasPrice". (observed in production with quais.js)
- Only receipt status 0 or 1 is final. quais `tx.wait()` throws `CALL_EXCEPTION` carrying the status-0 receipt for a revert; that is a final failure, not "unknown". A node refusal for fee, funds or gas means nothing was sent. Any other failure after the wallet was invoked is "status unknown": look the hash up before retrying. (observed in production)
- Block time is `block.woHeader.timestamp`; Quai blocks have no top-level `timestamp`. (observed in production with quais.js)
- Batched reads: keep `JsonRpcProvider` batches small (`batchMaxCount: 20` worked); a proxy that rejects an oversized batch answers with one id-less error and every call in the batch fails with "could not coalesce error". Use one shared read provider with fallback. (observed in production)

## What is NOT a Quai fact here
- Which DEXes, routers or aggregators exist, their addresses, fee tiers and ABIs: UNVERIFIED. Read them from the project's own deployment records or the contracts, and mark the adapter's confidence accordingly.
- Token symbols such as QAXE, HBOME or WQI are parsing hints in `scripts/intent.mjs`. Their addresses, decimals and zones come from the user's token list, never from this skill.
- Whether a wrapped native token exists, and its address: UNVERIFIED. Look it up on chain.

## Mock RPCs must tell the truth
Tests that mock the node must be checksum-strict (reject lowercase addresses), return a real non-zero gas price, put time at `woHeader.timestamp`, and surface a revert as `CALL_EXCEPTION` with a status-0 receipt. A permissive "return anything" mock hides outages that only appear on the real node. After any money-path change, run a read-only smoke against the live RPC. (observed in production)
