use crate::config::{
    resolve_threshold, to_cents, CompiledConfig, CompiledOffer, CompiledOrderReward,
    CompiledProductReward,
};
use crate::schema;
use schema::cart_lines_discounts_generate_run::Input;
use schema::cart_lines_discounts_generate_run::input::cart::Lines;
use schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise;
use shopify_function::Result;
use std::collections::{BTreeMap, HashMap, HashSet};

const LINE_TYPE_GIFT: &str = "gift";

#[derive(Debug, serde::Deserialize, Clone)]
struct VolumeDiscountTier {
    qty: i64,
    percent: f64,
}

struct VolumeDiscountGroup {
    quantity: i64,
    subtotal_cents: i64,
    tiers: Vec<VolumeDiscountTier>,
}

pub fn run(input: Input) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let has_product_discount = input
        .discount()
        .discount_classes()
        .iter()
        .any(|class| matches!(class, schema::DiscountClass::Product));
    let has_order_discount = input
        .discount()
        .discount_classes()
        .iter()
        .any(|class| matches!(class, schema::DiscountClass::Order));
    if !has_product_discount && !has_order_discount {
        return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
    }

    let config = match parse_config(&input) {
        Some(c) => c,
        None => return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] }),
    };

    let mut offers = config.offers.clone();
    offers.sort_by_key(|o| o.priority);

    let mut candidates: Vec<schema::ProductDiscountCandidate> = Vec::new();
    let mut order_candidates: Vec<schema::OrderDiscountCandidate> = Vec::new();
    let mut stop_after_priority: Option<i32> = None;

    for offer in &offers {
        if let Some(stop_at) = stop_after_priority {
            if offer.priority > stop_at {
                break;
            }
        }

        let offer_candidates = if has_product_discount {
            evaluate_offer(offer, &input)
        } else {
            vec![]
        };
        let offer_order_candidates = if has_order_discount {
            evaluate_order_offer(offer, &input)
        } else {
            vec![]
        };
        if !offer_candidates.is_empty() || !offer_order_candidates.is_empty() {
            if offer.stop_lower_priority {
                stop_after_priority = Some(offer.priority);
            }
            candidates.extend(offer_candidates);
            order_candidates.extend(offer_order_candidates);
        }
    }

    if candidates.is_empty() && order_candidates.is_empty() {
        return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
    }

    let mut operations = Vec::new();
    if !candidates.is_empty() {
        operations.push(schema::CartOperation::ProductDiscountsAdd(
            schema::ProductDiscountsAddOperation {
                selection_strategy: schema::ProductDiscountSelectionStrategy::All,
                candidates,
            },
        ));
    }
    if !order_candidates.is_empty() {
        operations.push(schema::CartOperation::OrderDiscountsAdd(
            schema::OrderDiscountsAddOperation {
                selection_strategy: schema::OrderDiscountSelectionStrategy::First,
                candidates: order_candidates,
            },
        ));
    }

    Ok(schema::CartLinesDiscountsGenerateRunResult {
        operations,
    })
}

fn evaluate_offer(offer: &CompiledOffer, input: &Input) -> Vec<schema::ProductDiscountCandidate> {
    if !offer.gift_rewards.is_empty() || offer.offer_type == "gift" {
        return evaluate_gift_offer(offer, input);
    }
    if !offer.product_rewards.is_empty() {
        if !check_main_condition(offer, input) {
            return vec![];
        }
        return offer
            .product_rewards
            .iter()
            .flat_map(|reward| evaluate_product_reward(reward, input))
            .collect();
    }
    if offer.offer_type == "discount" {
        return evaluate_discount_offer(offer, input);
    }
    vec![]
}

fn evaluate_product_reward(
    reward: &CompiledProductReward,
    input: &Input,
) -> Vec<schema::ProductDiscountCandidate> {
    if reward.scope_mode == "quiz_bundle" {
        return evaluate_quiz_bundle_reward(reward, input);
    }
    if reward.scope_mode == "landing" && !landing_anchor_qualifies(reward, input) {
        return vec![];
    }

    let product_ids: HashSet<&str> = reward.target_product_ids.iter().map(String::as_str).collect();
    let variant_ids: HashSet<&str> = reward.target_variant_ids.iter().map(String::as_str).collect();
    let mut eligible: Vec<&Lines> = input
        .cart()
        .lines()
        .iter()
        .filter(|line| line_type(line).as_deref() != Some(LINE_TYPE_GIFT))
        .filter(|line| {
            reward.scope_mode != "landing"
                || landing_source(line).as_deref() == reward.required_line_attribute_value.as_deref()
        })
        .filter(|line| {
            let Some((variant_id, product_id)) = variant_and_product_id(line) else {
                return false;
            };
            (product_ids.is_empty() && variant_ids.is_empty())
                || product_ids.contains(product_id.as_str())
                || variant_ids.contains(variant_id.as_str())
        })
        .filter(|line| {
            reward
                .line_quantity_equals
                .map(|quantity| i64::from(*line.quantity()) == quantity)
                .unwrap_or(true)
        })
        .filter(|line| match reward.subscription_mode.as_str() {
            "subscription_only" => line.selling_plan_allocation().is_some(),
            "one_time_only" => line.selling_plan_allocation().is_none(),
            _ => true,
        })
        .collect();

    if eligible.is_empty() {
        return vec![];
    }
    eligible.sort_by(|a, b| a.id().cmp(b.id()));

    let tier_target_price = if reward.price_tiers.is_empty() {
        None
    } else {
        let total_quantity: i64 = eligible.iter().map(|line| i64::from(*line.quantity())).sum();
        reward
            .price_tiers
            .iter()
            .filter(|tier| total_quantity >= tier.quantity)
            .max_by_key(|tier| tier.quantity)
            .map(|tier| tier.target_price_per_unit)
    };
    if !reward.price_tiers.is_empty() && tier_target_price.is_none() {
        return vec![];
    }

    if reward.discount_type == "cheapest_item_free" {
        eligible.sort_by(|a, b| {
            a.cost()
                .amount_per_quantity()
                .amount()
                .as_f64()
                .partial_cmp(&b.cost().amount_per_quantity().amount().as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.id().cmp(b.id()))
        });
        eligible.truncate(1);
    } else if reward.discount_type == "most_expensive_item_discount" {
        eligible.sort_by(|a, b| {
            b.cost()
                .amount_per_quantity()
                .amount()
                .as_f64()
                .partial_cmp(&a.cost().amount_per_quantity().amount().as_f64())
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.id().cmp(b.id()))
        });
        eligible.truncate(1);
    }

    let mut remaining = reward
        .max_units_total
        .or(reward.max_quantity)
        .unwrap_or(i64::MAX);
    let mut candidates = Vec::new();
    for line in eligible {
        if remaining <= 0 {
            break;
        }
        let quantity = i64::from(*line.quantity()).min(remaining);
        remaining -= quantity;
        let (discount_type, discount_value) = if let Some(target_price) = tier_target_price {
            let current_price = line.cost().amount_per_quantity().amount().as_f64();
            ("fixed_amount", (current_price - target_price).max(0.0))
        } else if reward.discount_type == "fixed_price" {
            let current_price = line.cost().amount_per_quantity().amount().as_f64();
            ("fixed_amount", (current_price - reward.discount_value).max(0.0))
        } else if reward.discount_type == "cheapest_item_free" {
            ("free", 100.0)
        } else {
            (reward.discount_type.as_str(), reward.discount_value)
        };
        if discount_type == "fixed_amount" && discount_value <= 0.0 {
            continue;
        }
        candidates.push(make_candidate(
            line.id().clone(),
            quantity,
            discount_type,
            discount_value,
            &format!("Reward {}", reward.id),
        ));
    }
    candidates
}

