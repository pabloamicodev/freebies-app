use crate::config::{
    is_zero_decimal, minor_units, to_cents, CompiledConfig, CompiledOffer, CompiledOrderReward,
    CompiledProductReward,
};
use crate::page_match::{metadata_matches, LineMetadata};
use crate::schema;
use schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise;
use schema::cart_lines_discounts_generate_run::input::cart::Lines;
use schema::cart_lines_discounts_generate_run::Input;
use shopify_function::Result;
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;

const LINE_TYPE_GIFT: &str = "gift";
const LINE_TYPE_UPSELL: &str = "upsell";

thread_local! {
    // Each line's packed metadata is parsed once per run (it used to be re-parsed on every lookup).
    static LINE_METADATA: RefCell<HashMap<String, Option<Rc<LineMetadata>>>> = RefCell::new(HashMap::new());
    // Page-match result per condition-set fingerprint, then line id, so offers sharing the same page
    // conditions match each line once per run instead of once per offer.
    static PAGE_MATCH: RefCell<HashMap<u64, HashMap<String, bool>>> = RefCell::new(HashMap::new());
    static ZERO_DECIMAL_CURRENCY: Cell<bool> = const { Cell::new(false) };
}

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

    let mut config = match parse_config(&input) {
        Some(c) => c,
        None => return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] }),
    };
    let currency = input.cart().cost().subtotal_amount().currency_code().to_string();
    LINE_METADATA.with(|cache| cache.borrow_mut().clear());
    PAGE_MATCH.with(|cache| cache.borrow_mut().clear());
    ZERO_DECIMAL_CURRENCY.with(|flag| flag.set(is_zero_decimal(&currency)));
    config.localize(input.presentment_currency_rate().as_f64(), &currency);

    let mut offers = config.offers.clone();
    offers.sort_by_key(|o| o.priority);

    #[cfg(feature = "code_gate")]
    let (entered, entered_hashes) = entered_codes(&input);
    #[cfg(feature = "code_gate")]
    let mut accepted: Vec<String> = Vec::new();

    let mut candidates: Vec<schema::ProductDiscountCandidate> = Vec::new();
    let mut order_candidates: Vec<schema::OrderDiscountCandidate> = Vec::new();
    // Only offers with a strictly lower priority (higher number) are blocked; equal-priority offers still apply.
    let mut stop_after_priority: Option<i32> = None;

    for offer in &offers {
        let blocked = stop_after_priority.is_some_and(|stop_at| offer.priority > stop_at);
        #[cfg(not(feature = "code_gate"))]
        if blocked {
            break;
        }
        #[cfg(feature = "code_gate")]
        {
            if !offer_code_matches(offer, &entered_hashes) {
                continue;
            }
            // A code is accepted only when its offer's conditions pass, so buyers are not told
            // a code applied when nothing can ever follow.
            if !check_main_condition(offer, &input, &config) {
                continue;
            }
            for (code, hash) in entered.iter().zip(&entered_hashes) {
                if offer.code_hashes.contains(hash) && !accepted.contains(code) {
                    accepted.push(code.clone());
                }
            }
            if blocked {
                continue;
            }
        }

        let mut offer_candidates = if has_product_discount {
            evaluate_offer(offer, &input, &config)
        } else {
            vec![]
        };
        let mut offer_order_candidates = if has_order_discount {
            evaluate_order_offer(offer, &input, &config)
        } else {
            vec![]
        };
        // Shopify shows the candidate message as the discount name in cart and checkout.
        if let Some(title) = offer.title.as_deref().filter(|title| !title.is_empty()) {
            for candidate in &mut offer_candidates {
                candidate.message = Some(title.to_string());
            }
            for candidate in &mut offer_order_candidates {
                candidate.message = Some(title.to_string());
            }
        }
        if !offer_candidates.is_empty() || !offer_order_candidates.is_empty() {
            if offer.stop_lower_priority {
                stop_after_priority = Some(offer.priority);
            }
            candidates.extend(offer_candidates);
            order_candidates.extend(offer_order_candidates);
        }
    }

    // Operations start with the accept op so buyer codes show as applied even when no discount follows.
    let mut operations = Vec::new();
    #[cfg(feature = "code_gate")]
    if !accepted.is_empty() {
        operations.push(schema::CartOperation::EnteredDiscountCodesAccept(
            schema::EnteredDiscountCodesAcceptOperation {
                codes: accepted
                    .into_iter()
                    .map(|code| schema::DiscountCode { code })
                    .collect(),
            },
        ));
    }
    if candidates.is_empty() && order_candidates.is_empty() {
        return Ok(schema::CartLinesDiscountsGenerateRunResult { operations });
    }

    let candidates = best_candidate_per_line(candidates, &input);

    if !candidates.is_empty() {
        operations.push(schema::CartOperation::ProductDiscountsAdd(
            schema::ProductDiscountsAddOperation {
                selection_strategy: schema::ProductDiscountSelectionStrategy::All,
                candidates,
            },
        ));
    }
    if !order_candidates.is_empty() {
        // Competing order offers resolve to the biggest saving for the customer;
        // merchants who need one offer to win use stopLowerPriority.
        operations.push(schema::CartOperation::OrderDiscountsAdd(
            schema::OrderDiscountsAddOperation {
                selection_strategy: schema::OrderDiscountSelectionStrategy::Maximum,
                candidates: order_candidates,
            },
        ));
    }

    Ok(schema::CartLinesDiscountsGenerateRunResult { operations })
}

fn evaluate_offer(
    offer: &CompiledOffer,
    input: &Input,
    config: &CompiledConfig,
) -> Vec<schema::ProductDiscountCandidate> {
    if !offer.gift_rewards.is_empty() || offer.offer_type == "gift" {
        return evaluate_gift_offer(offer, input, config);
    }
    if !offer.product_rewards.is_empty() {
        if !check_main_condition(offer, input, config) {
            return vec![];
        }
        return offer
            .product_rewards
            .iter()
            .flat_map(|reward| evaluate_product_reward(reward, input, offer))
            .collect();
    }
    if offer.offer_type == "discount" {
        return evaluate_discount_offer(offer, input, config);
    }
    vec![]
}

