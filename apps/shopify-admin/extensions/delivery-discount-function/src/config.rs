use serde::Deserialize;

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
            | "PYG"
            | "RWF"
            | "UGX"
            | "VUV"
            | "XAF"
            | "XOF"
            | "XPF"
    )
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
