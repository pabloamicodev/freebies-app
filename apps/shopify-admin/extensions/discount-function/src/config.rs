use serde::Deserialize;
use std::collections::HashMap;

/// Compiled config — parsed from the `promo_engine.function_config` metafield.
/// This is our own JSON shape (written by the offer-publisher worker), unrelated
/// to Shopify's GraphQL schema, so it stays hand-written serde like before.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct CompiledConfig {
    pub offers: Vec<CompiledOffer>,
    #[serde(default)]
    pub l1: Option<String>,
    #[serde(default)]
    pub l2: Option<String>,
    #[serde(default)]
    pub c1: Option<String>,
    #[serde(default)]
    pub c2: Option<String>,
    #[serde(default)]
    pub c3: Option<String>,
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
pub struct CompiledOffer {
    pub id: String,
    pub version: i32,
    pub offer_type: String,
    pub priority: i32,
    #[serde(default)]
    pub stop_lower_priority: bool,
    #[serde(default)]
    pub required_product_ids: Vec<String>,
    #[serde(default)]
    pub required_variant_ids: Vec<String>,
    #[serde(default)]
    pub excluded_product_ids: Vec<String>,
    #[serde(default)]
    pub gift_variant_ids: Vec<String>,
    #[serde(default)]
    pub gift_product_ids: Vec<String>,
    pub cart_value_threshold_cents: Option<i64>,
    pub cart_value_max_cents: Option<i64>,
    pub cart_quantity_threshold: Option<i64>,
    pub cart_quantity_max: Option<i64>,
    pub subscription_mode: Option<String>,
    pub customer_order_count_min: Option<i64>,
    pub customer_order_count_max: Option<i64>,
    pub customer_amount_spent_min_cents: Option<i64>,
    pub customer_amount_spent_max_cents: Option<i64>,
    #[serde(default)]
    pub required_customer_tags: Vec<String>,
    #[serde(default)]
    pub excluded_customer_tags: Vec<String>,
    #[serde(default = "default_treat_guest_as_no_tags")]
    pub treat_guest_as_no_tags: bool,
    #[serde(default)]
    pub include_country_codes: Vec<String>,
    #[serde(default)]
    pub exclude_country_codes: Vec<String>,
    pub max_gift_quantity: Option<i64>,
    #[serde(default = "default_discount_type")]
    pub discount_type: String,
    #[serde(default = "default_discount_value")]
    pub discount_value: f64,
    #[serde(default = "default_currency_code")]
    pub currency_code: String,
    pub currency_overrides: Option<HashMap<String, i64>>,
    pub max_currency_overrides: Option<HashMap<String, i64>>,
    #[serde(default)]
    pub requirements: Vec<CompiledRequirement>,
    #[serde(default)]
    pub gift_rewards: Vec<CompiledGiftReward>,
    #[serde(default)]
    pub product_rewards: Vec<CompiledProductReward>,
    #[serde(default)]
    pub order_rewards: Vec<CompiledOrderReward>,
    #[serde(default)]
    pub line_attribute_conditions: Vec<CompiledAttributeCondition>,
    #[serde(default)]
    pub cart_attribute_conditions: Vec<CompiledAttributeCondition>,
    #[serde(default)]
    pub page_url_conditions: Vec<CompiledPageUrlCondition>,
}

fn default_treat_guest_as_no_tags() -> bool {
    true
}

fn default_discount_type() -> String {
    "free".to_string()
}

fn default_discount_value() -> f64 {
    100.0
}

fn default_currency_code() -> String {
    "USD".to_string()
}

fn default_subscription_mode() -> String {
    "any".to_string()
}

#[derive(Debug, Deserialize, Clone)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct CompiledAttributeCondition {
    pub key: String,
    pub value: String,
    pub match_mode: String,
    pub min_matching_quantity: i64,
}

#[derive(Debug, Deserialize, Clone)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct CompiledGiftReward {
    pub id: String,
    #[serde(default)]
    pub target_product_ids: Vec<String>,
    #[serde(default)]
    pub target_variant_ids: Vec<String>,
    pub discount_type: String,
    pub discount_value: f64,
    pub max_quantity: i64,
}