fn landing_anchor_qualifies(reward: &CompiledProductReward, input: &Input) -> bool {
    let Some(required_source) = reward.required_line_attribute_value.as_deref() else {
        return false;
    };
    if reward.required_anchor_variant_ids.is_empty() {
        return true;
    }
    let anchor_ids: HashSet<&str> = reward
        .required_anchor_variant_ids
        .iter()
        .map(String::as_str)
        .collect();
    let quantity: i64 = input
        .cart()
        .lines()
        .iter()
        .filter(|line| landing_source(line).as_deref() == Some(required_source))
        .filter(|line| {
            variant_and_product_id(line)
                .map(|(variant_id, _)| anchor_ids.contains(variant_id.as_str()))
                .unwrap_or(false)
        })
        .filter(|line| !reward.requires_anchor_subscription || line.selling_plan_allocation().is_some())
        .map(|line| i64::from(*line.quantity()))
        .sum();
    quantity >= reward.required_anchor_min_quantity
}

struct QuizGroup<'a> {
    paid: Vec<&'a Lines>,
    gifts: Vec<&'a Lines>,
    target_cents: Option<i64>,
    expected_paid_count: Option<usize>,
}

fn evaluate_quiz_bundle_reward(
    reward: &CompiledProductReward,
    input: &Input,
) -> Vec<schema::ProductDiscountCandidate> {
    let mut groups: BTreeMap<String, QuizGroup<'_>> = BTreeMap::new();
    for line in input.cart().lines() {
        let Some(bundle_id) = quiz_bundle_id(line) else { continue };
        let group = groups.entry(bundle_id).or_insert_with(|| QuizGroup {
            paid: vec![],
            gifts: vec![],
            target_cents: None,
            expected_paid_count: None,
        });
        if quiz_free_gift(line).as_deref() == Some("true") {
            group.gifts.push(line);
        } else {
            group.paid.push(line);
        }
        if group.target_cents.is_none() {
            group.target_cents = quiz_target_cents(line).and_then(|value| value.parse::<i64>().ok());
        }
        if group.expected_paid_count.is_none() {
            group.expected_paid_count = quiz_expected_paid_count(line)
                .and_then(|value| value.parse::<usize>().ok());
        }
    }

    let mut candidates = vec![];
    for (bundle_id, group) in groups {
        let Some(expected_paid_count) = group.expected_paid_count else { continue };
        if group.paid.len() < expected_paid_count {
            continue;
        }
        for line in group.gifts {
            candidates.push(make_candidate(
                line.id().clone(),
                i64::from(*line.quantity()),
                "percentage",
                reward.discount_percentage_on_gifts,
                &format!("Quiz bundle {bundle_id}"),
            ));
        }
        let Some(target_cents) = group.target_cents else { continue };
        if group.paid.is_empty() {
            continue;
        }
        let current_total: f64 = group
            .paid
            .iter()
            .map(|line| line.cost().total_amount().amount().as_f64())
            .sum();
        let discount_needed = current_total - target_cents as f64 / 100.0;
        if discount_needed <= 0.0 {
            continue;
        }
        candidates.push(make_multi_line_fixed_candidate(
            group.paid,
            discount_needed,
            &format!("Quiz bundle {bundle_id}"),
        ));
    }
    candidates
}

fn evaluate_order_offer(
    offer: &CompiledOffer,
    input: &Input,
) -> Vec<schema::OrderDiscountCandidate> {
    if offer.order_rewards.is_empty() || !check_main_condition(offer, input) {
        return vec![];
    }
    let excluded_gift_line_ids: Vec<String> = input
        .cart()
        .lines()
        .iter()
        .filter(|line| line_type(line).as_deref() == Some(LINE_TYPE_GIFT))
        .map(|line| line.id().clone())
        .collect();

    offer
        .order_rewards
        .iter()
        .filter_map(|reward| make_order_candidate(reward, excluded_gift_line_ids.clone()))
        .collect()
}

fn make_order_candidate(
    reward: &CompiledOrderReward,
    excluded_cart_line_ids: Vec<String>,
) -> Option<schema::OrderDiscountCandidate> {
    let value = match reward.discount_type.as_str() {
        "free" => schema::OrderDiscountCandidateValue::Percentage(schema::Percentage {
            value: shopify_function::scalars::Decimal(100.0),
        }),
        "percentage" if reward.discount_value > 0.0 => {
            schema::OrderDiscountCandidateValue::Percentage(schema::Percentage {
                value: shopify_function::scalars::Decimal(reward.discount_value.min(100.0)),
            })
        }
        "fixed_amount" if reward.discount_value > 0.0 => {
            schema::OrderDiscountCandidateValue::FixedAmount(schema::FixedAmount {
                amount: shopify_function::scalars::Decimal(reward.discount_value),
            })
        }
        _ => return None,
    };
    Some(schema::OrderDiscountCandidate {
        associated_discount_code: None,
        conditions: None,
        message: Some(format!("Order reward {}", reward.id)),
        targets: vec![schema::OrderDiscountCandidateTarget::OrderSubtotal(
            schema::OrderSubtotalTarget {
                excluded_cart_line_ids,
            },
        )],
        value,
    })
}