fn evaluate_product_reward(
    reward: &CompiledProductReward,
    input: &Input,
    offer: &CompiledOffer,
) -> Vec<schema::ProductDiscountCandidate> {
    if reward.scope_mode == "quiz_bundle" {
        return evaluate_quiz_bundle_reward(reward, input);
    }
    if reward.scope_mode == "landing" && !landing_anchor_qualifies(reward, input) {
        return vec![];
    }
    // Landing/tagged rewards are unlocked by client-set line properties. The configured limit
    // (`maxQuantity`, default 1) is how many times the gift SET is granted: each target product
    // (or variant, when the reward targets variants) gets at most that many free units, no matter
    // how many anchors or units are in the cart. `maxUnitsTotal` stays a separate cart-wide cap.
    // The default of 1 set only applies to free-gift landing rewards: tagged bundles ("buy 3 of A,
    // 20% off") and landing price/quantity tiers discount every qualifying unit unless a limit is set.
    let free_landing_gift = reward.scope_mode == "landing"
        && reward.price_tiers.is_empty()
        && reward.quantity_tiers.is_empty()
        && (reward.discount_type == "free"
            || (reward.discount_type == "percentage" && reward.discount_value >= 100.0));
    let set_limit = if free_landing_gift {
        Some(reward.max_quantity.unwrap_or(1))
    } else if reward.scope_mode == "landing" || reward.scope_mode == "tagged_offer" {
        reward.max_quantity
    } else {
        None
    };
    let (per_product_cap, per_variant_cap) = match set_limit {
        Some(limit) if !reward.target_variant_ids.is_empty() => (
            reward.max_units_per_product,
            Some(reward.max_units_per_variant.map_or(limit, |cap| cap.min(limit))),
        ),
        Some(limit) => (
            Some(reward.max_units_per_product.map_or(limit, |cap| cap.min(limit))),
            reward.max_units_per_variant,
        ),
        None => (reward.max_units_per_product, reward.max_units_per_variant),
    };
    // A tagged offer with no configured targets would otherwise discount any
    // product carrying a copied/guessed offer id — fail closed instead.
    if reward.scope_mode == "tagged_offer"
        && reward.target_product_ids.is_empty()
        && reward.target_variant_ids.is_empty()
    {
        return vec![];
    }

    let product_ids: HashSet<&str> = reward
        .target_product_ids
        .iter()
        .map(String::as_str)
        .collect();
    let variant_ids: HashSet<&str> = reward
        .target_variant_ids
        .iter()
        .map(String::as_str)
        .collect();
    let mut eligible: Vec<&Lines> = input
        .cart()
        .lines()
        .iter()
        .filter(|line| !is_gift_line(line) && !outside_matched_lines(offer, line))
        .filter(|line| {
            reward.scope_mode != "landing"
                || landing_source(line).as_deref()
                    == reward.required_line_attribute_value.as_deref()
        })
        .filter(|line| {
            reward.scope_mode != "tagged_offer"
                || line_offer_id(line).as_deref() == reward.required_offer_id.as_deref()
        })
        .filter(|line| {
            let Some((_, product_id)) = variant_and_product_id(line) else {
                return false;
            };
            // Offer-level exclusions apply to the reward too, not only to the qualifying subtotal.
            if offer.excluded_product_ids.iter().any(|id| id == &product_id) {
                return false;
            }
            (product_ids.is_empty() && variant_ids.is_empty())
                || is_one_of(line, &product_ids, &variant_ids)
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
        .filter(|line| {
            reward.required_line_attribute.as_ref().is_none_or(|attribute| {
                metadata_value(line, &attribute.key).as_deref() == Some(attribute.value.as_str())
            })
        })
        .collect();

    if eligible.is_empty() {
        return vec![];
    }
    eligible.sort_by(|a, b| a.id().cmp(b.id()));

    let total_quantity: i64 = if reward.count_rule == "unique" {
        eligible
            .iter()
            .filter_map(|line| variant_and_product_id(line).map(|(_, product_id)| product_id))
            .collect::<HashSet<_>>()
            .len() as i64
    } else {
        eligible
            .iter()
            .map(|line| i64::from(*line.quantity()))
            .sum()
    };
    let quantity_tier = reward
        .quantity_tiers
        .iter()
        .filter(|tier| {
            total_quantity >= tier.minimum_quantity
                && tier
                    .maximum_quantity
                    .is_none_or(|maximum| total_quantity <= maximum)
        })
        .max_by_key(|tier| tier.minimum_quantity);
    if !reward.quantity_tiers.is_empty() && quantity_tier.is_none() {
        return vec![];
    }
    // "Cheapest item free" needs something to pair with; a lone item is not a BOGO.
    if reward.discount_type == "cheapest_item_free" && reward.quantity_tiers.is_empty() && total_quantity < 2 {
        return vec![];
    }

    let tier_target_price = if reward.price_tiers.is_empty() {
        None
    } else {
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

    let cheapest_first = reward.selection_mode == "cheapest" || reward.discount_type == "cheapest_item_free";
    let most_expensive_first = reward.selection_mode == "most_expensive"
        || reward.discount_type == "most_expensive_item_discount";
    if cheapest_first || most_expensive_first {
        eligible.sort_by(|a, b| {
            let ordering = line_price(a)
                .partial_cmp(&line_price(b))
                .unwrap_or(std::cmp::Ordering::Equal);
            (if cheapest_first { ordering } else { ordering.reverse() }).then(a.id().cmp(b.id()))
        });
    }

    let mut remaining = quantity_tier
        .and_then(|tier| tier.discounted_quantity)
        .or(reward.max_units_total)
        .or(if set_limit.is_some() { None } else { reward.max_quantity })
        .or_else(|| {
            if reward.discount_type == "cheapest_item_free"
                || reward.discount_type == "most_expensive_item_discount"
            {
                Some(1)
            } else {
                None
            }
        })
        .unwrap_or(i64::MAX);
    let mut candidates = Vec::new();
    let mut applied_by_product: HashMap<String, i64> = HashMap::new();
    let mut applied_by_variant: HashMap<String, i64> = HashMap::new();
    for line in eligible {
        if remaining <= 0 {
            break;
        }
        let mut quantity = i64::from(*line.quantity()).min(remaining);
        if let Some(per_line) = reward.max_units_per_line {
            quantity = quantity.min(per_line);
        }
        let (variant_id, product_id) = variant_and_product_id(line).unwrap_or_default();
        if let Some(per_product) = per_product_cap {
            quantity = take_units(&mut applied_by_product, product_id, per_product, quantity);
        }
        if let Some(per_variant) = per_variant_cap {
            quantity = take_units(&mut applied_by_variant, variant_id, per_variant, quantity);
        }
        if quantity <= 0 {
            continue;
        }
        remaining -= quantity;
        let effective_discount_type = quantity_tier
            .map(|tier| tier.discount_type.as_str())
            .unwrap_or(reward.discount_type.as_str());
        let effective_discount_value = quantity_tier
            .map(|tier| tier.discount_value)
            .unwrap_or(reward.discount_value);
        let (discount_type, discount_value) = if let Some(target_price) = tier_target_price {
            let current_price = line_price(line);
            ("fixed_amount", (current_price - target_price).max(0.0))
        } else if effective_discount_type == "fixed_price" {
            let current_price = line_price(line);
            (
                "fixed_amount",
                (current_price - effective_discount_value).max(0.0),
            )
        } else if effective_discount_type == "cheapest_item_free"
            || effective_discount_type == "free"
        {
            ("free", 100.0)
        } else if effective_discount_type == "most_expensive_item_discount" {
            ("percentage", effective_discount_value)
        } else {
            (effective_discount_type, effective_discount_value)
        };
        if discount_value <= 0.0 {
            continue;
        }
        candidates.push(make_candidate(
            line.id().clone(),
            quantity,
            discount_type,
            discount_value,
            "Discount",
        ));
    }
    candidates
}

/// Grants up to `wanted` units against a per-key cap, remembering what was granted.
fn take_units(applied: &mut HashMap<String, i64>, key: String, cap: i64, wanted: i64) -> i64 {
    let granted = applied.entry(key).or_insert(0);
    let units = wanted.min((cap - *granted).max(0));
    *granted += units;
    units
}

fn landing_anchor_qualifies(reward: &CompiledProductReward, input: &Input) -> bool {
    let Some(required_source) = reward.required_line_attribute_value.as_deref() else {
        return false;
    };
    let anchor_ids: HashSet<&str> = reward
        .required_anchor_variant_ids
        .iter()
        .map(String::as_str)
        .collect();
    let target_product_ids: HashSet<&str> = reward
        .target_product_ids
        .iter()
        .map(String::as_str)
        .collect();
    let target_variant_ids: HashSet<&str> = reward
        .target_variant_ids
        .iter()
        .map(String::as_str)
        .collect();
    let quantity: i64 = input
        .cart()
        .lines()
        .iter()
        .filter(|line| !is_gift_line(line))
        .filter(|line| landing_source(line).as_deref() == Some(required_source))
        .filter(|line| {
            if anchor_ids.is_empty() {
                // No configured anchor variant — any tagged line counts except
                // the reward's own targets, otherwise a customer could tag
                // just the target product itself and self-unlock the reward.
                return !is_one_of(line, &target_product_ids, &target_variant_ids);
            }
            variant_and_product_id(line)
                .map(|(variant_id, _)| anchor_ids.contains(variant_id.as_str()))
                .unwrap_or(false)
        })
        .filter(|line| {
            !reward.requires_anchor_subscription || line.selling_plan_allocation().is_some()
        })
        .map(|line| i64::from(*line.quantity()))
        .sum();
    quantity >= reward.required_anchor_min_quantity
}

const DEFAULT_QUIZ_MAX_DISCOUNT_PERCENT: f64 = 50.0;

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
    let target_product_ids: HashSet<&str> = reward
        .target_product_ids
        .iter()
        .map(String::as_str)
        .collect();
    let target_variant_ids: HashSet<&str> = reward
        .target_variant_ids
        .iter()
        .map(String::as_str)
        .collect();
    let restrict_to_targets = !target_product_ids.is_empty() || !target_variant_ids.is_empty();

    let mut groups: BTreeMap<String, QuizGroup<'_>> = BTreeMap::new();
    for line in input.cart().lines() {
        let Some(bundle_id) = quiz_bundle_id(line) else {
            continue;
        };
        if restrict_to_targets && !is_one_of(line, &target_product_ids, &target_variant_ids) {
            continue;
        }
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
            group.target_cents =
                quiz_target_cents(line).and_then(|value| value.parse::<i64>().ok());
        }
        if group.expected_paid_count.is_none() {
            group.expected_paid_count =
                quiz_expected_paid_count(line).and_then(|value| value.parse::<usize>().ok());
        }
    }

    let bundle_price_configured = reward.discount_type == "fixed_price" && reward.discount_value > 0.0;
    let currency = input.cart().cost().subtotal_amount().currency_code().to_string();
    let mut candidates = vec![];
    for (_bundle_id, group) in groups {
        let Some(expected_paid_count) = group.expected_paid_count else {
            continue;
        };
        if group.paid.len() < expected_paid_count {
            continue;
        }
        // Free gifts follow the same set rule: at most `maxQuantity` (default 1) units per gift product.
        let mut gift_units_by_product: HashMap<String, i64> = HashMap::new();
        for line in group.gifts {
            let product_id = variant_and_product_id(line).unwrap_or_default().1;
            let quantity = take_units(
                &mut gift_units_by_product,
                product_id,
                reward.max_quantity.unwrap_or(1),
                i64::from(*line.quantity()),
            );
            if quantity <= 0 {
                continue;
            }
            candidates.push(make_candidate(
                line.id().clone(),
                quantity,
                "percentage",
                reward.discount_percentage_on_gifts,
                "Bundle discount",
            ));
        }
        // A configured bundle price wins. Otherwise the client-set `_quiz_target_cents` is used,
        // bounded below. A target of 0 (or negative) would discount the paid lines to free —
        // reject it instead of silently treating it as a 100%-off bundle.
        let target_price = if bundle_price_configured {
            reward.discount_value
        } else {
            match group.target_cents {
                Some(minor) if minor > 0 => minor as f64 / minor_units(&currency),
                _ => continue,
            }
        };
        if group.paid.is_empty() {
            continue;
        }
        let current_total: f64 = group
            .paid
            .iter()
            .map(|line| line.cost().subtotal_amount().amount().as_f64())
            .sum();
        let mut discount_needed = (current_total - target_price).min(current_total);
        // The client-set target can only ever shave a configured share off the paid lines.
        // With no configured price the cap defaults to 50% so a forged target can't approach 100% off.
        if !bundle_price_configured || reward.quiz_max_discount_percent.is_some() {
            let percent = reward.quiz_max_discount_percent.unwrap_or(DEFAULT_QUIZ_MAX_DISCOUNT_PERCENT);
            discount_needed = discount_needed.min(current_total * percent / 100.0);
        }
        if discount_needed <= 0.0 {
            continue;
        }
        candidates.push(make_multi_line_fixed_candidate(
            group.paid,
            discount_needed,
            "Bundle discount",
        ));
    }
    candidates
}

fn evaluate_order_offer(
    offer: &CompiledOffer,
    input: &Input,
    config: &CompiledConfig,
) -> Vec<schema::OrderDiscountCandidate> {
    if offer.order_rewards.is_empty() || !check_main_condition(offer, input, config) {
        return vec![];
    }
    // Excluded lines leave the orderSubtotal target, so percentage/fixed values
    // and tier thresholds all work off the same (eligible) subtotal.
    let (eligible_lines, excluded_lines): (Vec<&Lines>, Vec<&Lines>) = input
        .cart()
        .lines()
        .iter()
        .partition(|line| !is_gift_line(line) && !outside_matched_lines(offer, line));
    let excluded_line_ids: Vec<String> =
        excluded_lines.iter().map(|line| line.id().clone()).collect();
    let active_currency = input
        .cart()
        .cost()
        .subtotal_amount()
        .currency_code()
        .to_string();
    let qualifying_subtotal_cents: i64 = eligible_lines
        .iter()
        .map(|line| {
            to_cents(
                line.cost().subtotal_amount().amount().as_f64(),
                &active_currency,
            )
        })
        .sum();
    let qualifying_quantity: i64 = eligible_lines
        .iter()
        .map(|line| i64::from(*line.quantity()))
        .sum();

    offer
        .order_rewards
        .iter()
        .filter_map(|reward| {
            make_order_candidate(
                reward,
                excluded_line_ids.clone(),
                qualifying_subtotal_cents,
                qualifying_quantity,
            )
        })
        .collect()
}

fn make_order_candidate(
    reward: &CompiledOrderReward,
    excluded_cart_line_ids: Vec<String>,
    qualifying_subtotal_cents: i64,
    _qualifying_quantity: i64,
) -> Option<schema::OrderDiscountCandidate> {
    let tier = reward
        .subtotal_tiers
        .iter()
        .filter(|tier| {
            tier.minimum_subtotal_cents
                .is_none_or(|minimum| qualifying_subtotal_cents >= minimum)
                && tier
                    .maximum_subtotal_cents
                    .is_none_or(|maximum| qualifying_subtotal_cents <= maximum)
                && tier
                    .minimum_quantity
                    .is_none_or(|minimum| _qualifying_quantity >= minimum)
                && tier
                    .maximum_quantity
                    .is_none_or(|maximum| _qualifying_quantity <= maximum)
        })
        .max_by_key(|tier| {
            (
                tier.minimum_subtotal_cents.unwrap_or(0),
                tier.minimum_quantity.unwrap_or(0),
            )
        });
    if !reward.subtotal_tiers.is_empty() && tier.is_none() {
        return None;
    }
    let discount_type = tier
        .map(|tier| tier.discount_type.as_str())
        .unwrap_or(reward.discount_type.as_str());
    let discount_value = tier
        .map(|tier| tier.discount_value)
        .unwrap_or(reward.discount_value);
    let value = match discount_type {
        "free" => schema::OrderDiscountCandidateValue::Percentage(schema::Percentage {
            value: shopify_function::scalars::Decimal(100.0),
        }),
        "percentage" if discount_value > 0.0 => {
            schema::OrderDiscountCandidateValue::Percentage(schema::Percentage {
                value: shopify_function::scalars::Decimal(discount_value.min(100.0)),
            })
        }
        "fixed_amount" if discount_value > 0.0 => {
            schema::OrderDiscountCandidateValue::FixedAmount(schema::FixedAmount {
                amount: shopify_function::scalars::Decimal(round_to_cents(discount_value)),
            })
        }
        _ => return None,
    };
    Some(schema::OrderDiscountCandidate {
        associated_discount_code: None,
        conditions: None,
        message: Some("Discount".to_string()),
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
fn evaluate_gift_offer(
    offer: &CompiledOffer,
    input: &Input,
    config: &CompiledConfig,
) -> Vec<schema::ProductDiscountCandidate> {
    if !check_main_condition(offer, input, config) {
        return vec![];
    }

    if !offer.gift_rewards.is_empty() {
        // The reward's limit is how many times its gift SET is granted: each gift product gets at
        // most `limit` discounted units, however high the buyer raises a gift line's quantity.
        let mut applied_by_product: HashMap<String, i64> = HashMap::new();
        let mut applied_by_reward: HashMap<String, i64> = HashMap::new();
        let mut candidates = Vec::new();

        for line in input.cart().lines().iter() {
            let line_quantity = i64::from(*line.quantity());
            if line_quantity <= 0
                || line_type(line).as_deref() != Some(LINE_TYPE_GIFT)
                || line_offer_id(line).as_deref() != Some(offer.id.as_str())
            {
                continue;
            }

            let Some(reward_id) = line_reward_id(line) else {
                continue;
            };
            let Some(reward) = offer
                .gift_rewards
                .iter()
                .find(|candidate| candidate.id == reward_id)
            else {
                continue;
            };
            let Some((variant_id, product_id)) = variant_and_product_id(line) else {
                continue;
            };
            let target_matches = if !reward.target_variant_ids.is_empty() {
                reward.target_variant_ids.iter().any(|id| id == &variant_id)
            } else {
                reward.target_product_ids.iter().any(|id| id == &product_id)
            };
            if !target_matches {
                continue;
            }

            let mut quantity = take_units(
                &mut applied_by_product,
                reward.id.clone() + &product_id,
                reward.max_quantity,
                line_quantity,
            );
            // A picker (choose K of N) grants selectionCount x limit units across ALL its gifts, so
            // adding every option via /cart/add frees only the first lines in cart order (the ones
            // the shopper added first); the rest are charged.
            if reward.selectable || reward.target_variant_ids.len() > 1 {
                quantity = take_units(
                    &mut applied_by_reward,
                    reward.id.clone(),
                    reward.selection_count.unwrap_or(1) * reward.max_quantity,
                    quantity,
                );
            }
            if quantity <= 0 {
                continue;
            }
            candidates.push(make_candidate(
                line.id().clone(),
                quantity,
                &reward.discount_type,
                reward.discount_value,
                "Free gift",
            ));
        }
        return candidates;
    }

    vec![]
}

fn evaluate_discount_offer(
    offer: &CompiledOffer,
    input: &Input,
    config: &CompiledConfig,
) -> Vec<schema::ProductDiscountCandidate> {
    if !check_main_condition(offer, input, config) {
        return vec![];
    }

    let required_set: HashSet<&str> = offer
        .required_product_ids
        .iter()
        .map(String::as_str)
        .collect();
    let excluded_set: HashSet<&str> = offer
        .excluded_product_ids
        .iter()
        .map(String::as_str)
        .collect();

    let eligible: Vec<_> = input
        .cart()
        .lines()
        .iter()
        .filter(|line| {
            is_eligible_line(line, &required_set, &excluded_set) && !outside_matched_lines(offer, line)
        })
        .collect();

    if eligible.is_empty() {
        return vec![];
    }

    match offer.discount_type.as_str() {
        "cheapest_item_free" => {
            let cheapest = eligible.iter().min_by(|a, b| {
                line_price(a)
                    .partial_cmp(&line_price(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(a.id().cmp(b.id()))
            });
            match cheapest {
                Some(line) => vec![make_candidate(
                    line.id().clone(),
                    1,
                    "free",
                    100.0,
                    "Cheapest item free",
                )],
                None => vec![],
            }
        }
        "most_expensive_item_discount" => {
            let most_expensive = eligible.iter().max_by(|a, b| {
                line_price(a)
                    .partial_cmp(&line_price(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(b.id().cmp(a.id()))
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
            .map(|line| {
                make_candidate(
                    line.id().clone(),
                    *line.quantity() as i64,
                    &offer.discount_type,
                    offer.discount_value,
                    "Discount applied",
                )
            })
            .collect(),
        _ => vec![],
    }
}

fn is_eligible_line(
    line: &Lines,
    required_set: &HashSet<&str>,
    excluded_set: &HashSet<&str>,
) -> bool {
    if is_gift_line(line) {
        return false;
    }
    let Some((_, product_id)) = variant_and_product_id(line) else {
        return false;
    };
    !excluded_set.contains(product_id.as_str())
        && (required_set.is_empty() || required_set.contains(product_id.as_str()))
}

/// Cart value / cart quantity / required-product checks, evaluated against the
/// current cart at checkout time — the merchant may have edited the offer, or
/// the cart may have changed, since the storefront runtime's own evaluation.
fn check_main_condition(offer: &CompiledOffer, input: &Input, config: &CompiledConfig) -> bool {
    let active_currency = input
        .cart()
        .cost()
        .subtotal_amount()
        .currency_code()
        .to_string();
    let excluded_products: HashSet<&str> = offer
        .excluded_product_ids
        .iter()
        .map(String::as_str)
        .collect();
    let non_gift_lines: Vec<_> = input
        .cart()
        .lines()
        .iter()
        .filter(|line| *line.quantity() > 0 && !is_gift_line(line))
        .filter(|line| {
            variant_and_product_id(line)
                .map(|(_, product_id)| !excluded_products.contains(product_id.as_str()))
                .unwrap_or(false)
        })
        .collect();

    // Offer-level thresholds below still count the whole cart even when
    // restrict_to_matched_lines narrows which lines the rewards touch.
    if !offer.page_url_conditions.is_empty()
        && !non_gift_lines
            .iter()
            .any(|line| added_from_matching_page(line, offer))
    {
        return false;
    }
    // App-added upsell lines are exempt from the reject check (they are discounted only if they match).
    if offer.reject_unmatched_lines
        && non_gift_lines.iter().any(|line| {
            line_type(line).as_deref() != Some(LINE_TYPE_UPSELL)
                && !added_from_matching_page(line, offer)
        })
    {
        return false;
    }

    for condition in &offer.line_attribute_conditions {
        let matching_quantity: i64 = non_gift_lines
            .iter()
            .filter(|line| {
                line_attribute_value(line, &condition.key, config).as_deref()
                    == condition.value.as_deref()
            })
            .map(|line| i64::from(*line.quantity()))
            .sum();
        let passes = if condition.match_mode == "not_equals" {
            matching_quantity == 0
        } else {
            matching_quantity >= condition.min_matching_quantity
        };
        if !passes {
            return false;
        }
    }

    for condition in &offer.cart_attribute_conditions {
        let actual = cart_attribute_value(input, &condition.key, config);
        let passes = match condition.match_mode.as_str() {
            "exists" => actual.is_some(),
            "not_equals" => actual.as_deref() != condition.value.as_deref(),
            _ => actual.as_deref() == condition.value.as_deref(),
        };
        if !passes {
            return false;
        }
    }

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

        if cart_value_cents < threshold_cents {
            return false;
        }
        if let Some(maximum) = offer.cart_value_max_cents {
            if cart_value_cents > maximum {
                return false;
            }
        }
    }

    if let Some(threshold_qty) = offer.cart_quantity_threshold {
        let cart_qty: i64 = non_gift_lines
            .iter()
            .map(|line| *line.quantity() as i64)
            .sum();
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

    let has_customer_tag_condition =
        !offer.required_customer_tags.is_empty() || !offer.excluded_customer_tags.is_empty();
    if has_customer_tag_condition {
        let customer = input
            .cart()
            .buyer_identity()
            .as_ref()
            .and_then(|identity| identity.customer());
        if customer.is_none() && !offer.treat_guest_as_no_tags {
            return false;
        }
        let matching_tags: HashSet<&str> = customer
            .map(|value| {
                value
                    .has_tags()
                    .iter()
                    .filter(|tag| *tag.has_tag())
                    .map(|tag| tag.tag().as_str())
                    .collect()
            })
            .unwrap_or_default();
        if !offer
            .required_customer_tags
            .iter()
            .all(|tag| matching_tags.contains(tag.as_str()))
            || offer
                .excluded_customer_tags
                .iter()
                .any(|tag| matching_tags.contains(tag.as_str()))
        {
            return false;
        }
    }

    if !offer.include_country_codes.is_empty() || !offer.exclude_country_codes.is_empty() {
        let country_code = input.localization().country().iso_code().to_string();
        if (!offer.include_country_codes.is_empty()
            && !offer
                .include_country_codes
                .iter()
                .any(|code| code.eq_ignore_ascii_case(&country_code)))
            || offer
                .exclude_country_codes
                .iter()
                .any(|code| code.eq_ignore_ascii_case(&country_code))
        {
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
        if offer
            .customer_order_count_min
            .is_some_and(|minimum| number_of_orders < minimum)
            || offer
                .customer_order_count_max
                .is_some_and(|maximum| number_of_orders > maximum)
        {
            return false;
        }
        let amount_spent = customer.amount_spent();
        let amount_spent_cents = to_cents(amount_spent.amount().as_f64(), &offer.currency_code);
        if offer
            .customer_amount_spent_min_cents
            .is_some_and(|minimum| amount_spent_cents < minimum)
            || offer
                .customer_amount_spent_max_cents
                .is_some_and(|maximum| amount_spent_cents > maximum)
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
        let required_products: HashSet<&str> = offer
            .required_product_ids
            .iter()
            .map(String::as_str)
            .collect();
        let required_variants: HashSet<&str> = offer
            .required_variant_ids
            .iter()
            .map(String::as_str)
            .collect();

        let has_required = input.cart().lines().iter().any(|line| {
            variant_and_product_id(line)
                .map(|(variant_id, product_id)| {
                    required_products.contains(product_id.as_str())
                        || required_variants.contains(variant_id.as_str())
                })
                .unwrap_or(false)
        });
        if !has_required {
            return false;
        }
    }

    // Any-of trigger products/variants: qualifies on mere presence of any one of them,
    // independent of (and AND-ed with) the all-of `requirements` check above.
    if !offer.any_required_product_ids.is_empty() || !offer.any_required_variant_ids.is_empty() {
        let any_products: HashSet<&str> = offer
            .any_required_product_ids
            .iter()
            .map(String::as_str)
            .collect();
        let any_variants: HashSet<&str> = offer
            .any_required_variant_ids
            .iter()
            .map(String::as_str)
            .collect();
        let has_any = input.cart().lines().iter().any(|line| {
            variant_and_product_id(line)
                .map(|(variant_id, product_id)| {
                    any_products.contains(product_id.as_str())
                        || any_variants.contains(variant_id.as_str())
                })
                .unwrap_or(false)
        });
        if !has_any {
            return false;
        }
    }

    true
}

/// Shopify applies only one of our candidates per line (the first). Keep the largest saving per
/// line so overlapping offers resolve in the customer's favor; multi-line candidates pass through.
fn best_candidate_per_line(
    candidates: Vec<schema::ProductDiscountCandidate>,
    input: &Input,
) -> Vec<schema::ProductDiscountCandidate> {
    let lines = input.cart().lines();
    // (line index, saving) for single-line candidates; None passes through untouched.
    let savings: Vec<Option<(usize, f64)>> = candidates
        .iter()
        .map(|candidate| {
            let [schema::ProductDiscountCandidateTarget::CartLine(target)] = candidate.targets.as_slice() else {
                return None;
            };
            let index = lines.iter().position(|line| line.id() == &target.id)?;
            let quantity = f64::from(target.quantity.unwrap_or(1));
            let saving = match &candidate.value {
                schema::ProductDiscountCandidateValue::Percentage(pct) => {
                    pct.value.0 * lines[index].cost().amount_per_quantity().amount().as_f64() * quantity
                }
                schema::ProductDiscountCandidateValue::FixedAmount(fixed) => fixed.amount.0 * quantity * 100.0,
            };
            Some((index, saving))
        })
        .collect();
    let mut best = vec![(usize::MAX, f64::MIN); lines.len()];
    for (position, entry) in savings.iter().enumerate() {
        if let Some((index, saving)) = entry {
            if *saving > best[*index].1 {
                best[*index] = (position, *saving);
            }
        }
    }
    candidates
        .into_iter()
        .zip(savings)
        .enumerate()
        .filter(|(position, (_, entry))| entry.is_none_or(|(index, _)| best[index].0 == *position))
        .map(|(_, (candidate, _))| candidate)
        .collect()
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
            let pct = if discount_type == "free" {
                100.0
            } else {
                discount_value.min(100.0)
            };
            schema::ProductDiscountCandidateValue::Percentage(schema::Percentage {
                value: shopify_function::scalars::Decimal(pct),
            })
        }
        _ => schema::ProductDiscountCandidateValue::FixedAmount(
            schema::ProductDiscountCandidateFixedAmount {
                amount: shopify_function::scalars::Decimal(round_to_cents(discount_value)),
                applies_to_each_item: Some(true),
            },
        ),
    };

    schema::ProductDiscountCandidate {
        associated_discount_code: None,
        message: Some(message.to_string()),
        prerequisites: None,
        targets: vec![schema::ProductDiscountCandidateTarget::CartLine(
            schema::CartLineTarget {
                id: cart_line_id,
                quantity: Some(quantity as i32),
            },
        )],
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
                amount: shopify_function::scalars::Decimal(round_to_cents(discount_value)),
                applies_to_each_item: Some(false),
            },
        ),
    }
}

/// Fixed-amount candidates are computed from floating-point subtraction (e.g.
/// price-tier targets), which can leave artifacts like 7.500000000000004.
/// Round to the currency's minor unit (whole units for JPY/KRW/…) so Shopify sees a clean amount.
fn round_to_cents(value: f64) -> f64 {
    if ZERO_DECIMAL_CURRENCY.with(Cell::get) {
        value.round()
    } else {
        (value * 100.0).round() / 100.0
    }
}

/// Shared by every reward-target check (eligible-line filter, landing anchor
/// exclusion, quiz-bundle restriction) — one shared body instead of a
/// duplicated closure per call site matters for the wasm size budget.
fn line_price(line: &Lines) -> f64 {
    line.cost().amount_per_quantity().amount().as_f64()
}

fn is_one_of(line: &Lines, product_ids: &HashSet<&str>, variant_ids: &HashSet<&str>) -> bool {
    variant_and_product_id(line)
        .map(|(variant_id, product_id)| {
            variant_ids.contains(variant_id.as_str()) || product_ids.contains(product_id.as_str())
        })
        .unwrap_or(false)
}

fn variant_and_product_id(line: &Lines) -> Option<(String, String)> {
    match line.merchandise() {
        Merchandise::ProductVariant(variant) => {
            Some((variant.id().to_string(), variant.product().id().to_string()))
        }
        Merchandise::Other => None,
    }
}

fn line_type(line: &Lines) -> Option<String> {
    line.line_type()
        .as_ref()
        .and_then(|attribute| attribute.value())
        .cloned()
        .or_else(|| metadata_value(line, "_promo_engine_line_type"))
}

fn is_gift_line(line: &Lines) -> bool {
    line_type(line).as_deref() == Some(LINE_TYPE_GIFT)
        || cart_gift_tier(line).is_some()
        || quiz_free_gift(line).as_deref() == Some("true")
}

fn line_offer_id(line: &Lines) -> Option<String> {
    metadata_value(line, "_promo_engine_offer_id")
}

fn line_reward_id(line: &Lines) -> Option<String> {
    metadata_value(line, "_promo_engine_reward_id")
}

fn projected_volume_discount_cents(lines: &[&Lines], currency_code: &str) -> i64 {
    let mut groups: BTreeMap<String, VolumeDiscountGroup> = BTreeMap::new();
    for line in lines {
        if bundle_item(line).as_deref() == Some("true") || nektar_glp1(line).is_some() {
            continue;
        }
        let Merchandise::ProductVariant(variant) = line.merchandise() else {
            continue;
        };
        let Some(metafield) = variant.product().volume_discount_tiers() else {
            continue;
        };
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
            line.cost().subtotal_amount().amount().as_f64(),
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
                .map(|tier| ((group.subtotal_cents as f64 * tier.percent) / 100.0).round() as i64)
        })
        .sum()
}

// Shared by every direct-attribute-with-packed-metadata-fallback lookup below —
// keeping the `or_else` glue in one place instead of duplicated per field
// matters for the discount function's wasm size budget.
fn attr_or_metadata(direct: Option<&String>, line: &Lines, key: &str) -> Option<String> {
    direct.cloned().or_else(|| metadata_value(line, key))
}

fn landing_source(line: &Lines) -> Option<String> {
    attr_or_metadata(
        line.landing_source().and_then(|attribute| attribute.value()),
        line,
        "__landing_source",
    )
}

fn bundle_item(line: &Lines) -> Option<String> {
    attr_or_metadata(
        line.volume_discount_bundle_item()
            .and_then(|attribute| attribute.value()),
        line,
        "_bundle_item",
    )
}

fn nektar_glp1(line: &Lines) -> Option<String> {
    attr_or_metadata(
        line.volume_discount_nektar_glp_1()
            .and_then(|attribute| attribute.value()),
        line,
        "_nektar_glp1",
    )
}

/// The storefront stamps each line with the page it was added from, plus the
/// session's last UTM landing URL (`source: "landing"` conditions read that).
fn added_from_matching_page(line: &Lines, offer: &CompiledOffer) -> bool {
    let cached = PAGE_MATCH.with(|cache| {
        cache
            .borrow()
            .get(&offer.page_set_key)
            .and_then(|lines| lines.get(line.id()).copied())
    });
    if let Some(matched) = cached {
        return matched;
    }
    let matched = metadata_matches(metadata_map(line).as_deref(), &offer.page_url_conditions);
    PAGE_MATCH.with(|cache| {
        cache
            .borrow_mut()
            .entry(offer.page_set_key)
            .or_default()
            .insert(line.id().clone(), matched)
    });
    matched
}

fn outside_matched_lines(offer: &CompiledOffer, line: &Lines) -> bool {
    offer.restrict_to_matched_lines && !added_from_matching_page(line, offer)
}

// Line attributes other than the direct ones in the input query come from the packed
// metadata property (the input query is capped at complexity 30).
fn line_attribute_value(line: &Lines, key: &str, _config: &CompiledConfig) -> Option<String> {
    metadata_value(line, key)
}

// The code-discount query has no custom cart attribute slots (complexity budget), so cart attribute conditions never match.
#[cfg(feature = "code_gate")]
fn cart_attribute_value(_: &Input, _: &str, _: &CompiledConfig) -> Option<String> {
    None
}

#[cfg(not(feature = "code_gate"))]
fn cart_attribute_value(input: &Input, key: &str, config: &CompiledConfig) -> Option<String> {
    if config.c1.as_deref() == Some(key) {
        return input
            .cart()
            .custom_cart_1()
            .as_ref()
            .and_then(|attribute| attribute.value())
            .cloned();
    }
    if config.c2.as_deref() == Some(key) {
        return input
            .cart()
            .custom_cart_2()
            .as_ref()
            .and_then(|attribute| attribute.value())
            .cloned();
    }
    if config.c3.as_deref() == Some(key) {
        return input
            .cart()
            .custom_cart_3()
            .as_ref()
            .and_then(|attribute| attribute.value())
            .cloned();
    }
    None
}

fn quiz_bundle_id(line: &Lines) -> Option<String> {
    metadata_value(line, "_quiz_bundle_id")
}

fn quiz_target_cents(line: &Lines) -> Option<String> {
    metadata_value(line, "_quiz_target_cents")
}

fn quiz_expected_paid_count(line: &Lines) -> Option<String> {
    metadata_value(line, "_quiz_expected_paid_count")
}

fn quiz_free_gift(line: &Lines) -> Option<String> {
    metadata_value(line, "_quiz_free_gift")
}

fn cart_gift_tier(line: &Lines) -> Option<String> {
    metadata_value(line, "__cart_gift_tier")
}

fn metadata_value(line: &Lines, key: &str) -> Option<String> {
    metadata_map(line)?.get(key).cloned()
}

fn metadata_map(line: &Lines) -> Option<Rc<LineMetadata>> {
    LINE_METADATA.with(|cache| {
        if let Some(parsed) = cache.borrow().get(line.id()) {
            return parsed.clone();
        }
        let parsed = line
            .promo_metadata()
            .as_ref()
            .and_then(|attribute| attribute.value())
            .and_then(|raw| serde_json::from_str::<LineMetadata>(raw).ok())
            .map(Rc::new);
        cache.borrow_mut().insert(line.id().clone(), parsed.clone());
        parsed
    })
}

/// Truncated FNV-1a-64 of the ASCII-uppercased code, 12 lowercase hex chars (mirrored by the TS publisher).
#[cfg(feature = "code_gate")]
pub fn code_hash(code: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in code.as_bytes() {
        hash = (hash ^ u64::from(byte.to_ascii_uppercase())).wrapping_mul(0x100000001b3);
    }
    (0..12)
        .map(|i| char::from(b"0123456789abcdef"[((hash >> (60 - 4 * i)) & 0xf) as usize]))
        .collect()
}

/// Entered codes (trimmed, as typed, deduped by hash) with their hashes, index-aligned.
#[cfg(feature = "code_gate")]
fn entered_codes(input: &Input) -> (Vec<String>, Vec<String>) {
    let mut codes: Vec<String> = Vec::new();
    let mut hashes: Vec<String> = Vec::new();
    for entered in input.entered_discount_codes() {
        let code = entered.code().trim_ascii();
        let hash = code_hash(code);
        if !hashes.contains(&hash) {
            codes.push(code.to_string());
            hashes.push(hash);
        }
    }
    (codes, hashes)
}

/// This node only serves code offers: no codeHashes, or no entered code in the set, means not eligible.
#[cfg(feature = "code_gate")]
fn offer_code_matches(offer: &CompiledOffer, entered_hashes: &[String]) -> bool {
    entered_hashes.iter().any(|hash| offer.code_hashes.contains(hash))
}

fn parse_config(input: &Input) -> Option<CompiledConfig> {
    let value = input.discount().metafield()?.value();
    serde_json::from_str(value).ok()
}

// These fixtures target the original query shape; the code-gate tests live in the code-discount crate.
#[cfg(all(test, not(feature = "code_gate")))]
mod tests {
    use super::*;
    use crate::config::CompiledPageUrlCondition;
    use shopify_function::run_function_with_input;
    use serde_json::Value;

    fn page_url_condition_matches(page_url: &str, condition: &CompiledPageUrlCondition) -> bool {
        let metadata = serde_json::json!({ "_promo_page_url": page_url }).to_string();
        crate::page_match::line_matches(Some(&metadata), std::slice::from_ref(condition))
    }

    fn cart_json(lines_json: &str, subtotal: &str, config_json: &str) -> String {
        cart_json_with_classes(lines_json, subtotal, config_json, r#"["PRODUCT"]"#)
    }

    fn cart_json_with_classes(
        lines_json: &str,
        subtotal: &str,
        config_json: &str,
        discount_classes: &str,
    ) -> String {
        let packed_lines = pack_legacy_metadata(lines_json);
        format!(
            r#"{{
                "discount": {{
                    "discountClasses": {discount_classes},
                    "metafield": {{ "value": {config} }}
                }},
                "cart": {{
                    "lines": {lines},
                    "cost": {{ "subtotalAmount": {{ "amount": "{subtotal}", "currencyCode": "USD" }} }}
                }},
                "presentmentCurrencyRate": "1.0",
                "localization": {{ "country": {{ "isoCode": "US" }} }}
            }}"#,
            config = serde_json::to_string(config_json).unwrap(),
            lines = packed_lines,
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
        let packed_lines = pack_legacy_metadata(lines_json);
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
                            "hasTags": [],
                            "amountSpent": {{ "amount": "{amount_spent}", "currencyCode": "USD" }}
                        }}
                    }},
                    "lines": {lines},
                    "cost": {{ "subtotalAmount": {{ "amount": "{subtotal}", "currencyCode": "USD" }} }}
                }},
                "presentmentCurrencyRate": "1.0",
                "localization": {{ "country": {{ "isoCode": "US" }} }}
            }}"#,
            config = serde_json::to_string(config_json).unwrap(),
            lines = packed_lines,
            subtotal = subtotal,
        )
    }

    fn pack_legacy_metadata(lines_json: &str) -> String {
        let mut lines: serde_json::Value = serde_json::from_str(lines_json).unwrap();
        let aliases = [
            ("offerId", "_promo_engine_offer_id"),
            ("rewardId", "_promo_engine_reward_id"),
            ("offerVersion", "_promo_engine_offer_version"),
            ("volumeDiscountBundleItem", "_bundle_item"),
            ("volumeDiscountNektarGlp1", "_nektar_glp1"),
            ("landingSource", "__landing_source"),
            ("bundleType", "__bundle_type"),
            ("quizBundleId", "_quiz_bundle_id"),
            ("quizTargetCents", "_quiz_target_cents"),
            ("quizExpectedPaidCount", "_quiz_expected_paid_count"),
            ("quizFreeGift", "_quiz_free_gift"),
            ("cartGiftTier", "__cart_gift_tier"),
            ("engravingMessage", "engraving_message"),
        ];

        for line in lines.as_array_mut().unwrap() {
            let object = line.as_object_mut().unwrap();
            let mut metadata = serde_json::Map::new();
            for (alias, key) in aliases {
                if let Some(value) = object.remove(alias).and_then(|attribute| {
                    attribute
                        .get("value")
                        .and_then(|value| value.as_str())
                        .map(str::to_owned)
                }) {
                    metadata.insert(key.to_string(), serde_json::Value::String(value));
                }
            }
            if !metadata.is_empty() {
                object.insert(
                    "promoMetadata".to_string(),
                    serde_json::json!({ "value": serde_json::to_string(&metadata).unwrap() }),
                );
            }
        }

        serde_json::to_string(&lines).unwrap()
    }

    fn with_customer_tags(payload: &str, tags: &[(&str, bool)]) -> String {
        let mut value: serde_json::Value = serde_json::from_str(payload).unwrap();
        value["cart"]["buyerIdentity"] = serde_json::json!({
            "customer": {
                "numberOfOrders": 0,
                "hasTags": tags.iter().map(|(tag, has_tag)| serde_json::json!({
                    "tag": tag,
                    "hasTag": has_tag,
                })).collect::<Vec<_>>(),
                "amountSpent": { "amount": "0.00" }
            }
        });
        serde_json::to_string(&value).unwrap()
    }

    fn with_country(payload: &str, country_code: &str) -> String {
        let mut value: serde_json::Value = serde_json::from_str(payload).unwrap();
        value["localization"]["country"]["isoCode"] = serde_json::json!(country_code);
        serde_json::to_string(&value).unwrap()
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

    fn gift_line(
        id: &str,
        variant_id: &str,
        product_id: &str,
        offer_id: &str,
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
        metadata: (&str, &str, &str),
        price: &str,
        qty: i64,
    ) -> String {
        let (offer_id, reward_id, offer_version) = metadata;
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
        let landing_json = landing
            .map(|value| format!(r#"{{ "value": "{value}" }}"#))
            .unwrap_or_else(|| "null".to_string());
        let (quiz_id, target, expected, gift) = quiz
            .map(|(bundle_id, target_cents, expected_count, is_gift)| {
                (
                    format!(r#"{{ "value": "{bundle_id}" }}"#),
                    format!(r#"{{ "value": "{target_cents}" }}"#),
                    format!(r#"{{ "value": "{expected_count}" }}"#),
                    format!(
                        r#"{{ "value": "{}" }}"#,
                        if is_gift { "true" } else { "false" }
                    ),
                )
            })
            .unwrap_or_else(|| {
                (
                    "null".to_string(),
                    "null".to_string(),
                    "null".to_string(),
                    "null".to_string(),
                )
            });
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
                "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
                "giftRewards":[{{"id":"reward-1","targetVariantIds":["gid://shopify/ProductVariant/gift-v1"],"discountType":"free","discountValue":100.0,"maxQuantity":{max_qty}}}]
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
    fn registered_line_attribute_guards_gift_offer() {
        let paid = regular_line(
            "gid://shopify/CartLine/1",
            "gid://shopify/ProductVariant/v1",
            "gid://shopify/Product/p1",
            "60.00",
            1,
        )
        .replace(
            "\"volumeDiscountNektarGlp1\": null",
            "\"volumeDiscountNektarGlp1\": null, \"bundleType\": { \"value\": \"starter\" }",
        );
        let lines = format!(
            "[{},{}]",
            paid,
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            )
        );
        let config = gift_offer_config(5000, 1).replace(
            "\"combinesWithOrderDiscounts\":true",
            "\"lineAttributeConditions\":[{\"key\":\"__bundle_type\",\"value\":\"starter\",\"matchMode\":\"equals\",\"minMatchingQuantity\":1}],\"combinesWithOrderDiscounts\":true",
        );
        let result = run_function_with_input(run, &cart_json(&lines, "80.00", &config))
            .expect("should not error");
        assert_eq!(result.operations.len(), 1);
    }

    #[test]
    fn registered_cart_attribute_guards_gift_offer() {
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            )
        );
        let config = gift_offer_config(5000, 1).replace(
            "\"combinesWithOrderDiscounts\":true",
            "\"cartAttributeConditions\":[{\"key\":\"source\",\"value\":\"vip-landing\",\"matchMode\":\"equals\",\"minMatchingQuantity\":1}],\"combinesWithOrderDiscounts\":true",
        ).replacen('{', "{\"c1\":\"source\",", 1);
        let payload = cart_json(&lines, "80.00", &config).replace(
            "\"cart\": {",
            "\"cart\": { \"customCart1\": { \"value\": \"vip-landing\" },",
        );
        let result = run_function_with_input(run, &payload).expect("should not error");
        assert_eq!(result.operations.len(), 1);
    }

    #[test]
    fn store_specific_line_attribute_is_loaded_from_packed_metadata() {
        let paid = regular_line(
            "gid://shopify/CartLine/1",
            "gid://shopify/ProductVariant/v1",
            "gid://shopify/Product/p1",
            "60.00",
            1,
        )
        .replace(
            "\"volumeDiscountNektarGlp1\": null",
            "\"volumeDiscountNektarGlp1\": null, \"engravingMessage\": { \"value\": \"VIP\" }",
        );
        let lines = format!(
            "[{},{}]",
            paid,
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            )
        );
        let config = gift_offer_config(5000, 1)
            .replace("{\"offers\":", "{\"offers\":")
            .replace(
                "\"combinesWithOrderDiscounts\":true",
                "\"lineAttributeConditions\":[{\"key\":\"engraving_message\",\"value\":\"VIP\",\"matchMode\":\"equals\",\"minMatchingQuantity\":1}],\"combinesWithOrderDiscounts\":true",
            );
        let result = run_function_with_input(run, &cart_json(&lines, "80.00", &config))
            .expect("should not error");
        assert_eq!(result.operations.len(), 1);
    }

    #[test]
    fn additional_store_specific_line_attributes_are_loaded_from_packed_metadata() {
        let paid = regular_line(
            "gid://shopify/CartLine/1",
            "gid://shopify/ProductVariant/v1",
            "gid://shopify/Product/p1",
            "60.00",
            1,
        );
        let lines = format!(
            "[{},{}]",
            paid,
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            )
        );
        let config = gift_offer_config(5000, 1).replace(
            "\"combinesWithOrderDiscounts\":true",
            "\"lineAttributeConditions\":[{\"key\":\"third_custom_key\",\"value\":\"VIP\",\"matchMode\":\"equals\",\"minMatchingQuantity\":1}],\"combinesWithOrderDiscounts\":true",
        );
        let mut payload: serde_json::Value =
            serde_json::from_str(&cart_json(&lines, "80.00", &config)).unwrap();
        payload["cart"]["lines"][0]["promoMetadata"] = serde_json::json!({
            "value": serde_json::to_string(&serde_json::json!({ "third_custom_key": "VIP" })).unwrap(),
        });
        let result = run_function_with_input(run, &serde_json::to_string(&payload).unwrap())
            .expect("should not error");
        assert_eq!(result.operations.len(), 1);
    }

    #[test]
    fn store_specific_cart_attribute_is_loaded_through_the_function_variable_slot() {
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            )
        );
        let config = gift_offer_config(5000, 1)
            .replace("{\"offers\":", "{\"c1\":\"affiliate_campaign\",\"offers\":")
            .replace(
                "\"combinesWithOrderDiscounts\":true",
                "\"cartAttributeConditions\":[{\"key\":\"affiliate_campaign\",\"value\":\"creator-42\",\"matchMode\":\"equals\",\"minMatchingQuantity\":1}],\"combinesWithOrderDiscounts\":true",
            );
        let payload = cart_json(&lines, "80.00", &config).replace(
            "\"cart\": {",
            "\"cart\": { \"customCart1\": { \"value\": \"creator-42\" },",
        );
        let result = run_function_with_input(run, &payload).expect("should not error");
        assert_eq!(result.operations.len(), 1);
    }

    #[test]
    fn cart_value_maximum_uses_the_active_currency_override() {
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "85.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            ),
        );
        let config = gift_offer_config(5000, 1).replace(
            "\"cartValueThresholdCents\":5000",
            "\"cartValueThresholdCents\":5000,\"cartValueMaxCents\":9999,\"currencyOverrides\":{\"EUR\":4000},\"maxCurrencyOverrides\":{\"EUR\":7999}",
        );
        let payload = cart_json(&lines, "105.00", &config)
            .replace("\"currencyCode\": \"USD\"", "\"currencyCode\": \"EUR\"");
        let result = run_function_with_input(run, &payload).expect("should not error");
        assert!(result.operations.is_empty());
    }

    #[test]
    fn cart_value_threshold_converts_with_presentment_rate_without_override() {
        let lines = |amount: &str| {
            format!(
                "[{},{}]",
                regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", amount, 1),
                gift_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/gift-v1", "gid://shopify/Product/gift-p1", "offer-1", "20.00", 1),
            )
        };
        // $50 USD threshold at 0.9 EUR/USD = €45.
        let eur = |amount: &str| {
            cart_json(&lines(amount), amount, &gift_offer_config(5000, 1))
                .replace("\"currencyCode\": \"USD\"", "\"currencyCode\": \"EUR\"")
                .replace("\"presentmentCurrencyRate\": \"1.0\"", "\"presentmentCurrencyRate\": \"0.9\"")
        };
        let payload = eur("46.00");
        assert!(payload.contains("\"presentmentCurrencyRate\": \"0.9\""));
        assert!(!run_function_with_input(run, &payload).unwrap().operations.is_empty());
        assert!(run_function_with_input(run, &eur("44.00")).unwrap().operations.is_empty());
    }

    #[test]
    fn gift_discount_applies_to_valid_gift_line() {
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            ),
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
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "40.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            ),
        );
        let payload = cart_json(&lines, "60.00", &gift_offer_config(10000, 1));

        let result = run_function_with_input(run, &payload).expect("should not error");
        assert!(
            result.operations.is_empty(),
            "should not discount below threshold"
        );
    }

    #[test]
    fn legacy_cart_gift_tier_cannot_unlock_a_gift_threshold() {
        let legacy_gift = regular_line(
            "gid://shopify/CartLine/legacy-gift",
            "gid://shopify/ProductVariant/legacy-gift",
            "gid://shopify/Product/legacy-gift",
            "20.00",
            1,
        )
        .replace(
            "\"volumeDiscountNektarGlp1\": null",
            "\"volumeDiscountNektarGlp1\": null, \"cartGiftTier\": { \"value\": \"tier-1\" }",
        );
        let lines = format!(
            "[{},{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "40.00",
                1
            ),
            legacy_gift,
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            ),
        );
        let payload = cart_json(&lines, "80.00", &gift_offer_config(5000, 1));

        let result = run_function_with_input(run, &payload).expect("should not error");
        assert!(
            result.operations.is_empty(),
            "legacy gift value must not unlock the threshold"
        );
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
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            ),
        );
        let result = run_function_with_input(
            run,
            &cart_json(&lines, "109.07", &gift_offer_config(8500, 1)),
        )
        .expect("should not error");

        assert!(
            result.operations.is_empty(),
            "$89.07 less 20% is $71.26 and must not unlock $85"
        );
    }

    #[test]
    fn tampered_gift_line_not_discounted() {
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/expensive-tampered",
                "gid://shopify/Product/p-expensive",
                "offer-1",
                "500.00",
                1
            ),
        );
        let payload = cart_json(&lines, "560.00", &gift_offer_config(5000, 1));

        let result = run_function_with_input(run, &payload).expect("should not error");
        assert!(
            result.operations.is_empty(),
            "tampered gift variant should not be discounted"
        );
    }

    #[test]
    fn max_gift_quantity_enforced() {
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                3
            ),
        );
        let payload = cart_json(&lines, "120.00", &gift_offer_config(5000, 1));

        let result = run_function_with_input(run, &payload).expect("should not error");
        assert_eq!(result.operations.len(), 1);
        match &result.operations[0] {
            schema::CartOperation::ProductDiscountsAdd(op) => {
                let target = &op.candidates[0].targets[0];
                match target {
                    schema::ProductDiscountCandidateTarget::CartLine(t) => {
                        assert_eq!(t.quantity, Some(1))
                    }
                }
            }
            other => panic!("expected ProductDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn strict_gift_rejects_cross_reward_variant_tampering() {
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line_with_metadata(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v2",
                "gid://shopify/Product/gift-p2",
                ("offer-1", "reward-1", "3"),
                "20.00",
                1,
            ),
        );
        let result =
            run_function_with_input(run, &cart_json(&lines, "80.00", strict_gift_offer_config()))
                .expect("should not error");
        assert!(
            result.operations.is_empty(),
            "a reward cannot claim another reward's variant"
        );
    }

    #[test]
    fn strict_gift_rejects_unlisted_variant_from_allowed_product() {
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line_with_metadata(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/unlisted",
                "gid://shopify/Product/gift-p1",
                ("offer-1", "reward-1", "3"),
                "100.00",
                1,
            ),
        );
        let result = run_function_with_input(
            run,
            &cart_json(&lines, "160.00", strict_gift_offer_config()),
        )
        .expect("should not error");
        assert!(
            result.operations.is_empty(),
            "an explicit variant allowlist must take precedence over its product id"
        );
    }

    #[test]
    fn gift_rewards_are_enforced_even_when_offer_type_is_misconfigured() {
        let config = strict_gift_offer_config()
            .replace("\"offerType\":\"gift\"", "\"offerType\":\"discount\"");
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line_with_metadata(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                ("offer-1", "reward-1", "3"),
                "20.00",
                1,
            ),
        );
        let result = run_function_with_input(run, &cart_json(&lines, "80.00", &config))
            .expect("should not error");
        assert_eq!(
            result.operations.len(),
            1,
            "gift reward data must select the strict gift path"
        );
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
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            ),
        );
        let result = run_function_with_input(run, &cart_json(&lines, "80.00", &config))
            .expect("should not error");
        assert!(
            result.operations.is_empty(),
            "excluded products must not count toward gift qualification"
        );
    }

    #[test]
    fn strict_gift_survives_an_offer_version_bump_while_ids_still_match() {
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line_with_metadata(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                ("offer-1", "reward-1", "2"),
                "20.00",
                1,
            ),
        );
        let result =
            run_function_with_input(run, &cart_json(&lines, "80.00", strict_gift_offer_config()))
                .expect("should not error");
        assert_eq!(
            result.operations.len(),
            1,
            "a merchant edit (version bump) must not strip the discount from gifts already in carts"
        );
    }

    #[test]
    fn strict_gift_applies_each_reward_discount_and_quantity_limit() {
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line_with_metadata(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v2",
                "gid://shopify/Product/gift-p2",
                ("offer-1", "reward-2", "3"),
                "20.00",
                3,
            ),
        );
        let result = run_function_with_input(
            run,
            &cart_json(&lines, "120.00", strict_gift_offer_config()),
        )
        .expect("should not error");
        match &result.operations[0] {
            schema::CartOperation::ProductDiscountsAdd(operation) => {
                assert_eq!(operation.candidates[0].targets.len(), 1);
                match &operation.candidates[0].targets[0] {
                    schema::ProductDiscountCandidateTarget::CartLine(target) => {
                        assert_eq!(target.quantity, Some(2))
                    }
                }
                match &operation.candidates[0].value {
                    schema::ProductDiscountCandidateValue::Percentage(value) => {
                        assert_eq!(value.value.0, 50.0)
                    }
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
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/trigger",
                "gid://shopify/Product/trigger",
                "30.00",
                2
            ),
            regular_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/target",
                "gid://shopify/Product/target",
                "20.00",
                1
            ),
            regular_line(
                "gid://shopify/CartLine/3",
                "gid://shopify/ProductVariant/other",
                "gid://shopify/Product/other",
                "20.00",
                1
            ),
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

    fn requirement_pooling_config(requirement: &str) -> String {
        format!(
            r#"{{"offers":[{{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[{requirement}],
            "productRewards":[{{
                "id":"reward-1","rewardType":"product_discount","targetProductIds":[],
                "targetVariantIds":["gid://shopify/ProductVariant/target"],"discountType":"percentage",
                "discountValue":25,"subscriptionMode":"any"
            }}],"orderRewards":[]
        }}]}}"#
        )
    }

    #[test]
    fn product_mode_requirement_pools_variants_but_variant_mode_does_not() {
        // Two different variants of the same product, one unit each, plus the reward target.
        let lines = format!(
            "[{},{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/mint",
                "gid://shopify/Product/planta",
                "30.00",
                1
            ),
            regular_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/cacao",
                "gid://shopify/Product/planta",
                "30.00",
                1
            ),
            regular_line(
                "gid://shopify/CartLine/3",
                "gid://shopify/ProductVariant/target",
                "gid://shopify/Product/target",
                "20.00",
                1
            ),
        );

        let by_product = requirement_pooling_config(
            r#"{"productId":"gid://shopify/Product/planta","trackMode":"product","minQuantity":2}"#,
        );
        let result = run_function_with_input(run, &cart_json(&lines, "80.00", &by_product))
            .expect("should not error");
        assert!(
            matches!(result.operations.first(), Some(schema::CartOperation::ProductDiscountsAdd(_))),
            "product mode should count both variants toward the minimum"
        );

        let by_variant = requirement_pooling_config(
            r#"{"variantId":"gid://shopify/ProductVariant/mint","trackMode":"variant","minQuantity":2}"#,
        );
        let result = run_function_with_input(run, &cart_json(&lines, "80.00", &by_variant))
            .expect("should not error");
        assert!(result.operations.is_empty(), "variant mode must not pool across variants");
    }

    #[test]
    fn bounded_product_tier_discounts_only_the_configured_cheapest_quantity() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{
                "id":"tiered","targetProductIds":[],"targetVariantIds":[],"discountType":"percentage","discountValue":0,
                "subscriptionMode":"any","scopeMode":"sitewide","priceTiers":[],"selectionMode":"cheapest",
                "quantityTiers":[{"minimumQuantity":2,"maximumQuantity":3,"discountType":"percentage","discountValue":20,"discountedQuantity":1}],
                "discountPercentageOnGifts":100
            }]
        }]}"#;
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/expensive",
                "gid://shopify/ProductVariant/a",
                "gid://shopify/Product/a",
                "30.00",
                1
            ),
            regular_line(
                "gid://shopify/CartLine/cheap",
                "gid://shopify/ProductVariant/b",
                "gid://shopify/Product/b",
                "10.00",
                1
            ),
        );
        let result = run_function_with_input(run, &cart_json(&lines, "40.00", config))
            .expect("should not error");

        match &result.operations[0] {
            schema::CartOperation::ProductDiscountsAdd(op) => {
                assert_eq!(op.candidates.len(), 1);
                match &op.candidates[0].targets[0] {
                    schema::ProductDiscountCandidateTarget::CartLine(target) => {
                        assert_eq!(target.id, "gid://shopify/CartLine/cheap");
                        assert_eq!(target.quantity, Some(1));
                    }
                }
                match &op.candidates[0].value {
                    schema::ProductDiscountCandidateValue::Percentage(value) => {
                        assert_eq!(value.value.0, 20.0)
                    }
                    other => panic!("expected percentage, got {other:?}"),
                }
            }
            other => panic!("expected ProductDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn unique_count_rule_deduplicates_split_lines_of_the_same_product() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{
                "id":"tiered","targetProductIds":[],"targetVariantIds":[],"discountType":"percentage","discountValue":0,
                "subscriptionMode":"any","scopeMode":"sitewide","priceTiers":[],"selectionMode":"all","countRule":"unique",
                "quantityTiers":[{"minimumQuantity":2,"discountType":"percentage","discountValue":20}],
                "discountPercentageOnGifts":100
            }]
        }]}"#;
        let same_product = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/a",
                "gid://shopify/Product/shared",
                "10.00",
                4
            ),
            regular_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/b",
                "gid://shopify/Product/shared",
                "10.00",
                1
            ),
        );
        let not_qualified =
            run_function_with_input(run, &cart_json(&same_product, "50.00", config))
                .expect("should not error");
        assert!(not_qualified.operations.is_empty());

        let distinct_products = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/a",
                "gid://shopify/Product/a",
                "10.00",
                1
            ),
            regular_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/b",
                "gid://shopify/Product/b",
                "10.00",
                1
            ),
        );
        let qualified =
            run_function_with_input(run, &cart_json(&distinct_products, "20.00", config))
                .expect("should not error");
        assert_eq!(qualified.operations.len(), 1);
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
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/paid",
                "gid://shopify/Product/paid",
                "50.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift",
                "gid://shopify/Product/gift",
                "offer-2",
                "20.00",
                1
            ),
        );
        let payload = cart_json_with_classes(&lines, "70.00", config, r#"["ORDER"]"#);
        let result = run_function_with_input(run, &payload).expect("should not error");

        match &result.operations[0] {
            schema::CartOperation::OrderDiscountsAdd(op) => match &op.candidates[0].targets[0] {
                schema::OrderDiscountCandidateTarget::OrderSubtotal(target) => {
                    assert_eq!(
                        target.excluded_cart_line_ids,
                        vec!["gid://shopify/CartLine/2"]
                    );
                }
            },
            other => panic!("expected OrderDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn bounded_order_tier_stops_above_its_maximum() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"productRewards":[],
            "orderRewards":[{"id":"order-1","discountType":"percentage","discountValue":0,
              "subtotalTiers":[{"minimumSubtotalCents":5000,"maximumSubtotalCents":9999,"discountType":"fixed_amount","discountValue":10}]}]
        }]}"#;
        let line = regular_line(
            "gid://shopify/CartLine/1",
            "gid://shopify/ProductVariant/paid",
            "gid://shopify/Product/paid",
            "120.00",
            1,
        );
        let above = run_function_with_input(
            run,
            &cart_json_with_classes(&format!("[{line}]"), "120.00", config, r#"["ORDER"]"#),
        )
        .expect("should not error");
        assert!(above.operations.is_empty());

        let line = regular_line(
            "gid://shopify/CartLine/1",
            "gid://shopify/ProductVariant/paid",
            "gid://shopify/Product/paid",
            "80.00",
            1,
        );
        let inside = run_function_with_input(
            run,
            &cart_json_with_classes(&format!("[{line}]"), "80.00", config, r#"["ORDER"]"#),
        )
        .expect("should not error");
        assert_eq!(inside.operations.len(), 1);
    }

    #[test]
    fn bounded_order_quantity_tier_uses_paid_item_count() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"productRewards":[],
            "orderRewards":[{"id":"order-1","discountType":"percentage","discountValue":0,
              "subtotalTiers":[{"minimumQuantity":2,"maximumQuantity":3,"discountType":"percentage","discountValue":15}]}]
        }]}"#;
        let two_items = regular_line(
            "gid://shopify/CartLine/1",
            "gid://shopify/ProductVariant/paid",
            "gid://shopify/Product/paid",
            "10.00",
            2,
        );
        let inside = run_function_with_input(
            run,
            &cart_json_with_classes(&format!("[{two_items}]"), "20.00", config, r#"["ORDER"]"#),
        )
        .expect("should not error");
        assert_eq!(inside.operations.len(), 1);

        let four_items = regular_line(
            "gid://shopify/CartLine/1",
            "gid://shopify/ProductVariant/paid",
            "gid://shopify/Product/paid",
            "10.00",
            4,
        );
        let above = run_function_with_input(
            run,
            &cart_json_with_classes(&format!("[{four_items}]"), "40.00", config, r#"["ORDER"]"#),
        )
        .expect("should not error");
        assert!(above.operations.is_empty());
    }

    #[test]
    fn tagged_offer_scope_discounts_only_lines_signed_for_that_bundle() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"bundle","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{
                "id":"bundle-tier","targetProductIds":[],"targetVariantIds":["gid://shopify/ProductVariant/a"],"discountType":"percentage","discountValue":0,
                "subscriptionMode":"any","scopeMode":"tagged_offer","requiredOfferId":"offer-1","selectionMode":"all","countRule":"all",
                "quantityTiers":[{"minimumQuantity":1,"discountType":"percentage","discountValue":20}],
                "priceTiers":[],"discountPercentageOnGifts":100
            }]
        }]}"#;
        let tagged = regular_line(
            "gid://shopify/CartLine/tagged",
            "gid://shopify/ProductVariant/a",
            "gid://shopify/Product/a",
            "10.00",
            1,
        )
        .replace(r#""offerId": null"#, r#""offerId": {"value":"offer-1"}"#);
        let ordinary = regular_line(
            "gid://shopify/CartLine/ordinary",
            "gid://shopify/ProductVariant/b",
            "gid://shopify/Product/b",
            "10.00",
            1,
        );
        let result = run_function_with_input(
            run,
            &cart_json(&format!("[{tagged},{ordinary}]"), "20.00", config),
        )
        .expect("should not error");
        match &result.operations[0] {
            schema::CartOperation::ProductDiscountsAdd(op) => {
                assert_eq!(op.candidates.len(), 1);
                match &op.candidates[0].targets[0] {
                    schema::ProductDiscountCandidateTarget::CartLine(target) => {
                        assert_eq!(target.id, "gid://shopify/CartLine/tagged")
                    }
                }
            }
            other => panic!("expected ProductDiscountsAdd, got {other:?}"),
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
                "maxQuantity":3,"discountPercentageOnGifts":100
            }]
        }]}"#;
        let lines = format!(
            "[{},{},{},{}]",
            scoped_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/protein",
                "gid://shopify/Product/protein",
                "50.00",
                2,
                Some("protein-lp"),
                None
            ),
            scoped_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/protein",
                "gid://shopify/Product/protein",
                "50.00",
                1,
                Some("protein-lp"),
                None
            ),
            scoped_line(
                "gid://shopify/CartLine/3",
                "gid://shopify/ProductVariant/protein",
                "gid://shopify/Product/protein",
                "50.00",
                1,
                None,
                None
            ),
            // A genuine (non-target) anchor line — the target lines above no
            // longer count toward their own anchor requirement. Its quantity (3)
            // is the hard cap on discounted target units.
            scoped_line(
                "gid://shopify/CartLine/4",
                "gid://shopify/ProductVariant/protein-lp-anchor",
                "gid://shopify/Product/protein-lp-anchor",
                "5.00",
                3,
                Some("protein-lp"),
                None
            ),
        );
        let result = run_function_with_input(run, &cart_json(&lines, "200.00", config))
            .expect("should not error");
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
    fn landing_scope_without_explicit_anchor_ids_still_enforces_quantity_and_subscription() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{
                "id":"atlas-gifts","rewardType":"product_discount","targetProductIds":[],
                "targetVariantIds":["gid://shopify/ProductVariant/gift"],"discountType":"free","discountValue":100,
                "subscriptionMode":"any","scopeMode":"landing","requiredLineAttributeValue":"atlas-sk-otg",
                "requiredAnchorVariantIds":[],"requiredAnchorMinQuantity":2,"requiresAnchorSubscription":true,
                "priceTiers":[],"discountPercentageOnGifts":100
            }]
        }]}"#;
        let one_time_anchor = scoped_line(
            "gid://shopify/CartLine/1",
            "gid://shopify/ProductVariant/anchor",
            "gid://shopify/Product/anchor",
            "50.00",
            2,
            Some("atlas-sk-otg"),
            None,
        );
        let subscription_anchor = one_time_anchor.replace(
            "\"sellingPlanAllocation\": null",
            "\"sellingPlanAllocation\": { \"sellingPlan\": { \"id\": \"gid://shopify/SellingPlan/monthly\" } }",
        );
        let gift = scoped_line(
            "gid://shopify/CartLine/2",
            "gid://shopify/ProductVariant/gift",
            "gid://shopify/Product/gift",
            "20.00",
            1,
            Some("atlas-sk-otg"),
            None,
        );

        let without_subscription = format!("[{one_time_anchor},{gift}]");
        let result =
            run_function_with_input(run, &cart_json(&without_subscription, "120.00", config))
                .expect("one-time input should parse");
        assert!(result.operations.is_empty());

        let with_subscription = format!("[{subscription_anchor},{gift}]");
        let result = run_function_with_input(run, &cart_json(&with_subscription, "120.00", config))
            .expect("subscription input should parse");
        assert_eq!(result.operations.len(), 1);
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
                "discountType":"fixed_price","discountValue":80,"subscriptionMode":"any","scopeMode":"quiz_bundle",
                "requiredAnchorVariantIds":[],"requiredAnchorMinQuantity":1,"requiresAnchorSubscription":false,
                "priceTiers":[],"discountPercentageOnGifts":100
            }]
        }]}"#;
        let paid_one = scoped_line(
            "gid://shopify/CartLine/1",
            "gid://shopify/ProductVariant/p1",
            "gid://shopify/Product/p1",
            "50.00",
            1,
            None,
            Some(("bundle-a", "8000", "2", false)),
        );
        let paid_two = scoped_line(
            "gid://shopify/CartLine/2",
            "gid://shopify/ProductVariant/p2",
            "gid://shopify/Product/p2",
            "50.00",
            1,
            None,
            Some(("bundle-a", "8000", "2", false)),
        );
        let gift = scoped_line(
            "gid://shopify/CartLine/3",
            "gid://shopify/ProductVariant/gift",
            "gid://shopify/Product/gift",
            "10.00",
            1,
            None,
            Some(("bundle-a", "8000", "2", true)),
        );

        let incomplete = format!("[{paid_one},{gift}]");
        let incomplete_result =
            run_function_with_input(run, &cart_json(&incomplete, "60.00", config))
                .expect("should not error");
        assert!(incomplete_result.operations.is_empty());

        let complete = format!("[{paid_one},{paid_two},{gift}]");
        let complete_result = run_function_with_input(run, &cart_json(&complete, "110.00", config))
            .expect("should not error");
        match &complete_result.operations[0] {
            schema::CartOperation::ProductDiscountsAdd(op) => {
                assert_eq!(op.candidates.len(), 2);
                let combined = op
                    .candidates
                    .iter()
                    .find(|candidate| candidate.targets.len() == 2)
                    .expect("combined paid candidate");
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
        let lines = format!(
            "[{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/loyalty",
                "gid://shopify/Product/loyalty",
                "50.00",
                1,
            )
        );

        let guest =
            run_function_with_input(run, &cart_json(&lines, "50.00", config)).expect("guest input");
        assert!(guest.operations.is_empty());

        let not_qualified = run_function_with_input(
            run,
            &cart_json_with_customer(&lines, "50.00", config, 2, "200.00"),
        )
        .expect("customer input");
        assert!(not_qualified.operations.is_empty());

        let qualified = run_function_with_input(
            run,
            &cart_json_with_customer(&lines, "50.00", config, 3, "100.00"),
        )
        .expect("customer input");
        assert_eq!(qualified.operations.len(), 1);
    }

    #[test]
    fn customer_tags_are_verified_at_checkout() {
        let config = gift_offer_config(5000, 1).replace(
            "\"combinesWithOrderDiscounts\":true",
            "\"requiredCustomerTags\":[\"vip\"],\"excludedCustomerTags\":[\"blocked\"],\"treatGuestAsNoTags\":true,\"combinesWithOrderDiscounts\":true",
        );
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            ),
        );
        let base = cart_json(&lines, "80.00", &config);
        let qualified = run_function_with_input(
            run,
            &with_customer_tags(&base, &[("vip", true), ("blocked", false)]),
        )
        .expect("tagged customer");
        assert_eq!(qualified.operations.len(), 1);

        let missing = run_function_with_input(
            run,
            &with_customer_tags(&base, &[("vip", false), ("blocked", false)]),
        )
        .expect("untagged customer");
        assert!(missing.operations.is_empty());
        let excluded = run_function_with_input(
            run,
            &with_customer_tags(&base, &[("vip", true), ("blocked", true)]),
        )
        .expect("excluded customer");
        assert!(excluded.operations.is_empty());
    }

    #[test]
    fn customer_tag_guest_policy_fails_closed_when_requested() {
        let config = gift_offer_config(5000, 1).replace(
            "\"combinesWithOrderDiscounts\":true",
            "\"excludedCustomerTags\":[\"blocked\"],\"treatGuestAsNoTags\":false,\"combinesWithOrderDiscounts\":true",
        );
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            ),
        );
        let guest = run_function_with_input(run, &cart_json(&lines, "80.00", &config))
            .expect("guest input");
        assert!(guest.operations.is_empty());
    }

    #[test]
    fn customer_country_is_verified_at_checkout() {
        let config = gift_offer_config(5000, 1).replace(
            "\"combinesWithOrderDiscounts\":true",
            "\"includeCountryCodes\":[\"US\",\"CA\"],\"excludeCountryCodes\":[\"CA\"],\"combinesWithOrderDiscounts\":true",
        );
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            ),
        );
        let base = cart_json(&lines, "80.00", &config);
        let allowed = run_function_with_input(run, &with_country(&base, "US")).expect("US input");
        assert_eq!(allowed.operations.len(), 1);
        let excluded = run_function_with_input(run, &with_country(&base, "CA")).expect("CA input");
        assert!(excluded.operations.is_empty());
        let outside = run_function_with_input(run, &with_country(&base, "MX")).expect("MX input");
        assert!(outside.operations.is_empty());
    }

    #[test]
    fn page_url_conditions_match_paths_and_encoded_query_parameters() {
        let exact = CompiledPageUrlCondition {
            patterns: vec!["/pages/vip".to_string()],
            match_mode: "exact".to_string(),
            case_sensitive: false,
            param_name: Some("code".to_string()),
            param_value: Some("summer%20sale".to_string()),
            source: None,
        };
        assert!(page_url_condition_matches(
            "/pages/vip?code=summer%20sale#offer",
            &exact,
        ));
        assert!(!page_url_condition_matches(
            "/pages/vip?code=winter",
            &exact,
        ));

        let prefix = CompiledPageUrlCondition {
            patterns: vec!["/collections/sale".to_string()],
            match_mode: "starts_with".to_string(),
            case_sensitive: true,
            param_name: None,
            param_value: None,
            source: None,
        };
        assert!(page_url_condition_matches(
            "/collections/sale/shoes?sort=price",
            &prefix,
        ));
        assert!(!page_url_condition_matches(
            "/collections/Sale/shoes",
            &prefix,
        ));
    }

    #[test]
    fn checkout_rejects_offer_when_source_page_url_does_not_match() {
        let config = gift_offer_config(5000, 1).replace(
            "\"combinesWithOrderDiscounts\":true",
            "\"pageUrlConditions\":[{\"patterns\":[\"/pages/vip\"],\"matchMode\":\"exact\",\"caseSensitive\":false,\"paramName\":\"code\",\"paramValue\":\"summer\"}],\"combinesWithOrderDiscounts\":true",
        );
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            ),
        );
        let base = cart_json(&lines, "80.00", &config);

        let with_page_url = |url: &str| {
            let mut payload: serde_json::Value = serde_json::from_str(&base).unwrap();
            payload["cart"]["lines"][0]["promoMetadata"] = serde_json::json!({
                "value": serde_json::to_string(&serde_json::json!({ "_promo_page_url": url })).unwrap(),
            });
            serde_json::to_string(&payload).unwrap()
        };

        let allowed = run_function_with_input(run, &with_page_url("/pages/vip?code=summer"))
            .expect("matching URL input");
        assert_eq!(allowed.operations.len(), 1);

        let wrong_path = run_function_with_input(run, &with_page_url("/pages/general?code=summer"))
            .expect("wrong URL input");
        assert!(wrong_path.operations.is_empty());

        let missing_metadata =
            run_function_with_input(run, &base).expect("missing URL metadata input");
        assert!(missing_metadata.operations.is_empty());
    }

    /// Landing line (added from ?utm_source=amazon) + a line added from another page.
    fn landing_and_other_page_payload(offer_fields: &str, classes: &str) -> String {
        let config = format!(
            r#"{{"offers":[{{
                "id":"offer-1","version":1,"offerType":"discount","priority":100,
                "currencyCode":"USD","discountType":"percentage","discountValue":10,
                "pageUrlConditions":[{{"matchMode":"contains","paramName":"utm_source","paramValue":"amazon"}}],
                {offer_fields}
            }}]}}"#
        );
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/a", "gid://shopify/Product/a", "40.00", 1),
            regular_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/b", "gid://shopify/Product/b", "60.00", 1),
        );
        let mut payload: serde_json::Value =
            serde_json::from_str(&cart_json_with_classes(&lines, "100.00", &config, classes)).unwrap();
        for (index, url) in [(0, "/pages/prime?utm_source=amazon"), (1, "/collections/all")] {
            payload["cart"]["lines"][index]["promoMetadata"] = serde_json::json!({
                "value": serde_json::to_string(&serde_json::json!({ "_promo_page_url": url })).unwrap(),
            });
        }
        serde_json::to_string(&payload).unwrap()
    }

    fn product_target_ids(result: &schema::CartLinesDiscountsGenerateRunResult) -> Vec<String> {
        result
            .operations
            .iter()
            .flat_map(|operation| match operation {
                schema::CartOperation::ProductDiscountsAdd(op) => op
                    .candidates
                    .iter()
                    .flat_map(|candidate| candidate.targets.iter())
                    .filter_map(|target| match target {
                        schema::ProductDiscountCandidateTarget::CartLine(line) => Some(line.id.clone()),
                        #[allow(unreachable_patterns)]
                        _ => None,
                    })
                    .collect::<Vec<_>>(),
                _ => vec![],
            })
            .collect()
    }

    const PRODUCT_REWARD: &str = r#""productRewards":[{"id":"r1","discountType":"percentage","discountValue":20,
        "maxQuantity":null,"lineQuantityEquals":null,"maxUnitsTotal":null,"requiredOfferId":null,"requiredLineAttributeValue":null}]"#;

    #[test]
    fn restrict_to_matched_lines_discounts_only_lines_added_from_the_landing_page() {
        let restricted = landing_and_other_page_payload(
            &format!(r#"{PRODUCT_REWARD},"restrictToMatchedLines":true"#),
            r#"["PRODUCT"]"#,
        );
        let result = run_function_with_input(run, &restricted).expect("restricted");
        assert_eq!(product_target_ids(&result), vec!["gid://shopify/CartLine/1"]);

        let unrestricted = landing_and_other_page_payload(PRODUCT_REWARD, r#"["PRODUCT"]"#);
        let result = run_function_with_input(run, &unrestricted).expect("unrestricted");
        assert_eq!(
            product_target_ids(&result),
            vec!["gid://shopify/CartLine/1", "gid://shopify/CartLine/2"]
        );
    }

    #[test]
    fn restrict_to_matched_lines_applies_to_plain_discount_offers() {
        let restricted =
            landing_and_other_page_payload(r#""restrictToMatchedLines":true"#, r#"["PRODUCT"]"#);
        let result = run_function_with_input(run, &restricted).expect("restricted");
        assert_eq!(product_target_ids(&result), vec!["gid://shopify/CartLine/1"]);

        let unrestricted = landing_and_other_page_payload(r#""restrictToMatchedLines":false"#, r#"["PRODUCT"]"#);
        let result = run_function_with_input(run, &unrestricted).expect("unrestricted");
        assert_eq!(product_target_ids(&result).len(), 2);
    }

    #[test]
    fn restrict_to_matched_lines_nothing_applies_without_a_landing_line() {
        let mut payload: serde_json::Value = serde_json::from_str(&landing_and_other_page_payload(
            &format!(r#"{PRODUCT_REWARD},"restrictToMatchedLines":true"#),
            r#"["PRODUCT"]"#,
        ))
        .unwrap();
        payload["cart"]["lines"][0]["promoMetadata"] = serde_json::json!({
            "value": serde_json::to_string(&serde_json::json!({ "_promo_page_url": "/" })).unwrap(),
        });
        let result = run_function_with_input(run, &serde_json::to_string(&payload).unwrap())
            .expect("no landing line");
        assert!(result.operations.is_empty());
    }

    #[test]
    fn restrict_to_matched_lines_excludes_other_lines_from_order_discounts() {
        let order_reward = r#""orderRewards":[{"id":"o1","discountType":"percentage","discountValue":0,
            "subtotalTiers":[{"minimumSubtotalCents":5000,"discountType":"percentage","discountValue":50},
                             {"minimumSubtotalCents":0,"discountType":"percentage","discountValue":10}]}]"#;
        // (excluded line ids, percentage)
        let order_candidate = |fields: &str| -> (Vec<String>, f64) {
            let result = run_function_with_input(
                run,
                &landing_and_other_page_payload(fields, r#"["ORDER"]"#),
            )
            .expect("order");
            let schema::CartOperation::OrderDiscountsAdd(op) = &result.operations[0] else {
                panic!("expected OrderDiscountsAdd");
            };
            let candidate = &op.candidates[0];
            let schema::OrderDiscountCandidateValue::Percentage(pct) = &candidate.value else {
                panic!("expected percentage");
            };
            #[allow(irrefutable_let_patterns)]
            let schema::OrderDiscountCandidateTarget::OrderSubtotal(target) = &candidate.targets[0] else {
                panic!("expected order subtotal target");
            };
            (target.excluded_cart_line_ids.clone(), pct.value.0)
        };

        // Restricted: only the $40 landing line counts, so the $50 tier is out of reach.
        let restricted = order_candidate(&format!(r#"{order_reward},"restrictToMatchedLines":true"#));
        assert_eq!(restricted, (vec!["gid://shopify/CartLine/2".to_string()], 10.0));

        let unrestricted = order_candidate(order_reward);
        assert_eq!(unrestricted, (vec![], 50.0));
    }

    fn page_type_condition(types: &[&str]) -> CompiledPageUrlCondition {
        CompiledPageUrlCondition {
            patterns: types.iter().map(|t| t.to_string()).collect(),
            match_mode: "page_type".to_string(),
            case_sensitive: false,
            param_name: None,
            param_value: None,
            source: None,
        }
    }

    #[test]
    fn page_type_classifies_shopify_paths_with_optional_locale_prefix() {
        let cases = [
            ("/", "home"),
            ("", "home"),
            ("/?utm_source=x", "home"),
            ("/en", "home"),
            ("/fr-ca/", "home"),
            ("/products/shirt", "product"),
            ("/es/products/shirt?variant=1", "product"),
            ("/collections/sale/products/shirt", "product"),
            ("/en-us/collections/sale/products/shirt", "product"),
            ("/collections", "collection"),
            ("/collections/sale", "collection"),
            ("/de/collections/sale/tag", "collection"),
            ("/search?q=shirt", "search"),
            ("/pages/about", "page"),
            ("/blogs/news/post", "blog"),
            ("/cart", "cart"),
            ("/EN/Products/Shirt", "product"),
            ("https://shop.example/en/pages/vip?x=1", "page"),
        ];
        for (url, expected) in cases {
            for kind in ["home", "collection", "product", "search", "page", "blog", "cart"] {
                assert_eq!(
                    page_url_condition_matches(url, &page_type_condition(&[kind])),
                    kind == expected,
                    "{url} as {kind}"
                );
            }
        }
        let all = page_type_condition(&["home", "collection", "product", "search", "page", "blog", "cart"]);
        for unknown in ["/account", "/policies/refund-policy", "/eng/products/x", "/apps/foo"] {
            assert!(!page_url_condition_matches(unknown, &all), "{unknown}");
        }
        assert!(!page_url_condition_matches("/products/x", &page_type_condition(&[])));
    }

    /// Two regular lines with the given packed metadata, a 10% plain discount offer.
    fn two_line_payload(offer_fields: &str, metadata: [serde_json::Value; 2]) -> String {
        let config = format!(
            r#"{{"offers":[{{
                "id":"offer-1","version":1,"offerType":"discount","priority":100,
                "currencyCode":"USD","discountType":"percentage","discountValue":10,
                {offer_fields}
            }}]}}"#
        );
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/a", "gid://shopify/Product/a", "40.00", 1),
            regular_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/b", "gid://shopify/Product/b", "60.00", 1),
        );
        let mut payload: serde_json::Value =
            serde_json::from_str(&cart_json_with_classes(&lines, "100.00", &config, r#"["PRODUCT"]"#)).unwrap();
        for (index, value) in metadata.into_iter().enumerate() {
            if !value.is_null() {
                payload["cart"]["lines"][index]["promoMetadata"] =
                    serde_json::json!({ "value": value.to_string() });
            }
        }
        serde_json::to_string(&payload).unwrap()
    }

    const PRODUCT_PAGES: &str =
        r#""pageUrlConditions":[{"matchMode":"page_type","patterns":["product"]}]"#;

    #[test]
    fn page_type_condition_gates_and_restricts_lines() {
        let metadata = || {
            [
                serde_json::json!({ "_promo_page_url": "/en/collections/x/products/y" }),
                serde_json::json!({ "_promo_page_url": "/" }),
            ]
        };
        let restricted = two_line_payload(&format!(r#"{PRODUCT_PAGES},"restrictToMatchedLines":true"#), metadata());
        let result = run_function_with_input(run, &restricted).expect("restricted");
        assert_eq!(product_target_ids(&result), vec!["gid://shopify/CartLine/1"]);

        let unrestricted = two_line_payload(PRODUCT_PAGES, metadata());
        let result = run_function_with_input(run, &unrestricted).expect("unrestricted");
        assert_eq!(product_target_ids(&result).len(), 2);

        let no_product_page = two_line_payload(
            PRODUCT_PAGES,
            [serde_json::json!({ "_promo_page_url": "/cart" }), serde_json::Value::Null],
        );
        let result = run_function_with_input(run, &no_product_page).expect("no product page");
        assert!(result.operations.is_empty());
    }

    #[test]
    fn reject_unmatched_lines_blocks_mixed_carts_while_restrict_only_excludes() {
        let mixed = || {
            [
                serde_json::json!({ "_promo_page_url": "/products/y" }),
                serde_json::json!({ "_promo_page_url": "/collections/all" }),
            ]
        };
        let reject = two_line_payload(
            &format!(r#"{PRODUCT_PAGES},"restrictToMatchedLines":true,"rejectUnmatchedLines":true"#),
            mixed(),
        );
        let result = run_function_with_input(run, &reject).expect("reject mixed");
        assert!(result.operations.is_empty());

        let exclude = two_line_payload(&format!(r#"{PRODUCT_PAGES},"restrictToMatchedLines":true"#), mixed());
        let result = run_function_with_input(run, &exclude).expect("exclude mixed");
        assert_eq!(product_target_ids(&result), vec!["gid://shopify/CartLine/1"]);

        // A line without any page metadata counts as unmatched.
        let missing = two_line_payload(
            &format!(r#"{PRODUCT_PAGES},"rejectUnmatchedLines":true"#),
            [serde_json::json!({ "_promo_page_url": "/products/y" }), serde_json::Value::Null],
        );
        let result = run_function_with_input(run, &missing).expect("reject missing");
        assert!(result.operations.is_empty());

        let all_matched = two_line_payload(
            &format!(r#"{PRODUCT_PAGES},"rejectUnmatchedLines":true"#),
            [
                serde_json::json!({ "_promo_page_url": "/products/y" }),
                serde_json::json!({ "_promo_page_url": "/es/products/z" }),
            ],
        );
        let result = run_function_with_input(run, &all_matched).expect("reject all matched");
        assert_eq!(product_target_ids(&result).len(), 2);
    }

    #[test]
    fn visit_scope_utm_reads_the_session_landing_url() {
        let visit = r#""pageUrlConditions":[{"matchMode":"contains","paramName":"utm_source","paramValue":"amazon","source":"landing"}],"restrictToMatchedLines":true"#;
        let landing = "/pages/prime?utm_source=amazon";
        let lines = || {
            [
                serde_json::json!({ "_promo_page_url": "/products/y", "_promo_landing_url": landing }),
                serde_json::json!({ "_promo_page_url": "/products/z" }),
            ]
        };
        let result = run_function_with_input(run, &two_line_payload(visit, lines())).expect("visit");
        assert_eq!(product_target_ids(&result), vec!["gid://shopify/CartLine/1"]);

        // Page scope ignores the landing URL: neither line was added from a UTM page.
        let page = visit.replace(r#","source":"landing""#, "");
        let result = run_function_with_input(run, &two_line_payload(&page, lines())).expect("page");
        assert!(result.operations.is_empty());

        // Visit scope ANDs with a page-scoped condition on the same line.
        let combined = r#""pageUrlConditions":[{"matchMode":"page_type","patterns":["product"]},{"matchMode":"contains","paramName":"utm_source","paramValue":"amazon","source":"landing"}],"restrictToMatchedLines":true"#;
        let result = run_function_with_input(
            run,
            &two_line_payload(
                combined,
                [
                    serde_json::json!({ "_promo_page_url": "/products/y", "_promo_landing_url": landing }),
                    serde_json::json!({ "_promo_page_url": "/", "_promo_landing_url": landing }),
                ],
            ),
        )
        .expect("combined");
        assert_eq!(product_target_ids(&result), vec!["gid://shopify/CartLine/1"]);
    }

    #[test]
    fn compact_metafield_produces_identical_output() {
        const FULL: &str = include_str!("fixtures/ambrosia-function-config.full.json");
        const COMPACT: &str = include_str!("fixtures/ambrosia-function-config.compact.json");
        const ANCHOR: &str = "gid://shopify/ProductVariant/50000000000001";
        let subscribed = |line: String| {
            line.replace(
                "\"sellingPlanAllocation\": null",
                "\"sellingPlanAllocation\": { \"sellingPlan\": { \"id\": \"gid://shopify/SellingPlan/7000000001\" } }",
            )
        };
        let landing_cart = |source: &str, gift_product: &str| {
            format!(
                "[{},{}]",
                subscribed(scoped_line(
                    "gid://shopify/CartLine/1",
                    ANCHOR,
                    "gid://shopify/Product/10000000000001",
                    "60.00",
                    2,
                    Some(source),
                    None,
                )),
                scoped_line(
                    "gid://shopify/CartLine/2",
                    "gid://shopify/ProductVariant/50000000000099",
                    gift_product,
                    "25.00",
                    1,
                    Some(source),
                    None,
                ),
            )
        };
        let shirt_cart = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                ANCHOR,
                "gid://shopify/Product/10000000000001",
                "90.00",
                1
            ),
            gift_line_with_metadata(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/50000000000012",
                "gid://shopify/Product/10000000000005",
                (
                    "00000001-0000-4000-8000-000000000002",
                    "00000002-0000-4000-8000-000000000020",
                    "154423745"
                ),
                "20.00",
                1
            ),
        );
        let carts = [
            (
                landing_cart("nektar-glp1-sk", "gid://shopify/Product/10000000000002"),
                "145.00",
            ),
            (
                landing_cart("atlas-sk-otg", "gid://shopify/Product/10000000000003"),
                "145.00",
            ),
            (
                landing_cart("unknown-source", "gid://shopify/Product/10000000000002"),
                "145.00",
            ),
            (shirt_cart, "110.00"),
        ];

        let mut discounted_carts = 0;
        for (lines, subtotal) in &carts {
            let run_with = |config: &str| {
                let payload =
                    cart_json_with_classes(lines, subtotal, config, r#"["PRODUCT","ORDER"]"#);
                format!(
                    "{:?}",
                    run_function_with_input(run, &payload).expect("valid input")
                )
            };
            let full = run_with(FULL);
            assert_eq!(run_with(COMPACT), full);
            if full.contains("Add") {
                discounted_carts += 1;
            }
        }
        assert!(
            discounted_carts >= 3,
            "fixture carts must exercise live offers"
        );
    }

    fn product_offer(id: &str, priority: i32, excluded: &str, reward: &str) -> String {
        format!(
            r#"{{"id":"{id}","version":1,"offerType":"discount","priority":{priority},
            "excludedProductIds":[{excluded}],"productRewards":[{reward}]}}"#
        )
    }

    fn product_candidates(offers: &[String], lines: &[String], subtotal: &str) -> Vec<(String, schema::ProductDiscountCandidateValue)> {
        let config = format!(r#"{{"offers":[{}]}}"#, offers.join(","));
        let result = run_function_with_input(run, &cart_json(&format!("[{}]", lines.join(",")), subtotal, &config))
            .expect("should not error");
        result
            .operations
            .iter()
            .filter_map(|op| match op {
                schema::CartOperation::ProductDiscountsAdd(op) => Some(op.candidates.clone()),
                _ => None,
            })
            .flatten()
            .map(|candidate| {
                let schema::ProductDiscountCandidateTarget::CartLine(target) = &candidate.targets[0];
                (target.id.clone(), candidate.value.clone())
            })
            .collect()
    }

    fn line_a(qty: i64) -> String {
        regular_line("gid://shopify/CartLine/a", "gid://shopify/ProductVariant/a", "gid://shopify/Product/a", "20.00", qty)
    }
    fn line_b() -> String {
        regular_line("gid://shopify/CartLine/b", "gid://shopify/ProductVariant/b", "gid://shopify/Product/b", "25.00", 1)
    }

    #[test]
    fn excluded_products_do_not_receive_product_rewards() {
        let reward = r#"{"id":"r","discountType":"percentage","discountValue":10,"scopeMode":"sitewide"}"#;
        let offers = [product_offer("o1", 1, r#""gid://shopify/Product/b""#, reward)];
        let found = product_candidates(&offers, &[line_a(2), line_b()], "65.00");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "gid://shopify/CartLine/a");
    }

    #[test]
    fn cheapest_item_free_needs_at_least_two_items() {
        let reward = r#"{"id":"r","discountType":"cheapest_item_free","discountValue":100,"scopeMode":"sitewide"}"#;
        let offers = [product_offer("o1", 1, "", reward)];
        assert!(product_candidates(&offers, &[line_a(1)], "20.00").is_empty());
        let found = product_candidates(&offers, &[line_a(1), line_b()], "45.00");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "gid://shopify/CartLine/a");
    }

    #[test]
    fn most_expensive_item_discount_is_a_percentage_of_the_priciest_item() {
        let reward = r#"{"id":"r","discountType":"most_expensive_item_discount","discountValue":50,"scopeMode":"sitewide"}"#;
        let offers = [product_offer("o1", 1, "", reward)];
        let found = product_candidates(&offers, &[line_a(1), line_b()], "45.00");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "gid://shopify/CartLine/b");
        match &found[0].1 {
            schema::ProductDiscountCandidateValue::Percentage(pct) => assert_eq!(pct.value.0, 50.0),
            other => panic!("expected percentage, got {other:?}"),
        }
    }

    #[test]
    fn overlapping_product_offers_keep_the_biggest_saving_per_line() {
        let small = r#"{"id":"small","discountType":"percentage","discountValue":10,"scopeMode":"sitewide"}"#;
        let big = r#"{"id":"big","discountType":"percentage","discountValue":30,"scopeMode":"sitewide"}"#;
        let offers = [product_offer("o1", 1, "", small), product_offer("o2", 2, "", big)];
        let found = product_candidates(&offers, &[line_a(1)], "20.00");
        assert_eq!(found.len(), 1);
        match &found[0].1 {
            schema::ProductDiscountCandidateValue::Percentage(pct) => assert_eq!(pct.value.0, 30.0),
            other => panic!("expected percentage, got {other:?}"),
        }
    }

    #[test]
    fn max_units_per_product_frees_one_unit_of_each_target() {
        let reward = r#"{"id":"r","discountType":"free","discountValue":100,"scopeMode":"sitewide","maxUnitsPerProduct":1}"#;
        let offers = [product_offer("o1", 1, "", reward)];
        let found = product_candidates(&offers, &[line_a(2), line_b()], "65.00");
        assert_eq!(found.len(), 2);
        let config = format!(r#"{{"offers":[{}]}}"#, offers.join(","));
        let result = run_function_with_input(run, &cart_json(&format!("[{},{}]", line_a(2), line_b()), "65.00", &config)).unwrap();
        let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] else { panic!("expected product discounts") };
        for candidate in &op.candidates {
            let schema::ProductDiscountCandidateTarget::CartLine(target) = &candidate.targets[0];
            assert_eq!(target.quantity, Some(1));
        }
    }

    #[test]
    fn max_units_per_line_caps_each_line_independently_without_accumulating() {
        let reward = r#"{"id":"r","discountType":"free","discountValue":100,"scopeMode":"sitewide","maxUnitsPerLine":1}"#;
        let offers = [product_offer("o1", 1, "", reward)];
        let line_1 = regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/a", "gid://shopify/Product/a", "20.00", 3);
        let line_2 = regular_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/a", "gid://shopify/Product/a", "20.00", 2);
        let config = format!(r#"{{"offers":[{}]}}"#, offers.join(","));
        let result = run_function_with_input(run, &cart_json(&format!("[{line_1},{line_2}]"), "100.00", &config)).unwrap();
        let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] else { panic!("expected product discounts") };
        assert_eq!(op.candidates.len(), 2, "each line gets its own independently-capped candidate");
        for candidate in &op.candidates {
            let schema::ProductDiscountCandidateTarget::CartLine(target) = &candidate.targets[0];
            assert_eq!(target.quantity, Some(1));
        }
    }

    #[test]
    fn max_units_per_variant_accumulates_across_lines_of_the_same_variant() {
        let reward = r#"{"id":"r","discountType":"free","discountValue":100,"scopeMode":"sitewide","maxUnitsPerVariant":1}"#;
        let offers = [product_offer("o1", 1, "", reward)];
        let line_1 = regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/a", "gid://shopify/Product/a", "20.00", 1);
        let line_2 = regular_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/a", "gid://shopify/Product/a", "20.00", 1);
        let config = format!(r#"{{"offers":[{}]}}"#, offers.join(","));
        let result = run_function_with_input(run, &cart_json(&format!("[{line_1},{line_2}]"), "40.00", &config)).unwrap();
        let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] else { panic!("expected product discounts") };
        // Unlike maxUnitsPerLine, the cap is shared across every line of the same
        // variant — once the first line exhausts it, later lines get nothing.
        assert_eq!(op.candidates.len(), 1);
        let schema::ProductDiscountCandidateTarget::CartLine(target) = &op.candidates[0].targets[0];
        assert_eq!(target.id, "gid://shopify/CartLine/1");
        assert_eq!(target.quantity, Some(1));
    }

    #[test]
    fn fixed_amount_price_tier_discount_rounds_to_the_nearest_cent() {
        let reward = r#"{"id":"r","discountType":"fixed_price","discountValue":0,"scopeMode":"sitewide","priceTiers":[{"quantity":1,"targetPricePerUnit":42.49}]}"#;
        let offers = [product_offer("o1", 1, "", reward)];
        let line = regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/a", "gid://shopify/Product/a", "49.99", 1);
        let found = product_candidates(&offers, &[line], "49.99");
        assert_eq!(found.len(), 1);
        match &found[0].1 {
            // 49.99 - 42.49 is 7.500000000000004 in f64 — must be rounded to 7.5.
            schema::ProductDiscountCandidateValue::FixedAmount(value) => assert_eq!(value.amount.0, 7.5),
            other => panic!("expected fixed amount, got {other:?}"),
        }
    }

    #[test]
    fn tagged_offer_without_configured_targets_fails_closed() {
        let reward = r#"{"id":"r","discountType":"free","discountValue":100,"scopeMode":"tagged_offer","requiredOfferId":"11111111-1111-1111-1111-111111111111"}"#;
        let offers = [product_offer("o1", 1, "", reward)];
        let tagged = regular_line(
            "gid://shopify/CartLine/a",
            "gid://shopify/ProductVariant/a",
            "gid://shopify/Product/a",
            "20.00",
            1,
        )
        .replace(
            "\"offerId\": null",
            "\"offerId\": { \"value\": \"11111111-1111-1111-1111-111111111111\" }",
        );
        let found = product_candidates(&offers, &[tagged], "20.00");
        assert!(
            found.is_empty(),
            "a tagged_offer reward with no configured targets must not discount anything"
        );
    }

    #[test]
    fn landing_anchor_self_reference_is_rejected_without_a_genuine_anchor_line() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{
                "id":"atlas-gifts","rewardType":"product_discount","targetProductIds":[],
                "targetVariantIds":["gid://shopify/ProductVariant/gift"],"discountType":"free","discountValue":100,
                "subscriptionMode":"any","scopeMode":"landing","requiredLineAttributeValue":"atlas-sk-otg",
                "requiredAnchorVariantIds":[],"requiredAnchorMinQuantity":1,"requiresAnchorSubscription":false,
                "priceTiers":[],"discountPercentageOnGifts":100
            }]
        }]}"#;
        let self_only = scoped_line(
            "gid://shopify/CartLine/1",
            "gid://shopify/ProductVariant/gift",
            "gid://shopify/Product/gift",
            "20.00",
            1,
            Some("atlas-sk-otg"),
            None,
        );
        let result = run_function_with_input(run, &cart_json(&format!("[{self_only}]"), "20.00", config))
            .expect("should not error");
        assert!(
            result.operations.is_empty(),
            "tagging only the target line must not unlock its own discount"
        );

        let atlas_kit = scoped_line(
            "gid://shopify/CartLine/2",
            "gid://shopify/ProductVariant/atlas-kit",
            "gid://shopify/Product/atlas-kit",
            "30.00",
            1,
            Some("atlas-sk-otg"),
            None,
        );
        let with_anchor = format!("[{self_only},{atlas_kit}]");
        let result = run_function_with_input(run, &cart_json(&with_anchor, "50.00", config))
            .expect("should not error");
        assert_eq!(
            result.operations.len(),
            1,
            "a genuine tagged anchor line alongside the target must unlock the discount"
        );
    }

    #[test]
    fn quiz_bundle_reward_with_targets_only_counts_matching_lines() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{
                "id":"quiz","rewardType":"product_discount","targetProductIds":[],
                "targetVariantIds":["gid://shopify/ProductVariant/p1"],
                "discountType":"fixed_price","discountValue":80,"subscriptionMode":"any","scopeMode":"quiz_bundle",
                "requiredAnchorVariantIds":[],"requiredAnchorMinQuantity":1,"requiresAnchorSubscription":false,
                "priceTiers":[],"discountPercentageOnGifts":100
            }]
        }]}"#;
        let p1 = scoped_line(
            "gid://shopify/CartLine/1", "gid://shopify/ProductVariant/p1", "gid://shopify/Product/p1",
            "50.00", 1, None, Some(("bundle-a", "8000", "2", false)),
        );
        let p2_other = scoped_line(
            "gid://shopify/CartLine/2", "gid://shopify/ProductVariant/p2", "gid://shopify/Product/p2",
            "50.00", 1, None, Some(("bundle-a", "8000", "2", false)),
        );
        // Only one matching (p1) paid line exists — the non-target p2 line must
        // not count toward expectedPaidCount, so the bundle stays incomplete.
        let incomplete = format!("[{p1},{p2_other}]");
        let result = run_function_with_input(run, &cart_json(&incomplete, "100.00", config)).unwrap();
        assert!(result.operations.is_empty());

        let p1_second = scoped_line(
            "gid://shopify/CartLine/3", "gid://shopify/ProductVariant/p1", "gid://shopify/Product/p1",
            "50.00", 1, None, Some(("bundle-a", "8000", "2", false)),
        );
        let complete = format!("[{p1},{p1_second},{p2_other}]");
        let result = run_function_with_input(run, &cart_json(&complete, "150.00", config)).unwrap();
        assert_eq!(result.operations.len(), 1);
    }

    fn landing_cap_config(targets: &str, extra: &str) -> String {
        format!(
            r#"{{"offers":[{{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{{
                "id":"landing","rewardType":"product_discount",{targets},"discountType":"free","discountValue":100,
                "subscriptionMode":"any","scopeMode":"landing","requiredLineAttributeValue":"lp",
                "requiredAnchorVariantIds":["gid://shopify/ProductVariant/anchor"],"requiredAnchorMinQuantity":1,
                "requiresAnchorSubscription":false,"priceTiers":[],"discountPercentageOnGifts":100{extra}
            }}]
        }}]}}"#
        )
    }

    const THREE_PRODUCTS: &str = r#""targetProductIds":["gid://shopify/Product/t1","gid://shopify/Product/t2","gid://shopify/Product/t3"],"targetVariantIds":[]"#;

    /// One anchor line plus one tagged line for each of the three target products.
    fn landing_cap_lines(anchor_quantity: i64, target_quantity: i64) -> String {
        let target = |n: i64| {
            scoped_line(
                &format!("gid://shopify/CartLine/t{n}"),
                &format!("gid://shopify/ProductVariant/t{n}"),
                &format!("gid://shopify/Product/t{n}"),
                "20.00", target_quantity, Some("lp"), None,
            )
        };
        format!(
            "[{},{},{},{}]",
            scoped_line(
                "gid://shopify/CartLine/anchor", "gid://shopify/ProductVariant/anchor", "gid://shopify/Product/anchor",
                "30.00", anchor_quantity, Some("lp"), None,
            ),
            target(1), target(2), target(3),
        )
    }

    /// Free units per cart line id.
    fn free_units_by_line(result: &schema::CartLinesDiscountsGenerateRunResult) -> BTreeMap<String, i64> {
        let mut units = BTreeMap::new();
        for operation in &result.operations {
            if let schema::CartOperation::ProductDiscountsAdd(op) = operation {
                for candidate in &op.candidates {
                    for target in &candidate.targets {
                        let schema::ProductDiscountCandidateTarget::CartLine(line) = target;
                        *units.entry(line.id.clone()).or_insert(0) += i64::from(line.quantity.unwrap_or(0));
                    }
                }
            }
        }
        units
    }

    fn landing_units(config: &str, anchor: i64, target: i64) -> Vec<i64> {
        let result = run_function_with_input(run, &cart_json(&landing_cap_lines(anchor, target), "500.00", config)).unwrap();
        let units = free_units_by_line(&result);
        (1..=3).map(|n| units.get(&format!("gid://shopify/CartLine/t{n}")).copied().unwrap_or(0)).collect()
    }

    #[test]
    fn landing_reward_grants_the_gift_set_once_by_default() {
        let config = landing_cap_config(THREE_PRODUCTS, "");
        // One of each target product, however many anchors or target units are in the cart.
        assert_eq!(landing_units(&config, 1, 1), vec![1, 1, 1]);
        assert_eq!(landing_units(&config, 2, 1), vec![1, 1, 1]);
        assert_eq!(landing_units(&config, 1, 50), vec![1, 1, 1]);
        assert_eq!(landing_units(&config, 9, 50), vec![1, 1, 1]);
    }

    #[test]
    fn landing_reward_limit_is_the_number_of_sets_per_target_product() {
        let config = landing_cap_config(THREE_PRODUCTS, r#","maxQuantity":2"#);
        assert_eq!(landing_units(&config, 1, 50), vec![2, 2, 2]);
        assert_eq!(landing_units(&config, 1, 1), vec![1, 1, 1], "never more than the cart holds");
    }

    #[test]
    fn landing_reward_max_units_total_still_caps_the_whole_cart() {
        let config = landing_cap_config(THREE_PRODUCTS, r#","maxQuantity":2,"maxUnitsTotal":4"#);
        let total: i64 = landing_units(&config, 1, 50).iter().sum();
        assert_eq!(total, 4);
    }

    #[test]
    fn landing_reward_with_variant_targets_caps_per_variant() {
        let variants = r#""targetProductIds":[],"targetVariantIds":["gid://shopify/ProductVariant/t1","gid://shopify/ProductVariant/t2"]"#;
        let config = landing_cap_config(variants, r#","maxQuantity":3"#);
        assert_eq!(landing_units(&config, 1, 50), vec![3, 3, 0]);
    }

    fn tagged_free_units(extra: &str) -> BTreeMap<String, i64> {
        let config = landing_cap_config(THREE_PRODUCTS, extra)
            .replace(r#""scopeMode":"landing","requiredLineAttributeValue":"lp""#, r#""scopeMode":"tagged_offer","requiredOfferId":"offer-x""#);
        let tagged: Vec<String> = serde_json::from_str::<Vec<Value>>(&landing_cap_lines(1, 5))
            .unwrap()
            .into_iter()
            .map(|mut line| {
                line["offerId"] = serde_json::json!({ "value": "offer-x" });
                line.to_string()
            })
            .collect();
        let result = run_function_with_input(run, &cart_json(&format!("[{}]", tagged.join(",")), "500.00", &config)).unwrap();
        free_units_by_line(&result)
    }

    #[test]
    fn tagged_offer_without_limit_discounts_every_tagged_unit() {
        // Tagged bundles ("buy 3 of A, 20% off") must not inherit the free-gift default of 1 set.
        let units = tagged_free_units("");
        assert_eq!(units.get("gid://shopify/CartLine/t1"), Some(&5));
        assert_eq!(units.get("gid://shopify/CartLine/t3"), Some(&5));
    }

    #[test]
    fn tagged_offer_with_configured_limit_caps_each_target_product() {
        let units = tagged_free_units(r#","maxQuantity":2"#);
        assert_eq!(units.get("gid://shopify/CartLine/t1"), Some(&2));
        assert_eq!(units.get("gid://shopify/CartLine/t3"), Some(&2));
    }

    #[test]
    fn landing_price_tiers_do_not_inherit_the_free_gift_default() {
        let config = landing_cap_config(THREE_PRODUCTS, "").replace(r#""discountType":"free","discountValue":100,
                "subscriptionMode""#, r#""discountType":"percentage","discountValue":20,
                "subscriptionMode""#);
        let result = run_function_with_input(run, &cart_json(&landing_cap_lines(1, 4), "300.00", &config)).unwrap();
        assert_eq!(free_units_by_line(&result).get("gid://shopify/CartLine/t1"), Some(&4));
    }

    fn gift_cart(gifts: &[(&str, &str, &str, i64)], config: &str, reward_id: Option<&str>) -> BTreeMap<String, i64> {
        let mut lines = vec![regular_line(
            "gid://shopify/CartLine/paid",
            "gid://shopify/ProductVariant/v1",
            "gid://shopify/Product/p1",
            "60.00",
            1,
        )];
        for (id, variant, product, quantity) in gifts {
            let reward = reward_id.unwrap_or(if variant.ends_with("gift-v2") { "reward-2" } else { "reward-1" });
            lines.push(gift_line_with_metadata(
                &format!("gid://shopify/CartLine/{id}"),
                &format!("gid://shopify/ProductVariant/{variant}"),
                &format!("gid://shopify/Product/{product}"),
                ("offer-1", reward, "3"),
                "20.00",
                *quantity,
            ));
        }
        let result = run_function_with_input(run, &cart_json(&format!("[{}]", lines.join(",")), "200.00", config)).unwrap();
        free_units_by_line(&result)
    }

    #[test]
    fn manual_gift_quantity_bump_discounts_only_the_limit() {
        let config = strict_gift_offer_config();
        // limit 1: raising the gift line to 5 discounts 1 unit, the other 4 are charged.
        let units = gift_cart(&[("g1", "gift-v1", "gift-p1", 5)], config, None);
        assert_eq!(units.get("gid://shopify/CartLine/g1"), Some(&1));
        // limit 2: 2 of 5.
        let units = gift_cart(&[("g2", "gift-v2", "gift-p2", 5)], config, None);
        assert_eq!(units.get("gid://shopify/CartLine/g2"), Some(&2));
    }

    #[test]
    fn gift_limit_applies_per_gift_product_of_a_set() {
        // One reward, a 2-product set, limit 1.
        let set = r#"{"offers":[{
            "id":"offer-1","version":3,"offerType":"gift","priority":100,"stopLowerPriority":false,
            "cartValueThresholdCents":5000,"discountType":"free","discountValue":100,"currencyCode":"USD",
            "giftRewards":[{"id":"set","targetProductIds":["gid://shopify/Product/gift-p1","gid://shopify/Product/gift-p2"],"targetVariantIds":[],"discountType":"free","discountValue":100,"maxQuantity":1}]
        }]}"#;
        let units = gift_cart(
            &[("g1", "gift-v1", "gift-p1", 3), ("g2", "gift-v2", "gift-p2", 3)],
            set,
            Some("set"),
        );
        assert_eq!(units.get("gid://shopify/CartLine/g1"), Some(&1));
        assert_eq!(units.get("gid://shopify/CartLine/g2"), Some(&1));
        // A product split over two lines still gets the limit once overall.
        let units = gift_cart(
            &[("g1", "gift-v1", "gift-p1", 3), ("g3", "gift-v1", "gift-p1", 3)],
            set,
            Some("set"),
        );
        assert_eq!(units.values().sum::<i64>(), 1);
    }

    fn picker_config(extra: &str) -> String {
        format!(
            r#"{{"offers":[{{
            "id":"offer-1","version":3,"offerType":"gift","priority":100,"stopLowerPriority":false,
            "cartValueThresholdCents":5000,"discountType":"free","discountValue":100,"currencyCode":"USD",
            "giftRewards":[{{"id":"pick","targetProductIds":[],"targetVariantIds":["gid://shopify/ProductVariant/gift-v1","gid://shopify/ProductVariant/gift-v2","gid://shopify/ProductVariant/gift-v3","gid://shopify/ProductVariant/gift-v4"],"discountType":"free","discountValue":100,"maxQuantity":1{extra}}}]
        }}]}}"#
        )
    }

    const FOUR_GIFTS: [(&str, &str, &str, i64); 4] = [
        ("g1", "gift-v1", "gift-p1", 1),
        ("g2", "gift-v2", "gift-p2", 1),
        ("g3", "gift-v3", "gift-p3", 1),
        ("g4", "gift-v4", "gift-p4", 1),
    ];

    #[test]
    fn picker_one_of_four_frees_only_the_first_added_gift() {
        let units = gift_cart(&FOUR_GIFTS, &picker_config(""), Some("pick"));
        // Cart order = the order the shopper added them: the first line is free, the rest are charged.
        assert_eq!(units.len(), 1);
        assert_eq!(units.get("gid://shopify/CartLine/g1"), Some(&1));
        // Flagged selectable with a single option behaves the same.
        let flagged = picker_config(r#","selectable":true"#);
        assert_eq!(gift_cart(&FOUR_GIFTS, &flagged, Some("pick")).len(), 1);
    }

    #[test]
    fn picker_selection_count_scales_the_total_and_each_product_stays_capped() {
        let config = picker_config(r#","selectionCount":2"#);
        let units = gift_cart(&FOUR_GIFTS, &config, Some("pick"));
        assert_eq!(units.values().sum::<i64>(), 2);
        // The same product bumped to qty 5 still gets only the per-product limit (1).
        let bumped = gift_cart(&[("g1", "gift-v1", "gift-p1", 5), ("g2", "gift-v2", "gift-p2", 1)], &config, Some("pick"));
        assert_eq!(bumped.get("gid://shopify/CartLine/g1"), Some(&1));
        assert_eq!(bumped.get("gid://shopify/CartLine/g2"), Some(&1));
    }

    fn quiz_config(discount_type: &str, discount_value: &str) -> String {
        format!(
            r#"{{"offers":[{{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{{
                "id":"quiz","rewardType":"product_discount","targetProductIds":[],"targetVariantIds":[],
                "discountType":"{discount_type}","discountValue":{discount_value},"subscriptionMode":"any","scopeMode":"quiz_bundle",
                "requiredAnchorVariantIds":[],"requiredAnchorMinQuantity":1,"requiresAnchorSubscription":false,
                "priceTiers":[],"discountPercentageOnGifts":100
            }}]
        }}]}}"#
        )
    }

    fn quiz_paid_line(target_cents: &str) -> String {
        quiz_paid_line_priced("50.00", target_cents)
    }

    fn quiz_paid_line_priced(price: &str, target_cents: &str) -> String {
        scoped_line(
            "gid://shopify/CartLine/1", "gid://shopify/ProductVariant/p1", "gid://shopify/Product/p1",
            price, 1, None, Some(("bundle-a", target_cents, "1", false)),
        )
    }

    #[test]
    fn quiz_bundle_price_comes_from_config_not_the_client_set_target() {
        let config = quiz_config("fixed_price", "30");
        for tampered in ["1", "0", "999999", "3000"] {
            let result = run_function_with_input(
                run,
                &cart_json(&format!("[{}]", quiz_paid_line(tampered)), "50.00", &config),
            )
            .unwrap();
            match &result.operations[0] {
                schema::CartOperation::ProductDiscountsAdd(op) => match &op.candidates[0].value {
                    schema::ProductDiscountCandidateValue::FixedAmount(value) => {
                        assert_eq!(value.amount.0, 20.0, "client target {tampered} must be ignored")
                    }
                    other => panic!("expected fixed amount, got {other:?}"),
                },
                other => panic!("expected ProductDiscountsAdd, got {other:?}"),
            }
        }
    }

    fn quiz_discount(config: &str, target_cents: &str) -> Option<f64> {
        let result = run_function_with_input(
            run,
            &cart_json(&format!("[{}]", quiz_paid_line(target_cents)), "50.00", config),
        )
        .unwrap();
        result.operations.iter().find_map(|operation| match operation {
            schema::CartOperation::ProductDiscountsAdd(op) => match &op.candidates[0].value {
                schema::ProductDiscountCandidateValue::FixedAmount(value) => Some(value.amount.0),
                _ => None,
            },
            _ => None,
        })
    }

    #[test]
    fn quiz_bundle_client_target_is_bounded() {
        let unconfigured = quiz_config("free", "100");
        // A target at or below zero would make the paid lines free: rejected.
        assert_eq!(quiz_discount(&unconfigured, "0"), None);
        assert_eq!(quiz_discount(&unconfigured, "-500"), None);
        // A target above the subtotal never discounts (and never goes negative).
        assert_eq!(quiz_discount(&unconfigured, "999999"), None);
        // A normal target discounts down to that price, never beyond the lines' own subtotal.
        assert_eq!(quiz_discount(&unconfigured, "3000"), Some(20.0));
        // No configured price and no quizMaxDiscountPercent: the default 50% cap applies.
        assert_eq!(quiz_discount(&unconfigured, "1"), Some(25.0));
        assert_eq!(quiz_discount(&unconfigured, "2600"), Some(24.0), "below the cap is untouched");
    }

    #[test]
    fn quiz_bundle_target_uses_currency_minor_units() {
        let config = quiz_config("free", "100").replace(
            r#""scopeMode":"quiz_bundle""#,
            r#""scopeMode":"quiz_bundle","quizMaxDiscountPercent":90"#,
        );
        let discount = |currency: &str, subtotal: &str, target: &str| {
            let json = cart_json(&format!("[{}]", quiz_paid_line_priced(subtotal, target)), subtotal, &config)
                .replace(r#""currencyCode": "USD""#, &format!(r#""currencyCode": "{currency}""#));
            run_function_with_input(run, &json).unwrap().operations.iter().find_map(|operation| match operation {
                schema::CartOperation::ProductDiscountsAdd(op) => match &op.candidates[0].value {
                    schema::ProductDiscountCandidateValue::FixedAmount(value) => Some(value.amount.0),
                    _ => None,
                },
                _ => None,
            })
        };
        assert_eq!(discount("JPY", "5000", "3000"), Some(2000.0), "JPY target is whole yen, not /100");
        assert_eq!(discount("USD", "50.00", "3000"), Some(20.0));
    }

    #[test]
    fn quiz_max_discount_percent_caps_the_client_target() {
        let capped = quiz_config("free", "100").replace(
            r#""scopeMode":"quiz_bundle""#,
            r#""scopeMode":"quiz_bundle","quizMaxDiscountPercent":30"#,
        );
        assert_eq!(quiz_discount(&capped, "1"), Some(15.0), "30% of the $50 subtotal");
        assert_eq!(quiz_discount(&capped, "4000"), Some(10.0), "a smaller discount is untouched");
        // A configured price is not subject to the client target at all.
        let priced = quiz_config("fixed_price", "30").replace(
            r#""scopeMode":"quiz_bundle""#,
            r#""scopeMode":"quiz_bundle","quizMaxDiscountPercent":30"#,
        );
        assert_eq!(quiz_discount(&priced, "1"), Some(15.0));
    }

    #[test]
    fn any_of_trigger_products_qualifies_on_presence_of_any_one() {
        let reward = r#"{"id":"r","targetProductIds":["gid://shopify/Product/a"],"discountType":"percentage","discountValue":10,"scopeMode":"sitewide"}"#;
        let offer = product_offer("o1", 1, "", reward).replace(
            "\"productRewards\":",
            "\"anyRequiredProductIds\":[\"gid://shopify/Product/trigger\"],\"productRewards\":",
        );
        assert!(
            product_candidates(&[offer.clone()], &[line_a(1)], "20.00").is_empty(),
            "no trigger product present — offer must not qualify"
        );
        let trigger = regular_line(
            "gid://shopify/CartLine/trigger",
            "gid://shopify/ProductVariant/trigger",
            "gid://shopify/Product/trigger",
            "5.00",
            1,
        );
        let found = product_candidates(&[offer], &[line_a(1), trigger], "25.00");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "gid://shopify/CartLine/a");
    }

    #[test]
    fn cart_attribute_exists_mode_ignores_value_and_requires_only_presence() {
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/v1",
                "gid://shopify/Product/p1",
                "60.00",
                1
            ),
            gift_line(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                "offer-1",
                "20.00",
                1
            )
        );
        let config = gift_offer_config(5000, 1).replace(
            "\"combinesWithOrderDiscounts\":true",
            "\"cartAttributeConditions\":[{\"key\":\"source\",\"matchMode\":\"exists\",\"minMatchingQuantity\":1}],\"combinesWithOrderDiscounts\":true",
        ).replacen('{', "{\"c1\":\"source\",", 1);
        let present = cart_json(&lines, "80.00", &config).replace(
            "\"cart\": {",
            "\"cart\": { \"customCart1\": { \"value\": \"anything-at-all\" },",
        );
        let result = run_function_with_input(run, &present).expect("should not error");
        assert_eq!(result.operations.len(), 1, "any attribute value must satisfy 'exists'");

        let absent = run_function_with_input(run, &cart_json(&lines, "80.00", &config)).expect("should not error");
        assert!(absent.operations.is_empty(), "a missing attribute must not satisfy 'exists'");
    }

    #[test]
    fn required_line_attribute_filters_product_reward_to_matching_lines() {
        let reward = r#"{"id":"r","discountType":"percentage","discountValue":10,"scopeMode":"sitewide","requiredLineAttribute":{"key":"__bundle_type","value":"two"}}"#;
        let offers = [product_offer("o1", 1, "", reward)];
        let tagged = line_a(1).replace(
            "\"volumeDiscountNektarGlp1\": null",
            "\"volumeDiscountNektarGlp1\": null, \"bundleType\": { \"value\": \"two\" }",
        );
        let found = product_candidates(&offers, &[tagged, line_b()], "45.00");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "gid://shopify/CartLine/a");
    }

    #[test]
    fn a_malformed_offer_is_skipped_and_the_others_still_apply() {
        let reward = r#"{"id":"r","discountType":"percentage","discountValue":10,"scopeMode":"sitewide"}"#;
        let good = product_offer("good", 2, "", reward);
        let bad = r#"{"id":"bad","version":"not-a-number","offerType":"discount","priority":1}"#.to_string();
        let not_an_object = "42".to_string();
        let found = product_candidates(&[bad, not_an_object, good], &[line_a(1)], "20.00");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "gid://shopify/CartLine/a");
    }

    #[test]
    fn stop_lower_priority_blocks_only_strictly_lower_priority_offers() {
        let offer = |id: &str, priority: i32, product: &str, stop: bool| {
            let reward = format!(
                r#"{{"id":"r","targetProductIds":["gid://shopify/Product/{product}"],"discountType":"percentage","discountValue":10,"scopeMode":"sitewide"}}"#
            );
            product_offer(id, priority, "", &reward)
                .replacen('{', &format!("{{\"stopLowerPriority\":{stop},"), 1)
        };
        let line_c = regular_line("gid://shopify/CartLine/c", "gid://shopify/ProductVariant/c", "gid://shopify/Product/c", "10.00", 1);
        let offers = [
            offer("stopper", 1, "a", true),
            offer("equal", 1, "b", false),
            offer("lower", 2, "c", false),
        ];
        let found = product_candidates(&offers, &[line_a(1), line_b(), line_c], "55.00");
        let mut ids: Vec<_> = found.iter().map(|(id, _)| id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, vec!["gid://shopify/CartLine/a", "gid://shopify/CartLine/b"]);
    }

    #[test]
    fn reject_mode_exempts_app_added_upsell_lines() {
        let reject = format!(r#"{PRODUCT_PAGES},"rejectUnmatchedLines":true"#);
        let with_upsell = two_line_payload(
            &reject,
            [
                serde_json::json!({ "_promo_page_url": "/products/y" }),
                serde_json::json!({ "_promo_engine_line_type": "upsell" }),
            ],
        );
        let result = run_function_with_input(run, &with_upsell).expect("upsell");
        assert!(!result.operations.is_empty(), "an unstamped upsell line must not block the offer");

        let stray = two_line_payload(
            &reject,
            [
                serde_json::json!({ "_promo_page_url": "/products/y" }),
                serde_json::json!({ "_promo_engine_line_type": "other" }),
            ],
        );
        let result = run_function_with_input(run, &stray).expect("stray");
        assert!(result.operations.is_empty(), "any other unmatched line still blocks reject mode");
    }

    #[test]
    fn fixed_amounts_round_to_the_currency_minor_unit() {
        let reward = r#"{"id":"r","discountType":"fixed_amount","discountValue":12.5,"scopeMode":"sitewide"}"#;
        let config = format!(r#"{{"offers":[{}]}}"#, product_offer("o1", 1, "", reward));
        let fixed_amount = |currency: &str| {
            let payload = cart_json(&format!("[{}]", line_a(1)), "20.00", &config).replace("USD", currency);
            let result = run_function_with_input(run, &payload).expect("should not error");
            match &result.operations[0] {
                schema::CartOperation::ProductDiscountsAdd(op) => match &op.candidates[0].value {
                    schema::ProductDiscountCandidateValue::FixedAmount(value) => value.amount.0,
                    other => panic!("expected fixed amount, got {other:?}"),
                },
                other => panic!("expected ProductDiscountsAdd, got {other:?}"),
            }
        };
        assert_eq!(fixed_amount("USD"), 12.5);
        assert_eq!(fixed_amount("JPY"), 13.0);
        assert_eq!(fixed_amount("KRW"), 13.0);
    }
}
