//! Page-condition matching shared (via `#[path]`) by the discount, code-discount and
//! delivery Functions. Decisions D1/D3 of docs/PRODUCTION-READINESS-PLAN.md.
//!
//! A line matches when its packed metadata carries `_promo_page_url` and satisfies
//! every condition. Conditions read `_promo_page_url`, or `_promo_landing_url` when
//! `source` is set (visit-scoped UTM).

use serde::Deserialize;
use std::collections::HashMap;

#[derive(Debug, Deserialize, Clone)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct CompiledPageUrlCondition {
    #[serde(default)]
    pub patterns: Vec<String>,
    pub match_mode: String,
    #[serde(default)]
    pub case_sensitive: bool,
    pub param_name: Option<String>,
    pub param_value: Option<String>,
    /// Some("landing"): match `_promo_landing_url` (session UTM landing) instead of `_promo_page_url`.
    pub source: Option<String>,
}

pub type LineMetadata = HashMap<String, String>;

#[allow(dead_code)] // the delivery Function calls this; the discount Functions use `metadata_matches`
pub fn line_matches(raw_metadata: Option<&str>, conds: &[CompiledPageUrlCondition]) -> bool {
    let map = raw_metadata.and_then(|raw| serde_json::from_str::<LineMetadata>(raw).ok());
    metadata_matches(map.as_ref(), conds)
}

pub fn metadata_matches(metadata: Option<&LineMetadata>, conds: &[CompiledPageUrlCondition]) -> bool {
    let Some(metadata) = metadata else {
        return false;
    };
    metadata.contains_key("_promo_page_url")
        && conds.iter().all(|cond| {
            let key = if cond.source.is_some() {
                "_promo_landing_url"
            } else {
                "_promo_page_url"
            };
            metadata
                .get(key)
                .is_some_and(|url| condition_matches(url, cond))
        })
}

/// Scheme and host are stripped only for absolute (`http://`, `https://`) and
/// protocol-relative (`//`) values; anything else is already a path (+ query), and
/// a `://` inside its query string must not be mistaken for a scheme.
fn path_and_query(url: &str) -> &str {
    let starts = |prefix: &str| {
        url.get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
    };
    let rest = if starts("https://") {
        &url[8..]
    } else if starts("http://") {
        &url[7..]
    } else if starts("//") {
        &url[2..]
    } else {
        return url.split('#').next().unwrap_or("");
    };
    let rest = rest.find(['/', '?', '#']).map_or("", |index| &rest[index..]);
    rest.split('#').next().unwrap_or("")
}

fn condition_matches(url: &str, cond: &CompiledPageUrlCondition) -> bool {
    let path_and_query = path_and_query(url);
    let (path, query) = path_and_query
        .split_once('?')
        .unwrap_or((path_and_query, ""));
    let path = if path.is_empty() { "/" } else { path };
    let lowered;
    let path = if cond.case_sensitive {
        path
    } else {
        lowered = path.to_ascii_lowercase();
        lowered.as_str()
    };

    if cond.match_mode == "page_type" {
        let kind = page_type(path);
        return cond.patterns.iter().any(|pattern| pattern == kind);
    }

    let path_matches = cond.patterns.is_empty()
        || cond.patterns.iter().any(|pattern| {
            let lowered;
            let pattern = if cond.case_sensitive {
                pattern.as_str()
            } else {
                lowered = pattern.to_ascii_lowercase();
                lowered.as_str()
            };
            match cond.match_mode.as_str() {
                "exact" => path == pattern,
                "starts_with" => path.starts_with(pattern),
                "ends_with" => path.ends_with(pattern),
                _ => path.contains(pattern),
            }
        });
    if !path_matches {
        return false;
    }

    let Some(name) = cond.param_name.as_deref() else {
        return true;
    };
    // Configs published before D3 hold encodeURIComponent'd names/values; decoding
    // them (without '+' handling, which encodeURIComponent never emits) keeps those
    // live offers matching until they are republished.
    let name = percent_decode(name, false);
    let is_utm = name.len() >= 4 && name.as_bytes()[..4].eq_ignore_ascii_case(b"utm_");
    let same = |left: &str, right: &str| {
        if is_utm {
            left.eq_ignore_ascii_case(right)
        } else {
            left == right
        }
    };
    let actual = query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        same(&percent_decode(key, true), &name).then(|| percent_decode(value, true))
    });
    match cond.param_value.as_deref() {
        Some(expected) => actual.is_some_and(|actual| {
            same(&actual, expected) || same(&actual, &percent_decode(expected, false))
        }),
        None => actual.is_some(),
    }
}

