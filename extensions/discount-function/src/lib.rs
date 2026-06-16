mod types;
use types::*;
use std::collections::{HashMap, HashSet};

/// Shopify Function entry point.
/// Called by Shopify at checkout calculation time.
/// MUST be deterministic: same input → same output, no side effects, no network.
pub fn function(input: FunctionInput) -> FunctionOutput {
    let config = match parse_config(&input.discount_node) {
        Some(c) => c,
        None => return no_discounts(),
    };

    let mut all_discounts: Vec<Discount> = Vec::new();
    let mut stop_after_priority: Option<i32> = None;

    // Sort offers by priority ascending (lower = higher priority)
    let mut offers = config.offers.clone();
    offers.sort_by_key(|o| o.priority);

    for offer in &offers {
        // Respect stop-lower-priority
        if let Some(stop_at) = stop_after_priority {
            if offer.priority > stop_at {
                break;
            }
        }

        let discounts = evaluate_offer(offer, &input.cart);
        if !discounts.is_empty() {
            if offer.stop_lower_priority {
                stop_after_priority = Some(offer.priority);
            }
            all_discounts.extend(discounts);
        }
    }

    FunctionOutput {
        discounts: all_discounts,
        discount_application_strategy: DiscountApplicationStrategy::Maximum,
    }
}

/// Evaluate a single compiled offer against the current cart.
fn evaluate_offer(offer: &CompiledOffer, cart: &Cart) -> Vec<Discount> {
    match offer.offer_type.as_str() {
        "gift" => evaluate_gift_offer(offer, cart),
        "discount" => evaluate_discount_offer(offer, cart),
        _ => vec![],
    }
}

/// Gift offer: apply discount to gift lines owned by this offer.
fn evaluate_gift_offer(offer: &CompiledOffer, cart: &Cart) -> Vec<Discount> {
    let gift_variant_set: HashSet<&str> = offer.gift_variant_ids.iter().map(|s| s.as_str()).collect();
    let gift_product_set: HashSet<&str> = offer.gift_product_ids.iter().map(|s| s.as_str()).collect();

    // Verify main condition is still met
    if !check_main_condition(offer, cart) {
        return vec![];
    }

    let mut discounts: Vec<Discount> = Vec::new();
    let mut gift_qty_applied: i64 = 0;
    let max_gift_qty = offer.max_gift_quantity.unwrap_or(i64::MAX);

    for line in &cart.lines {
        if line.quantity <= 0 {
            continue;
        }

        let line_type = get_attr(&line.attributes, "_promo_engine_line_type");
        let line_offer_id = get_attr(&line.attributes, "_promo_engine_offer_id");

        // Only discount lines tagged as gift by THIS offer
        if line_type != "gift" || line_offer_id != offer.id {
            continue;
        }

        // Verify the variant/product is an allowed gift
        let variant_id = &line.merchandise.id;
        let product_id = &line.merchandise.product.id;

        if !gift_variant_set.contains(variant_id.as_str())
            && !gift_product_set.contains(product_id.as_str())
        {
            // This line claims to be a gift from this offer but the variant isn't in the reward list
            // → Do NOT discount it (protection against tampered properties)
            continue;
        }

        // Apply discount to at most max_gift_quantity units
        let qty_remaining = max_gift_qty - gift_qty_applied;
        if qty_remaining <= 0 {
            break;
        }
        let qty_to_discount = line.quantity.min(qty_remaining);
        gift_qty_applied += qty_to_discount;

        let discount = make_line_discount(
            line,
            qty_to_discount,
            offer,
            &format!("Free gift from offer {}", &offer.id[..offer.id.len().min(8)]),
        );

        if let Some(d) = discount {
            discounts.push(d);
        }
    }

    discounts
}

