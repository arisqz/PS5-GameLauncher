//! Tiny JSON-file store (port of main/store.js): top-level keys saved in the
//! file override the defaults, and writes are atomic (temp file + rename).

use serde_json::Value;
use std::{fs, path::PathBuf};

pub struct JsonStore {
    file: PathBuf,
    pub data: Value,
}

impl JsonStore {
    pub fn load(file: PathBuf, defaults: Value) -> Self {
        let mut data = defaults;
        let saved = fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')).ok());
        if let (Value::Object(map), Some(Value::Object(saved))) = (&mut data, saved) {
            for (k, v) in saved {
                map.insert(k, v);
            }
        }
        Self { file, data }
    }

    /// Shallow merge, like Object.assign(store.data, patch).
    pub fn merge(&mut self, patch: &Value) {
        if let (Value::Object(map), Value::Object(patch)) = (&mut self.data, patch) {
            for (k, v) in patch {
                map.insert(k.clone(), v.clone());
            }
        }
    }

    pub fn save(&self) -> Result<(), String> {
        if let Some(dir) = self.file.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.file.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&self.data).map_err(|e| e.to_string())?;
        fs::write(&tmp, text).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.file).map_err(|e| e.to_string())
    }
}