/// Gift offer: discount (to free, or the configured value) the line(s) this
/// offer's runtime already tagged as its gift, but only if the variant is
/// actually in this offer's allowed gift list — protects against a buyer
/// editing cart line properties to claim an unrelated product as "the gift".
fn evaluate_gift_offer(offer: &CompiledOffer, input: &Input) -> Vec<schema::ProductDiscountCandidate> {
    if !check_main_condition(offer, input) {
        return vec![];
    }

    if !offer.gift_rewards.is_empty() {
        let offer_version = offer.version.to_string();
        let mut applied_by_reward: HashMap<String, i64> = HashMap::new();
        let mut candidates = Vec::new();

        for line in input.cart().lines().iter() {
            let line_quantity = i64::from(*line.quantity());
            if line_quantity <= 0
                || line_type(line).as_deref() != Some(LINE_TYPE_GIFT)
                || line_offer_id(line).as_deref() != Some(offer.id.as_str())
                || line_offer_version(line).as_deref() != Some(offer_version.as_str())
            {
                continue;
            }

            let Some(reward_id) = line_reward_id(line) else { continue };
            let Some(reward) = offer.gift_rewards.iter().find(|candidate| candidate.id == reward_id) else {
                continue;
            };
            let Some((variant_id, product_id)) = variant_and_product_id(line) else { continue };
            let target_matches = if !reward.target_variant_ids.is_empty() {
                reward.target_variant_ids.iter().any(|id| id == &variant_id)
            } else {
                reward.target_product_ids.iter().any(|id| id == &product_id)
            };
            if !target_matches {
                continue;
            }

            let applied = applied_by_reward.entry(reward.id.clone()).or_insert(0);
            let quantity = line_quantity.min((reward.max_quantity - *applied).max(0));
            if quantity <= 0 {
                continue;
            }
            *applied += quantity;
            candidates.push(make_candidate(
                line.id().clone(),
                quantity,
                &reward.discount_type,
                reward.discount_value,
                &format!("Gift reward {}", &reward.id[..reward.id.len().min(8)]),
            ));
        }
        return candidates;
    }

    // Backward-compatible fallback for already-published configs that predate
    // per-reward gift validation. New publishes always populate giftRewards.
    let gift_variant_set: HashSet<&str> = offer.gift_variant_ids.iter().map(String::as_str).collect();
    let gift_product_set: HashSet<&str> = offer.gift_product_ids.iter().map(String::as_str).collect();
    let max_gift_qty = offer.max_gift_quantity.unwrap_or(i64::MAX);
    let mut gift_qty_applied: i64 = 0;
    let mut candidates = Vec::new();

    for line in input.cart().lines().iter() {
        let line_quantity = *line.quantity() as i64;
        if line_quantity <= 0 {
            continue;
        }
        if line_type(line).as_deref() != Some(LINE_TYPE_GIFT) || line_offer_id(line).as_deref() != Some(&offer.id) {
            continue;
        }

        let (variant_id, product_id) = match variant_and_product_id(line) {
            Some(ids) => ids,
            None => continue,
        };

        let target_matches = if !gift_variant_set.is_empty() {
            gift_variant_set.contains(variant_id.as_str())
        } else {
            gift_product_set.contains(product_id.as_str())
        };
        if !target_matches {
            // Tampered: claims to be this offer's gift but isn't an allowed variant/product.
            continue;
        }

        let qty_remaining = max_gift_qty - gift_qty_applied;
        if qty_remaining <= 0 {
            break;
        }
        let qty_to_discount = line_quantity.min(qty_remaining);
        gift_qty_applied += qty_to_discount;

        candidates.push(make_candidate(
            line.id().clone(),
            qty_to_discount,
            &offer.discount_type,
            offer.discount_value,
            &format!("Free gift from offer {}", &offer.id[..offer.id.len().min(8)]),
        ));
    }

    candidates
}

fn evaluate_discount_offer(offer: &CompiledOffer, input: &Input) -> Vec<schema::ProductDiscountCandidate> {
    if !check_main_condition(offer, input) {
        return vec![];
    }

    let required_set: HashSet<&str> = offer.required_product_ids.iter().map(String::as_str).collect();
    let excluded_set: HashSet<&str> = offer.excluded_product_ids.iter().map(String::as_str).collect();

    let eligible: Vec<_> = input
        .cart()
        .lines()
        .iter()
        .filter(|line| is_eligible_line(line, &required_set, &excluded_set))
        .collect();

    if eligible.is_empty() {
        return vec![];
    }

    match offer.discount_type.as_str() {
        "cheapest_item_free" => {
            let cheapest = eligible.iter().min_by(|a, b| {
                let pa = a.cost().amount_per_quantity().amount().as_f64();
                let pb = b.cost().amount_per_quantity().amount().as_f64();
                pa.partial_cmp(&pb).unwrap_or(std::cmp::Ordering::Equal).then(a.id().cmp(b.id()))
            });
            match cheapest {
                Some(line) => vec![make_candidate(line.id().clone(), 1, "free", 100.0, "Cheapest item free")],
                None => vec![],
            }
        }
        "most_expensive_item_discount" => {
            let most_expensive = eligible.iter().max_by(|a, b| {
                let pa = a.cost().amount_per_quantity().amount().as_f64();
                let pb = b.cost().amount_per_quantity().amount().as_f64();
                pa.partial_cmp(&pb).unwrap_or(std::cmp::Ordering::Equal).then(b.id().cmp(a.id()))
            });
            match most_expensive {
                Some(line) => vec![make_candidate(
                    line.id().clone(),
                    *line.quantity() as i64,
                    &offer.discount_type,
                    offer.discount_value,
                    "Most expensive item discount",
                )],
                None => vec![],
            }
        }
        "percentage" | "fixed_amount" => eligible
            .iter()
            .map(|line| make_candidate(line.id().clone(), *line.quantity() as i64, &offer.discount_type, offer.discount_value, "Discount applied"))
            .collect(),
        _ => vec![],
    }
}

fn is_eligible_line(line: &Lines, required_set: &HashSet<&str>, excluded_set: &HashSet<&str>) -> bool {
    if line_type(line).as_deref() == Some(LINE_TYPE_GIFT) {
        return false;
    }
    let Some((_, product_id)) = variant_and_product_id(line) else { return false };
    !excluded_set.contains(product_id.as_str())
        && (required_set.is_empty() || required_set.contains(product_id.as_str()))
}

