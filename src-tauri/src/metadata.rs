//! Game artwork and details (port of main/metadata.js): Steam store search
//! and items, SteamGridDB (optional, needs an API key), image downloads.

use crate::util::encode_uri_component;
use regex::Regex;
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, sync::LazyLock, time::Duration};

const STORE_ASSETS: &str = "https://shared.steamstatic.com/store_item_assets/";
const STEAM_CDN: &str = "https://cdn.cloudflare.steamstatic.com/steam/apps/";
const SGDB_API: &str = "https://www.steamgriddb.com/api/v2";
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) PS5GameLauncher/1.0";

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder().user_agent(UA).build().expect("http client"));

pub async fn sleep(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

async fn get_json(url: &str, auth: Option<&str>) -> Result<Value, String> {
    let mut req = CLIENT.get(url).timeout(Duration::from_secs(20));
    if let Some(key) = auth {
        req = req.bearer_auth(key);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {} for {url}", res.status().as_u16()));
    }
    res.json::<Value>().await.map_err(|e| e.to_string())
}

/* ------------------------------------------------------------------ */
/* Name matching                                                       */
/* ------------------------------------------------------------------ */

fn normalize(s: &str) -> String {
    let lower = s.to_lowercase().replace(['™', '®', '©'], "").replace('&', " and ");
    let cleaned: String = lower.chars().map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() { c } else { ' ' }).collect();
    cleaned
        .split(' ')
        .filter(|w| !w.is_empty())
        .map(|w| match w {
            "i" => "1",
            "ii" => "2",
            "iii" => "3",
            "iv" => "4",
            "v" => "5",
            "vi" => "6",
            "vii" => "7",
            "viii" => "8",
            "ix" => "9",
            "x" => "10",
            other => other,
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn dice(a: &str, b: &str) -> f64 {
    let x = a.replace(' ', "");
    let y = b.replace(' ', "");
    if x == y {
        return 1.0;
    }
    if x.len() < 2 || y.len() < 2 {
        return 0.0;
    }
    let mut grams: HashMap<&str, i32> = HashMap::new();
    for i in 0..x.len() - 1 {
        *grams.entry(&x[i..i + 2]).or_default() += 1;
    }
    let mut hit = 0;
    for i in 0..y.len() - 1 {
        if let Some(n) = grams.get_mut(&y[i..i + 2]) {
            if *n > 0 {
                *n -= 1;
                hit += 1;
            }
        }
    }
    2.0 * hit as f64 / (x.len() + y.len() - 2) as f64
}

static EXTRA_WORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b(soundtrack|ost|dlc|demo|season pass|pack|bundle|artbook|expansion|playtest|dedicated server|sdk|editor|beta)\b").unwrap());

fn score_match(query: &str, candidate: &str, rank: usize) -> f64 {
    let q = normalize(query);
    let c = normalize(candidate);
    let mut score = dice(&q, &c);
    if q == c {
        score = 1.2;
    } else if format!(" {c} ").contains(&format!(" {q} ")) {
        score = score.max(0.8);
    } else if format!(" {q} ").contains(&format!(" {c} ")) {
        score = score.max(0.72);
    }
    if EXTRA_WORDS.is_match(candidate) && !EXTRA_WORDS.is_match(query) {
        score -= 0.4;
    }
    if rank == 0 {
        score += 0.05;
    }
    score
}

pub fn search_term(name: &str) -> String {
    static NOISE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)\b(launcher|game of the year edition|goty|definitive edition|remastered|x64|dx12|dx11|vulkan)\b").unwrap());
    let s = name.replace(['™', '®', '©'], "");
    let s = NOISE.replace_all(&s, " ");
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Steam store search: [{ appid, name, image }].
pub async fn search_steam(term: &str) -> Result<Vec<Value>, String> {
    let url = format!("https://store.steampowered.com/api/storesearch/?term={}&l=english&cc=US", encode_uri_component(term));
    let j = get_json(&url, None).await?;
    Ok(j["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|i| i["type"] == "app")
                .map(|i| json!({ "appid": i["id"].as_i64().map(|n| n.to_string()).unwrap_or_default(), "name": i["name"], "image": i.get("tiny_image").cloned().unwrap_or(Value::Null) }))
                .collect()
        })
        .unwrap_or_default())
}

pub struct Match {
    pub appid: String,
    pub name: String,
}

pub async fn resolve_steam_app_id(name: &str) -> Result<Option<Match>, String> {
    let first = search_term(name);
    static SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s[-–:]\s|:\s").unwrap());
    let short = SPLIT.split(&first).next().unwrap_or("").to_string();
    let mut tries = vec![first.clone()];
    if !short.is_empty() && short != first {
        tries.push(short);
    }
    let mut best: Option<(Match, f64)> = None;
    for term in tries {
        if term.is_empty() {
            continue;
        }
        for (rank, r) in search_steam(&term).await?.iter().enumerate() {
            let cand = r["name"].as_str().unwrap_or("");
            let s = score_match(name, cand, rank);
            if best.as_ref().is_none_or(|(_, b)| s > *b) {
                best = Some((Match { appid: r["appid"].as_str().unwrap_or("").to_string(), name: cand.to_string() }, s));
            }
        }
        if best.as_ref().is_some_and(|(_, s)| *s >= 0.9) {
            break;
        }
        sleep(120).await;
    }
    Ok(best.filter(|(_, s)| *s >= 0.62).map(|(m, _)| m))
}

/* ------------------------------------------------------------------ */
/* Steam store data                                                    */
/* ------------------------------------------------------------------ */

pub async fn fetch_store_items(appids: &[String]) -> HashMap<String, Value> {
    let mut out = HashMap::new();
    let mut ids: Vec<&String> = Vec::new();
    for a in appids {
        if !a.is_empty() && !ids.contains(&a) {
            ids.push(a);
        }
    }
    for chunk in ids.chunks(25) {
        let input = json!({
            "ids": chunk.iter().map(|a| json!({ "appid": a.parse::<i64>().unwrap_or(0) })).collect::<Vec<_>>(),
            "context": { "language": "english", "country_code": "US" },
            "data_request": { "include_assets": true, "include_basic_info": true, "include_release": true, "include_screenshots": true },
        });
        let url = format!("https://api.steampowered.com/IStoreBrowseService/GetItems/v1?input_json={}", encode_uri_component(&input.to_string()));
        match get_json(&url, None).await {
            Ok(j) => {
                for item in j["response"]["store_items"].as_array().into_iter().flatten() {
                    if let Some(id) = item["appid"].as_i64() {
                        out.insert(id.to_string(), item.clone());
                    }
                }
            }
            Err(e) => eprintln!("[metadata] GetItems failed {e}"),
        }
    }
    out
}

#[derive(Default)]
pub struct Candidates {
    pub hero: Vec<String>,
    pub logo: Vec<String>,
    pub capsule: Vec<String>,
    pub banner: Vec<String>,
    pub backdrop: Vec<String>,
    pub grid: Vec<String>,
}

impl Candidates {
    pub fn get(&self, k: &str) -> &[String] {
        match k {
            "hero" => &self.hero,
            "logo" => &self.logo,
            "capsule" => &self.capsule,
            "banner" => &self.banner,
            "grid" => &self.grid,
            _ => &[],
        }
    }
}

pub fn steam_candidates(appid: &str, item: Option<&Value>) -> Candidates {
    let a = item.map(|i| &i["assets"]).cloned().unwrap_or(Value::Null);
    let fmt = a["asset_url_format"].as_str().map(str::to_string).unwrap_or_else(|| format!("steam/apps/{appid}/${{FILENAME}}"));
    let u = |k: &str| a[k].as_str().filter(|f| !f.is_empty()).map(|f| format!("{STORE_ASSETS}{}", fmt.replace("${FILENAME}", f)));
    let plain = |f: &str| format!("{STORE_ASSETS}steam/apps/{appid}/{f}");
    let list = |v: Vec<Option<String>>| v.into_iter().flatten().collect::<Vec<_>>();
    Candidates {
        hero: list(vec![u("library_hero_2x"), u("library_hero"), Some(format!("{STEAM_CDN}{appid}/library_hero.jpg"))]),
        logo: vec![plain("logo_2x.png"), plain("logo.png"), format!("{STEAM_CDN}{appid}/logo.png")],
        capsule: list(vec![
            u("library_capsule_2x"),
            u("library_capsule"),
            Some(format!("{STEAM_CDN}{appid}/library_600x900_2x.jpg")),
            Some(format!("{STEAM_CDN}{appid}/library_600x900.jpg")),
        ]),
        banner: list(vec![u("header_2x"), u("header"), Some(format!("{STEAM_CDN}{appid}/header.jpg"))]),
        backdrop: list(vec![u("raw_page_background"), u("hero_capsule_2x")]),
        grid: Vec::new(),
    }
}

pub fn steam_meta(item: &Value) -> Value {
    let b = &item["basic_info"];
    let names = |k: &str| {
        b[k].as_array()
            .map(|a| a.iter().filter_map(|x| x["name"].as_str()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", "))
            .unwrap_or_default()
    };
    json!({
        "title": item.get("name").filter(|v| v.is_string()).cloned().unwrap_or(Value::Null),
        "description": b["short_description"].as_str().unwrap_or(""),
        "developer": names("developers"),
        "publisher": names("publishers"),
        "franchise": names("franchises"),
        "released": item["release"]["steam_release_date"].as_i64().filter(|d| *d != 0).map(|d| json!(d * 1000)).unwrap_or(Value::Null),
    })
}

pub fn steam_screenshots(item: &Value) -> Value {
    static JPG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.jpg(\?|$)").unwrap());
    let list = item["screenshots"]["all_ages_screenshots"].as_array().cloned().unwrap_or_default();
    Value::Array(
        list.iter()
            .take(8)
            .filter_map(|s| s["filename"].as_str())
            .map(|f| json!({ "full": format!("{STORE_ASSETS}{f}"), "thumb": format!("{STORE_ASSETS}{}", JPG.replace(f, ".600x338.jpg$1")) }))
            .collect(),
    )
}

/* ------------------------------------------------------------------ */
/* SteamGridDB (optional, needs an API key)                           */
/* ------------------------------------------------------------------ */

async fn sgdb_get(key: &str, p: &str) -> Result<Value, String> {
    let j = get_json(&format!("{SGDB_API}{p}"), Some(key)).await?;
    Ok(if j["success"] == true { j["data"].clone() } else { Value::Null })
}

pub async fn sgdb_candidates(key: &str, steam_app_id: Option<&str>, name: &str) -> Option<Candidates> {
    let mut game_id = None;
    if let Some(appid) = steam_app_id {
        game_id = sgdb_get(key, &format!("/games/steam/{appid}")).await.ok().and_then(|d| d["id"].as_i64());
    }
    if game_id.is_none() {
        game_id = sgdb_get(key, &format!("/search/autocomplete/{}", encode_uri_component(&search_term(name))))
            .await
            .ok()
            .and_then(|d| d[0]["id"].as_i64());
    }
    let id = game_id?;
    let grab = |p: String| async move {
        sgdb_get(key, &p)
            .await
            .ok()
            .and_then(|d| d.as_array().map(|a| a.iter().filter_map(|x| x["url"].as_str().map(str::to_string)).collect::<Vec<_>>()))
            .unwrap_or_default()
    };
    let (grid, capsule, hero, logo) = tokio::join!(
        grab(format!("/grids/game/{id}?dimensions=1024x1024,512x512&types=static")),
        grab(format!("/grids/game/{id}?dimensions=600x900&types=static")),
        grab(format!("/heroes/game/{id}?types=static")),
        grab(format!("/logos/game/{id}?types=static")),
    );
    Some(Candidates { hero, logo, capsule, grid, ..Default::default() })
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

/// Try the URLs in order; save the first real image as <dest_no_ext>.<ext>
/// and return its file name.
pub async fn download(urls: &[String], dest_no_ext: &Path) -> Option<String> {
    for url in urls {
        let Ok(res) = CLIENT.get(url).timeout(Duration::from_secs(30)).send().await else { continue };
        if !res.status().is_success() {
            continue;
        }
        let ct = res.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        if !ct.starts_with("image/") {
            continue;
        }
        let Ok(buf) = res.bytes().await else { continue };
        if buf.len() < 800 {
            continue;
        }
        let ext = if ct.contains("png") {
            "png"
        } else if ct.contains("webp") {
            "webp"
        } else if ct.contains("gif") {
            "gif"
        } else {
            "jpg"
        };
        let file = dest_no_ext.with_extension(ext);
        if tokio::fs::write(&file, &buf).await.is_ok() {
            return file.file_name().map(|n| n.to_string_lossy().into_owned());
        }
    }
    None
}
