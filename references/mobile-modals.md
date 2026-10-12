# Mobile modals and bottom sheets

Use the native `<dialog>` element. It already gives top-layer rendering, an inert background, a built-in focus trap, Esc to close and `::backdrop`. Add only what it does not do.

## 1. Markup
```html
<dialog id="tokenSheet" class="sheet" aria-labelledby="tokenSheetTitle">
  <form method="dialog" class="sheet-head">
    <h2 id="tokenSheetTitle" tabindex="-1">Select a token</h2>
    <button value="cancel" aria-label="Close" class="icon-btn">x</button>
  </form>
  <div class="sheet-body"><!-- search + scrolling list --></div>
</dialog>
```
Open with `dialog.showModal()` (not `show()` and not the `open` attribute: those skip the modal behaviour). One modal at a time: close the current one before opening another, or stack nothing.

## 2. Bottom sheet at <= 640px, centred card above
```css
.sheet { border: 0; padding: 0; max-width: 480px; width: calc(100% - 32px); border-radius: 16px;
         max-height: min(80dvh, 720px); overflow: hidden; display: flex; flex-direction: column; }
.sheet::backdrop { background: rgb(0 0 0 / .55); }            /* plain colour, no blur */
@media (max-width: 640px) {
  .sheet { position: fixed; inset: auto 0 0 0; margin: 0; width: 100%; max-width: none;
           border-radius: 16px 16px 0 0; max-height: min(88dvh, calc(100dvh - var(--kb, 0px) - 16px));
           padding-bottom: env(safe-area-inset-bottom); }
}
.sheet-body { overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
```
- Use `dvh`, not `vh`: `100vh` includes the area behind mobile browser bars.
- `env(safe-area-inset-*)` only works if the page has `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`.
- Do not put `backdrop-filter` on anything that moves (the sheet, scrolling lists). It tanks scroll performance on mid-range phones. A flat translucent backdrop is fine.
- Give the sheet a visible title and, optionally, a 4px-tall drag handle that is decorative; closing must never depend on a swipe alone.

## 3. Close paths (all of them)
```js
function openSheet(dlg, opener) {
  dlg._opener = opener ?? document.activeElement;
  history.pushState({ sheet: dlg.id }, '');
  lockScroll(true);
  dlg.showModal();
  dlg.querySelector('h2')?.focus();           // not the search input: it would raise the keyboard
}
dlg.addEventListener('close', () => {
  lockScroll(false);
  if (history.state?.sheet === dlg.id) history.back();   // closed by button/Esc/backdrop: pop our entry
  dlg._opener?.focus?.();                                 // restore focus
});
window.addEventListener('popstate', () => { if (dlg.open) dlg.close(); });  // system Back closes the sheet
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('backdrop'); }); // click on ::backdrop targets the dialog
```
- Esc: native. Backdrop: a click whose target is the `<dialog>` itself landed outside the content box (give inner content its own padding wrapper so padding clicks do not count as backdrop). `closedby="any"` does this natively in newer browsers; keep the JS as the fallback.
- System Back: push one history entry on open, close on `popstate`. Guard so closing via a button does not leave a stale entry (the `close` handler above).
- Return focus to the element that opened the sheet. Native does this in most browsers; do it explicitly anyway.

## 4. Body scroll lock without layout jump
```css
html { scrollbar-gutter: stable; }
html.scroll-locked { overflow: hidden; }
```
```js
const lockScroll = (on) => document.documentElement.classList.toggle('scroll-locked', on);
```
`scrollbar-gutter: stable` reserves the scrollbar width so content does not shift on desktop. On iOS Safari, `overflow: hidden` on `html` is respected for modal dialogs in current versions; if you must support older ones, fix the body with `position: fixed; top: -scrollY` and restore `window.scrollTo` on close. Always give the scrolling child `overscroll-behavior: contain` so a scroll at the list end does not chain to the page.

## 5. On-screen keyboard
`dvh` does not shrink when the keyboard opens on every browser. Track the visual viewport:
```js
const vv = window.visualViewport;
function syncKb() {
  const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
  document.documentElement.style.setProperty('--kb', kb + 'px');
}
vv?.addEventListener('resize', syncKb); vv?.addEventListener('scroll', syncKb);
```
The sheet's `max-height` uses `--kb` (see CSS above), so the search field and the first results stay visible. When an input gets focus, call `input.scrollIntoView({ block: 'nearest' })` after the resize settles. Alternative: `interactive-widget=resizes-content` in the viewport meta where supported. Test with a real keyboard, not only devtools emulation.

## 6. Touch and motion
- Every control >= 44x44 CSS px, with at least 8px between targets. Primary action sits at the bottom within thumb reach.
- Inputs use `font-size: 16px` or larger, or iOS zooms the page on focus.
- Animate only `transform` and `opacity`, 150-250 ms. Wrap it: `@media (prefers-reduced-motion: reduce) { .sheet { animation: none; transition: none; } }`.
- Slide-in example: `@starting-style` plus `transition` on `[open]`, or a keyframe on `.sheet[open]`; keep the closed state reachable so `close` still fires.

## 7. Money-action modals
A swap confirmation sheet shows: amount in, expected out, minOut, route, fees, gas in QUAI, deadline, and a single clear primary button. Approvals are their own step with the exact amount. Pending and failed states are honest ("Waiting for wallet", "Submitted, waiting for confirmation", "Reverted: reason"); the sheet cannot be dismissed into a state where the user thinks nothing was sent while a transaction is in flight, so keep a visible pending indicator after close.

## 8. Test checklist
- 390x844 and 360px wide: no horizontal scroll, sheet touches the bottom edge, safe-area padding present, content scrolls inside the sheet only.
- Open, then each close path: button, Esc, backdrop tap, system Back, programmatic. After each: focus is back on the opener, page scroll position unchanged, history has no stale entry.
- Keyboard open: input and first rows visible. Landscape phone: sheet still fits (`max-height` in `dvh`).
- Reduced motion on: no animation. Screen reader: title announced, background inert.
- Open a second modal while one is open: only one is ever visible.