#[derive(Debug, Deserialize, Clone)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct CompiledRequirement {
    pub product_id: Option<String>,
    pub variant_id: Option<String>,
    pub track_mode: String,
    pub min_quantity: i64,
    pub max_quantity: Option<i64>,
}

#[derive(Debug, Deserialize, Clone)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct CompiledProductReward {
    pub id: String,
    #[serde(default)]
    pub target_product_ids: Vec<String>,
    #[serde(default)]
    pub target_variant_ids: Vec<String>,
    pub discount_type: String,
    pub discount_value: f64,
    pub max_quantity: Option<i64>,
    pub line_quantity_equals: Option<i64>,
    pub max_units_total: Option<i64>,
    #[serde(default = "default_subscription_mode")]
    pub subscription_mode: String,
    #[serde(default = "default_shipping_scope")]
    pub scope_mode: String,
    pub required_offer_id: Option<String>,
    pub required_line_attribute_value: Option<String>,
    #[serde(default)]
    pub required_anchor_variant_ids: Vec<String>,
    #[serde(default = "default_anchor_quantity")]
    pub required_anchor_min_quantity: i64,
    #[serde(default)]
    pub requires_anchor_subscription: bool,
    #[serde(default)]
    pub price_tiers: Vec<ProductPriceTier>,
    #[serde(default)]
    pub quantity_tiers: Vec<ProductDiscountTier>,
    #[serde(default = "default_selection_mode")]
    pub selection_mode: String,
    #[serde(default = "default_count_rule")]
    pub count_rule: String,
    #[serde(default = "default_gift_percentage")]
    pub discount_percentage_on_gifts: f64,
}

fn default_gift_percentage() -> f64 {
    100.0
}

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
}

fn default_count_rule() -> String {
    "all".to_string()
}

fn default_selection_mode() -> String {
    "all".to_string()
}

#[derive(Debug, Deserialize, Clone)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct ProductPriceTier {
    pub quantity: i64,
    pub target_price_per_unit: f64,
}

#[derive(Debug, Deserialize, Clone)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct ProductDiscountTier {
    pub minimum_quantity: i64,
    pub maximum_quantity: Option<i64>,
    pub discount_type: String,
    pub discount_value: f64,
    pub discounted_quantity: Option<i64>,
}

#[derive(Debug, Deserialize, Clone)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct CompiledOrderReward {
    pub id: String,
    pub discount_type: String,
    pub discount_value: f64,
    #[serde(default)]
    pub subtotal_tiers: Vec<OrderSubtotalDiscountTier>,
}

#[derive(Debug, Deserialize, Clone)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct OrderSubtotalDiscountTier {
    pub minimum_subtotal_cents: Option<i64>,
    pub maximum_subtotal_cents: Option<i64>,
    pub minimum_quantity: Option<i64>,
    pub maximum_quantity: Option<i64>,
    pub discount_type: String,
    pub discount_value: f64,
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

pub fn resolve_threshold(
    base_cents: i64,
    overrides: &Option<HashMap<String, i64>>,
    active_currency: &str,
) -> i64 {
    if let Some(map) = overrides {
        if let Some(&override_cents) = map.get(active_currency) {
            return override_cents;
        }
    }
    base_cents
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL_FIXTURE: &str = include_str!("fixtures/ambrosia-function-config.full.json");
    const COMPACT_FIXTURE: &str = include_str!("fixtures/ambrosia-function-config.compact.json");

    #[test]
    fn compact_metafield_deserializes_to_the_full_config() {
        let full: CompiledConfig = serde_json::from_str(FULL_FIXTURE).unwrap();
        let mut compact: CompiledConfig = serde_json::from_str(COMPACT_FIXTURE).unwrap();
        // Query-variable placeholders never equal a real attribute key, so they behave like None.
        for slot in [&mut compact.l1, &mut compact.l2, &mut compact.c1, &mut compact.c2, &mut compact.c3] {
            if slot.as_deref() == Some("_promo_engine_unused") {
                *slot = None;
            }
        }
        assert_eq!(full.offers.len(), 13);
        assert_eq!(compact, full);
    }
}
