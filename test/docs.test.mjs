import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ref = (n) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'references', n), 'utf8');

// Author CSS `display` on a <dialog> beats the UA rule `dialog:not([open]) { display: none }`,
// so a closed sheet would stay visible. Layout display must live on `.sheet[open]`.
test('mobile-modals CSS: no bare `.sheet` rule sets display', () => {
  const css = ref('mobile-modals.md');
  const rules = [...css.matchAll(/(?:^|[\n}])\s*(\.sheet[^{}\n]*?)\s*\{([^}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const bare = rules.filter((r) => r.sel === '.sheet' && /\bdisplay\s*:/.test(r.body));
  assert.deepEqual(bare, [], 'a bare .sheet rule must not set display');
  assert.ok(rules.some((r) => r.sel === '.sheet[open]' && /display:\s*flex/.test(r.body)), '.sheet[open] must carry the flex layout');
});

test('mobile-modals CSS: mobile sheet is lifted above the keyboard with --kb and tells the reader to test on a device', () => {
  const css = ref('mobile-modals.md');
  assert.match(css, /bottom:\s*var\(--kb,\s*0px\)/);
  assert.match(css, /real (iPhone|device)/i);
});
