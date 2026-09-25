/*!
 * Cart and Checkout Validation Function — Rust.
 * Execution budget: 5ms HARD LIMIT. This MUST be Rust.
 *
 * Runs AFTER Discount Function at checkout — can see applied discounts.
 * Runs across ALL express checkout surfaces (Shop Pay, PayPal, Google Pay, Apple Pay).
 *
 * Blocks checkout when:
 * - Gift quantity exceeds allowed maximum
 * - Gift variant is not in the allowed gift set (tampered properties)
 * - Clone gift product is being purchased directly (price ~$0, no promo properties)
 * - Bundle is incomplete (parent without components or vice versa)
 */

use serde::{Deserialize, Serialize};
use shopify_function::wasm_api::{self, Context, Serialize as ShopifySerialize};
use std::collections::{HashMap, HashSet};

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct FunctionInput {
    pub cart: Cart,
    pub buyer_journey: Option<BuyerJourney>,
    pub validation_node: ValidationNode,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct BuyerJourney {
    pub step: Option<String>,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct Cart {
    pub lines: Vec<CartLine>,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct CartLine {
    pub id: String,
    pub quantity: i64,
    pub merchandise: Merchandise,
    pub line_type: Option<Attribute>,
    pub offer_id: Option<Attribute>,
    pub reward_id: Option<Attribute>,
    pub offer_version: Option<Attribute>,
    pub cost: LineCost,
    pub discount_allocations: Vec<DiscountAllocation>,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct Merchandise {
    pub id: String,
    pub product: Product,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct Product {
    pub id: String,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct Attribute {
    pub value: Option<String>,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct LineCost {
    pub amount_per_quantity: Money,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct Money {
    pub amount: String,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct DiscountAllocation {
    pub discounted_amount: Money,
    pub discount_application: DiscountApplication,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct DiscountApplication {
    pub metafield: Option<Metafield>,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct ValidationNode {
    pub metafield: Option<Metafield>,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct Metafield {
    pub value: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationConfig {
    /// Strict per-offer and per-reward rules used by current publishes.
    #[serde(default)]
    pub offer_rules: HashMap<String, GiftOfferRule>,
    /// Map of offerId → max gift quantity allowed
    #[serde(default)]
    pub offer_max_quantities: HashMap<String, i64>,
    /// Set of all allowed gift variant GIDs (for all active offers)
    #[serde(default)]
    pub allowed_gift_variant_ids: Vec<String>,
    /// Set of clone product GIDs that should NOT be directly purchasable
    #[serde(default)]
    pub clone_product_ids: Vec<String>,
    /// Min price in cents — clone products at $0 (or very low) outside of offer context are suspicious
    pub clone_min_price_cents: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftOfferRule {
    pub version: i64,
    pub max_quantity: i64,
    pub rewards: HashMap<String, GiftRewardRule>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftRewardRule {
    pub max_quantity: i64,
    pub variant_ids: Vec<String>,
}

// ─── Output ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionOutput {
    pub operations: Vec<Operation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub validation_add: ValidationAdd,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationAdd {
    pub errors: Vec<ValidationError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationError {
    pub message: String,
    pub target: String,
}

impl ShopifySerialize for FunctionOutput {
    fn serialize(&self, context: &mut Context) -> Result<(), wasm_api::write::Error> {
        context.write_object(
            |context| {
                context.write_utf8_str("operations")?;
                ShopifySerialize::serialize(&self.operations, context)
            },
            1,
        )
    }
}

impl ShopifySerialize for Operation {
    fn serialize(&self, context: &mut Context) -> Result<(), wasm_api::write::Error> {
        context.write_object(
            |context| {
                context.write_utf8_str("validationAdd")?;
                ShopifySerialize::serialize(&self.validation_add, context)
            },
            1,
        )
    }
}

impl ShopifySerialize for ValidationAdd {
    fn serialize(&self, context: &mut Context) -> Result<(), wasm_api::write::Error> {
        context.write_object(
            |context| {
                context.write_utf8_str("errors")?;
                ShopifySerialize::serialize(&self.errors, context)
            },
            1,
        )
    }
}

impl ShopifySerialize for ValidationError {
    fn serialize(&self, context: &mut Context) -> Result<(), wasm_api::write::Error> {
        context.write_object(
            |context| {
                context.write_utf8_str("message")?;
                ShopifySerialize::serialize(&self.message, context)?;
                context.write_utf8_str("target")?;
                ShopifySerialize::serialize(&self.target, context)
            },
            2,
        )
    }
}

// ─── Main function ────────────────────────────────────────────────────────────

pub fn function(input: FunctionInput) -> FunctionOutput {
    let config = match parse_config(&input.validation_node) {
        Some(c) => c,
        None => return FunctionOutput { operations: vec![] }, // No config = no validation (fail open)
    };

    let allowed_variants: HashSet<&str> =
        config.allowed_gift_variant_ids.iter().map(|s| s.as_str()).collect();
    let clone_products: HashSet<&str> =
        config.clone_product_ids.iter().map(|s| s.as_str()).collect();

    // During cart edits the storefront runtime removes a gift that stopped qualifying, but only
    // after the edit succeeds; rejecting it here would stop customers removing the product that
    // unlocked the gift. Checkout still blocks any gift our discount no longer covers.
    let cart_interaction = input
        .buyer_journey
        .as_ref()
        .and_then(|journey| journey.step.as_deref())
        == Some("CART_INTERACTION");

    let mut errors: Vec<ValidationError> = Vec::new();

    let mut gift_qty_by_offer: HashMap<String, i64> = HashMap::new();
    let mut gift_qty_by_reward: HashMap<(String, String), i64> = HashMap::new();
    let strict_rules_enabled = !config.offer_rules.is_empty();

    for line in &input.cart.lines {
        let line_type = attribute_value(&line.line_type);
        let offer_id = attribute_value(&line.offer_id);

        if line_type == "gift" {
            let reward_id = attribute_value(&line.reward_id);
            let offer_version = attribute_value(&line.offer_version);
            if line.quantity <= 0 || offer_id.is_empty() || reward_id.is_empty() || offer_version.is_empty() {
                errors.push(ValidationError {
                    message: "Your cart contains an invalid free gift. Please contact support.".to_string(),
                    target: "$.cart".to_string(),
                });
                continue;
            }

            if strict_rules_enabled {
                let Some(offer_rule) = config.offer_rules.get(offer_id) else {
                    errors.push(ValidationError {
                        message: "This free gift offer is no longer active. Please update your cart.".to_string(),
                        target: "$.cart".to_string(),
                    });
                    continue;
                };
                let Some(reward_rule) = offer_rule.rewards.get(reward_id) else {
                    errors.push(ValidationError {
                        message: "Your cart contains an invalid free gift. Please update your cart.".to_string(),
                        target: "$.cart".to_string(),
                    });
                    continue;
                };
                if offer_version != offer_rule.version.to_string()
                    || !reward_rule.variant_ids.iter().any(|id| id == &line.merchandise.id)
                {
                    errors.push(ValidationError {
                        message: "This free gift selection is outdated or invalid. Please choose it again.".to_string(),
                        target: "$.cart".to_string(),
                    });
                    continue;
                }
                *gift_qty_by_reward
                    .entry((offer_id.to_string(), reward_id.to_string()))
                    .or_insert(0) += line.quantity;
            } else if !allowed_variants.contains(line.merchandise.id.as_str()) {
                errors.push(ValidationError {
                    message: "Your cart contains an invalid free gift. Please contact support.".to_string(),
                    target: "$.cart".to_string(),
                });
                continue;
            }

            // Cart validation runs after discounts. Requiring an allocation
            // from our own discount node proves the server-side offer
            // conditions qualified; browser-controlled line attributes alone
            // can never authorize a freebie.
            if !cart_interaction && !has_promo_engine_discount(line) {
                errors.push(ValidationError {
                    message: "This free gift is not eligible for the current cart. Please update your cart.".to_string(),
                    target: "$.cart".to_string(),
                });
                continue;
            }

            *gift_qty_by_offer.entry(offer_id.to_string()).or_insert(0) += line.quantity;
        }

        // ── Block direct purchase of clone products ───────────────────────────
        if clone_products.contains(line.merchandise.product.id.as_str()) && line_type != "gift" {
            let price_cents = parse_amount(&line.cost.amount_per_quantity.amount);
            let min_price = config.clone_min_price_cents.unwrap_or(100); // $1 default
            if price_cents < min_price {
                errors.push(ValidationError {
                    message: "This product is only available as part of a promotion. Please add it through the offer.".to_string(),
                    target: "$.cart".to_string(),
                });
            }
        }
    }

    // ── Check max gift quantity per offer ─────────────────────────────────────
    // If an offer is not in offer_max_quantities, apply a conservative default of 1
    // to prevent unlimited gifts from newly-created offers whose config wasn't published yet.
    const DEFAULT_MAX_GIFT_QTY: i64 = 1;
    for (offer_id, qty) in &gift_qty_by_offer {
        let max_qty = config.offer_rules.get(offer_id)
            .map(|rule| rule.max_quantity)
            .or_else(|| config.offer_max_quantities.get(offer_id).copied())
            .unwrap_or(DEFAULT_MAX_GIFT_QTY);
        if *qty > max_qty {
            errors.push(ValidationError {
                message: format!(
                    "You can only add {} free gift(s) with this offer. Please update your cart.",
                    max_qty
                ),
                target: "$.cart".to_string(),
            });
        }
    }

    for ((offer_id, reward_id), qty) in &gift_qty_by_reward {
        let max_qty = config.offer_rules
            .get(offer_id)
            .and_then(|offer| offer.rewards.get(reward_id))
            .map(|reward| reward.max_quantity)
            .unwrap_or(0);
        if *qty > max_qty {
            errors.push(ValidationError {
                message: format!("You can only add {} gift(s) for this reward. Please update your cart.", max_qty),
                target: "$.cart".to_string(),
            });
        }
    }

    if errors.is_empty() {
        FunctionOutput { operations: vec![] }
    } else {
        FunctionOutput {
            operations: vec![Operation { validation_add: ValidationAdd { errors } }],
        }
    }
}

#[shopify_function::shopify_function]
fn run(input: FunctionInput) -> shopify_function::Result<FunctionOutput> {
    Ok(function(input))
}

fn parse_config(node: &ValidationNode) -> Option<ValidationConfig> {
    let value = node.metafield.as_ref()?.value.as_str();
    serde_json::from_str(value).ok()
}

fn attribute_value(attribute: &Option<Attribute>) -> &str {
    attribute.as_ref().and_then(|value| value.value.as_deref()).unwrap_or("")
}

fn parse_amount(amount_str: &str) -> i64 {
    let amount: f64 = amount_str.parse().unwrap_or(0.0);
    (amount * 100.0).round() as i64
}

fn has_promo_engine_discount(line: &CartLine) -> bool {
    line.discount_allocations.iter().any(|allocation| {
        allocation.discount_application.metafield.is_some()
            && parse_amount(&allocation.discounted_amount.amount) > 0
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config(max_qty: i64, allowed_variants: Vec<&str>, clone_products: Vec<&str>) -> ValidationConfig {
        ValidationConfig {
            offer_rules: HashMap::new(),
            offer_max_quantities: {
                let mut m = HashMap::new();
                m.insert("offer-1".to_string(), max_qty);
                m
            },
            allowed_gift_variant_ids: allowed_variants.iter().map(|s| s.to_string()).collect(),
            clone_product_ids: clone_products.iter().map(|s| s.to_string()).collect(),
            clone_min_price_cents: Some(100),
        }
    }

    fn make_gift_line(line_id: &str, variant_id: &str, product_id: &str, offer_id: &str, qty: i64) -> CartLine {
        CartLine {
            id: line_id.to_string(),
            quantity: qty,
            merchandise: Merchandise {
                id: variant_id.to_string(),
                product: Product { id: product_id.to_string() },
            },
            line_type: Some(Attribute { value: Some("gift".to_string()) }),
            offer_id: Some(Attribute { value: Some(offer_id.to_string()) }),
            reward_id: Some(Attribute { value: Some("reward-1".to_string()) }),
            offer_version: Some(Attribute { value: Some("1".to_string()) }),
            cost: LineCost { amount_per_quantity: Money { amount: "0.00".to_string() } },
            discount_allocations: vec![DiscountAllocation {
                discounted_amount: Money { amount: "10.00".to_string() },
                discount_application: DiscountApplication {
                    metafield: Some(Metafield { value: "promo-config".to_string() }),
                },
            }],
        }
    }

    fn validation_errors(output: &FunctionOutput) -> &[ValidationError] {
        output.operations
            .first()
            .map(|operation| operation.validation_add.errors.as_slice())
            .unwrap_or(&[])
    }

    #[test]
    fn test_valid_gift_passes() {
        let config = make_config(2, vec!["gid://shopify/ProductVariant/gift-v1"], vec![]);
        let config_json = serde_json::to_string(&config).unwrap();
        let line = make_gift_line("l1", "gid://shopify/ProductVariant/gift-v1", "p1", "offer-1", 1);
        let input = FunctionInput {
            buyer_journey: None,
            cart: Cart { lines: vec![line] },
            validation_node: ValidationNode { metafield: Some(Metafield { value: config_json }) },
        };
        let output = function(input);
        assert!(validation_errors(&output).is_empty());
    }

    #[test]
    fn test_excess_gift_quantity_blocked() {
        let config = make_config(1, vec!["gid://shopify/ProductVariant/gift-v1"], vec![]);
        let config_json = serde_json::to_string(&config).unwrap();
        // Buyer has 3 gifts but max is 1
        let line = make_gift_line("l1", "gid://shopify/ProductVariant/gift-v1", "p1", "offer-1", 3);
        let input = FunctionInput {
            buyer_journey: None,
            cart: Cart { lines: vec![line] },
            validation_node: ValidationNode { metafield: Some(Metafield { value: config_json }) },
        };
        let output = function(input);
        assert_eq!(validation_errors(&output).len(), 1);
        assert!(validation_errors(&output)[0].message.contains("1 free gift"));
    }

    #[test]
    fn test_invalid_gift_variant_blocked() {
        let config = make_config(2, vec!["gid://shopify/ProductVariant/allowed-gift"], vec![]);
        let config_json = serde_json::to_string(&config).unwrap();
        // Using a variant NOT in the allowed list
        let line = make_gift_line("l1", "gid://shopify/ProductVariant/expensive-product", "p1", "offer-1", 1);
        let input = FunctionInput {
            buyer_journey: None,
            cart: Cart { lines: vec![line] },
            validation_node: ValidationNode { metafield: Some(Metafield { value: config_json }) },
        };
        let output = function(input);
        assert_eq!(validation_errors(&output).len(), 1);
        assert!(validation_errors(&output)[0].message.contains("invalid"));
    }

    #[test]
    fn test_offer_not_in_max_quantities_uses_default() {
        // Config that knows about offer-1 but NOT offer-2
        let config = ValidationConfig {
            offer_rules: HashMap::new(),
            offer_max_quantities: {
                let mut m = HashMap::new();
                m.insert("offer-1".to_string(), 5_i64);
                m
            },
            allowed_gift_variant_ids: vec!["gid://shopify/ProductVariant/gift-v1".to_string()],
            clone_product_ids: vec![],
            clone_min_price_cents: Some(100),
        };
        let config_json = serde_json::to_string(&config).unwrap();
        // offer-2 is not in max_quantities — buyer tries to add 2 gifts (> DEFAULT_MAX of 1)
        let line = make_gift_line("l1", "gid://shopify/ProductVariant/gift-v1", "p1", "offer-2", 2);
        let input = FunctionInput {
            buyer_journey: None,
            cart: Cart { lines: vec![line] },
            validation_node: ValidationNode { metafield: Some(Metafield { value: config_json }) },
        };
        let output = function(input);
        assert_eq!(validation_errors(&output).len(), 1, "Unknown offer should fall back to DEFAULT_MAX_GIFT_QTY=1");
    }

    #[test]
    fn test_no_config_fails_open() {
        let input = FunctionInput {
            buyer_journey: None,
            cart: Cart { lines: vec![] },
            validation_node: ValidationNode { metafield: None },
        };
        let output = function(input);
        assert!(output.operations.is_empty(), "No config should fail open — never block checkout");
    }

    fn strict_config() -> ValidationConfig {
        ValidationConfig {
            offer_rules: {
                let mut offers = HashMap::new();
                offers.insert("offer-1".to_string(), GiftOfferRule {
                    version: 3,
                    max_quantity: 2,
                    rewards: {
                        let mut rewards = HashMap::new();
                        rewards.insert("reward-1".to_string(), GiftRewardRule {
                            max_quantity: 1,
                            variant_ids: vec!["gid://shopify/ProductVariant/gift-v1".to_string()],
                        });
                        rewards.insert("reward-2".to_string(), GiftRewardRule {
                            max_quantity: 1,
                            variant_ids: vec!["gid://shopify/ProductVariant/gift-v2".to_string()],
                        });
                        rewards
                    },
                });
                offers
            },
            offer_max_quantities: HashMap::new(),
            allowed_gift_variant_ids: vec![],
            clone_product_ids: vec![],
            clone_min_price_cents: Some(100),
        }
    }

    fn set_gift_metadata(line: &mut CartLine, reward_id: &str, version: &str) {
        line.reward_id = Some(Attribute { value: Some(reward_id.to_string()) });
        line.offer_version = Some(Attribute { value: Some(version.to_string()) });
    }

    fn run_with_config(config: ValidationConfig, lines: Vec<CartLine>) -> FunctionOutput {
        run_at_step(config, lines, None)
    }

    fn run_at_step(config: ValidationConfig, lines: Vec<CartLine>, step: Option<&str>) -> FunctionOutput {
        function(FunctionInput {
            buyer_journey: Some(BuyerJourney { step: step.map(str::to_string) }),
            cart: Cart { lines },
            validation_node: ValidationNode {
                metafield: Some(Metafield { value: serde_json::to_string(&config).unwrap() }),
            },
        })
    }

    #[test]
    fn strict_rules_bind_variant_to_offer_reward_and_version() {
        let mut cross_reward = make_gift_line(
            "l1",
            "gid://shopify/ProductVariant/gift-v2",
            "p2",
            "offer-1",
            1,
        );
        set_gift_metadata(&mut cross_reward, "reward-1", "3");
        let output = run_with_config(strict_config(), vec![cross_reward]);
        assert_eq!(validation_errors(&output).len(), 1);

        let mut stale = make_gift_line(
            "l2",
            "gid://shopify/ProductVariant/gift-v1",
            "p1",
            "offer-1",
            1,
        );
        set_gift_metadata(&mut stale, "reward-1", "2");
        let output = run_with_config(strict_config(), vec![stale]);
        assert_eq!(validation_errors(&output).len(), 1);
    }

    #[test]
    fn strict_rules_reject_unknown_offers_and_reward_quantity_abuse() {
        let mut unknown = make_gift_line(
            "l1",
            "gid://shopify/ProductVariant/gift-v1",
            "p1",
            "offer-unknown",
            1,
        );
        set_gift_metadata(&mut unknown, "reward-1", "3");
        let output = run_with_config(strict_config(), vec![unknown]);
        assert_eq!(validation_errors(&output).len(), 1);

        let mut excessive = make_gift_line(
            "l2",
            "gid://shopify/ProductVariant/gift-v1",
            "p1",
            "offer-1",
            2,
        );
        set_gift_metadata(&mut excessive, "reward-1", "3");
        let output = run_with_config(strict_config(), vec![excessive]);
        assert!(validation_errors(&output).iter().any(|error| error.message.contains("this reward")));
    }

    #[test]
    fn allows_undiscounted_gift_during_cart_edits_but_blocks_checkout() {
        let make = || {
            let mut line = make_gift_line("l1", "gid://shopify/ProductVariant/gift-v1", "p1", "offer-1", 1);
            set_gift_metadata(&mut line, "reward-1", "3");
            line.discount_allocations.clear();
            line
        };
        let not_eligible = |output: &FunctionOutput| {
            validation_errors(output).iter().any(|error| error.message.contains("not eligible"))
        };
        assert!(!not_eligible(&run_at_step(strict_config(), vec![make()], Some("CART_INTERACTION"))));
        assert!(not_eligible(&run_at_step(strict_config(), vec![make()], Some("CHECKOUT_INTERACTION"))));
        assert!(not_eligible(&run_at_step(strict_config(), vec![make()], Some("CHECKOUT_COMPLETION"))));
    }

    #[test]
    fn rejects_spoofed_gift_metadata_without_our_applied_discount() {
        let mut line = make_gift_line(
            "l1",
            "gid://shopify/ProductVariant/gift-v1",
            "p1",
            "offer-1",
            1,
        );
        set_gift_metadata(&mut line, "reward-1", "3");
        line.discount_allocations.clear();

        let output = run_with_config(strict_config(), vec![line]);
        assert!(validation_errors(&output)
            .iter()
            .any(|error| error.message.contains("not eligible")));
    }

    #[test]
    fn serializes_current_validation_add_contract() {
        let mut line = make_gift_line(
            "l1",
            "gid://shopify/ProductVariant/gift-v1",
            "p1",
            "offer-1",
            2,
        );
        set_gift_metadata(&mut line, "reward-1", "3");
        let output = run_with_config(strict_config(), vec![line]);
        let json = serde_json::to_value(output).unwrap();
        assert!(json["operations"][0]["validationAdd"]["errors"].is_array());
        assert_eq!(json["operations"][0]["validationAdd"]["errors"][0]["target"], "$.cart");
    }
}
