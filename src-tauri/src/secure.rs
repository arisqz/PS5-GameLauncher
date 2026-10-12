//! Secrets on disk (the Discord client secret and tokens).
//!
//! New values are protected with Windows DPAPI for the current user:
//!   { "enc": "dpapi", "v": base64 }
//! Values written by the Electron version are still readable:
//!   { "enc": true, "v": base64 }   Electron safeStorage: "v10" + AES-256-GCM,
//!                                   key from Electron's "Local State" (itself DPAPI-protected)
//!   { "enc": false, "v": base64 }  plain text (no encryption was available)

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde_json::{json, Value};
use std::sync::OnceLock;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

fn dpapi(data: &[u8], protect: bool) -> Option<Vec<u8>> {
    unsafe {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        let ok = if protect {
            CryptProtectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        } else {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        };
        ok.ok()?;
        let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
        Some(bytes)
    }
}

/// Electron's safeStorage key: "Local State" › os_crypt.encrypted_key
/// ("DPAPI" + DPAPI-protected AES key), always in the Electron data folder.
fn electron_key() -> Option<&'static [u8]> {
    static KEY: OnceLock<Option<Vec<u8>>> = OnceLock::new();
    KEY.get_or_init(|| {
        let file = std::path::PathBuf::from(std::env::var_os("APPDATA")?).join("PS5 Game Launcher").join("Local State");
        let state: Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
        let raw = B64.decode(state["os_crypt"]["encrypted_key"].as_str()?).ok()?;
        dpapi(raw.strip_prefix(b"DPAPI")?, false)
    })
    .as_deref()
}

fn electron_decrypt(raw: &[u8]) -> Option<String> {
    if let Some(rest) = raw.strip_prefix(b"v10") {
        if rest.len() < 12 + 16 {
            return None;
        }
        let cipher = Aes256Gcm::new_from_slice(electron_key()?).ok()?;
        let plain = cipher.decrypt(Nonce::from_slice(&rest[..12]), &rest[12..]).ok()?;
        return String::from_utf8(plain).ok();
    }
    // Very old Electron: plain DPAPI.
    dpapi(raw, false).and_then(|p| String::from_utf8(p).ok())
}

/// Protect a secret for discord.json.
pub fn seal(text: &str) -> Value {
    if text.is_empty() {
        return Value::Null;
    }
    match dpapi(text.as_bytes(), true) {
        Some(enc) => json!({ "enc": "dpapi", "v": B64.encode(enc) }),
        None => json!({ "enc": false, "v": B64.encode(text) }),
    }
}

/// Read a secret from discord.json (either version's format).
pub fn open(sealed: &Value) -> Option<String> {
    let raw = B64.decode(sealed.get("v")?.as_str()?).ok()?;
    match sealed.get("enc") {
        Some(Value::String(kind)) if kind == "dpapi" => dpapi(&raw, false).and_then(|p| String::from_utf8(p).ok()),
        Some(Value::Bool(true)) => electron_decrypt(&raw),
        _ => String::from_utf8(raw).ok(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn dpapi_round_trip() {
        let sealed = super::seal("round trip");
        assert_eq!(sealed["enc"], "dpapi");
        assert_eq!(super::open(&sealed).as_deref(), Some("round trip"));
    }

    /// Electron safeStorage blob ("v10" + AES-256-GCM) made with the current
    /// Electron key. Run by hand with COMPAT_BLOB pointing at a file holding
    /// { "enc": true, "v": "<base64>" } of the text "tauri compat check".
    #[test]
    #[ignore]
    fn opens_electron_blob() {
        let t = std::fs::read_to_string(std::env::var("COMPAT_BLOB").unwrap()).unwrap();
        let blob: serde_json::Value = serde_json::from_str(t.trim()).unwrap();
        assert_eq!(super::open(&blob).as_deref(), Some("tauri compat check"));
    }
}
