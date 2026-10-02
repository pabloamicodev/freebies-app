pub use crate::page_match::CompiledPageUrlCondition;
use serde::{Deserialize, Deserializer};
use serde_json::value::RawValue;
use std::collections::HashMap;

/// Compiled config — parsed from the `promo_engine.function_config` metafield.
/// This is our own JSON shape (written by the offer-publisher worker), unrelated
/// to Shopify's GraphQL schema, so it stays hand-written serde like before.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(PartialEq))]
#[serde(rename_all = "camelCase")]
pub struct CompiledConfig {
    #[serde(deserialize_with = "lenient_offers")]
    pub offers: Vec<CompiledOffer>,
    #[serde(default)]
    #[cfg_attr(feature = "code_gate", allow(dead_code))]
    pub c1: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "code_gate", allow(dead_code))]
    pub c2: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "code_gate", allow(dead_code))]
    pub c3: Option<String>,
}

/// Offers are parsed one at a time: a malformed offer is skipped and the others still apply.
fn lenient_offers<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<CompiledOffer>, D::Error> {
    let raw = Vec::<Box<RawValue>>::deserialize(deserializer)?;
    Ok(raw
        .iter()
        .filter_map(|offer| serde_json::from_str(offer.get()).ok())
        .collect())
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
    pub struct CompiledOffer {
        "id" => id: String,
        #[allow(dead_code)]
        "version" => version: i32,
        "offerType" => offer_type: String,
        "title" => title: Option<String> = None,
        "priority" => priority: i32,
        "stopLowerPriority" => stop_lower_priority: bool = false,
        "requiredProductIds" => required_product_ids: Vec<String> = Vec::new(),
        "requiredVariantIds" => required_variant_ids: Vec<String> = Vec::new(),
        "anyRequiredProductIds" => any_required_product_ids: Vec<String> = Vec::new(),
        "anyRequiredVariantIds" => any_required_variant_ids: Vec<String> = Vec::new(),
        "excludedProductIds" => excluded_product_ids: Vec<String> = Vec::new(),
        "cartValueThresholdCents" => cart_value_threshold_cents: Option<i64> = None,
        "cartValueMaxCents" => cart_value_max_cents: Option<i64> = None,
        "cartQuantityThreshold" => cart_quantity_threshold: Option<i64> = None,
        "cartQuantityMax" => cart_quantity_max: Option<i64> = None,
        "subscriptionMode" => subscription_mode: Option<String> = None,
        "customerOrderCountMin" => customer_order_count_min: Option<i64> = None,
        "customerOrderCountMax" => customer_order_count_max: Option<i64> = None,
        "customerAmountSpentMinCents" => customer_amount_spent_min_cents: Option<i64> = None,
        "customerAmountSpentMaxCents" => customer_amount_spent_max_cents: Option<i64> = None,
        "requiredCustomerTags" => required_customer_tags: Vec<String> = Vec::new(),
        "excludedCustomerTags" => excluded_customer_tags: Vec<String> = Vec::new(),
        "treatGuestAsNoTags" => treat_guest_as_no_tags: bool = default_treat_guest_as_no_tags(),
        "includeCountryCodes" => include_country_codes: Vec<String> = Vec::new(),
        "excludeCountryCodes" => exclude_country_codes: Vec<String> = Vec::new(),
        "discountType" => discount_type: String = default_discount_type(),
        "discountValue" => discount_value: f64 = default_discount_value(),
        "currencyCode" => currency_code: String = default_currency_code(),
        "currencyOverrides" => currency_overrides: Option<HashMap<String, i64>> = None,
        "maxCurrencyOverrides" => max_currency_overrides: Option<HashMap<String, i64>> = None,
        "requirements" => requirements: Vec<CompiledRequirement> = Vec::new(),
        "giftRewards" => gift_rewards: Vec<CompiledGiftReward> = Vec::new(),
        "productRewards" => product_rewards: Vec<CompiledProductReward> = Vec::new(),
        "orderRewards" => order_rewards: Vec<CompiledOrderReward> = Vec::new(),
        "lineAttributeConditions" => line_attribute_conditions: Vec<CompiledAttributeCondition> = Vec::new(),
        "cartAttributeConditions" => cart_attribute_conditions: Vec<CompiledAttributeCondition> = Vec::new(),
        "pageUrlConditions" => page_url_conditions: Vec<CompiledPageUrlCondition> = Vec::new(),
        // Product/order rewards only touch lines whose `_promo_page_url` matches
        // every page URL condition (the lines added from the campaign page).
        "restrictToMatchedLines" => restrict_to_matched_lines: bool = false,
        // The offer does not apply while any non-gift line misses a page URL condition.
        "rejectUnmatchedLines" => reject_unmatched_lines: bool = false,
        // Truncated FNV-1a-64 hashes of this offer's discount codes (code-discount Function only).
        #[cfg(feature = "code_gate")]
        "codeHashes" => code_hashes: Vec<String> = Vec::new(),
    }
}