/// Cart value / cart quantity / required-product checks, evaluated against the
/// current cart at checkout time — the merchant may have edited the offer, or
/// the cart may have changed, since the storefront runtime's own evaluation.
fn check_main_condition(offer: &CompiledOffer, input: &Input) -> bool {
    let active_currency = input.cart().cost().subtotal_amount().currency_code().to_string();
    let excluded_products: HashSet<&str> = offer
        .excluded_product_ids
        .iter()
        .map(String::as_str)
        .collect();
    let non_gift_lines: Vec<_> = input
        .cart()
        .lines()
        .iter()
        .filter(|line| *line.quantity() > 0 && line_type(line).as_deref() != Some(LINE_TYPE_GIFT))
        .filter(|line| {
            variant_and_product_id(line)
                .map(|(_, product_id)| !excluded_products.contains(product_id.as_str()))
                .unwrap_or(false)
        })
        .collect();

    if let Some(threshold_cents) = offer.cart_value_threshold_cents {
        let raw_cart_value_cents: i64 = non_gift_lines
            .iter()
            .map(|line| {
                let amount = line.cost().subtotal_amount().amount().as_f64();
                to_cents(amount, &active_currency)
            })
            .sum();
        // Discount Functions execute concurrently, so the input does not
        // contain discounts emitted by the store's separate volume-discount
        // Function. Mirror only its qualification math here; this Function
        // still emits no volume-discount candidate of its own.
        let cart_value_cents = (raw_cart_value_cents
            - projected_volume_discount_cents(&non_gift_lines, &active_currency))
            .max(0);

        let effective_threshold = resolve_threshold(threshold_cents, &offer.currency_overrides, &active_currency);
        if cart_value_cents < effective_threshold {
            return false;
        }
        if offer
            .cart_value_max_cents
            .is_some_and(|maximum| cart_value_cents > maximum)
        {
            return false;
        }
    }

    if let Some(threshold_qty) = offer.cart_quantity_threshold {
        let cart_qty: i64 = non_gift_lines.iter().map(|line| *line.quantity() as i64).sum();
        if cart_qty < threshold_qty {
            return false;
        }
        if offer
            .cart_quantity_max
            .is_some_and(|maximum| cart_qty > maximum)
        {
            return false;
        }
    }

    if let Some(subscription_mode) = offer.subscription_mode.as_deref() {
        let has_matching_line = non_gift_lines.iter().any(|line| match subscription_mode {
            "subscription_only" => line.selling_plan_allocation().is_some(),
            "one_time_only" => line.selling_plan_allocation().is_none(),
            _ => true,
        });
        if !has_matching_line {
            return false;
        }
    }

    let has_customer_history_condition = offer.customer_order_count_min.is_some()
        || offer.customer_order_count_max.is_some()
        || offer.customer_amount_spent_min_cents.is_some()
        || offer.customer_amount_spent_max_cents.is_some();
    if has_customer_history_condition {
        let buyer_identity = input.cart().buyer_identity();
        let Some(identity) = buyer_identity.as_ref() else {
            return false;
        };
        let Some(customer) = identity.customer() else {
            return false;
        };
        let number_of_orders = i64::from(*customer.number_of_orders());
        if offer.customer_order_count_min.is_some_and(|minimum| number_of_orders < minimum)
            || offer.customer_order_count_max.is_some_and(|maximum| number_of_orders > maximum)
        {
            return false;
        }
        let amount_spent = customer.amount_spent();
        let amount_spent_cents = to_cents(
            amount_spent.amount().as_f64(),
            &offer.currency_code,
        );
        if offer.customer_amount_spent_min_cents.is_some_and(|minimum| amount_spent_cents < minimum)
            || offer.customer_amount_spent_max_cents.is_some_and(|maximum| amount_spent_cents > maximum)
        {
            return false;
        }
    }

    if !offer.requirements.is_empty() {
        for requirement in &offer.requirements {
            let matching_quantity: i64 = non_gift_lines
                .iter()
                .filter_map(|line| variant_and_product_id(line).map(|ids| (line, ids)))
                .filter(|(_, (variant_id, product_id))| {
                    if requirement.track_mode == "variant" {
                        requirement.variant_id.as_deref() == Some(variant_id.as_str())
                    } else {
                        requirement.product_id.as_deref() == Some(product_id.as_str())
                    }
                })
                .map(|(line, _)| i64::from(*line.quantity()))
                .sum();
            if matching_quantity < requirement.min_quantity {
                return false;
            }
            if requirement
                .max_quantity
                .is_some_and(|maximum| matching_quantity > maximum)
            {
                return false;
            }
        }
    } else if !offer.required_product_ids.is_empty() || !offer.required_variant_ids.is_empty() {
        let required_products: HashSet<&str> = offer.required_product_ids.iter().map(String::as_str).collect();
        let required_variants: HashSet<&str> = offer.required_variant_ids.iter().map(String::as_str).collect();

        let has_required = input.cart().lines().iter().any(|line| {
            variant_and_product_id(line)
                .map(|(variant_id, product_id)| {
                    required_products.contains(product_id.as_str()) || required_variants.contains(variant_id.as_str())
                })
                .unwrap_or(false)
        });
        if !has_required {
            return false;
        }
    }

    true
}

fn make_candidate(
    cart_line_id: String,
    quantity: i64,
    discount_type: &str,
    discount_value: f64,
    message: &str,
) -> schema::ProductDiscountCandidate {
    let value = match discount_type {
        "free" | "percentage" => {
            let pct = if discount_type == "free" { 100.0 } else { discount_value.min(100.0) };
            schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                value: shopify_function::scalars::Decimal(pct),
            })
        }
        _ => schema::ProductDiscountCandidateValue::FixedAmount(schema::ProductDiscountCandidateFixedAmount {
            amount: shopify_function::scalars::Decimal(discount_value),
            applies_to_each_item: Some(true),
        }),
    };

    schema::ProductDiscountCandidate {
        associated_discount_code: None,
        message: Some(message.to_string()),
        prerequisites: None,
        targets: vec![schema::ProductDiscountCandidateTarget::CartLine(schema::CartLineTarget {
            id: cart_line_id,
            quantity: Some(quantity as i32),
        })],
        value,
    }
}

fn make_multi_line_fixed_candidate(
    lines: Vec<&Lines>,
    discount_value: f64,
    message: &str,
) -> schema::ProductDiscountCandidate {
    schema::ProductDiscountCandidate {
        associated_discount_code: None,
        message: Some(message.to_string()),
        prerequisites: None,
        targets: lines
            .into_iter()
            .map(|line| {
                schema::ProductDiscountCandidateTarget::CartLine(schema::CartLineTarget {
                    id: line.id().clone(),
                    quantity: Some(*line.quantity()),
                })
            })
            .collect(),
        value: schema::ProductDiscountCandidateValue::FixedAmount(
            schema::ProductDiscountCandidateFixedAmount {
                amount: shopify_function::scalars::Decimal(discount_value),
                applies_to_each_item: Some(false),
            },
        ),
    }
}

fn variant_and_product_id(line: &Lines) -> Option<(String, String)> {
    match line.merchandise() {
        Merchandise::ProductVariant(variant) => Some((variant.id().to_string(), variant.product().id().to_string())),
        Merchandise::Other => None,
    }
}

fn line_type(line: &Lines) -> Option<String> {
    line.line_type().as_ref().map(|attribute| attribute.value()).flatten().cloned()
}

fn line_offer_id(line: &Lines) -> Option<String> {
    line.offer_id().as_ref().map(|attribute| attribute.value()).flatten().cloned()
}

