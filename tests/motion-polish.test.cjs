const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

test('modal close keeps the dialog mounted for its exit animation', () => {
  assert.match(app, /let modalCloseTimer=null;/);
  assert.match(app, /modalClosing=true;modalRoot\.classList\.add\('is-closing'\)/);
  assert.match(app, /setTimeout\(\(\)=>finishModalClose\(modalRoot\),closeDelay\)/);
  assert.match(app, /dialog\.setAttribute\('aria-hidden','true'\)/);
  assert.match(app, /if\(modalReturnFocus&&modalReturnFocus\.isConnected\)\{modalReturnFocus\.focus/);
  assert.match(css, /#modal-root \.modal\.is-closing\{animation:ui-dialog-out/);
});

test('reopening a dialog cancels a pending close and restores active modal state', () => {
  assert.match(app, /if\(modalCloseTimer\)\{clearTimeout\(modalCloseTimer\);modalCloseTimer=null;\}/);
  assert.match(app, /modalClosing=false;modalRoot\.classList\.remove\('is-closing'\)/);
});

test('mobile drawer uses the shared motion curve and scrim fade', () => {
  assert.match(css, /\.sidebar\{transition:transform 260ms var\(--motion-emphasis\)/);
  assert.match(css, /\.mobile-nav-backdrop\{transition:opacity 240ms ease,visibility 240ms ease\}/);
});

test('toast and image lightbox use matching exit transitions', () => {
  assert.match(app, /node\.classList\.add\('is-leaving'\)/);
  assert.match(app, /function closeMediaLightbox\(/);
  assert.match(css, /#toast-root>\.toast-message\.is-leaving\{animation:ui-toast-out/);
  assert.match(css, /#rich-media-lightbox\.is-closing\{animation:ui-lightbox-out/);
});

test('global motion honors reduced-motion preferences', () => {
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /#modal-root \.modal\.is-closing/);
  assert.match(css, /#rich-media-lightbox\.is-closing/);
});