/// Discount offer: apply cart-level or line-level discounts.
fn evaluate_discount_offer(offer: &CompiledOffer, cart: &Cart) -> Vec<Discount> {
    if !check_main_condition(offer, cart) {
        return vec![];
    }

    let required_set: HashSet<&str> = offer.required_product_ids.iter().map(|s| s.as_str()).collect();
    let excluded_set: HashSet<&str> = offer.excluded_product_ids.iter().map(|s| s.as_str()).collect();

    match offer.discount_type.as_str() {
        "cheapest_item_free" => evaluate_cheapest_item_free(offer, cart, &required_set, &excluded_set),
        "most_expensive_item_discount" => evaluate_most_expensive(offer, cart, &required_set, &excluded_set),
        "percentage" | "fixed_amount" => {
            // Apply to all eligible lines
            cart.lines
                .iter()
                .filter(|line| {
                    let product_id = &line.merchandise.product.id;
                    !excluded_set.contains(product_id.as_str())
                        && (required_set.is_empty() || required_set.contains(product_id.as_str()))
                        && get_attr(&line.attributes, "_promo_engine_line_type") != "gift"
                })
                .filter_map(|line| make_line_discount(line, line.quantity, offer, "Discount applied"))
                .collect()
        }
        _ => vec![],
    }
}

fn evaluate_cheapest_item_free(
    offer: &CompiledOffer,
    cart: &Cart,
    required_set: &HashSet<&str>,
    excluded_set: &HashSet<&str>,
) -> Vec<Discount> {
    let eligible: Vec<&CartLine> = cart
        .lines
        .iter()
        .filter(|line| {
            let product_id = &line.merchandise.product.id;
            !excluded_set.contains(product_id.as_str())
                && (required_set.is_empty() || required_set.contains(product_id.as_str()))
                && get_attr(&line.attributes, "_promo_engine_line_type") != "gift"
        })
        .collect();

    if eligible.is_empty() {
        return vec![];
    }

    // Find cheapest line (by price per quantity). Tie-break: line with lowest ID (deterministic)
    let cheapest = eligible.iter().min_by(|a, b| {
        let pa = a.cost.amount_per_quantity.to_cents();
        let pb = b.cost.amount_per_quantity.to_cents();
        pa.cmp(&pb).then(a.id.cmp(&b.id))
    });

    if let Some(line) = cheapest {
        let free_offer = CompiledOffer {
            discount_type: "free".to_string(),
            discount_value: 100.0,
            ..offer.clone()
        };
        if let Some(d) = make_line_discount(line, 1, &free_offer, "Cheapest item free") {
            return vec![d];
        }
    }

    vec![]
}

fn evaluate_most_expensive(
    offer: &CompiledOffer,
    cart: &Cart,
    required_set: &HashSet<&str>,
    excluded_set: &HashSet<&str>,
) -> Vec<Discount> {
    let eligible: Vec<&CartLine> = cart
        .lines
        .iter()
        .filter(|line| {
            let product_id = &line.merchandise.product.id;
            !excluded_set.contains(product_id.as_str())
                && (required_set.is_empty() || required_set.contains(product_id.as_str()))
                && get_attr(&line.attributes, "_promo_engine_line_type") != "gift"
        })
        .collect();

    if eligible.is_empty() {
        return vec![];
    }

    // Most expensive by price per unit
    let most_expensive = eligible.iter().max_by(|a, b| {
        let pa = a.cost.amount_per_quantity.to_cents();
        let pb = b.cost.amount_per_quantity.to_cents();
        pa.cmp(&pb).then(b.id.cmp(&a.id)) // tie-break: higher line ID
    });

    if let Some(line) = most_expensive {
        if let Some(d) = make_line_discount(line, 1, offer, "Most expensive item discount") {
            return vec![d];
        }
    }

    vec![]
}

