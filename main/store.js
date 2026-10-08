const fs = require('fs');
const path = require('path');

/**
 * Tiny JSON-file store with debounced, atomic writes.
 */
class JsonStore {
  constructor(file, defaults) {
    this.file = file;
    this.defaults = defaults;
    this.timer = null;
    this.data = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      return { ...structuredClone(this.defaults), ...parsed };
    } catch {
      return structuredClone(this.defaults);
    }
  }

  saveSoon(delay = 400) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), delay);
  }

  saveNow() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[store] failed to save', this.file, err);
    }
  }
}

module.exports = { JsonStore };
