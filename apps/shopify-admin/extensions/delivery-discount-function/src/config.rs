use serde::de::Deserializer;
use serde::Deserialize;
use serde_json::value::RawValue;

pub use crate::page_match::CompiledPageUrlCondition;

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct CompiledConfig {
    #[serde(default, deserialize_with = "lenient_shipping_offers")]
    pub shipping_offers: Vec<CompiledShippingOffer>,
}

/// Shipping offers are parsed one at a time: a malformed offer is skipped and the others still apply.
fn lenient_shipping_offers<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<CompiledShippingOffer>, D::Error> {
    let raw = Vec::<Box<RawValue>>::deserialize(deserializer)?;
    Ok(raw
        .iter()
        .filter_map(|offer| serde_json::from_str(offer.get()).ok())
        .collect())
}

de_struct! {
    #[derive(Debug, Clone)]
    #[cfg_attr(test, derive(PartialEq))]
    pub struct CompiledShippingOffer {
        "id" => id: String,
        "title" => title: Option<String> = None,
        "priority" => priority: i32,
        "tiers" => tiers: Vec<ShippingTier>,
        "targetGroupTypes" => target_group_types: Option<Vec<String>> = None,
        "scopeMode" => scope_mode: String = default_shipping_scope(),
        "requiredLineAttributeValue" => required_line_attribute_value: Option<String> = None,
        "requiredAnchorVariantIds" => required_anchor_variant_ids: Vec<String> = Vec::new(),
        "requiredAnchorMinQuantity" => required_anchor_min_quantity: i64 = default_anchor_quantity(),
        "requiresAnchorSubscription" => requires_anchor_subscription: bool = false,
        "codeHashes" => code_hashes: Vec<String> = Vec::new(),
        "acceptCodes" => accept_codes: bool = false,
        // Page conditions over the stamped line metadata. When set, at least one non-gift line
        // must match (exclude mode); tier thresholds still count the whole cart.
        "pageUrlConditions" => page_url_conditions: Vec<CompiledPageUrlCondition> = Vec::new(),
        // Reject mode: every non-gift line must match, not just one.
        "rejectUnmatchedLines" => reject_unmatched_lines: bool = false,
        // Shop currency of the tier thresholds and fixed amounts (minor-unit scale).
        "currencyCode" => currency_code: String = default_currency_code(),
    }
}

fn default_currency_code() -> String {
    "USD".to_string()
}

fn default_shipping_scope() -> String {
    "sitewide".to_string()
}

fn default_anchor_quantity() -> i64 {
    1
}

de_struct! {
    #[derive(Debug, Clone)]
    #[cfg_attr(test, derive(PartialEq))]
    pub struct ShippingTier {
        "minimumSubtotalCents" => minimum_subtotal_cents: i64,
        "maximumSubtotalCents" => maximum_subtotal_cents: Option<i64> = None,
        "discountType" => discount_type: String,
        "discountValue" => discount_value: f64,
        "appliesWhen" => applies_when: Option<String> = None,
    }
}

pub fn is_zero_decimal(currency_code: &str) -> bool {
    matches!(
        currency_code,
        "JPY"
            | "KRW"
            | "VND"
            | "BIF"
            | "CLP"
            | "GNF"
            | "ISK"
            | "KMF"
            | "MGA"
            | "DJF"
            | "PYG"
            | "RWF"
            | "UGX"
            | "VUV"
            | "XAF"
            | "XOF"
            | "XPF"
    )
}

pub fn minor_units(currency_code: &str) -> f64 {
    if is_zero_decimal(currency_code) {
        1.0
    } else {
        100.0
    }
}

/// Fixed amounts are sent in major units of the presentment currency: whole units for
/// zero-decimal currencies, two decimals otherwise.
pub fn round_amount(amount: f64, currency_code: &str) -> f64 {
    if is_zero_decimal(currency_code) {
        amount.round()
    } else {
        (amount * 100.0).round() / 100.0
    }
}

pub fn to_cents(amount: f64, currency_code: &str) -> i64 {
    if is_zero_decimal(currency_code) {
        amount.round() as i64
    } else {
        (amount * 100.0).round() as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_metafield_deserializes_to_the_full_config() {
        let parse = |raw: &str| serde_json::from_str::<CompiledConfig>(raw).unwrap();
        let full = parse(include_str!(
            "../../discount-function/src/fixtures/ambrosia-function-config.full.json"
        ));
        let compact = parse(include_str!(
            "../../discount-function/src/fixtures/ambrosia-function-config.compact.json"
        ));
        assert_eq!(full.shipping_offers.len(), 2);
        assert_eq!(compact, full);
    }

    #[test]
    fn a_malformed_shipping_offer_is_skipped_without_dropping_the_others() {
        let raw = r#"{"shippingOffers":[
            {"id":"bad","priority":"high","tiers":[]},
            {"id":"no-tiers","priority":1},
            {"id":"ok","priority":2,"unknownKey":[1,2],"tiers":[{"minimumSubtotalCents":5000,"discountType":"free","discountValue":100}]}
        ]}"#;
        let config = serde_json::from_str::<CompiledConfig>(raw).unwrap();
        assert_eq!(config.shipping_offers.len(), 1);
        let offer = &config.shipping_offers[0];
        assert_eq!(offer.id, "ok");
        assert_eq!(offer.scope_mode, "sitewide");
        assert_eq!(offer.currency_code, "USD");
        assert_eq!(offer.required_anchor_min_quantity, 1);
        assert_eq!(offer.tiers[0].applies_when, None);
    }
}
