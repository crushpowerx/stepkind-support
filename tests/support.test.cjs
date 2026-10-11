const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../docs/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function createPage({ url = 'https://example.com/', languages = ['uk-UA'], clipboard } = {}) {
  const localized = [...html.matchAll(/data-language="(uk|en)"/g)].map((match) => ({ dataset: { language: match[1] }, hidden: false }));
  const links = ['uk', 'en'].map((language) => ({
    dataset: { switchLanguage: language }, attributes: {}, listeners: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
  }));
  const status = { textContent: '', hidden: true };
  const copy = { listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; } };
  const meta = {};
  const document = {
    documentElement: {}, title: '',
    querySelector() { return meta; },
    querySelectorAll(selector) { return selector === '[data-language]' ? localized : links; },
    getElementById(id) { return id === 'copy-status' ? status : copy; },
  };
  const timers = new Map();
  const window = {
    location: { href: url, search: new URL(url).search },
    history: { replaceState(_state, _title, next) { window.location.href = String(next); } },
  };
  const navigator = { languages, clipboard: clipboard || { async writeText() {} } };
  const context = vm.createContext({
    document, window, navigator, URL, URLSearchParams,
    setTimeout(callback) { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(script, context);
  return { document, localized, links, meta, status, copy, timers, window };
}

test('HTML has complete translations and unique IDs including the existing privacy anchor', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('privacy'));
  assert.equal([...html.matchAll(/data-language="uk"/g)].length, 4);
  assert.equal([...html.matchAll(/data-language="en"/g)].length, 4);
  assert.match(html, /<h2>Privacy Policy<\/h2>/);
  assert.match(html, /<h2>Quick help<\/h2>/);
});

test('browser preference selects English and updates accessibility and metadata', () => {
  const page = createPage({ languages: ['en-US', 'uk-UA'] });
  assert.equal(page.document.documentElement.lang, 'en');
  assert.equal(page.document.title, 'StepKind — Support');
  assert.match(page.meta.content, /Support and privacy/);
  assert.equal(page.links[1].attributes['aria-current'], 'page');
  assert.ok(page.localized.every((element) => element.hidden === (element.dataset.language !== 'en')));
});

test('explicit language overrides browser preference; unsupported locales fall back safely', () => {
  assert.equal(createPage({ url: 'https://example.com/?lang=uk', languages: ['en-US'] }).document.documentElement.lang, 'uk');
  assert.equal(createPage({ url: 'https://example.com/?lang=en', languages: ['uk-UA'] }).document.documentElement.lang, 'en');
  assert.equal(createPage({ url: 'https://example.com/?lang=invalid', languages: ['fr-FR'] }).document.documentElement.lang, 'uk');
  assert.equal(createPage({ languages: ['fr-FR', 'en-GB'] }).document.documentElement.lang, 'en');
});

test('switching languages preserves privacy anchor and other query parameters', () => {
  const page = createPage({ url: 'https://example.com/?source=store#privacy' });
  let prevented = false;
  page.links[1].listeners.click({ button: 0, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(page.document.documentElement.lang, 'en');
  const url = new URL(page.window.location.href);
  assert.equal(url.hash, '#privacy');
  assert.equal(url.searchParams.get('source'), 'store');
  assert.equal(url.searchParams.get('lang'), 'en');
  assert.equal(page.links[0].attributes['aria-current'], undefined);
});

test('modified clicks retain normal link behavior', () => {
  const page = createPage();
  page.links[1].listeners.click({ button: 0, ctrlKey: true, preventDefault() { assert.fail('Modified click must not be intercepted'); } });
  assert.equal(page.document.documentElement.lang, 'uk');
});

test('copy success is localized and reset when switching language', async () => {
  let copied;
  const page = createPage({ languages: ['en-US'], clipboard: { async writeText(value) { copied = value; } } });
  await page.copy.listeners.click();
  assert.equal(copied, 'app.step.kind@gmail.com');
  assert.equal(page.status.textContent, 'Email address copied');
  assert.equal(page.status.hidden, false);
  page.links[0].listeners.click({ button: 0, preventDefault() {} });
  assert.equal(page.status.hidden, true);
  assert.equal(page.timers.size, 0);
});

test('clipboard failure and missing Clipboard API show an actionable message', async () => {
  for (const clipboard of [{ async writeText() { throw new Error('Denied'); } }, {}]) {
    const page = createPage({ languages: ['en-US'], clipboard });
    await page.copy.listeners.click();
    assert.equal(page.status.hidden, false);
    assert.match(page.status.textContent, /Copy it manually/);
  }
});
