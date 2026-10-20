//! Per-customer offer usage, read from the `$app:promo_engine.usage` customer metafield:
//! `{"v":1,"u":{"<offerId>":<count>}}`. A missing key counts as 0 uses; an unreadable value
//! or unknown version reads as empty (fail open, like a guest).

use std::collections::HashMap;

pub type Usage = HashMap<String, i64>;

de_struct! {
    pub struct Payload {
        "v" => version: i64 = 0,
        "u" => uses: Usage = Usage::new(),
    }
}

pub fn parse(raw: Option<&str>) -> Usage {
    raw.and_then(|value| serde_json::from_str::<Payload>(value).ok())
        .filter(|payload| payload.version == 1)
        .map(|payload| payload.uses)
        .unwrap_or_default()
}

/// True when the buyer can no longer get this offer: not identified while the offer requires it,
/// or already used it `max_per_customer` times.
pub fn customer_blocked(
    usage: &Usage,
    offer_id: &str,
    max_per_customer: Option<i64>,
    require_identified: bool,
    identified: bool,
) -> bool {
    (require_identified && !identified)
        || max_per_customer.is_some_and(|max| usage.get(offer_id).copied().unwrap_or(0) >= max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_counts_and_treats_anything_unreadable_as_empty() {
        let usage = parse(Some(r#"{"v":1,"u":{"a":2,"b":0},"future":true}"#));
        assert_eq!((usage["a"], usage["b"], usage.get("c")), (2, 0, None));
        for raw in [None, Some(""), Some("x"), Some(r#"{"v":2,"u":{"a":1}}"#), Some(r#"{"u":{"a":1}}"#), Some(r#"{"v":1}"#)] {
            assert!(parse(raw).is_empty(), "{raw:?}");
        }
    }

    #[test]
    fn blocked_when_unidentified_but_required_or_at_the_limit() {
        let usage = parse(Some(r#"{"v":1,"u":{"a":2}}"#));
        assert!(!customer_blocked(&usage, "a", None, false, false));
        assert!(!customer_blocked(&usage, "a", Some(3), false, true));
        assert!(customer_blocked(&usage, "a", Some(2), false, true));
        assert!(!customer_blocked(&usage, "unseen", Some(1), false, true));
        assert!(!customer_blocked(&usage, "unseen", Some(1), false, false));
        assert!(customer_blocked(&usage, "unseen", None, true, false));
        assert!(!customer_blocked(&usage, "unseen", None, true, true));
    }
}