fn line_reward_id(line: &Lines) -> Option<String> {
    line.reward_id().as_ref().and_then(|attribute| attribute.value()).cloned()
}

fn line_offer_version(line: &Lines) -> Option<String> {
    line.offer_version().as_ref().and_then(|attribute| attribute.value()).cloned()
}

fn projected_volume_discount_cents(lines: &[&Lines], currency_code: &str) -> i64 {
    let mut groups: BTreeMap<String, VolumeDiscountGroup> = BTreeMap::new();
    for line in lines {
        if line
            .volume_discount_bundle_item()
            .as_ref()
            .and_then(|attribute| attribute.value())
            .is_some_and(|value| value == "true")
            || line
                .volume_discount_nektar_glp_1()
                .as_ref()
                .and_then(|attribute| attribute.value())
                .is_some()
        {
            continue;
        }
        let Merchandise::ProductVariant(variant) = line.merchandise() else { continue };
        let Some(metafield) = variant.product().volume_discount_tiers() else { continue };
        let Ok(tiers) = serde_json::from_str::<Vec<VolumeDiscountTier>>(metafield.value()) else {
            continue;
        };
        let tiers: Vec<_> = tiers
            .into_iter()
            .filter(|tier| tier.qty > 0 && tier.percent.is_finite() && tier.percent >= 0.0)
            .collect();
        if tiers.is_empty() {
            continue;
        }
        let subtotal_cents = to_cents(
            line.cost().total_amount().amount().as_f64(),
            currency_code,
        );
        if subtotal_cents <= 0 {
            continue;
        }
        let group = groups
            .entry(variant.product().id().to_string())
            .or_insert_with(|| VolumeDiscountGroup {
                quantity: 0,
                subtotal_cents: 0,
                tiers: vec![],
            });
        group.quantity += i64::from(*line.quantity());
        group.subtotal_cents += subtotal_cents;
        group.tiers.extend(tiers);
    }

    groups
        .values()
        .filter_map(|group| {
            group
                .tiers
                .iter()
                .filter(|tier| tier.percent > 0.0 && group.quantity >= tier.qty)
                .max_by(|left, right| {
                    left.qty.cmp(&right.qty).then_with(|| {
                        left.percent
                            .partial_cmp(&right.percent)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
                })
                .map(|tier| {
                    ((group.subtotal_cents as f64 * tier.percent) / 100.0).round() as i64
                })
        })
        .sum()
}

fn landing_source(line: &Lines) -> Option<String> {
    line.landing_source().as_ref().and_then(|attribute| attribute.value()).cloned()
}

fn quiz_bundle_id(line: &Lines) -> Option<String> {
    line.quiz_bundle_id().as_ref().and_then(|attribute| attribute.value()).cloned()
}

fn quiz_target_cents(line: &Lines) -> Option<String> {
    line.quiz_target_cents().as_ref().and_then(|attribute| attribute.value()).cloned()
}

fn quiz_expected_paid_count(line: &Lines) -> Option<String> {
    line.quiz_expected_paid_count().as_ref().and_then(|attribute| attribute.value()).cloned()
}

fn quiz_free_gift(line: &Lines) -> Option<String> {
    line.quiz_free_gift().as_ref().and_then(|attribute| attribute.value()).cloned()
}

fn parse_config(input: &Input) -> Option<CompiledConfig> {
    let value = input.discount().metafield()?.value();
    serde_json::from_str(&value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::run_function_with_input;

    fn cart_json(lines_json: &str, subtotal: &str, config_json: &str) -> String {
        cart_json_with_classes(lines_json, subtotal, config_json, r#"["PRODUCT"]"#)
    }

    fn cart_json_with_classes(
        lines_json: &str,
        subtotal: &str,
        config_json: &str,
        discount_classes: &str,
    ) -> String {
        format!(
            r#"{{
                "discount": {{
                    "discountClasses": {discount_classes},
                    "metafield": {{ "value": {config} }}
                }},
                "cart": {{
                    "lines": {lines},
                    "cost": {{ "subtotalAmount": {{ "amount": "{subtotal}", "currencyCode": "USD" }} }}
                }}
            }}"#,
            config = serde_json::to_string(config_json).unwrap(),
            lines = lines_json,
            subtotal = subtotal,
        )
    }

    fn cart_json_with_customer(
        lines_json: &str,
        subtotal: &str,
        config_json: &str,
        number_of_orders: i64,
        amount_spent: &str,
    ) -> String {
        format!(
            r#"{{
                "discount": {{
                    "discountClasses": ["PRODUCT"],
                    "metafield": {{ "value": {config} }}
                }},
                "cart": {{
                    "buyerIdentity": {{
                        "customer": {{
                            "numberOfOrders": {number_of_orders},
                            "amountSpent": {{ "amount": "{amount_spent}", "currencyCode": "USD" }}
                        }}
                    }},
                    "lines": {lines},
                    "cost": {{ "subtotalAmount": {{ "amount": "{subtotal}", "currencyCode": "USD" }} }}
                }}
            }}"#,
            config = serde_json::to_string(config_json).unwrap(),
            lines = lines_json,
            subtotal = subtotal,
        )
    }

    fn regular_line(id: &str, variant_id: &str, product_id: &str, price: &str, qty: i64) -> String {
        format!(
            r#"{{
                "id": "{id}", "quantity": {qty},
                "cost": {{
                    "amountPerQuantity": {{ "amount": "{price}", "currencyCode": "USD" }},
                    "subtotalAmount": {{ "amount": "{price}", "currencyCode": "USD" }}
                }},
                "merchandise": {{ "__typename": "ProductVariant", "id": "{variant_id}", "product": {{ "id": "{product_id}", "volumeDiscountTiers": null }} }},
                "sellingPlanAllocation": null,
                "lineType": null,
                "offerId": null,
                "rewardId": null,
                "offerVersion": null,
                "volumeDiscountBundleItem": null,
                "volumeDiscountNektarGlp1": null
            }}"#
        )
    }

    fn gift_line(id: &str, variant_id: &str, product_id: &str, offer_id: &str, price: &str, qty: i64) -> String {
        format!(
            r#"{{
                "id": "{id}", "quantity": {qty},
                "cost": {{
                    "amountPerQuantity": {{ "amount": "{price}", "currencyCode": "USD" }},
                    "subtotalAmount": {{ "amount": "{price}", "currencyCode": "USD" }}
                }},
                "merchandise": {{ "__typename": "ProductVariant", "id": "{variant_id}", "product": {{ "id": "{product_id}", "volumeDiscountTiers": null }} }},
                "sellingPlanAllocation": null,
                "lineType": {{ "value": "gift" }},
                "offerId": {{ "value": "{offer_id}" }},
                "rewardId": {{ "value": "reward-1" }},
                "offerVersion": {{ "value": "1" }},
                "volumeDiscountBundleItem": null,
                "volumeDiscountNektarGlp1": null
            }}"#
        )
    }

    fn gift_line_with_metadata(
        id: &str,
        variant_id: &str,
        product_id: &str,
        offer_id: &str,
        reward_id: &str,
        offer_version: &str,
        price: &str,
        qty: i64,
    ) -> String {
        format!(
            r#"{{
                "id": "{id}", "quantity": {qty},
                "cost": {{
                    "amountPerQuantity": {{ "amount": "{price}", "currencyCode": "USD" }},
                    "subtotalAmount": {{ "amount": "{price}", "currencyCode": "USD" }}
                }},
                "merchandise": {{ "__typename": "ProductVariant", "id": "{variant_id}", "product": {{ "id": "{product_id}", "volumeDiscountTiers": null }} }},
                "sellingPlanAllocation": null,
                "lineType": {{ "value": "gift" }},
                "offerId": {{ "value": "{offer_id}" }},
                "rewardId": {{ "value": "{reward_id}" }},
                "offerVersion": {{ "value": "{offer_version}" }},
                "volumeDiscountBundleItem": null,
                "volumeDiscountNektarGlp1": null
            }}"#
        )
    }

    fn volume_discount_line(
        id: &str,
        variant_id: &str,
        product_id: &str,
        unit_price: &str,
        subtotal: &str,
        qty: i64,
        tiers_json: &str,
    ) -> String {
        let encoded_tiers = serde_json::to_string(tiers_json).unwrap();
        format!(
            r#"{{
                "id": "{id}", "quantity": {qty},
                "cost": {{
                    "amountPerQuantity": {{ "amount": "{unit_price}", "currencyCode": "USD" }},
                    "subtotalAmount": {{ "amount": "{subtotal}", "currencyCode": "USD" }},
                    "totalAmount": {{ "amount": "{subtotal}", "currencyCode": "USD" }}
                }},
                "merchandise": {{ "__typename": "ProductVariant", "id": "{variant_id}", "product": {{
                    "id": "{product_id}", "volumeDiscountTiers": {{ "value": {encoded_tiers} }}
                }} }},
                "sellingPlanAllocation": null,
                "lineType": null, "offerId": null, "rewardId": null, "offerVersion": null,
                "volumeDiscountBundleItem": null, "volumeDiscountNektarGlp1": null
            }}"#
        )
    }

    fn scoped_line(
        id: &str,
        variant_id: &str,
        product_id: &str,
        price: &str,
        qty: i64,
        landing: Option<&str>,
        quiz: Option<(&str, &str, &str, bool)>,
    ) -> String {
        let subtotal = price.parse::<f64>().unwrap() * qty as f64;
        let landing_json = landing.map(|value| format!(r#"{{ "value": "{value}" }}"#)).unwrap_or_else(|| "null".to_string());
        let (quiz_id, target, expected, gift) = quiz
            .map(|(bundle_id, target_cents, expected_count, is_gift)| (
                format!(r#"{{ "value": "{bundle_id}" }}"#),
                format!(r#"{{ "value": "{target_cents}" }}"#),
                format!(r#"{{ "value": "{expected_count}" }}"#),
                format!(r#"{{ "value": "{}" }}"#, if is_gift { "true" } else { "false" }),
            ))
            .unwrap_or_else(|| ("null".to_string(), "null".to_string(), "null".to_string(), "null".to_string()));
        format!(
            r#"{{
                "id": "{id}", "quantity": {qty},
                "cost": {{
                    "amountPerQuantity": {{ "amount": "{price}", "currencyCode": "USD" }},
                    "subtotalAmount": {{ "amount": "{subtotal:.2}", "currencyCode": "USD" }},
                    "totalAmount": {{ "amount": "{subtotal:.2}", "currencyCode": "USD" }}
                }},
                "merchandise": {{ "__typename": "ProductVariant", "id": "{variant_id}", "product": {{ "id": "{product_id}", "volumeDiscountTiers": null }} }},
                "sellingPlanAllocation": null,
                "lineType": null, "offerId": null, "rewardId": null, "offerVersion": null,
                "volumeDiscountBundleItem": null, "volumeDiscountNektarGlp1": null,
                "landingSource": {landing_json},
                "quizBundleId": {quiz_id}, "quizTargetCents": {target},
                "quizExpectedPaidCount": {expected}, "quizFreeGift": {gift}
            }}"#
        )
    }

    fn gift_offer_config(threshold_cents: i64, max_qty: i64) -> String {
        format!(
            r#"{{"offers":[{{
                "id":"offer-1","version":1,"offerType":"gift","priority":100,"stopLowerPriority":false,
                "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
                "giftVariantIds":["gid://shopify/ProductVariant/gift-v1"],"giftProductIds":[],
                "cartValueThresholdCents":{threshold_cents},"maxGiftQuantity":{max_qty},
                "discountType":"free","discountValue":100.0,"currencyCode":"USD",
                "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true
            }}]}}"#
        )
    }

    fn strict_gift_offer_config() -> &'static str {
        r#"{"offers":[{
            "id":"offer-1","version":3,"offerType":"gift","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":["gid://shopify/ProductVariant/gift-v1","gid://shopify/ProductVariant/gift-v2"],
            "giftProductIds":[],"cartValueThresholdCents":5000,"maxGiftQuantity":3,
            "discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "giftRewards":[
                {"id":"reward-1","targetProductIds":["gid://shopify/Product/gift-p1"],"targetVariantIds":["gid://shopify/ProductVariant/gift-v1"],"discountType":"free","discountValue":100,"maxQuantity":1},
                {"id":"reward-2","targetProductIds":["gid://shopify/Product/gift-p2"],"targetVariantIds":["gid://shopify/ProductVariant/gift-v2"],"discountType":"percentage","discountValue":50,"maxQuantity":2}
            ]
        }]}"#
    }

    #[test]
    fn gift_discount_applies_to_valid_gift_line() {
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "60.00", 1),
            gift_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/gift-v1", "gid://shopify/Product/gift-p1", "offer-1", "20.00", 1),
        );
        let payload = cart_json(&lines, "80.00", &gift_offer_config(5000, 1));

        let result = run_function_with_input(run, &payload).expect("should not error");
        assert_eq!(result.operations.len(), 1);
        match &result.operations[0] {
            schema::CartOperation::ProductDiscountsAdd(op) => {
                assert_eq!(op.candidates.len(), 1);
                assert_eq!(op.candidates[0].targets.len(), 1);
            }
            other => panic!("expected ProductDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn gift_discount_not_applied_when_threshold_not_met() {
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "40.00", 1),
            gift_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/gift-v1", "gid://shopify/Product/gift-p1", "offer-1", "20.00", 1),
        );
        let payload = cart_json(&lines, "60.00", &gift_offer_config(10000, 1));

        let result = run_function_with_input(run, &payload).expect("should not error");
        assert!(result.operations.is_empty(), "should not discount below threshold");
    }

    #[test]
    fn projected_volume_discount_cannot_unlock_a_gift_threshold() {
        let lines = format!(
            "[{},{}]",
            volume_discount_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "29.69",
                "89.07",
                3,
                r#"[{"qty":3,"percent":20}]"#,
            ),
            gift_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/gift-v1", "gid://shopify/Product/gift-p1", "offer-1", "20.00", 1),
        );
        let result = run_function_with_input(
            run,
            &cart_json(&lines, "109.07", &gift_offer_config(8500, 1)),
        ).expect("should not error");

        assert!(result.operations.is_empty(), "$89.07 less 20% is $71.26 and must not unlock $85");
    }

    #[test]
    fn tampered_gift_line_not_discounted() {
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "60.00", 1),
            gift_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/expensive-tampered", "gid://shopify/Product/p-expensive", "offer-1", "500.00", 1),
        );
        let payload = cart_json(&lines, "560.00", &gift_offer_config(5000, 1));

        let result = run_function_with_input(run, &payload).expect("should not error");
        assert!(result.operations.is_empty(), "tampered gift variant should not be discounted");
    }

    #[test]
    fn max_gift_quantity_enforced() {
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "60.00", 1),
            gift_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/gift-v1", "gid://shopify/Product/gift-p1", "offer-1", "20.00", 3),
        );
        let payload = cart_json(&lines, "120.00", &gift_offer_config(5000, 1));

        let result = run_function_with_input(run, &payload).expect("should not error");
        assert_eq!(result.operations.len(), 1);
        match &result.operations[0] {
            schema::CartOperation::ProductDiscountsAdd(op) => {
                let target = &op.candidates[0].targets[0];
                match target {
                    schema::ProductDiscountCandidateTarget::CartLine(t) => assert_eq!(t.quantity, Some(1)),
                }
            }
            other => panic!("expected ProductDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn strict_gift_rejects_cross_reward_variant_tampering() {
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "60.00", 1),
            gift_line_with_metadata(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v2",
                "gid://shopify/Product/gift-p2",
                "offer-1",
                "reward-1",
                "3",
                "20.00",
                1,
            ),
        );
        let result = run_function_with_input(run, &cart_json(&lines, "80.00", strict_gift_offer_config())).expect("should not error");
        assert!(result.operations.is_empty(), "a reward cannot claim another reward's variant");
    }

    #[test]
    fn strict_gift_rejects_unlisted_variant_from_allowed_product() {
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "60.00", 1),
            gift_line_with_metadata(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/unlisted",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "reward-1",
                "3",
                "100.00",
                1,
            ),
        );
        let result = run_function_with_input(run, &cart_json(&lines, "160.00", strict_gift_offer_config())).expect("should not error");
        assert!(result.operations.is_empty(), "an explicit variant allowlist must take precedence over its product id");
    }

    #[test]
    fn gift_rewards_are_enforced_even_when_offer_type_is_misconfigured() {
        let config = strict_gift_offer_config().replace("\"offerType\":\"gift\"", "\"offerType\":\"discount\"");
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "60.00", 1),
            gift_line_with_metadata(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "reward-1",
                "3",
                "20.00",
                1,
            ),
        );
        let result = run_function_with_input(run, &cart_json(&lines, "80.00", &config)).expect("should not error");
        assert_eq!(result.operations.len(), 1, "gift reward data must select the strict gift path");
    }

    #[test]
    fn excluded_products_cannot_unlock_a_gift_threshold() {
        let config = gift_offer_config(5000, 1).replace(
            "\"excludedProductIds\":[]",
            "\"excludedProductIds\":[\"gid://shopify/Product/excluded\"]",
        );
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/excluded",
                "gid://shopify/Product/excluded",
                "60.00",
                1,
            ),
            gift_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/gift-v1", "gid://shopify/Product/gift-p1", "offer-1", "20.00", 1),
        );
        let result = run_function_with_input(run, &cart_json(&lines, "80.00", &config)).expect("should not error");
        assert!(result.operations.is_empty(), "excluded products must not count toward gift qualification");
    }

    #[test]
    fn strict_gift_rejects_stale_offer_version() {
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "60.00", 1),
            gift_line_with_metadata(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "reward-1",
                "2",
                "20.00",
                1,
            ),
        );
        let result = run_function_with_input(run, &cart_json(&lines, "80.00", strict_gift_offer_config())).expect("should not error");
        assert!(result.operations.is_empty(), "a stale offer version must not receive a discount");
    }

    #[test]
    fn strict_gift_applies_each_reward_discount_and_quantity_limit() {
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "60.00", 1),
            gift_line_with_metadata(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v2",
                "gid://shopify/Product/gift-p2",
                "offer-1",
                "reward-2",
                "3",
                "20.00",
                3,
            ),
        );
        let result = run_function_with_input(run, &cart_json(&lines, "120.00", strict_gift_offer_config())).expect("should not error");
        match &result.operations[0] {
            schema::CartOperation::ProductDiscountsAdd(operation) => {
                assert_eq!(operation.candidates[0].targets.len(), 1);
                match &operation.candidates[0].targets[0] {
                    schema::ProductDiscountCandidateTarget::CartLine(target) => assert_eq!(target.quantity, Some(2)),
                }
                match &operation.candidates[0].value {
                    schema::ProductDiscountCandidateValue::Percentage(value) => assert_eq!(value.value.0, 50.0),
                    other => panic!("expected percentage, got {other:?}"),
                }
            }
            other => panic!("expected ProductDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn product_reward_requires_every_compiled_requirement_and_targets_exact_variants() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":["gid://shopify/ProductVariant/trigger"],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[{"variantId":"gid://shopify/ProductVariant/trigger","trackMode":"variant","minQuantity":2}],
            "productRewards":[{
                "id":"reward-1","rewardType":"product_discount","targetProductIds":[],
                "targetVariantIds":["gid://shopify/ProductVariant/target"],"discountType":"percentage",
                "discountValue":25,"lineQuantityEquals":1,"maxUnitsTotal":1,"subscriptionMode":"one_time_only"
            }],"orderRewards":[]
        }]}"#;
        let lines = format!(
            "[{},{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/trigger", "gid://shopify/Product/trigger", "30.00", 2),
            regular_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/target", "gid://shopify/Product/target", "20.00", 1),
            regular_line("gid://shopify/CartLine/3", "gid://shopify/ProductVariant/other", "gid://shopify/Product/other", "20.00", 1),
        );
        let payload = cart_json(&lines, "100.00", config);
        let result = run_function_with_input(run, &payload).expect("should not error");

        match &result.operations[0] {
            schema::CartOperation::ProductDiscountsAdd(op) => {
                assert_eq!(op.candidates.len(), 1);
                match &op.candidates[0].targets[0] {
                    schema::ProductDiscountCandidateTarget::CartLine(target) => {
                        assert_eq!(target.id, "gid://shopify/CartLine/2");
                        assert_eq!(target.quantity, Some(1));
                    }
                }
            }
            other => panic!("expected ProductDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn order_reward_excludes_gift_lines_from_order_subtotal_target() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"productRewards":[],
            "orderRewards":[{"id":"order-1","discountType":"percentage","discountValue":10}]
        }]}"#;
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/paid", "gid://shopify/Product/paid", "50.00", 1),
            gift_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/gift", "gid://shopify/Product/gift", "offer-2", "20.00", 1),
        );
        let payload = cart_json_with_classes(&lines, "70.00", config, r#"["ORDER"]"#);
        let result = run_function_with_input(run, &payload).expect("should not error");

        match &result.operations[0] {
            schema::CartOperation::OrderDiscountsAdd(op) => match &op.candidates[0].targets[0] {
                schema::OrderDiscountCandidateTarget::OrderSubtotal(target) => {
                    assert_eq!(target.excluded_cart_line_ids, vec!["gid://shopify/CartLine/2"]);
                }
            },
            other => panic!("expected OrderDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn landing_tier_only_discounts_tagged_lines_at_the_highest_qualified_price() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{
                "id":"landing-tier","rewardType":"product_discount","targetProductIds":[],
                "targetVariantIds":["gid://shopify/ProductVariant/protein"],"discountType":"fixed_price","discountValue":49.99,
                "subscriptionMode":"any","scopeMode":"landing","requiredLineAttributeValue":"protein-lp",
                "requiredAnchorVariantIds":[],"requiredAnchorMinQuantity":1,"requiresAnchorSubscription":false,
                "priceTiers":[{"quantity":1,"targetPricePerUnit":45},{"quantity":3,"targetPricePerUnit":40}],
                "discountPercentageOnGifts":100
            }]
        }]}"#;
        let lines = format!(
            "[{},{},{}]",
            scoped_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/protein", "gid://shopify/Product/protein", "50.00", 2, Some("protein-lp"), None),
            scoped_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/protein", "gid://shopify/Product/protein", "50.00", 1, Some("protein-lp"), None),
            scoped_line("gid://shopify/CartLine/3", "gid://shopify/ProductVariant/protein", "gid://shopify/Product/protein", "50.00", 1, None, None),
        );
        let result = run_function_with_input(run, &cart_json(&lines, "200.00", config)).expect("should not error");
        match &result.operations[0] {
            schema::CartOperation::ProductDiscountsAdd(op) => {
                assert_eq!(op.candidates.len(), 2);
                for candidate in &op.candidates {
                    match &candidate.value {
                        schema::ProductDiscountCandidateValue::FixedAmount(value) => {
                            assert_eq!(value.amount.0, 10.0);
                            assert_eq!(value.applies_to_each_item, Some(true));
                        }
                        other => panic!("expected fixed amount, got {other:?}"),
                    }
                }
            }
            other => panic!("expected ProductDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn quiz_bundle_requires_every_paid_component_before_price_match_or_gifts() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{
                "id":"quiz","rewardType":"product_discount","targetProductIds":[],"targetVariantIds":[],
                "discountType":"free","discountValue":100,"subscriptionMode":"any","scopeMode":"quiz_bundle",
                "requiredAnchorVariantIds":[],"requiredAnchorMinQuantity":1,"requiresAnchorSubscription":false,
                "priceTiers":[],"discountPercentageOnGifts":100
            }]
        }]}"#;
        let paid_one = scoped_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/p1", "gid://shopify/Product/p1", "50.00", 1, None, Some(("bundle-a", "8000", "2", false)));
        let paid_two = scoped_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/p2", "gid://shopify/Product/p2", "50.00", 1, None, Some(("bundle-a", "8000", "2", false)));
        let gift = scoped_line("gid://shopify/CartLine/3", "gid://shopify/ProductVariant/gift", "gid://shopify/Product/gift", "10.00", 1, None, Some(("bundle-a", "8000", "2", true)));

        let incomplete = format!("[{paid_one},{gift}]");
        let incomplete_result = run_function_with_input(run, &cart_json(&incomplete, "60.00", config)).expect("should not error");
        assert!(incomplete_result.operations.is_empty());

        let complete = format!("[{paid_one},{paid_two},{gift}]");
        let complete_result = run_function_with_input(run, &cart_json(&complete, "110.00", config)).expect("should not error");
        match &complete_result.operations[0] {
            schema::CartOperation::ProductDiscountsAdd(op) => {
                assert_eq!(op.candidates.len(), 2);
                let combined = op.candidates.iter().find(|candidate| candidate.targets.len() == 2).expect("combined paid candidate");
                match &combined.value {
                    schema::ProductDiscountCandidateValue::FixedAmount(value) => {
                        assert_eq!(value.amount.0, 20.0);
                        assert_eq!(value.applies_to_each_item, Some(false));
                    }
                    other => panic!("expected fixed amount, got {other:?}"),
                }
            }
            other => panic!("expected ProductDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn customer_history_is_checkout_verified_and_guests_fail_closed() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "customerOrderCountMin":3,"customerAmountSpentMinCents":10000,
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{
                "id":"loyalty","rewardType":"product_discount","targetProductIds":["gid://shopify/Product/loyalty"],
                "targetVariantIds":[],"discountType":"percentage","discountValue":20,"subscriptionMode":"any",
                "scopeMode":"sitewide","requiredAnchorVariantIds":[],"requiredAnchorMinQuantity":1,
                "requiresAnchorSubscription":false,"priceTiers":[],"discountPercentageOnGifts":100
            }]
        }]}"#;
        let lines = format!("[{}]", regular_line(
            "gid://shopify/CartLine/1",
            "gid://shopify/ProductVariant/loyalty",
            "gid://shopify/Product/loyalty",
            "50.00",
            1,
        ));

        let guest = run_function_with_input(run, &cart_json(&lines, "50.00", config)).expect("guest input");
        assert!(guest.operations.is_empty());

        let not_qualified = run_function_with_input(run, &cart_json_with_customer(&lines, "50.00", config, 2, "200.00")).expect("customer input");
        assert!(not_qualified.operations.is_empty());

        let qualified = run_function_with_input(run, &cart_json_with_customer(&lines, "50.00", config, 3, "100.00")).expect("customer input");
        assert_eq!(qualified.operations.len(), 1);
    }
}