/// Check if the main condition (cart value / cart quantity / specific product) is still met.
fn check_main_condition(offer: &CompiledOffer, cart: &Cart) -> bool {
    // Cart value threshold
    if let Some(threshold_cents) = offer.cart_value_threshold_cents {
        let cart_value = cart
            .lines
            .iter()
            .filter(|line| line.quantity > 0 && get_attr(&line.attributes, "_promo_engine_line_type") != "gift")
            .map(|line| line.cost.subtotal_amount.to_cents())
            .sum::<i64>();

        // Resolve currency override
        let effective_threshold = resolve_threshold(
            threshold_cents,
            &offer.currency_overrides,
            &cart.cost.subtotal_amount.currency_code,
        );

        if cart_value < effective_threshold {
            return false;
        }
    }

    // Cart quantity threshold
    if let Some(threshold_qty) = offer.cart_quantity_threshold {
        let cart_qty: i64 = cart
            .lines
            .iter()
            .filter(|line| line.quantity > 0 && get_attr(&line.attributes, "_promo_engine_line_type") != "gift")
            .map(|line| line.quantity)
            .sum();

        if cart_qty < threshold_qty {
            return false;
        }
    }

    // Required products check (if any required product IDs specified)
    if !offer.required_product_ids.is_empty() || !offer.required_variant_ids.is_empty() {
        let required_products: HashSet<&str> =
            offer.required_product_ids.iter().map(|s| s.as_str()).collect();
        let required_variants: HashSet<&str> =
            offer.required_variant_ids.iter().map(|s| s.as_str()).collect();

        let has_required = cart.lines.iter().any(|line| {
            required_products.contains(line.merchandise.product.id.as_str())
                || required_variants.contains(line.merchandise.id.as_str())
        });

        if !has_required {
            return false;
        }
    }

    true
}

fn resolve_threshold(
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

fn make_line_discount(
    line: &CartLine,
    qty: i64,
    offer: &CompiledOffer,
    message: &str,
) -> Option<Discount> {
    if qty <= 0 || offer.discount_value < 0.0 {
        return None;
    }

    let price_cents = line.cost.amount_per_quantity.to_cents();
    let currency = &line.cost.amount_per_quantity.currency_code;

    let value = match offer.discount_type.as_str() {
        "free" | "percentage" => {
            let pct = if offer.discount_type == "free" {
                100.0
            } else {
                offer.discount_value.min(100.0)
            };
            DiscountValue::Percentage {
                value: format!("{:.2}", pct),
            }
        }
        "fixed_amount" => {
            // Zero-decimal currencies (JPY, KRW, etc.) have no sub-unit; don't scale × 100.
            let scale = if types::is_zero_decimal(currency) { 1.0 } else { 100.0 };
            let discount_units = (offer.discount_value * scale).round() as i64;
            let capped = discount_units.min(price_cents);
            let amount = if scale == 1.0 {
                format!("{}", capped)
            } else {
                format!("{:.2}", capped as f64 / scale)
            };
            DiscountValue::FixedAmount {
                amount,
                currency_code: currency.clone(),
                applies_to_each_item: false,
            }
        }
        _ => return None,
    };

    Some(Discount {
        targets: vec![Target {
            cart_line: CartLineTarget {
                id: line.id.clone(),
                quantity: if qty < line.quantity { Some(qty) } else { None },
            },
        }],
        value,
        message: Some(message.to_string()),
        conditions: None,
    })
}

fn get_attr<'a>(attrs: &'a [Attribute], key: &str) -> &'a str {
    attrs
        .iter()
        .find(|a| a.key == key)
        .and_then(|a| a.value.as_deref())
        .unwrap_or("")
}

fn parse_config(discount_node: &DiscountNode) -> Option<CompiledConfig> {
    let value = discount_node.metafield.as_ref()?.value.as_str();
    serde_json::from_str(value).ok()
}

fn no_discounts() -> FunctionOutput {
    FunctionOutput {
        discounts: vec![],
        discount_application_strategy: DiscountApplicationStrategy::First,
    }
}

