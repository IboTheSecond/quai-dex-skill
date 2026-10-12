# Mobile token list and token picker

Use `scripts/tokenlist.mjs` to validate a list before the UI sees it and to rank search results (`searchTokens`).

## 1. Schema (Uniswap token-list shape)
```json
{ "name": "...", "timestamp": "ISO-8601", "version": {"major":1,"minor":0,"patch":0},
  "tokens": [{ "chainId": 9, "address": "0x00...", "symbol": "...", "name": "...", "decimals": 18, "logoURI": "https://..." }] }
```
Rules enforced by `validateTokenList`:
- `chainId` 9 (Quai mainnet) or 15000 (Orchard testnet); one list may hold both, filter by the connected chain.
- `address` is `0x` + 40 hex and unique per chain (compare lowercase). Checksum it with `quais.getAddress` before any RPC call or wallet request.
- Cyprus-1 tokens start with `0x00`; other prefixes are warned (other zone). `0x00` followed by a byte >= `0x80` is Qi-shaped and cannot be a token contract.
- `decimals` integer 0..36. `logoURI` optional; https, ipfs or data:image only.
- Never trust a list blindly: show the full address (shortened with the middle visible on tap) for any token the user imports, and require an explicit confirm for unlisted tokens.

## 2. Row design (phone)
- One row = logo 40px, symbol (strong) + name (muted, one line, ellipsis), balance right-aligned with tabular numerals. Row height 56-64px; the whole row is the tap target (>= 44px).
- Zone badge: show a small neutral badge when the address prefix is not `0x00`. Do not hide such tokens, mark them.
- Never show a broken-image icon. Logos are lazy (`loading="lazy"`, `decoding="async"`, fixed `width`/`height`) with a fallback of two-letter initials in the same wrapper, same size, so every row is identical in height.
- Disabled rows (same token as the other side, wrong chain) stay visible but dimmed with a reason in text, not colour alone.

## 3. Long lists
- Up to a few hundred rows: render all with `content-visibility: auto; contain-intrinsic-size: auto 60px;` on each row. The browser skips layout and paint of off-screen rows.
- Thousands of rows: window the list (render visible rows +/- a buffer inside a container with a spacer of `rows * rowHeight`). Keep row height fixed so the math is exact.
- Make the scroller the dialog body (`overflow-y: auto; overscroll-behavior: contain`), not the page.
- Search filters the in-memory array with `searchTokens` (exact symbol, symbol prefix, name contains, address prefix). Debounce about 100 ms, but render the first results synchronously. Keep the result count in an `aria-live="polite"` region.
- A pasted valid address that is not in the list: show an "Import token" row that reads `symbol`, `decimals` and `name` from chain (read-only calls) with a clear warning.

## 4. Pinned and recent
- Pin the native token and the user's 4-6 most used tokens in a chip row above the list (horizontal scroll, chips >= 44px tall).
- Recents: store addresses only, in `localStorage` wrapped in try/catch (private windows can throw); the UI must work with it empty.

## 5. Balances
- Fetch lazily for visible rows only (IntersectionObserver or the window range), batched in small groups (keep RPC batches at 20 or fewer calls), one shared provider.
- Show a skeleton or a dash while loading, never `0` before the real value arrives. Cache per account+chain for a short time; refresh after a transaction.
- Sort order: pinned, then tokens with a balance (desc by value if priced, else alphabetical), then the rest. Re-sort only when the user is not scrolling.

## 6. Loading and caching the list
- Fetch with `If-None-Match` using the stored ETag; a 304 keeps the cached copy. Store `{etag, list, fetchedAt}` in `localStorage` or IndexedDB inside try/catch.
- Stale-while-revalidate: render the cached list immediately, refresh in the background, swap in only if `version` or `timestamp` changed.
- Validate after every fetch. If the new list fails validation, keep the old one and report the reason.
- Show real states: loading (skeleton rows), empty search ("No token matches 'xyz'. Paste a contract address to import."), error with retry.

## 7. Accessibility
- Search input has a label, `type="search"`, `enterkeyhint="search"`, `autocomplete="off"`, `autocapitalize="off"`, `spellcheck="false"`.
- The list is a `ul` of `button`s (or a `listbox` with proper roles if you implement arrow-key navigation). Selected state exposed with `aria-current` or `aria-selected`.
- Do not autofocus the search field on phones: the keyboard will cover half the list. Focus the dialog title; let the user tap search.

## 8. Test checklist
Run the picker at 390x844 and 360px wide: no horizontal scroll, search visible with the keyboard open, rows 44px or more, logos fallback when the image 404s, empty/error states readable, 5,000-token list scrolls smoothly.
