import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRecentsDrawer } from '../assets/conversation-history.js';

function fixture() {
  const doc = { listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; } };
  function element(parent) {
    return { parent, isConnected: true, hidden: false, inert: false, disabled: false, attributes: {}, listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; },
      closest() { return this.hidden || this.inert ? this : this.parent?.closest(); },
      getClientRects() { return this.visible === false ? [] : [{}]; },
      contains(node) { return node === this || Boolean(node?.parent && this.contains(node.parent)); },
      focus() { doc.activeElement = this; doc.listeners.focusin?.({ target: this }); },
      click() { this.listeners.click?.({ target: this }); }
    };
  }
  doc.body = element();
  const background = element(), opener = element(background), fallback = element(background);
  const conversationView = element(background);
  const drawer = element(), closeButton = element(drawer), first = element(drawer), last = element(drawer);
  drawer.hidden = true;
  drawer.querySelectorAll = () => [closeButton, first, last].filter(node => node.isConnected);
  const controller = createRecentsDrawer({ drawer, opener, closeButton, fallback, conversationView, background, documentRef: doc });
  function key(key, shiftKey = false) {
    const event = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; } };
    doc.listeners.keydown(event);
    return event;
  }
  opener.focus();
  return { doc, drawer, opener, fallback, conversationView, background, closeButton, first, last, controller, key };
}

test('opening focuses Close and makes the background inert; Tab wraps in both directions', () => {
  const f = fixture(); f.opener.click();
  assert.equal(f.doc.activeElement, f.closeButton);
  assert.equal(f.background.inert, true);
  assert.equal(f.opener.attributes['aria-expanded'], 'true');
  assert.equal(f.key('Tab').prevented, false); // Native Tab visits the next button.
  f.first.focus(); assert.equal(f.key('Tab').prevented, false);
  f.last.focus(); assert.equal(f.key('Tab').prevented, true);
  assert.equal(f.doc.activeElement, f.closeButton);
  f.key('Tab', true); assert.equal(f.doc.activeElement, f.last);
  f.fallback.focus(); assert.equal(f.doc.activeElement, f.closeButton);
  assert.equal(f.key('Enter').prevented, false);
  assert.equal(f.key(' ').prevented, false); // Native button activation is preserved.
});

for (const method of ['escape', 'button', 'backdrop']) test(`${method} restores opener focus and releases the modal`, () => {
  const f = fixture(); f.opener.click();
  if (method === 'escape') f.key('Escape');
  if (method === 'button') f.closeButton.click();
  if (method === 'backdrop') f.drawer.click();
  assert.equal(f.drawer.hidden, true);
  assert.equal(f.background.inert, false);
  assert.equal(f.doc.activeElement, f.opener);
  assert.equal(f.opener.attributes['aria-expanded'], 'false');
  assert.equal(f.key('Tab').prevented, false);
});

for (const unavailable of ['removed', 'hidden', 'disabled']) test(`dismissal falls back to the composer when opener is ${unavailable}`, () => {
  const f = fixture(); f.opener.click();
  if (unavailable === 'removed') f.opener.isConnected = false;
  if (unavailable === 'hidden') f.opener.visible = false;
  if (unavailable === 'disabled') f.opener.disabled = true;
  f.key('Escape'); assert.equal(f.doc.activeElement, f.fallback);
});

test('list replacement keeps focus stable; empty and failed lists still allow dismissal', () => {
  const f = fixture(); f.opener.click(); f.first.focus();
  f.controller.beforeListUpdate(); f.first.isConnected = false; f.last.isConnected = false;
  assert.equal(f.doc.activeElement, f.closeButton);
  for (const shift of [false, true]) {
    assert.equal(f.key('Tab', shift).prevented, true);
    assert.equal(f.doc.activeElement, f.closeButton);
  }
  f.key('Escape'); assert.equal(f.doc.activeElement, f.opener);
});

const consoleSource = await readFile('assets/console.js', 'utf8');
for (const fails of [false, true]) test(`Console selection ${fails ? 'failure keeps drawer usable' : 'renders history and focuses composer before refresh resolves'}`, async () => {
  const f = fixture(); f.opener.click(); f.first.focus();
  const rendered = []; let resolveRefresh;
  const refresh = new Promise(resolve => { resolveRefresh = resolve; });
  let reachedRefresh; const refreshing = new Promise(resolve => { reachedRefresh = resolve; });
  const context = vm.createContext({
    stopVoiceActivity() {}, renderRecentsState() { f.controller.beforeListUpdate(); },
    requestError: { hidden: true }, conversationHistory: { async select(id) {
      assert.equal(id, 'saved-chat'); if (fails) throw new Error('Unavailable');
      return [{ role: 'user', content: 'Saved message' }];
    } }, clearConversation() {}, addMessage(message) { rendered.push(message); },
    restoreLiveActivities() {}, welcome: {}, recentsDialog: f.controller, input: f.fallback,
    refreshRecents: () => { reachedRefresh(); return refresh; }
  });
  const source = consoleSource.slice(consoleSource.indexOf('async function selectConversation('), consoleSource.indexOf('\nfunction addMessage('));
  vm.runInContext(source, context);
  const selection = context.selectConversation('saved-chat');
  await refreshing;
  assert.equal(f.drawer.hidden, !fails);
  assert.equal(f.doc.activeElement, fails ? f.closeButton : f.fallback);
  if (!fails) assert.deepEqual(rendered.map(x => x.text), ['Saved message']);
  else assert.equal(context.requestError.textContent, 'Unavailable');
  resolveRefresh(); await selection;
  assert.equal(f.doc.activeElement, fails ? f.closeButton : f.fallback);
});

test('Console retains native buttons, dialog naming, current entry state, and update hooks', async () => {
  const html = await readFile('index.html', 'utf8');
  assert.match(html, /id="historyButton"[^>]*aria-haspopup="dialog"[^>]*aria-controls="recentsDrawer"[^>]*aria-expanded="false"/);
  assert.match(html, /id="recentsDrawer" role="dialog" aria-modal="true" aria-labelledby="mobileRecentsHeading" hidden/);
  assert.match(html, /id="mobileRecentsHeading">Recent conversations/);
  assert.match(html, /id="closeRecentsButton" aria-label="Close recent conversations"/);
  assert.match(consoleSource, /createElement\("button"\); button.type = "button"/);
  assert.match(consoleSource, /button.setAttribute\("aria-current", "true"\)/);
  assert.match(consoleSource, /function renderRecents\(conversations\) \{\s+recentsDialog.beforeListUpdate\(\)/);
  assert.match(consoleSource, /function renderRecentsState\([^]*?recentsDialog.beforeListUpdate\(\)/);
  assert.match(consoleSource, /if \(button\) selectConversation\(button.dataset.conversationId\)/);
});

test('pointer opening restores the trigger even if the browser left focus on the composer', () => {
  const f = fixture(); f.fallback.focus(); f.opener.click(); f.key('Escape');
  assert.equal(f.doc.activeElement, f.opener);
});

 test('a disabled composer falls back to the conversation view after selection', () => {
  const f = fixture(); f.opener.click(); f.fallback.disabled = true;
  f.controller.close({ selected: true });
  assert.equal(f.doc.activeElement, f.conversationView);
});
