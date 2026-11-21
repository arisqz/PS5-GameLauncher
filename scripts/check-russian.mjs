// Zero-dependency checks for the Russian locale and the existing language API.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');
const localeSource = (code) => read(`renderer/js/locales/${code}.js`);
const parseLocale = (source) => JSON.parse(source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1));
const ru = parseLocale(localeSource('ru'));
const de = parseLocale(localeSource('de'));
const extraKeys = ['Scanning for games…', 'Scanning {name}…', 'Finding artwork…', 'Matching {name}…', 'Downloading artwork · {name}'];
const placeholders = (text) => [...text.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();

function loadI18n(systemLanguage = 'en-US') {
  const context = vm.createContext({
    de,
    es: parseLocale(localeSource('es')),
    fr: parseLocale(localeSource('fr')),
    pt: parseLocale(localeSource('pt')),
    ru,
    navigator: { language: systemLanguage },
    document: { documentElement: {} },
  });
  const source = read('renderer/js/i18n.js')
    .replace(/^import .+;\r?\n/gm, '')
    .replace(/^export /gm, '');
  vm.runInContext(`${source}\nglobalThis.api = { setLanguage, language, t, LANGUAGES };`, context);
  return context;
}

test('Russian locale covers every reference key with a nonempty string', () => {
  assert.deepEqual(Object.keys(ru).sort(), [...Object.keys(de), ...extraKeys].sort());
  for (const [key, value] of Object.entries(ru)) {
    assert.equal(typeof value, 'string', key);
    assert.ok(value.trim(), key);
    assert.ok(!value.includes('\uFFFD'), key);
  }
});

test('Russian dictionary has no duplicate keys or accidental template literals', () => {
  const source = localeSource('ru');
  const entries = [...source.matchAll(/^\s*"(?:[^"\\]|\\.)*"\s*:/gm)];
  assert.equal(entries.length, Object.keys(ru).length);
  assert.ok(!source.includes('${'));
});

test('all placeholder names and occurrence counts are preserved', () => {
  for (const [key, value] of Object.entries(ru)) {
    assert.deepEqual(placeholders(value), placeholders(key), key);
  }
});

test('intentional line breaks and external URLs are preserved', () => {
  const urls = (text) => text.match(/https?:\/\/[^\s]+/g) || [];
  for (const [key, value] of Object.entries(ru)) {
    assert.equal(value.split('\n').length, key.split('\n').length, key);
    assert.deepEqual(urls(value), urls(key), key);
  }
});

test('Russian is registered exactly once and can be selected explicitly', () => {
  const context = loadI18n();
  const { api } = context;
  assert.equal(api.LANGUAGES.filter((lang) => lang.value === 'ru').length, 1);
  assert.equal(api.LANGUAGES.find((lang) => lang.value === 'ru').label, 'Русский');
  api.setLanguage('ru');
  assert.equal(api.language(), 'ru');
  assert.equal(context.document.documentElement.lang, 'ru');
  assert.equal(api.t('Settings'), 'Настройки');
});

test('auto selects Russian on ru-RU Windows and unknown languages fall back to English', () => {
  const { api } = loadI18n('ru-RU');
  api.setLanguage('auto');
  assert.equal(api.language(), 'ru');
  api.setLanguage('unknown');
  assert.equal(api.language(), 'en');
  assert.equal(api.t('Settings'), 'Settings');
});

test('formatting, English fallback and null inputs retain their behavior', () => {
  const { api } = loadI18n();
  api.setLanguage('ru');
  assert.equal(api.t('Playing for {h} h {m} min', { h: 2, m: 15 }), 'В игре: 2 ч 15 мин');
  assert.equal(api.t('Couldn\'t download {name}', { name: 'The Alters' }), 'Не удалось скачать The Alters');
  assert.equal(api.t('{n} games', { n: 0 }), 'Игр: 0');
  assert.equal(api.t('Not a registered string: {n}', { n: 42 }), 'Not a registered string: 42');
  assert.equal(api.t('Playing for {m} min'), 'В игре: {m} мин');
  assert.equal(api.t(null), null);
  assert.equal(api.t(''), '');
  api.setLanguage('en');
  assert.equal(api.t('Settings'), 'Settings');
});

test('other languages remain selectable and use their existing dictionaries', () => {
  const { api } = loadI18n();
  for (const code of ['de', 'es', 'fr', 'pt']) {
    api.setLanguage(code);
    assert.equal(api.t('Settings'), parseLocale(localeSource(code)).Settings);
  }
});

test('welcome text and home tooltips call the translator', () => {
  assert.ok(read('renderer/js/views/boot.js').includes('text: t("Who\'s using this controller?")'));
  for (const key of ['Search', 'Settings', 'Profile']) {
    assert.ok(read('renderer/js/views/home.js').includes(`title: t('${key}')`));
  }
});

test('scan progress translates fixed and dynamic labels without changing names', () => {
  const { api } = loadI18n();
  api.setLanguage('ru');
  const context = vm.createContext({ t: api.t, document: { getElementById: () => null }, on: () => {} });
  const source = read('renderer/js/ui/toast.js').replace(/^import .+;\r?\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${source}\nglobalThis.label = scanProgressLabel;`, context);
  assert.equal(context.label('Scanning for games…'), 'Поиск игр…');
  assert.equal(context.label('Scanning Nintendo Switch games…'), 'Поиск игр Nintendo Switch…');
  assert.equal(context.label('Finding artwork…'), 'Поиск оформления…');
  assert.equal(context.label('Scanning Game Shortcuts…'), 'Поиск в Game Shortcuts…');
  assert.equal(context.label('Matching The Alters…'), 'Поиск соответствия: The Alters…');
  assert.equal(context.label('Downloading artwork · The Alters'), 'Загрузка оформления · The Alters');
  assert.equal(context.label('Downloading artwork · <b>{name}</b>'), 'Загрузка оформления · <b>{name}</b>');
  assert.equal(context.label('Unrecognized label'), 'Unrecognized label');
  assert.equal(context.label(), '');
  assert.ok(source.includes('.textContent = scanProgressLabel('));
  api.setLanguage('en');
  assert.equal(context.label('Matching The Alters…'), 'Matching The Alters…');
});