fn scale_cents(cents: &mut Option<i64>, rate: f64) {
    if let Some(value) = cents {
        *value = (*value as f64 * rate).ceil() as i64;
    }
}

fn scale_money(discount_type: &str, value: &mut f64, rate: f64) {
    if discount_type.starts_with("fixed") {
        *value *= rate;
    }
}

impl CompiledConfig {
    /// Config money is in the shop currency; checkout amounts (and the fixed
    /// discount amounts Shopify expects back) are in the cart's presentment
    /// currency. Explicit per-currency overrides win over the converted value.
    pub fn localize(&mut self, rate: f64, active_currency: &str) {
        let minor_units = |code: &str| if is_zero_decimal(code) { 1.0 } else { 100.0 };
        let localize_threshold =
            |cents: &mut Option<i64>, overrides: &Option<HashMap<String, i64>>, cents_rate: f64| {
                match overrides.as_ref().and_then(|map| map.get(active_currency)) {
                    Some(&value) if cents.is_some() => *cents = Some(value),
                    _ => scale_cents(cents, cents_rate),
                }
            };
        for offer in &mut self.offers {
            let cents_rate = rate * minor_units(active_currency) / minor_units(&offer.currency_code);
            localize_threshold(&mut offer.cart_value_threshold_cents, &offer.currency_overrides, cents_rate);
            localize_threshold(&mut offer.cart_value_max_cents, &offer.max_currency_overrides, cents_rate);
            for reward in &mut offer.gift_rewards {
                scale_money(&reward.discount_type, &mut reward.discount_value, rate);
            }
            for reward in &mut offer.product_rewards {
                scale_money(&reward.discount_type, &mut reward.discount_value, rate);
                for tier in &mut reward.price_tiers {
                    tier.target_price_per_unit *= rate;
                }
                for tier in &mut reward.quantity_tiers {
                    scale_money(&tier.discount_type, &mut tier.discount_value, rate);
                }
            }
            for reward in &mut offer.order_rewards {
                scale_money(&reward.discount_type, &mut reward.discount_value, rate);
                for tier in &mut reward.subtotal_tiers {
                    scale_cents(&mut tier.minimum_subtotal_cents, cents_rate);
                    scale_cents(&mut tier.maximum_subtotal_cents, cents_rate);
                    scale_money(&tier.discount_type, &mut tier.discount_value, rate);
                }
            }
        }
    }
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

de_struct! {
    #[derive(Debug, Clone)]
    #[cfg_attr(test, derive(PartialEq))]
    pub struct CompiledAttributeCondition {
        "key" => key: String,
        "value" => value: Option<String> = None,
        "matchMode" => match_mode: String,
        "minMatchingQuantity" => min_matching_quantity: i64,
    }
}

de_struct! {
    #[derive(Debug, Clone)]
    #[cfg_attr(test, derive(PartialEq))]
    pub struct CompiledGiftReward {
        "id" => id: String,
        "targetProductIds" => target_product_ids: Vec<String> = Vec::new(),
        "targetVariantIds" => target_variant_ids: Vec<String> = Vec::new(),
        "discountType" => discount_type: String,
        "discountValue" => discount_value: f64,
        "maxQuantity" => max_quantity: i64,
        // Customer-picked ("choose K of N") reward: its free units are capped across all N gifts.
        "selectable" => selectable: bool = false,
        // How many gifts the shopper may pick from a selectable reward (default 1).
        "selectionCount" => selection_count: Option<i64> = None,
    }
}

de_struct! {
    #[derive(Debug, Clone)]
    #[cfg_attr(test, derive(PartialEq))]
    pub struct CompiledRequirement {
        "productId" => product_id: Option<String> = None,
        "variantId" => variant_id: Option<String> = None,
        "trackMode" => track_mode: String,
        "minQuantity" => min_quantity: i64,
        "maxQuantity" => max_quantity: Option<i64> = None,
    }
}

de_struct! {
    #[derive(Debug, Clone)]
    #[cfg_attr(test, derive(PartialEq))]
    pub struct CompiledProductReward {
        "targetProductIds" => target_product_ids: Vec<String> = Vec::new(),
        "targetVariantIds" => target_variant_ids: Vec<String> = Vec::new(),
        "discountType" => discount_type: String,
        "discountValue" => discount_value: f64,
        "maxQuantity" => max_quantity: Option<i64> = None,
        "lineQuantityEquals" => line_quantity_equals: Option<i64> = None,
        "maxUnitsTotal" => max_units_total: Option<i64> = None,
        "maxUnitsPerProduct" => max_units_per_product: Option<i64> = None,
        "maxUnitsPerLine" => max_units_per_line: Option<i64> = None,
        "maxUnitsPerVariant" => max_units_per_variant: Option<i64> = None,
        "subscriptionMode" => subscription_mode: String = default_subscription_mode(),
        "scopeMode" => scope_mode: String = default_shipping_scope(),
        "requiredOfferId" => required_offer_id: Option<String> = None,
        "requiredLineAttributeValue" => required_line_attribute_value: Option<String> = None,
        "requiredAnchorVariantIds" => required_anchor_variant_ids: Vec<String> = Vec::new(),
        "requiredAnchorMinQuantity" => required_anchor_min_quantity: i64 = default_anchor_quantity(),
        "requiresAnchorSubscription" => requires_anchor_subscription: bool = false,
        "priceTiers" => price_tiers: Vec<ProductPriceTier> = Vec::new(),
        "quantityTiers" => quantity_tiers: Vec<ProductDiscountTier> = Vec::new(),
        "selectionMode" => selection_mode: String = default_selection_mode(),
        "countRule" => count_rule: String = default_count_rule(),
        "discountPercentageOnGifts" => discount_percentage_on_gifts: f64 = default_gift_percentage(),
        "requiredLineAttribute" => required_line_attribute: Option<RequiredLineAttribute> = None,
        // Quiz bundles only: upper bound (share of the paid lines' subtotal) on the discount derived
        // from the client-set `_quiz_target_cents`. None means no extra cap.
        "quizMaxDiscountPercent" => quiz_max_discount_percent: Option<f64> = None,
    }
}

fn default_gift_percentage() -> f64 {
    100.0
}

de_struct! {
    #[derive(Debug, Clone)]
    #[cfg_attr(test, derive(PartialEq))]
    pub struct RequiredLineAttribute {
        "key" => key: String,
        "value" => value: String,
    }
}

fn default_count_rule() -> String {
    "all".to_string()
}

fn default_selection_mode() -> String {
    "all".to_string()
}

de_struct! {
    #[derive(Debug, Clone)]
    #[cfg_attr(test, derive(PartialEq))]
    pub struct ProductPriceTier {
        "quantity" => quantity: i64,
        "targetPricePerUnit" => target_price_per_unit: f64,
    }
}

de_struct! {
    #[derive(Debug, Clone)]
    #[cfg_attr(test, derive(PartialEq))]
    pub struct ProductDiscountTier {
        "minimumQuantity" => minimum_quantity: i64,
        "maximumQuantity" => maximum_quantity: Option<i64> = None,
        "discountType" => discount_type: String,
        "discountValue" => discount_value: f64,
        "discountedQuantity" => discounted_quantity: Option<i64> = None,
    }
}

de_struct! {
    #[derive(Debug, Clone)]
    #[cfg_attr(test, derive(PartialEq))]
    pub struct CompiledOrderReward {
        "discountType" => discount_type: String,
        "discountValue" => discount_value: f64,
        "subtotalTiers" => subtotal_tiers: Vec<OrderSubtotalDiscountTier> = Vec::new(),
    }
}

de_struct! {
    #[derive(Debug, Clone)]
    #[cfg_attr(test, derive(PartialEq))]
    pub struct OrderSubtotalDiscountTier {
        "minimumSubtotalCents" => minimum_subtotal_cents: Option<i64> = None,
        "maximumSubtotalCents" => maximum_subtotal_cents: Option<i64> = None,
        "minimumQuantity" => minimum_quantity: Option<i64> = None,
        "maximumQuantity" => maximum_quantity: Option<i64> = None,
        "discountType" => discount_type: String,
        "discountValue" => discount_value: f64,
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

    const FULL_FIXTURE: &str = include_str!("fixtures/ambrosia-function-config.full.json");
    const COMPACT_FIXTURE: &str = include_str!("fixtures/ambrosia-function-config.compact.json");

    #[test]
    fn compact_metafield_deserializes_to_the_full_config() {
        let full: CompiledConfig = serde_json::from_str(FULL_FIXTURE).unwrap();
        let mut compact: CompiledConfig = serde_json::from_str(COMPACT_FIXTURE).unwrap();
        // Query-variable placeholders never equal a real attribute key, so they behave like None.
        for slot in [&mut compact.c1, &mut compact.c2, &mut compact.c3] {
            if slot.as_deref() == Some("_promo_engine_unused") {
                *slot = None;
            }
        }
        assert_eq!(full.offers.len(), 13);
        assert_eq!(compact, full);
    }
    fn parse(offers: &str) -> CompiledConfig {
        serde_json::from_str(&format!(r#"{{"offers":{offers}}}"#)).unwrap()
    }

    #[test]
    fn map_only_deserializer_applies_defaults_and_ignores_unknown_keys() {
        let config = parse(r#"[{"id":"a","version":1,"offerType":"gift","priority":2,"future":{"x":[1]},
            "giftRewards":[{"id":"g","discountType":"free","discountValue":100,"maxQuantity":1,"extra":null}]}]"#);
        let offer = &config.offers[0];
        assert_eq!((offer.discount_type.as_str(), offer.discount_value), ("free", 100.0));
        assert!(offer.treat_guest_as_no_tags && offer.title.is_none() && offer.required_product_ids.is_empty());
        assert_eq!(offer.gift_rewards[0].selection_count, None);
    }

    #[test]
    fn malformed_offers_are_skipped_not_fatal() {
        // missing required `priority`; wrong type for `priority`; array instead of object; a valid one
        let config = parse(
            r#"[{"id":"a","version":1,"offerType":"gift"},
                {"id":"b","version":1,"offerType":"gift","priority":"1"},
                [1,2,3],
                {"id":"ok","version":1,"offerType":"gift","priority":1,"cartValueMaxCents":null}]"#,
        );
        assert_eq!(config.offers.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), ["ok"]);
    }

    #[test]
    fn nested_required_field_missing_skips_the_whole_offer() {
        let config = parse(
            r#"[{"id":"a","version":1,"offerType":"gift","priority":1,"requirements":[{"trackMode":"any"}]}]"#,
        );
        assert!(config.offers.is_empty());
    }
}
