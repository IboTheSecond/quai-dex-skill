---
name: quai-dex-builder
description: "Use when building a DEX aggregator, swap routing, a token list or token picker, or a mobile modal or bottom sheet on Quai Network, or when a user asks to swap, quote or route tokens in plain words."
---

# Quai DEX builder

Three jobs: DEX aggregation, mobile token lists, mobile modals. Plus a parser that reads plain-language swap requests, scores its own confidence and learns from corrections. Scripts are zero-dependency Node 20+. Paths below are relative to this folder.

## 1. Read the request (confidence first)
1. Run `node scripts/intent.mjs parse "<user text>"` (or apply the same rules by hand). Every field has a confidence 0..1; `confidence.overall` is the minimum.
2. Thresholds: `>= 0.85` act. `0.60 to 0.85` act and state each item in `assumptions` in one line. `< 0.60` ask exactly the one `question` it returns, nothing else.
3. Several requests in one sentence come back in `intents`: handle them one at a time, confirm each.
4. Rate your own technical claims: verified by reading code or chain = high; from docs = medium (cite the page); inferred = low and labelled "(inferred)". Details: `references/confidence-and-learning.md`.

## 2. Learn
1. At the start, read `.quai-dex/learned.json` and `LEARNINGS.md` in the user's project (both optional).
2. When the user corrects you, record it at once: `node scripts/intent.mjs learn <phrase> <meaning>` and add a one-line dated entry to `LEARNINGS.md`.
3. Meaning is a token symbol, a `0x` address, an action (`swap|buy|sell|quote|route`) or `bps:N`. `forget <phrase>` undoes it.
4. Never repeat a corrected mistake: check learned data before parsing again.

## 3. Aggregation method (`references/aggregation.md`)
1. Venue adapters, one per venue, read-only quotes, BigInt base units, same block for all.
2. Quote every venue, then rank by net output: amountOut minus gas valued in the output token (`bestRoute`).
3. Split across two venues only when `evaluateSplit` shows a gain after the extra gas; otherwise single route.
4. `minOut` from slippage with BigInt (`minOut`); default 50 bps, warn above 10%; short deadline.
5. Re-quote on the latest block, then simulate (`eth_call` with `from`, `estimateGas`). A failed simulation stops the flow.
6. Show amount in, expected out, minOut, route, fees, gas, deadline. Never send without an explicit user confirm. Approve exact amounts as their own step.

## 4. Quai specifics (`references/quai-facts.md`, every fact has a source label)
1. Mainnet chainId 9, Orchard 15000, zone Cyprus-1, addresses start `0x00`; `0x00` + byte >= `0x80` is Qi, not Quai.
2. Checksum every address with `quais.getAddress`; pass the zone to `getFeeData`; block time is `woHeader.timestamp`.
3. Browser-wallet requests carry no `chainId`; always attach an explicit gas limit; the wallet only signs.
4. Anything marked UNVERIFIED (block time, gas price, DEX addresses, token addresses) is read from chain or the user's lists, never hard-coded.

## 5. Mobile token list and modals
1. Token picker: `references/token-lists.md`. Validate with `node scripts/tokenlist.mjs validate <list.json>`; rank search with `searchTokens`.
2. Rows 44px+, lazy logos with initials fallback, `content-visibility` or windowing, balances for visible rows only, no autofocus on search.
3. Modal: `references/mobile-modals.md`. Native `<dialog>` + `showModal()`, bottom sheet at `<= 640px`, Esc, backdrop and system Back all close it, focus restored, scroll locked without layout jump, `visualViewport` for the keyboard, safe-area insets, reduced motion, no `backdrop-filter` on moving content, one modal at a time.

## 6. Verify before saying done
1. Run the project's tests and `npm test` here if you changed these scripts; read the exit code, not a grep.
2. Look at the UI at 390x844 and 360px wide: no horizontal scroll, keyboard open, every close path.
3. Dry run (simulate, do not send) before any real transaction. Report what was verified vs inferred.

## Rationalizations
| Excuse | Reality |
|---|---|
| "The quote looked fine so I skipped simulation" | Quotes go stale and state-dependent calls revert. Simulate with `from`. |
| "Confidence is high, no need to state the assumption" | Below 0.85 the user must see each assumption. |
| "One more guess is cheaper than a question" | Below 0.60 ask the one question. |
| "Max slippage will make it go through" | Slippage is also the most a sandwich can take. |
| "Gas is small, compare gross output" | Multi-hop gas can flip the winner. Compare net. |
| "The user already said swap, confirm is redundant" | A parse is not consent. Show the card, wait for yes. |
| "Block time is about N seconds" | UNVERIFIED. Measure it. |
| "It works in the emulator" | Test a real phone width and a real keyboard. |

## Red flags (stop)
- Sending with no simulation, no gas limit, or `chainId` in a wallet request.
- A lowercase address reaching the RPC; a Qi-shaped address accepted.
- Hard-coded gas price, block time, token address or venue address.
- Asking two questions, or none when `overall < 0.60`.
- Repeating something the user already corrected.
- Modal that cannot be closed by system Back or Esc; `100vh` sheets; unlimited approvals by default.
