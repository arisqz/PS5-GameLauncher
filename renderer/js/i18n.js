// Interface language. Strings are written in English in the code and looked
// up here by their English text; anything without a translation stays in
// English. {name}-style placeholders are filled from `vars`.

import de from './locales/de.js';
import es from './locales/es.js';
import fr from './locales/fr.js';
import pt from './locales/pt.js';

const TABLES = { de, es, fr, pt };

export const LANGUAGES = [
  { value: 'auto', label: 'System Language' },
  { value: 'en', label: 'English' },
  { value: 'de', label: 'Deutsch' },
  { value: 'es', label: 'Español' },
  { value: 'pt', label: 'Português' },
  { value: 'fr', label: 'Français' },
];

let table = null;
let lang = 'en';

/** Pick the language from the setting ('auto' follows Windows). */
export function setLanguage(value) {
  let code = value && value !== 'auto' ? value : (navigator.language || 'en').slice(0, 2).toLowerCase();
  if (code !== 'en' && !TABLES[code]) code = 'en';
  lang = code;
  table = TABLES[code] || null;
  document.documentElement.lang = code;
}

export function language() {
  return lang;
}

export function t(text, vars) {
  if (text == null || text === '') return text;
  let out = String(text);
  if (table) {
    const hit = table[out];
    if (hit) out = hit;
  }
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  return out;
}
