use serde::Deserialize;

pub use crate::page_match::CompiledPageUrlCondition;

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct CompiledConfig {
    #[serde(default)]
    pub shipping_offers: Vec<CompiledShippingOffer>,
}

#[derive(Debug, Deserialize, Clone)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct CompiledShippingOffer {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    pub priority: i32,
    pub tiers: Vec<ShippingTier>,
    pub target_group_types: Option<Vec<String>>,
    #[serde(default = "default_shipping_scope")]
    pub scope_mode: String,
    pub required_line_attribute_value: Option<String>,
    #[serde(default)]
    pub required_anchor_variant_ids: Vec<String>,
    #[serde(default = "default_anchor_quantity")]
    pub required_anchor_min_quantity: i64,
    #[serde(default)]
    pub requires_anchor_subscription: bool,
    #[serde(default)]
    pub code_hashes: Vec<String>,
    #[serde(default)]
    pub accept_codes: bool,
    /// Page conditions over the stamped line metadata. When set, at least one non-gift line
    /// must match (exclude mode); tier thresholds still count the whole cart.
    #[serde(default)]
    pub page_url_conditions: Vec<CompiledPageUrlCondition>,
    /// Reject mode: every non-gift line must match, not just one.
    #[serde(default)]
    pub reject_unmatched_lines: bool,
    /// Shop currency of the tier thresholds and fixed amounts (minor-unit scale).
    #[serde(default = "default_currency_code")]
    pub currency_code: String,
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

#[derive(Debug, Deserialize, Clone)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct ShippingTier {
    pub minimum_subtotal_cents: i64,
    pub maximum_subtotal_cents: Option<i64>,
    pub discount_type: String,
    pub discount_value: f64,
    pub applies_when: Option<String>,
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
}