fn percent_decode(input: &str, plus_as_space: bool) -> String {
    if !input.contains('%') && !(plus_as_space && input.contains('+')) {
        return input.to_string();
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let hex = |byte: u8| (byte as char).to_digit(16);
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(if plus_as_space && byte == b'+' { b' ' } else { byte });
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Shopify storefront page kind of a (lowercased) path, after an optional
/// locale segment (`/en`, `/fr-ca`). Unknown paths get "", which no pattern equals.
fn page_type(path: &str) -> &'static str {
    let mut segments = path.split('/').filter(|segment| !segment.is_empty());
    let mut first = segments.next();
    if first.is_some_and(is_locale_segment) {
        first = segments.next();
    }
    match first {
        None => "home",
        Some("products") => "product",
        Some("collections") if segments.nth(1) == Some("products") => "product",
        Some("collections") => "collection",
        Some("search") => "search",
        Some("pages") => "page",
        Some("blogs") => "blog",
        Some("cart") => "cart",
        _ => "",
    }
}

fn is_locale_segment(segment: &str) -> bool {
    let bytes = segment.as_bytes();
    let letters = |range: &[u8]| range.iter().all(u8::is_ascii_alphabetic);
    match bytes.len() {
        2 => letters(bytes),
        5 => bytes[2] == b'-' && letters(&bytes[..2]) && letters(&bytes[3..]),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cond(mode: &str, patterns: &[&str]) -> CompiledPageUrlCondition {
        CompiledPageUrlCondition {
            patterns: patterns.iter().map(|p| p.to_string()).collect(),
            match_mode: mode.to_string(),
            case_sensitive: false,
            param_name: None,
            param_value: None,
            source: None,
        }
    }

    fn param(name: &str, value: Option<&str>) -> CompiledPageUrlCondition {
        CompiledPageUrlCondition {
            param_name: Some(name.to_string()),
            param_value: value.map(str::to_string),
            ..cond("contains", &[])
        }
    }

    fn meta(page: &str) -> String {
        serde_json::json!({ "_promo_page_url": page }).to_string()
    }

    fn matches(page: &str, conds: &[CompiledPageUrlCondition]) -> bool {
        line_matches(Some(&meta(page)), conds)
    }

    #[test]
    fn missing_or_unstamped_metadata_never_matches() {
        assert!(!line_matches(None, &[]));
        assert!(!line_matches(Some("not json"), &[]));
        assert!(!line_matches(Some(r#"{"x":"1"}"#), &[]));
        assert!(line_matches(Some(&meta("/")), &[]));
    }

    #[test]
    fn strips_scheme_and_host_only_for_absolute_urls() {
        let c = [cond("exact", &["/pages/sale"])];
        assert!(matches("https://shop.com/pages/sale?x=1", &c));
        assert!(matches("HTTP://shop.com/pages/sale#frag", &c));
        assert!(matches("//shop.com/pages/sale", &c));
        assert!(matches("/pages/sale?next=https://evil.com/other", &c));
        let other = [cond("exact", &["/other"])];
        assert!(!matches("/pages/sale?next=https://evil.com/other", &other));
    }

    #[test]
    fn host_only_url_is_the_home_page() {
        assert!(matches("https://shop.com", &[cond("page_type", &["home"])]));
        assert!(matches("https://shop.com?utm_source=a", &[cond("exact", &["/"])]));
    }

    #[test]
    fn path_modes_and_case() {
        assert!(matches("/Collections/Sale", &[cond("starts_with", &["/collections/"])]));
        assert!(matches("/a/b", &[cond("ends_with", &["/b"])]));
        let mut sensitive = cond("exact", &["/Pages/Sale"]);
        sensitive.case_sensitive = true;
        assert!(!matches("/pages/sale", &[sensitive.clone()]));
        assert!(matches("/Pages/Sale", &[sensitive]));
    }

    #[test]
    fn page_types_with_locale_prefix() {
        let product = [cond("page_type", &["product"])];
        assert!(matches("/products/x", &product));
        assert!(matches("/en/products/x", &product));
        assert!(matches("/fr-ca/products/x?v=1", &product));
        assert!(matches("/collections/c/products/x", &product));
        assert!(!matches("/collections/c", &product));
        assert!(matches("/en-US/collections/c", &[cond("page_type", &["collection"])]));
        assert!(matches("/", &[cond("page_type", &["home"])]));
        assert!(matches("/fr", &[cond("page_type", &["home"])]));
        assert!(!matches("/account", &[cond("page_type", &["home", "page"])]));
    }

    #[test]
    fn query_values_are_percent_and_plus_decoded() {
        let c = [param("utm_campaign", Some("spring sale"))];
        assert!(matches("/?utm_campaign=spring%20sale", &c));
        assert!(matches("/?utm_campaign=spring+sale", &c));
        assert!(!matches("/?utm_campaign=spring-sale", &c));
        let c = [param("ref", Some("a+b"))];
        assert!(matches("/?ref=a%2Bb", &c));
        assert!(!matches("/?ref=a+b", &c));
    }

    #[test]
    fn legacy_encoded_config_values_still_match() {
        let c = [param("utm_campaign", Some("spring%20sale"))];
        assert!(matches("/?utm_campaign=spring%20sale", &c));
        assert!(matches("/?utm_campaign=spring+sale", &c));
    }

    #[test]
    fn utm_compare_is_ascii_case_insensitive_but_other_params_are_not() {
        assert!(matches("/?utm_source=Google", &[param("utm_source", Some("google"))]));
        assert!(matches("/?UTM_SOURCE=google", &[param("utm_source", Some("GOOGLE"))]));
        assert!(!matches("/?code=Abc", &[param("code", Some("abc"))]));
        assert!(matches("/?code=Abc", &[param("code", Some("Abc"))]));
    }

    #[test]
    fn param_presence_and_nested_urls() {
        assert!(matches("/?freegifts_code", &[param("freegifts_code", None)]));
        assert!(!matches("/?other=1", &[param("freegifts_code", None)]));
        assert!(!matches(
            "/?next=%2F%3Futm_source%3Dx",
            &[param("utm_source", Some("x"))]
        ));
    }

    #[test]
    fn landing_source_reads_the_landing_key() {
        let mut visit = param("utm_source", Some("g"));
        visit.source = Some("landing".to_string());
        let raw = serde_json::json!({
            "_promo_page_url": "/products/x",
            "_promo_landing_url": "/?utm_source=g"
        })
        .to_string();
        assert!(line_matches(Some(&raw), &[visit.clone()]));
        let no_page = serde_json::json!({ "_promo_landing_url": "/?utm_source=g" }).to_string();
        assert!(!line_matches(Some(&no_page), &[visit]));
    }

    #[test]
    fn all_conditions_must_hold() {
        let c = [cond("starts_with", &["/collections/"]), param("utm_source", Some("g"))];
        assert!(matches("/collections/a?utm_source=g", &c));
        assert!(!matches("/collections/a", &c));
        assert!(!matches("/pages/a?utm_source=g", &c));
    }
}
