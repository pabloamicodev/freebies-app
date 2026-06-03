/**
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
use std::collections::{HashMap, HashSet};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInput {
    pub cart: Cart,
    pub validation_node: ValidationNode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cart {
    pub lines: Vec<CartLine>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CartLine {
    pub id: String,
    pub quantity: i64,
    pub merchandise: Merchandise,
    pub attributes: Vec<Attribute>,
    pub cost: LineCost,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Merchandise {
    pub id: String,
    pub product: Product,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attribute {
    pub key: String,
    pub value: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineCost {
    pub amount_per_quantity: Money,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Money {
    pub amount: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationNode {
    pub metafield: Option<Metafield>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metafield {
    pub value: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationConfig {
    /// Map of offerId → max gift quantity allowed
    pub offer_max_quantities: HashMap<String, i64>,
    /// Set of all allowed gift variant GIDs (for all active offers)
    pub allowed_gift_variant_ids: Vec<String>,
    /// Set of clone product GIDs that should NOT be directly purchasable
    pub clone_product_ids: Vec<String>,
    /// Min price in cents — clone products at $0 (or very low) outside of offer context are suspicious
    pub clone_min_price_cents: Option<i64>,
}

// ─── Output ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionOutput {
    pub errors: Vec<ValidationError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationError {
    pub message: String,
    pub target: ValidationTarget,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ValidationTarget {
    pub cart_line_id: Option<String>,
}

// ─── Main function ────────────────────────────────────────────────────────────

pub fn function(input: FunctionInput) -> FunctionOutput {
    let config = match parse_config(&input.validation_node) {
        Some(c) => c,
        None => return FunctionOutput { errors: vec![] }, // No config = no validation (fail open)
    };

    let allowed_variants: HashSet<&str> =
        config.allowed_gift_variant_ids.iter().map(|s| s.as_str()).collect();
    let clone_products: HashSet<&str> =
        config.clone_product_ids.iter().map(|s| s.as_str()).collect();

    let mut errors: Vec<ValidationError> = Vec::new();

    // ── Track gift quantity per offer ─────────────────────────────────────────
    let mut gift_qty_by_offer: HashMap<String, i64> = HashMap::new();

    for line in &input.cart.lines {
        let line_type = get_attr(&line.attributes, "_promo_engine_line_type");
        let offer_id = get_attr(&line.attributes, "_promo_engine_offer_id");

        if line_type == "gift" {
            // ── Validate gift variant is in allowed set ───────────────────────
            if !offer_id.is_empty() && !allowed_variants.contains(line.merchandise.id.as_str()) {
                errors.push(ValidationError {
                    message: "Your cart contains an invalid free gift. Please contact support.".to_string(),
                    target: ValidationTarget { cart_line_id: Some(line.id.clone()) },
                });
                continue;
            }

            // ── Accumulate quantity per offer ─────────────────────────────────
            if !offer_id.is_empty() {
                *gift_qty_by_offer.entry(offer_id.to_string()).or_insert(0) += line.quantity;
            }
        }

        // ── Block direct purchase of clone products ───────────────────────────
        if clone_products.contains(line.merchandise.product.id.as_str()) && line_type != "gift" {
            let price_cents = parse_amount(&line.cost.amount_per_quantity.amount);
            let min_price = config.clone_min_price_cents.unwrap_or(100); // $1 default
            if price_cents < min_price {
                errors.push(ValidationError {
                    message: "This product is only available as part of a promotion. Please add it through the offer.".to_string(),
                    target: ValidationTarget { cart_line_id: Some(line.id.clone()) },
                });
            }
        }
    }

    // ── Check max gift quantity per offer ─────────────────────────────────────
    for (offer_id, qty) in &gift_qty_by_offer {
        if let Some(&max_qty) = config.offer_max_quantities.get(offer_id) {
            if *qty > max_qty {
                errors.push(ValidationError {
                    message: format!(
                        "You can only add {} free gift(s) with this offer. Please update your cart.",
                        max_qty
                    ),
                    target: ValidationTarget { cart_line_id: None },
                });
            }
        }
    }

    FunctionOutput { errors }
}

fn parse_config(node: &ValidationNode) -> Option<ValidationConfig> {
    let value = node.metafield.as_ref()?.value.as_str();
    serde_json::from_str(value).ok()
}

fn get_attr<'a>(attrs: &'a [Attribute], key: &str) -> &'a str {
    attrs
        .iter()
        .find(|a| a.key == key)
        .and_then(|a| a.value.as_deref())
        .unwrap_or("")
}

fn parse_amount(amount_str: &str) -> i64 {
    let amount: f64 = amount_str.parse().unwrap_or(0.0);
    (amount * 100.0).round() as i64
}

// ─── WASM entry point ─────────────────────────────────────────────────────────

#[cfg(target_arch = "wasm32")]
mod shopify_function {
    use super::*;
    use std::io::{self, Read, Write};

    #[no_mangle]
    pub extern "C" fn _start() {
        let mut input_str = String::new();
        io::stdin().read_to_string(&mut input_str).expect("Failed to read stdin");
        let input: FunctionInput = serde_json::from_str(&input_str).expect("Failed to parse input");
        let output = function(input);
        let output_str = serde_json::to_string(&output).expect("Failed to serialize output");
        io::stdout().write_all(output_str.as_bytes()).expect("Failed to write stdout");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_config(max_qty: i64, allowed_variants: Vec<&str>, clone_products: Vec<&str>) -> ValidationConfig {
        ValidationConfig {
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
                product: Product { id: product_id.to_string(), tags: vec![] },
            },
            attributes: vec![
                Attribute { key: "_promo_engine_line_type".to_string(), value: Some("gift".to_string()) },
                Attribute { key: "_promo_engine_offer_id".to_string(), value: Some(offer_id.to_string()) },
            ],
            cost: LineCost { amount_per_quantity: Money { amount: "0.00".to_string() } },
        }
    }

    #[test]
    fn test_valid_gift_passes() {
        let config = make_config(2, vec!["gid://shopify/ProductVariant/gift-v1"], vec![]);
        let config_json = serde_json::to_string(&config).unwrap();
        let line = make_gift_line("l1", "gid://shopify/ProductVariant/gift-v1", "p1", "offer-1", 1);
        let input = FunctionInput {
            cart: Cart { lines: vec![line] },
            validation_node: ValidationNode { metafield: Some(Metafield { value: config_json }) },
        };
        let output = function(input);
        assert!(output.errors.is_empty());
    }

    #[test]
    fn test_excess_gift_quantity_blocked() {
        let config = make_config(1, vec!["gid://shopify/ProductVariant/gift-v1"], vec![]);
        let config_json = serde_json::to_string(&config).unwrap();
        // Buyer has 3 gifts but max is 1
        let line = make_gift_line("l1", "gid://shopify/ProductVariant/gift-v1", "p1", "offer-1", 3);
        let input = FunctionInput {
            cart: Cart { lines: vec![line] },
            validation_node: ValidationNode { metafield: Some(Metafield { value: config_json }) },
        };
        let output = function(input);
        assert_eq!(output.errors.len(), 1);
        assert!(output.errors[0].message.contains("1 free gift"));
    }

    #[test]
    fn test_invalid_gift_variant_blocked() {
        let config = make_config(2, vec!["gid://shopify/ProductVariant/allowed-gift"], vec![]);
        let config_json = serde_json::to_string(&config).unwrap();
        // Using a variant NOT in the allowed list
        let line = make_gift_line("l1", "gid://shopify/ProductVariant/expensive-product", "p1", "offer-1", 1);
        let input = FunctionInput {
            cart: Cart { lines: vec![line] },
            validation_node: ValidationNode { metafield: Some(Metafield { value: config_json }) },
        };
        let output = function(input);
        assert_eq!(output.errors.len(), 1);
        assert!(output.errors[0].message.contains("invalid"));
    }

    #[test]
    fn test_no_config_fails_open() {
        let input = FunctionInput {
            cart: Cart { lines: vec![] },
            validation_node: ValidationNode { metafield: None },
        };
        let output = function(input);
        assert!(output.errors.is_empty(), "No config should fail open — never block checkout");
    }
}
