/**
 * Minimal parser for Valve's text KeyValues (VDF/ACF) format.
 */
function parseVdf(text) {
  let i = 0;
  const len = text.length;

  function skipWs() {
    while (i < len) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') i++;
      else if (c === '/' && text[i + 1] === '/') {
        while (i < len && text[i] !== '\n') i++;
      } else break;
    }
  }

  function readString() {
    if (text[i] === '"') {
      i++;
      let s = '';
      while (i < len && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < len) {
          const n = text[i + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          i += 2;
        } else s += text[i++];
      }
      i++;
      return s;
    }
    let s = '';
    while (i < len && !/[\s{}"]/.test(text[i])) s += text[i++];
    return s;
  }

  function skipConditional() {
    skipWs();
    if (text[i] === '[') {
      while (i < len && text[i] !== ']') i++;
      i++;
    }
  }

  function readObject() {
    const obj = {};
    while (true) {
      skipWs();
      if (i >= len) break;
      if (text[i] === '}') { i++; break; }
      const key = readString();
      skipWs();
      if (text[i] === '{') {
        i++;
        obj[key] = readObject();
      } else {
        obj[key] = readString();
        skipConditional();
      }
    }
    return obj;
  }

  return readObject();
}

/** Case-insensitive nested lookup: getCI(obj, 'AppState', 'name') */
function getCI(obj, ...keys) {
  let cur = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== 'object') return undefined;
    const lower = key.toLowerCase();
    const found = Object.keys(cur).find((k) => k.toLowerCase() === lower);
    if (found === undefined) return undefined;
    cur = cur[found];
  }
  return cur;
}

module.exports = { parseVdf, getCI };