// ─── Shopify Function WASM entry point ────────────────────────────────────────

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

    fn make_cart(lines: Vec<CartLine>) -> Cart {
        let subtotal = lines.iter().map(|l| l.cost.subtotal_amount.to_cents()).sum::<i64>();
        Cart {
            lines,
            buyer_identity: None,
            discount_codes: vec![],
            cost: CartCost {
                subtotal_amount: Money {
                    amount: format!("{:.2}", subtotal as f64 / 100.0),
                    currency_code: "USD".to_string(),
                },
            },
        }
    }

    fn make_gift_line(
        line_id: &str,
        variant_id: &str,
        product_id: &str,
        offer_id: &str,
        price: &str,
        qty: i64,
    ) -> CartLine {
        CartLine {
            id: line_id.to_string(),
            quantity: qty,
            cost: LineCost {
                amount_per_quantity: Money { amount: price.to_string(), currency_code: "USD".to_string() },
                subtotal_amount: Money {
                    amount: format!("{:.2}", price.parse::<f64>().unwrap() * qty as f64),
                    currency_code: "USD".to_string(),
                },
            },
            merchandise: Merchandise {
                id: variant_id.to_string(),
                product: Product {
                    id: product_id.to_string(),
                    tags: vec![],
                    vendor: String::new(),
                    product_type: String::new(),
                },
            },
            attributes: vec![
                Attribute { key: "_promo_engine_line_type".to_string(), value: Some("gift".to_string()) },
                Attribute { key: "_promo_engine_offer_id".to_string(), value: Some(offer_id.to_string()) },
                Attribute { key: "_promo_engine_reward_id".to_string(), value: Some("reward-1".to_string()) },
                Attribute { key: "_promo_engine_hash".to_string(), value: Some("abc123".to_string()) },
            ],
        }
    }

    fn make_regular_line(line_id: &str, variant_id: &str, product_id: &str, price: &str, qty: i64) -> CartLine {
        CartLine {
            id: line_id.to_string(),
            quantity: qty,
            cost: LineCost {
                amount_per_quantity: Money { amount: price.to_string(), currency_code: "USD".to_string() },
                subtotal_amount: Money {
                    amount: format!("{:.2}", price.parse::<f64>().unwrap() * qty as f64),
                    currency_code: "USD".to_string(),
                },
            },
            merchandise: Merchandise {
                id: variant_id.to_string(),
                product: Product {
                    id: product_id.to_string(),
                    tags: vec![],
                    vendor: "Vendor".to_string(),
                    product_type: "T-Shirt".to_string(),
                },
            },
            attributes: vec![],
        }
    }

    #[test]
    fn test_gift_discount_applies_to_valid_gift_line() {
        let offer = CompiledOffer {
            id: "offer-1".to_string(),
            version: 1,
            offer_type: "gift".to_string(),
            priority: 100,
            stop_lower_priority: false,
            required_product_ids: vec![],
            required_variant_ids: vec![],
            excluded_product_ids: vec![],
            gift_variant_ids: vec!["gid://shopify/ProductVariant/gift-v1".to_string()],
            gift_product_ids: vec![],
            cart_value_threshold_cents: Some(5000),
            cart_quantity_threshold: None,
            max_gift_quantity: Some(1),
            discount_type: "free".to_string(),
            discount_value: 100.0,
            currency_code: "USD".to_string(),
            currency_overrides: None,
            combines_with_order_discounts: true,
            combines_with_shipping_discounts: true,
            combines_with_product_discounts: true,
        };

        let regular = make_regular_line("line-1", "v1", "p1", "60.00", 1); // $60 cart > $50 threshold
        let gift = make_gift_line("gift-line-1", "gid://shopify/ProductVariant/gift-v1", "gift-p1", "offer-1", "20.00", 1);
        let cart = make_cart(vec![regular, gift]);

        let discounts = evaluate_gift_offer(&offer, &cart);
        assert_eq!(discounts.len(), 1);
        assert!(matches!(discounts[0].value, DiscountValue::Percentage { ref value } if value == "100.00"));
    }

    #[test]
    fn test_gift_discount_not_applied_when_threshold_not_met() {
        let offer = CompiledOffer {
            id: "offer-1".to_string(),
            version: 1,
            offer_type: "gift".to_string(),
            priority: 100,
            stop_lower_priority: false,
            required_product_ids: vec![],
            required_variant_ids: vec![],
            excluded_product_ids: vec![],
            gift_variant_ids: vec!["gid://shopify/ProductVariant/gift-v1".to_string()],
            gift_product_ids: vec![],
            cart_value_threshold_cents: Some(10000), // $100 threshold
            cart_quantity_threshold: None,
            max_gift_quantity: Some(1),
            discount_type: "free".to_string(),
            discount_value: 100.0,
            currency_code: "USD".to_string(),
            currency_overrides: None,
            combines_with_order_discounts: true,
            combines_with_shipping_discounts: true,
            combines_with_product_discounts: true,
        };

        let regular = make_regular_line("line-1", "v1", "p1", "40.00", 1); // $40 < $100 threshold
        let gift = make_gift_line("gift-line-1", "gid://shopify/ProductVariant/gift-v1", "gift-p1", "offer-1", "20.00", 1);
        let cart = make_cart(vec![regular, gift]);

        let discounts = evaluate_gift_offer(&offer, &cart);
        assert_eq!(discounts.len(), 0, "Gift discount should NOT apply when cart value is below threshold");
    }

    #[test]
    fn test_max_gift_quantity_enforced() {
        let offer = CompiledOffer {
            id: "offer-1".to_string(),
            version: 1,
            offer_type: "gift".to_string(),
            priority: 100,
            stop_lower_priority: false,
            required_product_ids: vec![],
            required_variant_ids: vec![],
            excluded_product_ids: vec![],
            gift_variant_ids: vec!["gid://shopify/ProductVariant/gift-v1".to_string()],
            gift_product_ids: vec![],
            cart_value_threshold_cents: Some(5000),
            cart_quantity_threshold: None,
            max_gift_quantity: Some(1), // Only 1 gift allowed
            discount_type: "free".to_string(),
            discount_value: 100.0,
            currency_code: "USD".to_string(),
            currency_overrides: None,
            combines_with_order_discounts: true,
            combines_with_shipping_discounts: true,
            combines_with_product_discounts: true,
        };

        let regular = make_regular_line("line-1", "v1", "p1", "60.00", 1);
        // Buyer has 3 gift items but max_gift_quantity = 1
        let gift = make_gift_line("gift-line-1", "gid://shopify/ProductVariant/gift-v1", "gift-p1", "offer-1", "20.00", 3);
        let cart = make_cart(vec![regular, gift]);

        let discounts = evaluate_gift_offer(&offer, &cart);
        assert_eq!(discounts.len(), 1);
        // Only 1 unit should be discounted
        if let Some(target) = discounts[0].targets.first() {
            assert_eq!(target.cart_line.quantity, Some(1));
        }
    }

    #[test]
    fn test_tampered_gift_line_not_discounted() {
        let offer = CompiledOffer {
            id: "offer-1".to_string(),
            version: 1,
            offer_type: "gift".to_string(),
            priority: 100,
            stop_lower_priority: false,
            required_product_ids: vec![],
            required_variant_ids: vec![],
            excluded_product_ids: vec![],
            gift_variant_ids: vec!["gid://shopify/ProductVariant/allowed-gift".to_string()],
            gift_product_ids: vec![],
            cart_value_threshold_cents: Some(5000),
            cart_quantity_threshold: None,
            max_gift_quantity: Some(1),
            discount_type: "free".to_string(),
            discount_value: 100.0,
            currency_code: "USD".to_string(),
            currency_overrides: None,
            combines_with_order_discounts: true,
            combines_with_shipping_discounts: true,
            combines_with_product_discounts: true,
        };

        // Gift line claims to belong to offer-1 but uses a DIFFERENT variant not in the reward list
        let regular = make_regular_line("line-1", "v1", "p1", "60.00", 1);
        let tampered_gift = make_gift_line(
            "gift-line-1",
            "gid://shopify/ProductVariant/expensive-product-tampered", // not in gift list!
            "p-expensive",
            "offer-1",
            "500.00",
            1,
        );
        let cart = make_cart(vec![regular, tampered_gift]);

        let discounts = evaluate_gift_offer(&offer, &cart);
        assert_eq!(discounts.len(), 0, "Tampered gift variant should NOT receive a discount");
    }
}
