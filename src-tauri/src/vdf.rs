//! Minimal parser for Valve's text KeyValues (VDF/ACF) format (port of main/vdf.js).

use serde_json::{Map, Value};

struct Parser {
    s: Vec<char>,
    i: usize,
}

impl Parser {
    fn peek(&self, off: usize) -> Option<char> {
        self.s.get(self.i + off).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(c) = self.peek(0) {
            if matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{feff}') {
                self.i += 1;
            } else if c == '/' && self.peek(1) == Some('/') {
                while self.peek(0).is_some_and(|c| c != '\n') {
                    self.i += 1;
                }
            } else {
                break;
            }
        }
    }

    fn read_string(&mut self) -> String {
        let mut out = String::new();
        if self.peek(0) == Some('"') {
            self.i += 1;
            while let Some(c) = self.peek(0) {
                if c == '"' {
                    break;
                }
                if c == '\\' && self.peek(1).is_some() {
                    let n = self.peek(1).unwrap();
                    out.push(match n {
                        'n' => '\n',
                        't' => '\t',
                        other => other,
                    });
                    self.i += 2;
                } else {
                    out.push(c);
                    self.i += 1;
                }
            }
            self.i += 1;
            return out;
        }
        while let Some(c) = self.peek(0) {
            if c.is_whitespace() || matches!(c, '{' | '}' | '"') {
                break;
            }
            out.push(c);
            self.i += 1;
        }
        out
    }

    fn skip_conditional(&mut self) {
        self.skip_ws();
        if self.peek(0) == Some('[') {
            while self.peek(0).is_some_and(|c| c != ']') {
                self.i += 1;
            }
            self.i += 1;
        }
    }

    fn read_object(&mut self) -> Value {
        let mut obj = Map::new();
        loop {
            self.skip_ws();
            match self.peek(0) {
                None => break,
                Some('}') => {
                    self.i += 1;
                    break;
                }
                _ => {}
            }
            let key = self.read_string();
            self.skip_ws();
            if self.peek(0) == Some('{') {
                self.i += 1;
                let v = self.read_object();
                obj.insert(key, v);
            } else {
                let v = self.read_string();
                obj.insert(key, Value::String(v));
                self.skip_conditional();
            }
        }
        Value::Object(obj)
    }
}

pub fn parse(text: &str) -> Value {
    Parser { s: text.chars().collect(), i: 0 }.read_object()
}

/// Case-insensitive nested lookup: get_ci(&v, &["AppState", "name"]).
pub fn get_ci<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for key in keys {
        let map = cur.as_object()?;
        let lower = key.to_lowercase();
        cur = map.iter().find(|(k, _)| k.to_lowercase() == lower).map(|(_, v)| v)?;
    }
    Some(cur)
}

/// get_ci for a string value.
pub fn str_ci<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    get_ci(v, keys).and_then(|v| v.as_str())
}
