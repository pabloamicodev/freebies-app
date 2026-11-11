use crate::config::{
    is_zero_decimal, minor_units, to_cents, to_cents_in, CompiledConfig, CompiledGiftReward, CompiledOffer,
    CompiledOrderReward, CompiledProductReward,
};
use crate::page_match::{metadata_matches, LineMetadata, PAGE_STAMP_KEYS};
use crate::schema;
use schema::cart_lines_discounts_generate_run::input::cart::lines::Merchandise;
use schema::cart_lines_discounts_generate_run::input::cart::Lines;
use schema::cart_lines_discounts_generate_run::Input;
use shopify_function::Result;
use std::cell::{Cell, OnceCell, RefCell};
use crate::de::{HashMap, HashSet};
use std::collections::BTreeMap;
use std::rc::Rc;

const LINE_TYPE_GIFT: &str = "gift";
const LINE_TYPE_UPSELL: &str = "upsell";

/// Metadata-derived values of one line.
struct PackedFacts {
    metadata: Option<Rc<LineMetadata>>,
    // Lines whose stamps that page conditions read are identical share a class (see `page_class`).
    page_class: usize,
    line_type: Option<String>,
    gift: bool,
}

struct Merch {
    tiers: Option<Rc<[VolumeDiscountTier]>>,
}

/// Per-line values every offer re-reads. Each is computed on first use (reading a line field is costly) and kept
/// for the run; facts are indexed by the line's position in the cart.
#[derive(Default)]
struct LineFacts {
    packed: OnceCell<PackedFacts>,
    quantity: OnceCell<i32>,
    subtotal: OnceCell<f64>,
    merchandise: OnceCell<Merch>,
    outside_tiers: OnceCell<bool>,
    subscription: OnceCell<bool>,
    landing_source: OnceCell<Option<String>>,
    offer_id: OnceCell<Option<String>>,
    reward_id: OnceCell<Option<String>>,
}

impl LineFacts {
    fn packed(&self, line: &Lines) -> &PackedFacts {
        self.packed.get_or_init(|| compute_packed_facts(line))
    }

    fn quantity(&self, line: &Lines) -> i32 {
        *self.quantity.get_or_init(|| *line.quantity())
    }

    fn subtotal(&self, line: &Lines) -> f64 {
        *self.subtotal.get_or_init(|| line.cost().subtotal_amount().amount().as_f64())
    }

    fn subscription(&self, line: &Lines) -> bool {
        *self.subscription.get_or_init(|| line.selling_plan_allocation().is_some())
    }

    fn landing_source(&self, line: &Lines) -> Option<&String> {
        self.landing_source
            .get_or_init(|| {
                line.landing_source()
                    .and_then(|attribute| attribute.value())
                    .or_else(|| self.packed(line).metadata.as_deref()?.get("__landing_source"))
                    .cloned()
            })
            .as_ref()
    }

    fn merchandise(&self, line: &Lines) -> &Merch {
        self.merchandise.get_or_init(|| match line.merchandise() {
            Merchandise::ProductVariant(variant) => {
                let product = variant.product();
                Merch {
                    tiers: product
                        .volume_discount_tiers()
                        .and_then(|metafield| parse_volume_tiers(metafield.value())),
                }
            }
            Merchandise::Other => Merch { tiers: None },
        })
    }

    /// The line's valid volume-discount tiers; None for bundle components and Nektar GLP-1 lines, which the projection skips.
    fn volume_tiers(&self, line: &Lines) -> Option<&[VolumeDiscountTier]> {
        let tiers = self.merchandise(line).tiers.as_deref()?;
        let outside_tiers = *self.outside_tiers.get_or_init(|| {
            let packed = self.packed(line).metadata.as_deref();
            let packed = |key: &str| packed.and_then(|map| map.get(key));
            let bundle_item = line
                .volume_discount_bundle_item()
                .and_then(|attribute| attribute.value())
                .or_else(|| packed("_bundle_item"));
            let nektar_glp1 = line
                .volume_discount_nektar_glp_1()
                .and_then(|attribute| attribute.value())
                .or_else(|| packed("_nektar_glp1"));
            bundle_item.map(String::as_str) == Some("true") || nektar_glp1.is_some()
        });
        (!outside_tiers).then_some(tiers)
    }
}

thread_local! {
    // Leaked once per run (the wasm instance ends right after) so borrowed ids can outlive the lookup.
    static LINE_FACTS: Cell<&'static [LineFacts]> = const { Cell::new(&[]) };
    // Address and length of this run's cart-lines slice: `line_slot` maps a `&Lines` to its position by pointer offset.
    static LINES_SPAN: Cell<(usize, usize)> = const { Cell::new((0, 0)) };
    // Page-match result per condition-set fingerprint, then line slot, so offers sharing the same page
    // conditions match each line once per run instead of once per offer.
    static PAGE_MATCH: RefCell<HashMap<u64, Vec<Option<bool>>>> = RefCell::new(HashMap::default());
    // Cart value and qualifying lines depend only on which lines are counted (and the excluded products), so offers
    // that count the same lines share one computation. Keyed by line slots.
    static METADATA_CACHE: RefCell<HashMap<String, (Option<Rc<LineMetadata>>, usize)>> = RefCell::new(HashMap::default());
    static PAGE_CLASSES: RefCell<Vec<Option<PageStamps>>> = const { RefCell::new(Vec::new()) };
    // CART_VALUES and QUALIFYING hold at most 8 entries (one per distinct set of counted lines / excluded products). Offers
    // in one config share a handful of such sets (live configs: 1-3), and each lookup is a linear scan comparing the whole
    // key (up to 200 slots), so past 8 entries a lookup would cost more than the recomputation it saves.
    static CART_VALUES: RefCell<Vec<(Vec<usize>, i64)>> = const { RefCell::new(Vec::new()) };
    static QUALIFYING: RefCell<Vec<(Vec<String>, Vec<usize>)>> = const { RefCell::new(Vec::new()) };
    static ZERO_DECIMAL_CURRENCY: Cell<bool> = const { Cell::new(false) };
    static LAST_METADATA: RefCell<Option<(String, (Option<Rc<LineMetadata>>, usize))>> = const { RefCell::new(None) };
    static VOLUME_TIERS: RefCell<HashMap<String, Option<Rc<[VolumeDiscountTier]>>>> = RefCell::new(HashMap::default());
}

#[derive(Debug, serde::Deserialize, Clone)]
struct VolumeDiscountTier {
    qty: i64,
    percent: f64,
}

/// Valid tiers of a product's volume-discount metafield. Products of one store usually share the same tier JSON, so each
/// distinct value is parsed once per run.
fn parse_volume_tiers(raw: &str) -> Option<Rc<[VolumeDiscountTier]>> {
    if let Some(cached) = VOLUME_TIERS.with(|cache| cache.borrow().get(raw).cloned()) {
        return cached;
    }
    let parsed: Option<Rc<[VolumeDiscountTier]>> = serde_json::from_str::<Vec<VolumeDiscountTier>>(raw)
        .ok()
        .map(|tiers| {
            tiers
                .into_iter()
                .filter(|tier| tier.qty > 0 && tier.percent.is_finite() && tier.percent >= 0.0)
                .collect::<Vec<_>>()
        })
        .filter(|tiers| !tiers.is_empty())
        .map(Rc::from);
    VOLUME_TIERS.with(|cache| cache.borrow_mut().insert(raw.to_string(), parsed.clone()));
    parsed
}

struct VolumeDiscountGroup {
    quantity: i64,
    subtotal_cents: i64,
    // One entry per line of the product, in cart order.
    tiers: Vec<&'static [VolumeDiscountTier]>,
}

pub fn run(input: Input) -> Result<schema::CartLinesDiscountsGenerateRunResult> {
    let input = std::mem::ManuallyDrop::new(input);
    // Never dropped: the wasm instance ends right after this run, so freeing the compiled config only burns instructions.
    let mut config = match parse_config(&input) {
        Some(c) => std::mem::ManuallyDrop::new(c),
        None => return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] }),
    };
    // The node's classes travel in the config (`dc`); absent means product + order.
    let has_class = |class: char| config.dc.as_deref().is_none_or(|classes| classes.contains(class));
    let (has_product_discount, has_order_discount) = (has_class('p'), has_class('o'));
    if !has_product_discount && !has_order_discount {
        return Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] });
    }
    config.usage = crate::usage::parse(
        input
            .cart()
            .buyer_identity()
            .as_ref()
            .and_then(|identity| identity.customer())
            .and_then(|customer| customer.usage())
            .map(|metafield| metafield.value().as_str()),
    );
    let currency = input.cart().cost().subtotal_amount().currency_code().to_string();
    PAGE_MATCH.with(|cache| cache.borrow_mut().clear());
    CART_VALUES.with(|cache| cache.borrow_mut().clear());
    QUALIFYING.with(|cache| cache.borrow_mut().clear());
    METADATA_CACHE.with(|cache| cache.borrow_mut().clear());
    PAGE_CLASSES.with(|classes| classes.borrow_mut().clear());
    VOLUME_TIERS.with(|cache| cache.borrow_mut().clear());
    LAST_METADATA.with(|last| *last.borrow_mut() = None);
    let _line_facts = LineFactsGuard::new(&input);
    ZERO_DECIMAL_CURRENCY.with(|flag| flag.set(is_zero_decimal(&currency)));
    config.localize(input.presentment_currency_rate().as_f64(), &currency);

    let mut offers: Vec<&CompiledOffer> = config.offers.iter().collect();
    crate::de::sort_by(&mut offers, |a, b| a.priority.cmp(&b.priority).then_with(|| a.id.cmp(&b.id)));

    #[cfg(feature = "code_gate")]
    let (entered, entered_hashes) = entered_codes(&input);
    #[cfg(feature = "code_gate")]
    let mut accepted: Vec<String> = Vec::new();

    let mut candidates: Vec<schema::ProductDiscountCandidate> = Vec::new();
    let mut order_candidates: Vec<schema::OrderDiscountCandidate> = Vec::new();
    // Only offers with a strictly lower priority (higher number) are blocked; equal-priority offers still apply.
    let mut stop_after_priority: Option<i32> = None;
    // Anchor units already used up by non-stacking gift offers, per cart line.
    let mut consumed: HashMap<String, i64> = HashMap::default();

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

        let anchors = if has_product_discount && (!offer.can_stack_with_gift_offers || !consumed.is_empty()) {
            gift_anchors(offer, &input)
        } else {
            None
        };
        if anchors.as_ref().is_some_and(|a| free_units(a, &consumed) < a.needed) {
            continue;
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
        let title = offer
            .cart_message
            .as_deref()
            .filter(|message| !message.is_empty())
            .or(offer.title.as_deref().filter(|title| !title.is_empty()));
        for candidate in &mut offer_candidates {
            let tier_message = candidate
                .message
                .as_deref()
                .and_then(|message| message.strip_prefix(TIER_MESSAGE_MARK))
                .map(str::to_string);
            candidate.message = match (title, tier_message) {
                (Some(title), Some(tier)) => {
                    let mut message = String::with_capacity(title.len() + tier.len() + 3);
                    message.push_str(title);
                    message.push_str(" \u{b7} ");
                    message.push_str(&tier);
                    Some(cap_message(message))
                }
                (None, Some(tier)) => Some(cap_message(tier)),
                (Some(title), None) => Some(cap_message(title.to_string())),
                (None, None) => candidate.message.take(),
            };
        }
        if let Some(title) = title {
            for candidate in &mut offer_order_candidates {
                candidate.message = Some(cap_message(title.to_string()));
            }
        }
        if !offer_candidates.is_empty() || !offer_order_candidates.is_empty() {
            if offer.stop_lower_priority {
                stop_after_priority = Some(offer.priority);
            }
            if let Some(anchors) = anchors.as_ref().filter(|_| !offer.can_stack_with_gift_offers) {
                consume(anchors, &mut consumed);
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
    let candidates = if config.merge_candidates { merge_adjacent_candidates(candidates) } else { candidates };

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
        return evaluate_quiz_bundle_reward(reward, input, offer);
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
    let set_limit = if is_free_landing_gift(reward) {
        Some(reward.max_quantity.unwrap_or(1))
    } else if reward.scope_mode == "landing" || reward.scope_mode == "tagged_offer" {
        reward.max_quantity
    } else {
        None
    }
    .map(|limit| cap_per_cart(offer, limit));
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
    // Matched once, not per line.
    let (landing_scope, tagged_scope) = (reward.scope_mode == "landing", reward.scope_mode == "tagged_offer");
    let purchase = PurchaseType::of(Some(reward.subscription_mode.as_str()));
    let mut eligible: Vec<&Lines> = input
        .cart()
        .lines()
        .iter()
        .filter(|line| !is_gift_line(line) && !is_zero_cost(line) && !outside_matched_lines(offer, line))
        .filter(|line| {
            !landing_scope
                || landing_source(line).as_deref()
                    == reward.required_line_attribute_value.as_deref()
        })
        .filter(|line| {
            !tagged_scope
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
                .map(|quantity| i64::from(quantity_of(line)) == quantity)
                .unwrap_or(true)
        })
        .filter(|line| purchase.allows(line))
        .filter(|line| {
            reward.required_line_attribute.as_ref().is_none_or(|attribute| {
                metadata_value(line, &attribute.key).as_deref() == Some(attribute.value.as_str())
            })
        })
        .collect();

    if eligible.is_empty() {
        return vec![];
    }
    crate::de::sort_by(&mut eligible, |a, b| crate::de::cmp_str(a.id(), b.id()));

    let total_quantity: i64 = if reward.count_rule == "unique" {
        eligible
            .iter()
            .filter_map(|line| variant_and_product_id(line).map(|(_, product_id)| product_id))
            .collect::<HashSet<_>>()
            .len() as i64
    } else {
        eligible
            .iter()
            .map(|line| i64::from(quantity_of(line)))
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

    let price_tier = reward
        .price_tiers
        .iter()
        .filter(|tier| total_quantity >= tier.quantity)
        .max_by_key(|tier| tier.quantity);
    let tier_target_price = price_tier.map(|tier| tier.target_price_per_unit);
    if !reward.price_tiers.is_empty() && tier_target_price.is_none() {
        return vec![];
    }

    let cheapest_first = reward.selection_mode == "cheapest" || reward.discount_type == "cheapest_item_free";
    let most_expensive_first = reward.selection_mode == "most_expensive"
        || reward.discount_type == "most_expensive_item_discount";
    if cheapest_first || most_expensive_first {
        crate::de::sort_by(&mut eligible, |a, b| {
            let ordering = line_price(a)
                .partial_cmp(&line_price(b))
                .unwrap_or(std::cmp::Ordering::Equal);
            (if cheapest_first { ordering } else { ordering.reverse() }).then(crate::de::cmp_str(a.id(), b.id()))
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
    // Per cart: one application is one discounted unit, or one pack of the matched tier. Landing
    // sets are already capped per product above.
    if let (Some(max), None) = (offer.max_per_cart, set_limit) {
        let pack = quantity_tier
            .map(|tier| tier.discounted_quantity.unwrap_or(tier.minimum_quantity))
            .or(price_tier.map(|tier| tier.quantity))
            .unwrap_or(1);
        remaining = remaining.min(max.saturating_mul(pack));
    }
    let mut candidates = Vec::new();
    let mut applied_by_product: HashMap<String, i64> = HashMap::default();
    let mut applied_by_variant: HashMap<String, i64> = HashMap::default();
    for line in eligible {
        if remaining <= 0 {
            break;
        }
        let mut quantity = i64::from(quantity_of(line)).min(remaining);
        if let Some(per_line) = reward.max_units_per_line {
            quantity = quantity.min(per_line);
        }
        let (variant_id, product_id) = variant_and_product_id(line).unwrap_or_default();
        if let Some(per_product) = per_product_cap {
            quantity = take_units(&mut applied_by_product, product_id.to_string(), per_product, quantity);
        }
        if let Some(per_variant) = per_variant_cap {
            quantity = take_units(&mut applied_by_variant, variant_id.to_string(), per_variant, quantity);
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
        let message = quantity_tier
            .and_then(|tier| tier.cart_message.as_deref().filter(|message| !message.is_empty()))
            .map_or_else(|| "Discount".to_string(), |message| format!("{TIER_MESSAGE_MARK}{message}"));
        candidates.push(make_candidate(
            line.id().clone(),
            quantity,
            discount_type,
            discount_value,
            &message,
        ));
    }
    candidates
}

const TIER_MESSAGE_MARK: &str = "\u{1}";
const MAX_MESSAGE_CHARS: usize = 64;

fn cap_message(message: String) -> String {
    // At most 64 bytes is at most 64 characters: nothing to cut, and no need to rebuild the string.
    if message.len() <= MAX_MESSAGE_CHARS {
        return message;
    }
    message.chars().take(MAX_MESSAGE_CHARS).collect()
}

/// Per-cart cap (`mpc`): only ever lowers a limit that already exists.
fn cap_per_cart(offer: &CompiledOffer, limit: i64) -> i64 {
    offer.max_per_cart.map_or(limit, |max| limit.min(max))
}

/// Grants up to `wanted` units against a per-key cap, remembering what was granted.
fn take_units(applied: &mut HashMap<String, i64>, key: String, cap: i64, wanted: i64) -> i64 {
    let granted = applied.entry(key).or_insert(0);
    let units = wanted.min((cap - *granted).max(0));
    *granted += units;
    units
}

fn is_free_landing_gift(reward: &CompiledProductReward) -> bool {
    reward.scope_mode == "landing"
        && reward.price_tiers.is_empty()
        && reward.quantity_tiers.is_empty()
        && (reward.discount_type == "free"
            || (reward.discount_type == "percentage" && reward.discount_value >= 100.0))
}

fn landing_anchor_qualifies(reward: &CompiledProductReward, input: &Input) -> bool {
    landing_anchor_lines(reward, input).is_some_and(|lines| {
        lines.iter().map(|line| i64::from(quantity_of(line))).sum::<i64>()
            >= reward.required_anchor_min_quantity
    })
}

fn landing_anchor_lines<'a>(reward: &CompiledProductReward, input: &'a Input) -> Option<Vec<&'a Lines>> {
    let required_source = reward.required_line_attribute_value.as_deref()?;
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
    Some(input
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
                .map(|(variant_id, _)| anchor_ids.contains(variant_id))
                .unwrap_or(false)
        })
        .filter(|line| {
            !reward.requires_anchor_subscription || has_selling_plan(line)
        })
        .collect())
}

/// Cart lines (id, quantity) whose units unlock a gift offer, and how many units unlocking takes.
struct Anchors {
    lines: Vec<(String, i64)>,
    needed: i64,
}

fn free_units(anchors: &Anchors, consumed: &HashMap<String, i64>) -> i64 {
    anchors
        .lines
        .iter()
        .map(|(id, quantity)| quantity - consumed.get(id).copied().unwrap_or(0))
        .sum()
}

/// Takes the units an unlocked offer needs from its anchors, in cart order.
fn consume(anchors: &Anchors, consumed: &mut HashMap<String, i64>) {
    let mut left = anchors.needed;
    for (id, quantity) in &anchors.lines {
        let used = consumed.entry(id.clone()).or_insert(0);
        let taken = left.min(quantity - *used).max(0);
        *used += taken;
        left -= taken;
    }
}

/// None when the offer is not a gift offer or has no identifiable anchor lines (it then never consumes or is gated).
fn gift_anchors(offer: &CompiledOffer, input: &Input) -> Option<Anchors> {
    if !offer.gift_rewards.is_empty() || offer.offer_type == "gift" {
        return product_gift_anchors(offer, input);
    }
    let reward = offer.product_rewards.iter().find(|reward| is_free_landing_gift(reward))?;
    Some(Anchors {
        lines: landing_anchor_lines(reward, input)?
            .into_iter()
            .map(|line| (line.id().clone(), i64::from(quantity_of(line))))
            .collect(),
        needed: reward.required_anchor_min_quantity,
    })
}

/// The non-gift lines the main condition's product requirements (and page conditions) qualify.
fn product_gift_anchors(offer: &CompiledOffer, input: &Input) -> Option<Anchors> {
    let product_lists = [&offer.required_product_ids, &offer.any_required_product_ids];
    let variant_lists = [&offer.required_variant_ids, &offer.any_required_variant_ids];
    let has_products = !offer.requirements.is_empty()
        || product_lists.iter().chain(&variant_lists).any(|ids| !ids.is_empty());
    if !has_products && offer.page_url_conditions.is_empty() {
        return None;
    }
    let purchase = PurchaseType::of(offer.subscription_mode.as_deref());
    let lines = input
        .cart()
        .lines()
        .iter()
        .filter(|line| quantity_of(line) > 0 && !is_gift_line(line))
        .filter(|line| purchase.allows(line))
        .filter(|line| offer.page_url_conditions.is_empty() || added_from_matching_page(line, offer))
        .filter(|line| {
            let Some((variant_id, product_id)) = variant_and_product_id(line) else {
                return false;
            };
            !offer.excluded_product_ids.iter().any(|id| id == product_id)
                && (!has_products
                    || offer.requirements.iter().any(|requirement| {
                        if requirement.track_mode == "variant" {
                            requirement.variant_id.as_deref() == Some(variant_id)
                        } else {
                            requirement.product_id.as_deref() == Some(product_id)
                        }
                    })
                    || product_lists.iter().any(|ids| ids.iter().any(|id| id == product_id))
                    || variant_lists.iter().any(|ids| ids.iter().any(|id| id == variant_id)))
        })
        .map(|line| (line.id().clone(), i64::from(quantity_of(line))))
        .collect();
    Some(Anchors {
        lines,
        needed: offer.requirements.iter().map(|requirement| requirement.min_quantity).sum::<i64>().max(1),
    })
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
    offer: &CompiledOffer,
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

    // Output order depends on this BTreeMap being ordered. Do not turn it into a HashMap (see de::tests::hash_collections_are_never_iterated).
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
    let mut bundles = 0;
    for (_bundle_id, group) in groups {
        let Some(expected_paid_count) = group.expected_paid_count else {
            continue;
        };
        if group.paid.len() < expected_paid_count {
            continue;
        }
        if offer.max_per_cart.is_some_and(|max| bundles >= max) {
            break;
        }
        bundles += 1;
        // Free gifts follow the same set rule: at most `maxQuantity` (default 1) units per gift product.
        let mut gift_units_by_product: HashMap<String, i64> = HashMap::default();
        for line in group.gifts {
            let product_id = variant_and_product_id(line).unwrap_or_default().1;
            let quantity = take_units(
                &mut gift_units_by_product,
                product_id.to_string(),
                cap_per_cart(offer, reward.max_quantity.unwrap_or(1)),
                i64::from(quantity_of(line)),
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
            .map(|line| subtotal_of(line))
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
    // and tier thresholds all work off the same (eligible) subtotal. A reward's
    // purchase type (subscriptionMode) removes the lines of the other type too.
    let active_currency = input
        .cart()
        .cost()
        .subtotal_amount()
        .currency_code()
        .to_string();

    offer
        .order_rewards
        .iter()
        .filter_map(|reward| {
            let purchase = PurchaseType::of(Some(reward.subscription_mode.as_str()));
            let (eligible_lines, excluded_lines): (Vec<&Lines>, Vec<&Lines>) =
                input.cart().lines().iter().partition(|line| {
                    !is_gift_line(line) && !outside_matched_lines(offer, line) && purchase.allows(line)
                });
            if eligible_lines.is_empty() && reward.subscription_mode != "any" {
                return None;
            }
            let excluded_line_ids: Vec<String> =
                excluded_lines.iter().map(|line| line.id().clone()).collect();
            let qualifying_subtotal_cents: i64 = eligible_lines
                .iter()
                .map(|line| {
                    to_cents(
                        subtotal_of(line),
                        &active_currency,
                    )
                })
                .sum();
            let qualifying_quantity: i64 = eligible_lines
                .iter()
                .filter(|line| !is_zero_cost(line))
                .map(|line| i64::from(quantity_of(line)))
                .sum();
            make_order_candidate(
                reward,
                excluded_line_ids,
                qualifying_subtotal_cents,
                qualifying_quantity,
            )
        })
        .collect()
}

#[derive(Clone, Copy)]
enum PurchaseType {
    Any,
    SubscriptionOnly,
    OneTimeOnly,
}

impl PurchaseType {
    fn of(mode: Option<&str>) -> Self {
        match mode {
            Some("subscription_only") => Self::SubscriptionOnly,
            Some("one_time_only") => Self::OneTimeOnly,
            _ => Self::Any,
        }
    }

    fn allows(self, line: &Lines) -> bool {
        match self {
            Self::SubscriptionOnly => has_selling_plan(line),
            Self::OneTimeOnly => !has_selling_plan(line),
            Self::Any => true,
        }
    }
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

/// Units of an untagged line that qualify the offer (anchor): never counted as its own gift.
fn reserved_anchor_units(offer: &CompiledOffer, variant_id: &str, product_id: &str) -> i64 {
    let required = offer
        .requirements
        .iter()
        .filter(|r| {
            if r.track_mode == "variant" {
                r.variant_id.as_deref() == Some(variant_id)
            } else {
                r.product_id.as_deref() == Some(product_id)
            }
        })
        .map(|r| r.min_quantity)
        .max()
        .unwrap_or(0);
    let listed = [&offer.required_product_ids, &offer.any_required_product_ids]
        .iter()
        .any(|ids| ids.iter().any(|id| id == product_id))
        || [&offer.required_variant_ids, &offer.any_required_variant_ids]
            .iter()
            .any(|ids| ids.iter().any(|id| id == variant_id));
    required.max(i64::from(listed))
}

/// Gift offer: discount (to free, or the configured value) the line(s) this
/// offer's runtime tagged as its gift, plus untagged lines (added by the theme) of a
/// configured gift variant, but only if the variant is actually in this offer's allowed
/// gift list — protects against a buyer editing cart line properties to claim an
/// unrelated product as "the gift".
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
        let mut applied_by_product: HashMap<String, i64> = HashMap::default();
        let mut applied_by_reward: HashMap<String, i64> = HashMap::default();
        let mut candidates = Vec::new();
        let tier_cut = gift_tier_cut(offer, input);

        // Tagged lines claim the quota first; untagged lines (a theme adding the gift itself) fill
        // what is left, so a variant only ever counts as a gift of an offer that qualifies.
        // A line no reward targets never yields a candidate in either pass, so only the targeted lines are walked.
        let targeted: Vec<(&Lines, &str, &str)> = input
            .cart()
            .lines()
            .iter()
            .filter_map(|line| {
                let (variant_id, product_id) = variant_and_product_id(line)?;
                offer
                    .gift_rewards
                    .iter()
                    .any(|reward| gift_target_matches(reward, variant_id, product_id))
                    .then_some((line, variant_id, product_id))
            })
            .collect();
        for tagged_pass in [true, false] {
            for &(line, variant_id, product_id) in &targeted {
                let mut line_quantity = i64::from(quantity_of(line));
                let tagged = line_type(line).as_deref() == Some(LINE_TYPE_GIFT)
                    && line_offer_id(line).as_deref() == Some(offer.id.as_str());
                if line_quantity <= 0
                    || tagged != tagged_pass
                    || (!tagged && (line_offer_id(line).is_some() || is_gift_line(line)))
                {
                    continue;
                }
                if !tagged {
                    line_quantity -= reserved_anchor_units(offer, variant_id, product_id);
                }
                let reward_id = line_reward_id(line);
                for reward in offer
                    .gift_rewards
                    .iter()
                    .filter(|reward| !tagged || reward_id.as_deref() == Some(reward.id.as_str()))
                    .filter(|reward| gift_tier_unlocked(reward, tier_cut))
                {
                    if !gift_target_matches(reward, variant_id, product_id) {
                        continue;
                    }
                    let limit = cap_per_cart(offer, reward.max_quantity);
                    let mut quantity = take_units(
                        &mut applied_by_product,
                        reward.id.clone() + product_id,
                        limit,
                        line_quantity,
                    );
                    // A picker (choose K of N) grants selectionCount x limit units across ALL its
                    // gifts, so adding every option via /cart/add frees only the first lines in cart
                    // order (the ones the shopper added first); the rest are charged.
                    if reward.selectable || reward.target_variant_ids.len() > 1 {
                        quantity = take_units(
                            &mut applied_by_reward,
                            reward.id.clone(),
                            reward.selection_count.unwrap_or(1) * limit,
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
                    break;
                }
            }
        }
        return candidates;
    }

    vec![]
}

fn gift_target_matches(reward: &CompiledGiftReward, variant_id: &str, product_id: &str) -> bool {
    if !reward.target_variant_ids.is_empty() {
        reward.target_variant_ids.iter().any(|id| id == variant_id)
    } else {
        reward.target_product_ids.iter().any(|id| id == product_id)
    }
}

/// (cart value, lowest threshold still granted). None when no gift reward has a tier: every reward is granted.
fn gift_tier_cut(offer: &CompiledOffer, input: &Input) -> Option<(i64, i64)> {
    if offer.gift_rewards.iter().all(|reward| reward.min_cart_subtotal_cents.is_none()) {
        return None;
    }
    let cart_value = cart_value_cents(&qualifying_lines(offer, input), input);
    let floor = if offer.tier_mode.as_deref() == Some("h") {
        offer
            .gift_rewards
            .iter()
            .filter_map(|reward| reward.min_cart_subtotal_cents)
            .filter(|threshold| *threshold <= cart_value)
            .max()
            .unwrap_or(0)
    } else {
        0
    };
    Some((cart_value, floor))
}

fn gift_tier_unlocked(reward: &CompiledGiftReward, cut: Option<(i64, i64)>) -> bool {
    // A gift without a threshold is always granted, even in "highest" mode (which only ranks the gifts that have one).
    let Some(threshold) = reward.min_cart_subtotal_cents else { return true };
    cut.is_none_or(|(cart_value, floor)| threshold <= cart_value && threshold >= floor)
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
                    cap_per_cart(offer, i64::from(quantity_of(line))),
                    &offer.discount_type,
                    offer.discount_value,
                    "Most expensive item discount",
                )],
                None => vec![],
            }
        }
        "percentage" | "fixed_amount" => {
            let mut left = cap_per_cart(offer, i64::MAX);
            let mut candidates = Vec::new();
            for line in eligible {
                if left <= 0 {
                    break;
                }
                let quantity = i64::from(quantity_of(line)).min(left);
                left -= quantity;
                candidates.push(make_candidate(
                    line.id().clone(),
                    quantity,
                    &offer.discount_type,
                    offer.discount_value,
                    "Discount applied",
                ));
            }
            candidates
        }
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
    !excluded_set.contains(product_id)
        && (required_set.is_empty() || required_set.contains(product_id))
}

/// The non-gift lines an offer's cart thresholds count (its excluded products never do).
fn qualifying_lines<'a>(offer: &CompiledOffer, input: &'a Input) -> Vec<&'a Lines> {
    let all_lines = input.cart().lines();
    let cached = QUALIFYING.with(|cache| {
        cache
            .borrow()
            .iter()
            .find(|(excluded, _)| *excluded == offer.excluded_product_ids)
            .map(|(_, slots)| slots.iter().map(|&slot| &all_lines[slot]).collect::<Vec<_>>())
    });
    if let Some(lines) = cached {
        return lines;
    }
    let lines = compute_qualifying_lines(offer, input);
    let slots: Option<Vec<usize>> = lines.iter().map(|line| line_slot(line)).collect();
    if let Some(slots) = slots {
        QUALIFYING.with(|cache| {
            let mut cache = cache.borrow_mut();
            if cache.len() < 8 {
                cache.push((offer.excluded_product_ids.clone(), slots));
            }
        });
    }
    lines
}

fn compute_qualifying_lines<'a>(offer: &CompiledOffer, input: &'a Input) -> Vec<&'a Lines> {
    let excluded_products: HashSet<&str> = offer
        .excluded_product_ids
        .iter()
        .map(String::as_str)
        .collect();
    input
        .cart()
        .lines()
        .iter()
        .filter(|line| quantity_of(line) > 0 && !is_gift_line(line))
        .filter(|line| {
            variant_and_product_id(line)
                .map(|(_, product_id)| !excluded_products.contains(product_id))
                .unwrap_or(false)
        })
        .collect()
}

fn cart_value_cents(lines: &[&Lines], input: &Input) -> i64 {
    let slots: Option<Vec<usize>> = lines.iter().map(|line| line_slot(line)).collect();
    let Some(slots) = slots else {
        return compute_cart_value_cents(lines, input);
    };
    let cached = CART_VALUES.with(|cache| cache.borrow().iter().find(|(key, _)| *key == slots).map(|(_, cents)| *cents));
    if let Some(cents) = cached {
        return cents;
    }
    let cents = compute_cart_value_cents(lines, input);
    CART_VALUES.with(|cache| {
        let mut cache = cache.borrow_mut();
        if cache.len() < 8 {
            cache.push((slots, cents));
        }
    });
    cents
}

fn compute_cart_value_cents(lines: &[&Lines], input: &Input) -> i64 {
    let active_currency = input.cart().cost().subtotal_amount().currency_code();
    let zero_decimal = is_zero_decimal(active_currency);
    let raw_cart_value_cents: i64 = lines
        .iter()
        .map(|line| to_cents_in(subtotal_of(line), zero_decimal))
        .sum();
    // Discount Functions execute concurrently, so the input does not
    // contain discounts emitted by the store's separate volume-discount
    // Function. Mirror only its qualification math here; this Function
    // still emits no volume-discount candidate of its own.
    (raw_cart_value_cents - projected_volume_discount_cents(lines, zero_decimal)).max(0)
}

/// Cart value / cart quantity / required-product checks, evaluated against the
/// current cart at checkout time — the merchant may have edited the offer, or
/// the cart may have changed, since the storefront runtime's own evaluation.
fn check_main_condition(offer: &CompiledOffer, input: &Input, config: &CompiledConfig) -> bool {
    let identified = input
        .cart()
        .buyer_identity()
        .as_ref()
        .is_some_and(|identity| identity.customer().is_some());
    if crate::usage::customer_blocked(
        &config.usage,
        &offer.id,
        offer.max_per_customer,
        offer.require_identified,
        identified,
    ) {
        return false;
    }
    let non_gift_lines = qualifying_lines(offer, input);

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
            .map(|line| i64::from(quantity_of(line)))
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
        let cart_value = cart_value_cents(&non_gift_lines, input);
        if cart_value < threshold_cents {
            return false;
        }
        if let Some(maximum) = offer.cart_value_max_cents {
            if cart_value > maximum {
                return false;
            }
        }
    }

    if let Some(threshold_qty) = offer.cart_quantity_threshold {
        let cart_qty: i64 = non_gift_lines
            .iter()
            .filter(|line| !is_zero_cost(line))
            .map(|line| quantity_of(line) as i64)
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
        let purchase = PurchaseType::of(Some(subscription_mode));
        let has_matching_line = non_gift_lines.iter().any(|line| purchase.allows(line));
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
                        requirement.variant_id.as_deref() == Some(variant_id)
                    } else {
                        requirement.product_id.as_deref() == Some(product_id)
                    }
                })
                .map(|(line, _)| i64::from(quantity_of(line)))
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
                    required_products.contains(product_id)
                        || required_variants.contains(variant_id)
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
                    any_products.contains(product_id)
                        || any_variants.contains(variant_id)
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
    // Index of the first line with an id. A handful of candidates is cheaper to scan than to hash every id.
    let mut index_by_id: HashMap<&str, usize> = HashMap::default();
    if candidates.len() >= 8 {
        index_by_id.reserve(lines.len());
        for (index, line) in lines.iter().enumerate() {
            index_by_id.entry(line.id().as_str()).or_insert(index);
        }
    }
    let line_index = |id: &str| {
        if index_by_id.is_empty() {
            lines.iter().position(|line| line.id() == id)
        } else {
            index_by_id.get(id).copied()
        }
    };
    // (line index, saving) for single-line candidates; None passes through untouched.
    let savings: Vec<Option<(usize, f64)>> = candidates
        .iter()
        .map(|candidate| {
            let [schema::ProductDiscountCandidateTarget::CartLine(target)] = candidate.targets.as_slice() else {
                return None;
            };
            let index = line_index(target.id.as_str())?;
            let quantity = f64::from(target.quantity.unwrap_or(1));
            let saving = match &candidate.value {
                schema::ProductDiscountCandidateValue::Percentage(pct) => {
                    pct.value.0 * line_price(&lines[index]) * quantity
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

/// Folds each maximal run of adjacent percentage candidates that differ only in their targets into one candidate with
/// the concatenated targets (each keeps its quantity): the discount every line gets is unchanged and the output, which
/// is paid for per candidate, shrinks. Non-adjacent candidates are never merged (the order decides which candidate
/// Shopify applies to a line) and neither are fixed amounts (a fixed amount is not equivalent across targets).
fn merge_adjacent_candidates(
    candidates: Vec<schema::ProductDiscountCandidate>,
) -> Vec<schema::ProductDiscountCandidate> {
    let mut merged: Vec<schema::ProductDiscountCandidate> = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        match merged.last_mut() {
            Some(last) if same_percentage_candidate(last, &candidate) => last.targets.extend(candidate.targets),
            _ => merged.push(candidate),
        }
    }
    merged
}

fn same_percentage_candidate(a: &schema::ProductDiscountCandidate, b: &schema::ProductDiscountCandidate) -> bool {
    let (
        schema::ProductDiscountCandidateValue::Percentage(left),
        schema::ProductDiscountCandidateValue::Percentage(right),
    ) = (&a.value, &b.value)
    else {
        return false;
    };
    left.value.0.to_bits() == right.value.0.to_bits()
        && a.message == b.message
        && a.associated_discount_code.as_ref().map(|code| &code.code) == b.associated_discount_code.as_ref().map(|code| &code.code)
        && a.prerequisites.is_none()
        && b.prerequisites.is_none()
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
                    quantity: Some(quantity_of(line)),
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
    subtotal_of(line) / f64::from(quantity_of(line).max(1))
}

fn is_one_of(line: &Lines, product_ids: &HashSet<&str>, variant_ids: &HashSet<&str>) -> bool {
    variant_and_product_id(line)
        .map(|(variant_id, product_id)| {
            variant_ids.contains(variant_id) || product_ids.contains(product_id)
        })
        .unwrap_or(false)
}

fn variant_and_product_id(line: &Lines) -> Option<(&str, &str)> {
    match line.merchandise() {
        Merchandise::ProductVariant(variant) => Some((variant.id().as_str(), variant.product().id().as_str())),
        Merchandise::Other => None,
    }
}

fn line_type(line: &Lines) -> Option<&str> {
    facts(line).packed(line).line_type.as_deref()
}

// A $0 line (another app's free gift) is not a paid unit: it must not raise a quantity tier,
// consume a unit cap or be picked as the cheapest item.
fn is_zero_cost(line: &Lines) -> bool {
    subtotal_of(line) <= 0.0
}

fn is_gift_line(line: &Lines) -> bool {
    with_facts(line, |facts| facts.packed(line).gift)
}

fn line_offer_id(line: &Lines) -> Option<&str> {
    let facts = facts(line);
    facts
        .offer_id
        .get_or_init(|| metadata_value(line, "_promo_engine_offer_id"))
        .as_deref()
}

fn line_reward_id(line: &Lines) -> Option<&str> {
    let facts = facts(line);
    facts
        .reward_id
        .get_or_init(|| metadata_value(line, "_promo_engine_reward_id"))
        .as_deref()
}

fn projected_volume_discount_cents(lines: &[&Lines], zero_decimal: bool) -> i64 {
    // Ordered on purpose: keep BTreeMap (a HashMap here would make the result order-dependent).
    let mut groups: BTreeMap<&str, VolumeDiscountGroup> = BTreeMap::new();
    for line in lines {
        let facts = facts(line);
        let (Some((_, product_id)), Some(tiers)) = (variant_and_product_id(line), facts.volume_tiers(line)) else {
            continue;
        };
        let subtotal_cents = to_cents_in(facts.subtotal(line), zero_decimal);
        if subtotal_cents <= 0 {
            continue;
        }
        let group = groups.entry(product_id).or_insert_with(|| VolumeDiscountGroup {
            quantity: 0,
            subtotal_cents: 0,
            tiers: vec![],
        });
        group.quantity += i64::from(facts.quantity(line));
        group.subtotal_cents += subtotal_cents;
        group.tiers.push(tiers);
    }

    groups
        .values()
        .filter_map(|group| {
            group
                .tiers
                .iter()
                .flat_map(|tiers| tiers.iter())
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

fn landing_source(line: &Lines) -> Option<&str> {
    facts(line).landing_source(line).map(String::as_str)
}

fn has_selling_plan(line: &Lines) -> bool {
    with_facts(line, |facts| facts.subscription(line))
}

/// The storefront stamps each line with the page it was added from, plus the
/// session's last UTM landing URL (`source: "landing"` conditions read that).
fn added_from_matching_page(line: &Lines, offer: &CompiledOffer) -> bool {
    let matches = || metadata_matches(metadata_map(line).as_deref(), &offer.page_url_conditions);
    if line_slot(line).is_none() {
        return matches();
    }
    let class = with_facts(line, |facts| facts.packed(line).page_class);
    let cached = PAGE_MATCH.with(|cache| {
        cache
            .borrow()
            .get(&offer.page_set_key)
            .and_then(|classes| classes.get(class).copied().flatten())
    });
    if let Some(matched) = cached {
        return matched;
    }
    let matched = matches();
    PAGE_MATCH.with(|cache| {
        let mut cache = cache.borrow_mut();
        let classes = cache.entry(offer.page_set_key).or_default();
        if classes.len() <= class {
            classes.resize(class + 1, None);
        }
        classes[class] = Some(matched);
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

fn metadata_value(line: &Lines, key: &str) -> Option<String> {
    with_facts(line, |facts| facts.packed(line).metadata.as_deref()?.get(key).cloned())
}

fn metadata_map(line: &Lines) -> Option<Rc<LineMetadata>> {
    with_facts(line, |facts| facts.packed(line).metadata.clone())
}

/// The values of `PAGE_STAMP_KEYS`: lines with equal stamps always match the same page conditions.
type PageStamps = [Option<String>; PAGE_STAMP_KEYS.len()];

/// Parses a line's packed metadata and classifies its page stamps; lines carrying the same raw metadata (the
/// common case: every line added from one page) share one parse.
fn parse_line_metadata(raw: Option<&String>) -> (Option<Rc<LineMetadata>>, usize) {
    // Consecutive lines usually carry the identical string: comparing it is cheaper than hashing it.
    let Some(raw) = raw else { return parse_line_metadata_shared(None) };
    if let Some(hit) = LAST_METADATA.with(|last| last.borrow().as_ref().filter(|(known, _)| known == raw).map(|(_, parsed)| parsed.clone())) {
        return hit;
    }
    let parsed = parse_line_metadata_shared(Some(raw));
    LAST_METADATA.with(|last| *last.borrow_mut() = Some((raw.clone(), parsed.clone())));
    parsed
}

fn parse_line_metadata_shared(raw: Option<&String>) -> (Option<Rc<LineMetadata>>, usize) {
    if let Some(cached) = raw.and_then(|raw| METADATA_CACHE.with(|cache| cache.borrow().get(raw.as_str()).cloned())) {
        return cached;
    }
    let metadata = raw.and_then(|raw| serde_json::from_str::<LineMetadata>(raw).ok()).map(Rc::new);
    let stamps: Option<PageStamps> = metadata
        .as_deref()
        .map(|map| PAGE_STAMP_KEYS.map(|key| map.get(key).cloned()));
    let class = PAGE_CLASSES.with(|classes| {
        let mut classes = classes.borrow_mut();
        classes.iter().position(|known| *known == stamps).unwrap_or_else(|| {
            classes.push(stamps);
            classes.len() - 1
        })
    });
    if let Some(raw) = raw {
        METADATA_CACHE.with(|cache| cache.borrow_mut().insert(raw.clone(), (metadata.clone(), class)));
    }
    (metadata, class)
}

fn compute_packed_facts(line: &Lines) -> PackedFacts {
    let (metadata, page_class) = parse_line_metadata(
        line.promo_metadata().as_ref().and_then(|attribute| attribute.value()),
    );
    let packed = |key: &str| metadata.as_deref().and_then(|map| map.get(key));
    let line_type = line
        .line_type()
        .as_ref()
        .and_then(|attribute| attribute.value())
        .or_else(|| packed("_promo_engine_line_type"))
        .cloned();
    let gift = line_type.as_deref() == Some(LINE_TYPE_GIFT)
        || packed("__cart_gift_tier").is_some()
        || packed("_quiz_free_gift").map(String::as_str) == Some("true");
    PackedFacts { metadata, page_class, line_type, gift }
}

/// Position of `line` in this run's cart lines, or None for a `Lines` that is not from it.
fn line_slot(line: &Lines) -> Option<usize> {
    let (base, len) = LINES_SPAN.with(Cell::get);
    let offset = (std::ptr::from_ref(line) as usize).checked_sub(base)?;
    let size = std::mem::size_of::<Lines>();
    (offset % size == 0 && offset / size < len).then_some(offset / size)
}

/// The line's facts for the rest of the run. A `Lines` outside the run's slice (never in production) gets throwaway facts.
fn facts(line: &Lines) -> &'static LineFacts {
    match line_slot(line) {
        Some(slot) => &LINE_FACTS.with(Cell::get)[slot],
        None => Box::leak(Box::default()),
    }
}

fn with_facts<R>(line: &Lines, read: impl FnOnce(&LineFacts) -> R) -> R {
    match line_slot(line) {
        Some(slot) => read(&LINE_FACTS.with(Cell::get)[slot]),
        None => read(&LineFacts::default()),
    }
}

fn quantity_of(line: &Lines) -> i32 {
    with_facts(line, |facts| facts.quantity(line))
}

fn subtotal_of(line: &Lines) -> f64 {
    with_facts(line, |facts| facts.subtotal(line))
}

/// Sizes the per-line facts for one run and forgets the lines' address when the run ends.
struct LineFactsGuard;

impl LineFactsGuard {
    fn new(input: &Input) -> Self {
        let lines = input.cart().lines();
        let facts: Vec<LineFacts> = lines.iter().map(|_| LineFacts::default()).collect();
        LINE_FACTS.with(|slot| slot.set(Box::leak(facts.into_boxed_slice())));
        LINES_SPAN.with(|span| span.set((lines.as_ptr() as usize, lines.len())));
        LineFactsGuard
    }
}

impl Drop for LineFactsGuard {
    fn drop(&mut self) {
        LINES_SPAN.with(|span| span.set((0, 0)));
        LINE_FACTS.with(|slot| slot.set(&[]));
        PAGE_MATCH.with(|cache| cache.borrow_mut().clear());
        CART_VALUES.with(|cache| cache.borrow_mut().clear());
        QUALIFYING.with(|cache| cache.borrow_mut().clear());
        METADATA_CACHE.with(|cache| cache.borrow_mut().clear());
        PAGE_CLASSES.with(|classes| classes.borrow_mut().clear());
        VOLUME_TIERS.with(|cache| cache.borrow_mut().clear());
        LAST_METADATA.with(|last| *last.borrow_mut() = None);
    }
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
    use crate::de::run_function_with_input;
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
        // The node's classes travel in the config as `dc` ("p" product, "o" order).
        let mut config: Value = serde_json::from_str(config_json).unwrap();
        config["dc"] = Value::String(
            [("PRODUCT", 'p'), ("ORDER", 'o')]
                .into_iter()
                .filter(|(class, _)| discount_classes.contains(class))
                .map(|(_, letter)| letter)
                .collect(),
        );
        format!(
            r#"{{
                "discount": {{
                    "metafield": {{ "value": {config} }}
                }},
                "cart": {{
                    "lines": {lines},
                    "cost": {{ "subtotalAmount": {{ "amount": "{subtotal}", "currencyCode": "USD" }} }}
                }},
                "presentmentCurrencyRate": "1.0",
                "localization": {{ "country": {{ "isoCode": "US" }} }}
            }}"#,
            config = serde_json::to_string(&config.to_string()).unwrap(),
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
        let subtotal = format!("{:.2}", price.parse::<f64>().unwrap() * qty as f64);
        format!(
            r#"{{
                "id": "{id}", "quantity": {qty},
                "cost": {{
                    "subtotalAmount": {{ "amount": "{subtotal}", "currencyCode": "USD" }}
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
        _unit_price: &str,
        subtotal: &str,
        qty: i64,
        tiers_json: &str,
    ) -> String {
        let encoded_tiers = serde_json::to_string(tiers_json).unwrap();
        format!(
            r#"{{
                "id": "{id}", "quantity": {qty},
                "cost": {{
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

    /// Parity with `evaluateCartValue` in the rule engine: a zero-decimal shop stores whole units, the cart is in whole units.
    /// Keep the numbers in sync with packages/rule-engine/src/evaluator.zero-decimal.test.ts.
    #[test]
    fn zero_decimal_shop_threshold_is_whole_units_and_converts_through_minor_units() {
        let run_cart = |currency: &str, rate: &str, amount: &str| {
            let lines = format!(
                "[{},{}]",
                regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", amount, 1),
                gift_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/gift-v1", "gid://shopify/Product/gift-p1", "offer-1", "0.00", 1),
            );
            let config = gift_offer_config(5000, 1).replace(r#""currencyCode":"USD""#, r#""currencyCode":"JPY""#);
            let payload = cart_json(&lines, amount, &config)
                .replace("\"currencyCode\": \"USD\"", &format!("\"currencyCode\": \"{currency}\""))
                .replace("\"presentmentCurrencyRate\": \"1.0\"", &format!("\"presentmentCurrencyRate\": \"{rate}\""));
            run_function_with_input(run, &payload).unwrap().operations.len()
        };
        // JPY shop, JPY cart: 5000 means 5,000 yen.
        assert_eq!(run_cart("JPY", "1.0", "5000"), 1);
        assert_eq!(run_cart("JPY", "1.0", "4999"), 0);
        // JPY shop, USD market at 0.0067 USD/JPY: 5,000 yen is 33.50 USD.
        assert_eq!(run_cart("USD", "0.0067", "34.00"), 1);
        assert_eq!(run_cart("USD", "0.0067", "33.00"), 0);
    }

    #[test]
    fn line_facts_are_indexed_by_cart_position_and_scoped_to_the_run() {
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "60.00", 1),
            gift_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/gift-v1", "gid://shopify/Product/gift-p1", "offer-1", "20.00", 1),
        );
        let payload = cart_json(&lines, "80.00", &gift_offer_config(5000, 1));
        run_function_with_input(
            |input: Input| {
                {
                    let _facts = LineFactsGuard::new(&input);
                    let lines = input.cart().lines();
                    let slots: Vec<_> = lines.iter().map(line_slot).collect();
                    assert_eq!(slots, vec![Some(0), Some(1)]);
                    let gifts: Vec<_> = lines.iter().map(is_gift_line).collect();
                    assert_eq!(gifts, vec![false, true]);
                    assert!(compute_packed_facts(&lines[1]).gift);
                    assert_eq!(LineFacts::default().quantity(&lines[1]), 1);
                    assert_eq!(line_type(&lines[1]).as_deref(), Some(LINE_TYPE_GIFT));
                }
                assert_eq!(line_slot(&input.cart().lines()[0]), None);
                Ok(schema::CartLinesDiscountsGenerateRunResult { operations: vec![] })
            },
            &payload,
        )
        .expect("should not error");
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
    fn products_sharing_tier_json_are_projected_per_product() {
        let tiers = r#"[{"qty":3,"percent":20}]"#;
        let lines = format!(
            "[{},{},{},{}]",
            volume_discount_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "29.69", "89.07", 3, tiers),
            volume_discount_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/v2", "gid://shopify/Product/p2", "29.69", "89.07", 3, tiers),
            // Same product as line 1: its two lines form one group of 4 units.
            volume_discount_line("gid://shopify/CartLine/3", "gid://shopify/ProductVariant/v3", "gid://shopify/Product/p1", "10.00", "10.00", 1, tiers),
            gift_line("gid://shopify/CartLine/4", "gid://shopify/ProductVariant/gift-v1", "gid://shopify/Product/gift-p1", "offer-1", "20.00", 1),
        );
        // p1: 99.07 less 20% (19.81) + p2: 89.07 less 20% (17.81) = 150.52.
        let granted = |threshold: i64| {
            run_function_with_input(run, &cart_json(&lines, "208.14", &gift_offer_config(threshold, 1)))
                .expect("should not error")
                .operations
                .len()
        };
        assert_eq!(granted(15052), 1);
        assert_eq!(granted(15053), 0);
    }

    #[test]
    fn volume_tiers_are_parsed_once_per_distinct_json() {
        let first = parse_volume_tiers(r#"[{"qty":2,"percent":10},{"qty":0,"percent":5}]"#).expect("valid tiers");
        let again = parse_volume_tiers(r#"[{"qty":2,"percent":10},{"qty":0,"percent":5}]"#).expect("valid tiers");
        assert!(Rc::ptr_eq(&first, &again));
        assert_eq!(first.len(), 1, "a tier without a positive quantity is dropped");
        assert!(parse_volume_tiers("not json").is_none());
        assert!(parse_volume_tiers("[]").is_none());
        assert!(parse_volume_tiers("[]").is_none(), "a cached rejection stays a rejection");
    }

    #[test]
    fn identical_line_metadata_shares_one_parse() {
        let page_a = r#"{"_promo_page_url":"/a"}"#.to_string();
        let page_b = r#"{"_promo_page_url":"/b"}"#.to_string();
        let first = parse_line_metadata(Some(&page_a));
        let again = parse_line_metadata(Some(&page_a));
        assert!(Rc::ptr_eq(first.0.as_ref().unwrap(), again.0.as_ref().unwrap()));
        let other = parse_line_metadata(Some(&page_b));
        assert_ne!(other.1, first.1, "different page stamps are different classes");
        // `page_a` is no longer the most recent string: it is found through the shared cache.
        let back = parse_line_metadata(Some(&page_a));
        assert!(Rc::ptr_eq(first.0.as_ref().unwrap(), back.0.as_ref().unwrap()));
        assert_eq!(back.1, first.1);
        assert!(parse_line_metadata(None).0.is_none());
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

    fn flavor_trigger_config(trigger_fields: &str) -> String {
        format!(
            r#"{{"offers":[{{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            {trigger_fields},
            "productRewards":[{{
                "id":"reward-1","rewardType":"product_discount","targetProductIds":[],
                "targetVariantIds":["gid://shopify/ProductVariant/target"],"discountType":"percentage",
                "discountValue":25,"subscriptionMode":"any"
            }}],"orderRewards":[]
        }}]}}"#
        )
    }

    fn flavor_cart(flavor: Option<u32>) -> String {
        let mut lines = Vec::new();
        if let Some(n) = flavor {
            lines.push(regular_line(
                "gid://shopify/CartLine/1",
                &format!("gid://shopify/ProductVariant/flavor-{n}"),
                &format!("gid://shopify/Product/flavor-{n}"),
                "30.00",
                1,
            ));
        }
        lines.push(regular_line(
            "gid://shopify/CartLine/2",
            "gid://shopify/ProductVariant/target",
            "gid://shopify/Product/target",
            "20.00",
            1,
        ));
        format!("[{}]", lines.join(","))
    }

    #[test]
    fn any_of_trigger_qualifies_on_one_of_six_flavors_while_all_of_requires_every_one() {
        let ids: Vec<String> = (0..6).map(|n| format!("gid://shopify/ProductVariant/flavor-{n}")).collect();
        let any_of = flavor_trigger_config(&format!(
            r#""requirements":[],"anyRequiredVariantIds":{}"#,
            serde_json::to_string(&ids).unwrap()
        ));
        let all_of = flavor_trigger_config(&format!(
            r#""requirements":{}"#,
            serde_json::to_string(
                &ids.iter()
                    .map(|id| serde_json::json!({"variantId": id, "trackMode": "variant", "minQuantity": 1}))
                    .collect::<Vec<_>>()
            )
            .unwrap()
        ));

        let one_flavor = flavor_cart(Some(3));
        let none = flavor_cart(None);

        let result = run_function_with_input(run, &cart_json(&one_flavor, "50.00", &any_of)).expect("should not error");
        assert!(
            matches!(result.operations.first(), Some(schema::CartOperation::ProductDiscountsAdd(_))),
            "any-of must qualify on a single flavor"
        );

        let result = run_function_with_input(run, &cart_json(&none, "20.00", &any_of)).expect("should not error");
        assert!(result.operations.is_empty(), "any-of must not qualify with no flavor in the cart");

        let result = run_function_with_input(run, &cart_json(&one_flavor, "50.00", &all_of)).expect("should not error");
        assert!(result.operations.is_empty(), "all-of still needs every flavor");
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

    fn order_mode_config(mode: &str) -> String {
        format!(r#"{{"offers":[{{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"productRewards":[],
            "orderRewards":[{{"id":"order-1","discountType":"percentage","discountValue":10,"subscriptionMode":"{mode}"}}]
        }}]}}"#)
    }

    fn order_mode_excluded(mode: &str, lines: &str) -> Option<Vec<String>> {
        let payload = cart_json_with_classes(lines, "100.00", &order_mode_config(mode), r#"["ORDER"]"#);
        let result = run_function_with_input(run, &payload).expect("should not error");
        match result.operations.first() {
            Some(schema::CartOperation::OrderDiscountsAdd(op)) => match &op.candidates[0].targets[0] {
                schema::OrderDiscountCandidateTarget::OrderSubtotal(target) => {
                    Some(target.excluded_cart_line_ids.clone())
                }
            },
            _ => None,
        }
    }

    #[test]
    fn order_reward_subscription_mode_filters_lines() {
        let one_time = regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/a", "gid://shopify/Product/a", "50.00", 1);
        let subscription = regular_line("gid://shopify/CartLine/2", "gid://shopify/ProductVariant/b", "gid://shopify/Product/b", "50.00", 1).replace(
            "\"sellingPlanAllocation\": null",
            "\"sellingPlanAllocation\": { \"sellingPlan\": { \"id\": \"gid://shopify/SellingPlan/monthly\" } }",
        );
        let both = format!("[{one_time},{subscription}]");
        assert_eq!(order_mode_excluded("any", &both), Some(vec![]));
        assert_eq!(
            order_mode_excluded("subscription_only", &both),
            Some(vec!["gid://shopify/CartLine/1".to_string()])
        );
        assert_eq!(
            order_mode_excluded("one_time_only", &both),
            Some(vec!["gid://shopify/CartLine/2".to_string()])
        );
        let only_one_time = format!("[{one_time}]");
        assert_eq!(order_mode_excluded("subscription_only", &only_one_time), None);
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

    fn zero_cost_config(reward_extra: &str) -> String {
        format!(
            r#"{{"offers":[{{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{{
                "id":"tiered","targetProductIds":[],"targetVariantIds":[],"discountType":"percentage","discountValue":0,
                "subscriptionMode":"any","scopeMode":"sitewide","priceTiers":[],"selectionMode":"all",
                {reward_extra}
            }}]
        }}]}}"#
        )
    }

    const TRU_TIERS: &str = r#""countRule":"total","quantityTiers":[
        {"minimumQuantity":1,"discountType":"percentage","discountValue":15},
        {"minimumQuantity":2,"discountType":"percentage","discountValue":20},
        {"minimumQuantity":3,"discountType":"percentage","discountValue":25},
        {"minimumQuantity":4,"discountType":"percentage","discountValue":30}]"#;

    /// (percentage, [(line id, units)]) per product candidate.
    fn product_percentages(lines: &[String], subtotal: &str, config: &str) -> Vec<(f64, Vec<(String, Option<i32>)>)> {
        let result = run_function_with_input(run, &cart_json(&format!("[{}]", lines.join(",")), subtotal, config))
            .expect("should not error");
        let mut out = vec![];
        for operation in &result.operations {
            if let schema::CartOperation::ProductDiscountsAdd(op) = operation {
                for candidate in &op.candidates {
                    let schema::ProductDiscountCandidateValue::Percentage(value) = &candidate.value else {
                        panic!("expected percentage");
                    };
                    let targets = candidate
                        .targets
                        .iter()
                        .map(|target| match target {
                            schema::ProductDiscountCandidateTarget::CartLine(line) => (line.id.clone(), line.quantity),
                        })
                        .collect();
                    out.push((value.value.0, targets));
                }
            }
        }
        out
    }

    fn paid(id: &str, product: &str, qty: i64) -> String {
        regular_line(
            &format!("gid://shopify/CartLine/{id}"),
            &format!("gid://shopify/ProductVariant/{product}"),
            &format!("gid://shopify/Product/{product}"),
            "10.00",
            qty,
        )
    }

    fn free(id: &str) -> String {
        regular_line(
            &format!("gid://shopify/CartLine/{id}"),
            "gid://shopify/ProductVariant/jug",
            "gid://shopify/Product/jug",
            "0.00",
            1,
        )
    }

    #[test]
    fn zero_cost_line_from_another_app_does_not_raise_the_quantity_tier() {
        let config = zero_cost_config(TRU_TIERS);
        let two_paid = product_percentages(&[paid("1", "meta", 2), free("2")], "20.00", &config);
        assert_eq!(two_paid.len(), 1);
        assert_eq!(two_paid[0].0, 20.0);
        assert_eq!(two_paid[0].1, vec![("gid://shopify/CartLine/1".to_string(), Some(2))]);

        let three_paid = product_percentages(&[paid("1", "meta", 3), free("2")], "30.00", &config);
        assert_eq!(three_paid[0].0, 25.0);
    }

    #[test]
    fn cart_without_a_zero_cost_line_keeps_its_tier() {
        let config = zero_cost_config(TRU_TIERS);
        assert_eq!(product_percentages(&[paid("1", "energy", 2)], "20.00", &config)[0].0, 20.0);
        let split = product_percentages(&[paid("1", "a", 2), paid("2", "b", 2)], "40.00", &config);
        assert_eq!(split[0].0, 30.0);
    }

    #[test]
    fn only_zero_cost_lines_get_no_tier_discount() {
        let config = zero_cost_config(TRU_TIERS);
        assert!(product_percentages(&[free("2")], "0.00", &config).is_empty());
    }

    #[test]
    fn zero_cost_and_promo_gift_lines_together_do_not_raise_the_quantity_tier() {
        let config = zero_cost_config(TRU_TIERS);
        let gift = gift_line("gid://shopify/CartLine/3", "gid://shopify/ProductVariant/gift", "gid://shopify/Product/gift", "offer-1", "0.00", 1);
        let result = product_percentages(&[paid("1", "meta", 3), free("2"), gift], "30.00", &config);
        assert_eq!(result[0].0, 25.0);
        assert_eq!(result[0].1, vec![("gid://shopify/CartLine/1".to_string(), Some(3))]);
    }

    fn with_merge_candidates(config: &str) -> String {
        config.replacen(r#"{"offers""#, r#"{"mergeCandidates":true,"offers""#, 1)
    }

    #[test]
    fn merge_candidates_folds_identical_percentages_into_one_candidate_and_keeps_quantities() {
        let config = zero_cost_config(TRU_TIERS);
        let lines = [paid("1", "a", 1), paid("2", "b", 2), paid("3", "c", 1)];
        let off = product_percentages(&lines, "40.00", &config);
        assert_eq!(off.len(), 3);

        let on = product_percentages(&lines, "40.00", &with_merge_candidates(&config));
        assert_eq!(on.len(), 1);
        assert_eq!(on[0].0, 30.0);
        assert_eq!(
            on[0].1,
            vec![
                ("gid://shopify/CartLine/1".to_string(), Some(1)),
                ("gid://shopify/CartLine/2".to_string(), Some(2)),
                ("gid://shopify/CartLine/3".to_string(), Some(1)),
            ]
        );
        let unmerged: Vec<_> = off.iter().flat_map(|(_, targets)| targets.clone()).collect();
        assert_eq!(on[0].1, unmerged);
    }

    #[test]
    fn merge_candidates_off_or_malformed_changes_nothing() {
        let config = zero_cost_config(TRU_TIERS);
        let lines = [paid("1", "a", 1), paid("2", "b", 1)];
        let baseline = product_percentages(&lines, "20.00", &config);
        assert_eq!(baseline.len(), 2);
        for flag in [r#""mergeCandidates":false"#, r#""mergeCandidates":"true""#, r#""mergeCandidates":1"#, r#""mergeCandidates":null"#] {
            let tolerant = config.replacen(r#"{"offers""#, &format!(r#"{{{flag},"offers""#), 1);
            assert_eq!(product_percentages(&lines, "20.00", &tolerant), baseline, "{flag}");
        }
    }

    #[test]
    fn merge_candidates_with_200_lines_emits_one_candidate() {
        let config = with_merge_candidates(&zero_cost_config(TRU_TIERS));
        let lines: Vec<String> = (1..=200).map(|index| paid(&index.to_string(), &format!("p{index}"), 1)).collect();
        let merged = product_percentages(&lines, "2000.00", &config);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].1.len(), 200);
    }

    fn percentage(line: &str, value: f64, message: &str) -> schema::ProductDiscountCandidate {
        make_candidate(format!("gid://shopify/CartLine/{line}"), 1, "percentage", value, message)
    }

    fn targets_of(candidates: &[schema::ProductDiscountCandidate]) -> Vec<Vec<String>> {
        candidates
            .iter()
            .map(|candidate| {
                candidate
                    .targets
                    .iter()
                    .map(|target| match target {
                        schema::ProductDiscountCandidateTarget::CartLine(line) => line.id.clone(),
                    })
                    .collect()
            })
            .collect()
    }

    #[test]
    fn merge_only_joins_adjacent_runs_and_never_reorders() {
        let merged = merge_adjacent_candidates(vec![
            percentage("1", 10.0, "a"),
            percentage("2", 10.0, "a"),
            percentage("3", 20.0, "a"),
            percentage("4", 10.0, "a"),
            percentage("5", 10.0, "b"),
            percentage("6", 10.0, "b"),
        ]);
        let ids = |lines: &[&str]| lines.iter().map(|line| format!("gid://shopify/CartLine/{line}")).collect::<Vec<_>>();
        assert_eq!(targets_of(&merged), vec![ids(&["1", "2"]), ids(&["3"]), ids(&["4"]), ids(&["5", "6"])]);
    }

    #[test]
    fn merge_never_joins_fixed_amounts_or_candidates_with_a_different_code_or_prerequisites() {
        let fixed = |line: &str| make_candidate(format!("gid://shopify/CartLine/{line}"), 1, "fixed_amount", 5.0, "a");
        assert_eq!(merge_adjacent_candidates(vec![fixed("1"), fixed("2")]).len(), 2);

        let mut coded = percentage("2", 10.0, "a");
        coded.associated_discount_code = Some(schema::AssociatedDiscountCode { code: "SAVE".to_string() });
        assert_eq!(merge_adjacent_candidates(vec![percentage("1", 10.0, "a"), coded]).len(), 2);

        let mut same_code = vec![percentage("1", 10.0, "a"), percentage("2", 10.0, "a")];
        for candidate in &mut same_code {
            candidate.associated_discount_code = Some(schema::AssociatedDiscountCode { code: "SAVE".to_string() });
        }
        assert_eq!(merge_adjacent_candidates(same_code).len(), 1);

        let mut gated = percentage("2", 10.0, "a");
        gated.prerequisites = Some(vec![]);
        assert_eq!(merge_adjacent_candidates(vec![percentage("1", 10.0, "a"), gated]).len(), 2);
    }

    #[test]
    fn zero_cost_line_does_not_count_as_a_unique_product() {
        let config = zero_cost_config(
            r#""countRule":"unique","quantityTiers":[{"minimumQuantity":2,"discountType":"percentage","discountValue":20}]"#,
        );
        assert!(product_percentages(&[paid("1", "a", 3), free("2")], "30.00", &config).is_empty());
        let with_second_product = product_percentages(&[paid("1", "a", 1), paid("2", "b", 1), free("3")], "20.00", &config);
        assert_eq!(with_second_product[0].0, 20.0);
    }

    fn cart_quantity_config(bounds: &str) -> String {
        zero_cost_config(r#""countRule":"total","quantityTiers":[]"#)
            .replace(r#""discountType":"percentage","discountValue":0,"#, r#""discountType":"percentage","discountValue":10,"#)
            .replace(r#""requirements":[],"#, &format!(r#""requirements":[],{bounds},"#))
    }

    #[test]
    fn zero_cost_line_does_not_reach_the_cart_quantity_minimum() {
        let config = cart_quantity_config(r#""cartQuantityThreshold":3"#);
        assert!(product_percentages(&[paid("1", "meta", 2), free("2")], "20.00", &config).is_empty());
        assert_eq!(product_percentages(&[paid("1", "meta", 3), free("2")], "30.00", &config).len(), 1);
    }

    #[test]
    fn zero_cost_line_does_not_exceed_the_cart_quantity_maximum() {
        let config = cart_quantity_config(r#""cartQuantityThreshold":1,"cartQuantityMax":2"#);
        assert_eq!(product_percentages(&[paid("1", "meta", 2), free("2")], "20.00", &config).len(), 1);
        assert!(product_percentages(&[paid("1", "meta", 3), free("2")], "30.00", &config).is_empty());
    }

    #[test]
    fn cart_quantity_without_a_zero_cost_line_is_unchanged() {
        let config = cart_quantity_config(r#""cartQuantityThreshold":3,"cartQuantityMax":4"#);
        assert!(product_percentages(&[paid("1", "a", 2)], "20.00", &config).is_empty());
        assert!(!product_percentages(&[paid("1", "a", 2), paid("2", "b", 1)], "30.00", &config).is_empty());
        assert!(product_percentages(&[paid("1", "a", 3), paid("2", "b", 2)], "50.00", &config).is_empty());
    }

    #[test]
    fn zero_cost_line_does_not_consume_the_unit_cap() {
        // The $0 line sorts first by id; before the fix it took the single capped unit.
        let config = zero_cost_config(
            r#""countRule":"total","maxUnitsTotal":1,"quantityTiers":[{"minimumQuantity":1,"discountType":"percentage","discountValue":20}]"#,
        );
        let result = product_percentages(&[free("0"), paid("1", "a", 2)], "20.00", &config);
        assert_eq!(result[0].1, vec![("gid://shopify/CartLine/1".to_string(), Some(1))]);
    }

    #[test]
    fn zero_cost_line_is_not_the_cheapest_item_free() {
        let config = zero_cost_config(r#""countRule":"total","quantityTiers":[]"#).replace(
            r#""discountType":"percentage","discountValue":0,"#,
            r#""discountType":"cheapest_item_free","discountValue":100,"#,
        );
        let result = product_percentages(&[free("0"), paid("1", "a", 1), paid("2", "b", 1)], "20.00", &config);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].1[0].0, "gid://shopify/CartLine/1");
    }

    #[test]
    fn zero_cost_line_does_not_count_toward_an_order_quantity_tier() {
        let config = r#"{"offers":[{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"productRewards":[],
            "orderRewards":[{"id":"order-1","discountType":"percentage","discountValue":0,
              "subtotalTiers":[{"minimumQuantity":3,"discountType":"percentage","discountValue":15}]}]
        }]}"#;
        let run_with = |lines: Vec<String>, subtotal: &str| {
            run_function_with_input(
                run,
                &cart_json_with_classes(&format!("[{}]", lines.join(",")), subtotal, config, r#"["ORDER"]"#),
            )
            .expect("should not error")
        };
        assert!(run_with(vec![paid("1", "a", 2), free("2")], "20.00").operations.is_empty());
        assert_eq!(run_with(vec![paid("1", "a", 3), free("2")], "30.00").operations.len(), 1);
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

    fn product_message(result: &schema::CartLinesDiscountsGenerateRunResult) -> Option<String> {
        let schema::CartOperation::ProductDiscountsAdd(op) = &result.operations[0] else {
            panic!("expected ProductDiscountsAdd");
        };
        op.candidates[0].message.clone()
    }

    const FOUR_TIERS: &str = r#"[
        {"minimumQuantity":1,"maximumQuantity":1,"discountType":"percentage","discountValue":15,"cartMessage":"Starter"},
        {"minimumQuantity":2,"maximumQuantity":2,"discountType":"percentage","discountValue":20,"cartMessage":"Twenty off \u00b7 Duo"},
        {"minimumQuantity":3,"maximumQuantity":3,"discountType":"percentage","discountValue":25},
        {"minimumQuantity":4,"discountType":"fixed_amount","discountValue":5}]"#;

    fn tiered_message(title: Option<&str>, tiers: &str, quantity: i64) -> Option<String> {
        labeled_tiered_message(title, None, tiers, quantity)
    }

    fn labeled_tiered_message(title: Option<&str>, cart_message: Option<&str>, tiers: &str, quantity: i64) -> Option<String> {
        let title = format!(
            "{}{}",
            title.map_or(String::new(), |t| format!(r#""title":"{t}","#)),
            cart_message.map_or(String::new(), |m| format!(r#""cartMessage":"{m}","#)),
        );
        let config = format!(
            r#"{{"offers":[{{
            "id":"offer-1","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,{title}
            "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
            "giftVariantIds":[],"giftProductIds":[],"discountType":"free","discountValue":100,"currencyCode":"USD",
            "combinesWithOrderDiscounts":true,"combinesWithShippingDiscounts":true,"combinesWithProductDiscounts":true,
            "requirements":[],"orderRewards":[],"productRewards":[{{
                "id":"tiered","targetProductIds":[],"targetVariantIds":[],"discountType":"percentage","discountValue":0,
                "subscriptionMode":"any","scopeMode":"sitewide","priceTiers":[],"selectionMode":"all","countRule":"sum",
                "quantityTiers":{tiers},"discountPercentageOnGifts":100
            }}]
        }}]}}"#
        );
        let lines = format!(
            "[{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/a", "gid://shopify/Product/a", "10.00", quantity)
        );
        let result = run_function_with_input(run, &cart_json(&lines, "50.00", &config)).expect("tiered");
        product_message(&result)
    }

    #[test]
    fn tier_cart_message_is_appended_to_the_offer_title() {
        assert_eq!(
            tiered_message(Some("Black Friday"), FOUR_TIERS, 2).as_deref(),
            Some("Black Friday \u{b7} Twenty off \u{b7} Duo")
        );
        assert_eq!(tiered_message(Some("Black Friday"), FOUR_TIERS, 1).as_deref(), Some("Black Friday \u{b7} Starter"));
    }

    #[test]
    fn tier_without_cart_message_leaves_the_message_untouched() {
        assert_eq!(tiered_message(Some("Sale"), FOUR_TIERS, 3).as_deref(), Some("Sale"));
        assert_eq!(tiered_message(Some("Sale"), FOUR_TIERS, 5).as_deref(), Some("Sale"));
        assert_eq!(tiered_message(None, FOUR_TIERS, 3).as_deref(), Some("Discount"));
    }

    #[test]
    fn tier_message_is_capped_at_64_chars() {
        let long = "x".repeat(60);
        let tiers = format!(
            r#"[{{"minimumQuantity":1,"discountType":"percentage","discountValue":10,"cartMessage":"{long}"}}]"#
        );
        let message = tiered_message(Some("Black Friday Sale"), &tiers, 1).unwrap();
        assert_eq!(message.chars().count(), 64);
        assert!(message.starts_with("Black Friday Sale \u{b7} xxx"));
    }

    #[test]
    fn offer_cart_message_replaces_the_title_and_precedes_the_tier_message() {
        let tiers = r#"[{"minimumQuantity":1,"discountType":"percentage","discountValue":20,"cartMessage":"20% OFF"}]"#;
        assert_eq!(
            labeled_tiered_message(Some("Title"), Some("Title \u{b7} A \u{b7} B"), tiers, 1).as_deref(),
            Some("Title \u{b7} A \u{b7} B \u{b7} 20% OFF")
        );
        let untiered_plain = format!(r#"{PRODUCT_REWARD},"title":"Title","cartMessage":"Title · A · B""#);
        let result = run_function_with_input(run, &landing_and_other_page_payload(&untiered_plain, r#"["PRODUCT"]"#)).expect("product");
        assert_eq!(product_message(&result).as_deref(), Some("Title \u{b7} A \u{b7} B"));
    }

    #[test]
    fn offers_without_tiers_keep_the_title_only_message() {
        let titled = format!(r#"{PRODUCT_REWARD},"title":"Spring sale""#);
        let result = run_function_with_input(run, &landing_and_other_page_payload(&titled, r#"["PRODUCT"]"#)).expect("product");
        assert_eq!(product_message(&result).as_deref(), Some("Spring sale"));
    }

    #[test]
    fn offer_title_is_the_product_and_order_discount_message() {
        let titled = format!(r#"{PRODUCT_REWARD},"title":"Spring sale""#);
        let result = run_function_with_input(
            run,
            &landing_and_other_page_payload(&titled, r#"["PRODUCT"]"#),
        )
        .expect("product");
        assert_eq!(product_message(&result).as_deref(), Some("Spring sale"));

        let order_reward = r#""orderRewards":[{"id":"o1","discountType":"percentage","discountValue":10}],"title":"Spring sale""#;
        let result = run_function_with_input(
            run,
            &landing_and_other_page_payload(order_reward, r#"["ORDER"]"#),
        )
        .expect("order");
        let schema::CartOperation::OrderDiscountsAdd(op) = &result.operations[0] else {
            panic!("expected OrderDiscountsAdd");
        };
        assert_eq!(op.candidates[0].message.as_deref(), Some("Spring sale"));
    }

    #[test]
    fn empty_offer_title_keeps_the_default_product_message() {
        let untitled = format!(r#"{PRODUCT_REWARD},"title":"""#);
        let result = run_function_with_input(
            run,
            &landing_and_other_page_payload(&untitled, r#"["PRODUCT"]"#),
        )
        .expect("product");
        assert_ne!(product_message(&result).as_deref(), Some(""));
        assert!(product_message(&result).is_some());
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
        two_line_payload_with_classes(offer_fields, metadata, r#"["PRODUCT"]"#)
    }

    fn two_line_payload_with_classes(offer_fields: &str, metadata: [serde_json::Value; 2], classes: &str) -> String {
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
            serde_json::from_str(&cart_json_with_classes(&lines, "100.00", &config, classes)).unwrap();
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

    const EXCLUDING_PAGES: &str = r#""pageUrlConditions":[{"matchMode":"page_type","patterns":["home","collection","product","!/products/protein-creatine-bundle","!/products/one-sol™-8-week-system-1"]}],"restrictToMatchedLines":true"#;

    #[test]
    fn excluded_url_lines_get_no_product_discount_while_other_lines_do() {
        let lines = |first: &str| {
            [
                serde_json::json!({ "_promo_page_url": first }),
                serde_json::json!({ "_promo_page_url": "/products/other" }),
            ]
        };
        for excluded in [
            "/products/protein-creatine-bundle",
            "/Products/Protein-Creatine-Bundle/?variant=1",
            "https://onesol.com/products/protein-creatine-bundle",
            "/en/products/protein-creatine-bundle",
            "/products/one-sol%E2%84%A2-8-week-system-1",
            "/products/one-sol™-8-week-system-1",
        ] {
            let result = run_function_with_input(run, &two_line_payload(EXCLUDING_PAGES, lines(excluded))).expect("excluded");
            assert_eq!(product_target_ids(&result), vec!["gid://shopify/CartLine/2"], "{excluded}");
        }
        let result = run_function_with_input(run, &two_line_payload(EXCLUDING_PAGES, lines("/products/protein-creatine-bundle-2"))).expect("near miss");
        assert_eq!(product_target_ids(&result).len(), 2);
        let result = run_function_with_input(run, &two_line_payload(EXCLUDING_PAGES, lines("/collections/x/products/protein-creatine-bundle"))).expect("collection path");
        assert_eq!(product_target_ids(&result).len(), 2);
    }

    #[test]
    fn excluded_url_lines_are_left_out_of_the_order_discount_and_its_tiers() {
        let order_candidate = |reward: &str| {
            let metadata = [
                serde_json::json!({ "_promo_page_url": "/products/protein-creatine-bundle" }),
                serde_json::json!({ "_promo_page_url": "/products/other" }),
            ];
            let payload = two_line_payload_with_classes(&format!("{reward},{EXCLUDING_PAGES}"), metadata, r#"["ORDER"]"#);
            run_function_with_input(run, &payload).expect("order")
        };
        let result = order_candidate(r#""orderRewards":[{"id":"o1","discountType":"percentage","discountValue":10}]"#);
        let schema::CartOperation::OrderDiscountsAdd(op) = &result.operations[0] else {
            panic!("expected OrderDiscountsAdd");
        };
        #[allow(irrefutable_let_patterns)]
        let schema::OrderDiscountCandidateTarget::OrderSubtotal(target) = &op.candidates[0].targets[0] else {
            panic!("expected order subtotal target");
        };
        assert_eq!(target.excluded_cart_line_ids, vec!["gid://shopify/CartLine/1"]);

        // The $40 excluded line does not count toward the reward's own subtotal tier: $60 < $70.
        let tiered = order_candidate(
            r#""orderRewards":[{"id":"o1","discountType":"percentage","discountValue":0,"subtotalTiers":[{"minimumSubtotalCents":7000,"discountType":"percentage","discountValue":20}]}]"#,
        );
        assert!(tiered.operations.is_empty());

        // The offer-level cart value gate still counts the whole cart ($100 >= $90).
        let gated = order_candidate(
            r#""cartValueThresholdCents":9000,"orderRewards":[{"id":"o1","discountType":"percentage","discountValue":10}]"#,
        );
        assert_eq!(gated.operations.len(), 1);
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

    const SK_PAGE: &str = "/pages/nektar-starter-kit-50";

    fn theme_gift_config() -> String {
        r#"{"offers":[{
            "id":"offer-sk","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
            "requiredProductIds":["gid://shopify/Product/nektar"],"requiredVariantIds":[],"excludedProductIds":[],
            "subscriptionMode":"subscription_only",
            "pageUrlConditions":[{"matchMode":"exact","patterns":["/pages/nektar-starter-kit-50"],"caseSensitive":false}],
            "discountType":"free","discountValue":100,"currencyCode":"USD",
            "giftRewards":[
                {"id":"reward-frother","targetVariantIds":["gid://shopify/ProductVariant/frother"],"discountType":"free","discountValue":100,"maxQuantity":1},
                {"id":"reward-otg","targetVariantIds":["gid://shopify/ProductVariant/otg"],"discountType":"free","discountValue":100,"maxQuantity":1}
            ]
        }]}"#
        .to_string()
    }

    fn theme_line(id: &str, variant: &str, product: &str, qty: i64, subscription: bool, page: &str) -> String {
        let line = regular_line(
            &format!("gid://shopify/CartLine/{id}"),
            &format!("gid://shopify/ProductVariant/{variant}"),
            &format!("gid://shopify/Product/{product}"),
            "10.00",
            qty,
        );
        let mut value: Value = serde_json::from_str(&line).unwrap();
        if subscription {
            value["sellingPlanAllocation"] = serde_json::json!({ "sellingPlan": { "id": "gid://shopify/SellingPlan/1" } });
        }
        value["promoMetadata"] = serde_json::json!({
            "value": serde_json::json!({ "_promo_page_url": page }).to_string(),
        });
        value.to_string()
    }

    fn tagged_line(id: &str, variant: &str, product: &str, offer: &str, reward: &str, qty: i64) -> String {
        gift_line_with_metadata(
            &format!("gid://shopify/CartLine/{id}"),
            &format!("gid://shopify/ProductVariant/{variant}"),
            &format!("gid://shopify/Product/{product}"),
            (offer, reward, "1"),
            "10.00",
            qty,
        )
    }

    fn discounted_units(lines: &[String], config: &str) -> Vec<(String, i64)> {
        let payload = cart_json(&format!("[{}]", lines.join(",")), "100.00", config);
        let result = run_function_with_input(run, &payload).expect("should not error");
        let mut units = Vec::new();
        for operation in &result.operations {
            let schema::CartOperation::ProductDiscountsAdd(op) = operation else {
                panic!("expected ProductDiscountsAdd, got {operation:?}");
            };
            for candidate in &op.candidates {
                let schema::ProductDiscountCandidateTarget::CartLine(target) = &candidate.targets[0];
                units.push((
                    target.id.trim_start_matches("gid://shopify/CartLine/").to_string(),
                    i64::from(target.quantity.unwrap_or(0)),
                ));
            }
        }
        units.sort();
        units
    }

    fn anchor() -> String {
        theme_line("1", "nektar-sub", "nektar", 1, true, SK_PAGE)
    }

    #[test]
    fn untagged_theme_gift_lines_are_discounted_when_the_offer_qualifies() {
        let lines = [
            anchor(),
            theme_line("2", "frother", "frother-p", 1, false, SK_PAGE),
            theme_line("3", "otg", "otg-p", 1, false, SK_PAGE),
        ];
        assert_eq!(
            discounted_units(&lines, &theme_gift_config()),
            vec![("2".to_string(), 1), ("3".to_string(), 1)]
        );
    }

    #[test]
    fn untagged_gift_lines_are_charged_when_the_offer_does_not_qualify() {
        let gifts = [
            theme_line("2", "frother", "frother-p", 1, false, SK_PAGE),
            theme_line("3", "otg", "otg-p", 1, false, SK_PAGE),
        ];
        let wrong_page = [
            theme_line("1", "nektar-sub", "nektar", 1, true, "/pages/other"),
            theme_line("2", "frother", "frother-p", 1, false, "/pages/other"),
            theme_line("3", "otg", "otg-p", 1, false, "/pages/other"),
        ]
        .to_vec();
        let one_time = [vec![theme_line("1", "nektar-sub", "nektar", 1, false, SK_PAGE)], gifts.to_vec()].concat();
        let no_anchor = gifts.to_vec();
        for lines in [wrong_page, one_time, no_anchor] {
            assert!(discounted_units(&lines, &theme_gift_config()).is_empty());
        }
    }

    #[test]
    fn untagged_gift_units_are_capped_at_the_reward_quantity() {
        let lines = [anchor(), theme_line("2", "frother", "frother-p", 2, false, SK_PAGE)];
        assert_eq!(discounted_units(&lines, &theme_gift_config()), vec![("2".to_string(), 1)]);
    }

    #[test]
    fn untagged_lines_never_take_a_gift_tagged_for_another_offer_or_reward() {
        let other_offer = tagged_line("2", "frother", "frother-p", "offer-other", "reward-frother", 1);
        let other_reward = tagged_line("3", "otg", "otg-p", "offer-sk", "reward-frother", 1);
        let lines = [anchor(), other_offer, other_reward];
        assert!(discounted_units(&lines, &theme_gift_config()).is_empty());
    }

    #[test]
    fn our_tagged_gift_line_has_priority_over_an_untagged_one() {
        let lines = [
            anchor(),
            theme_line("2", "frother", "frother-p", 1, false, SK_PAGE),
            tagged_line("3", "frother", "frother-p", "offer-sk", "reward-frother", 1),
        ];
        assert_eq!(discounted_units(&lines, &theme_gift_config()), vec![("3".to_string(), 1)]);
    }

    #[test]
    fn the_anchor_unit_is_never_consumed_as_its_own_gift() {
        let config = theme_gift_config().replace(
            "\"targetVariantIds\":[\"gid://shopify/ProductVariant/otg\"]",
            "\"targetVariantIds\":[\"gid://shopify/ProductVariant/nektar-sub\"]",
        );
        let alone = [anchor()];
        assert!(discounted_units(&alone, &config).is_empty());
        let two = [theme_line("1", "nektar-sub", "nektar", 2, true, SK_PAGE)];
        assert_eq!(discounted_units(&two, &config), vec![("1".to_string(), 1)]);
    }

    fn stacking_config(landing: &str, theme: &str) -> String {
        let landing_offer = landing_cap_config(
            r#""targetProductIds":["gid://shopify/Product/g13"],"targetVariantIds":[]"#,
            "",
        )
        .replace("ProductVariant/anchor", "ProductVariant/nektar-sub")
        .replace(r#""lp""#, r#""nektar-13-offer""#);
        let mut landing_offer: Value = serde_json::from_str(&landing_offer).unwrap();
        let mut theme_offer: Value = serde_json::from_str(&theme_gift_config()).unwrap();
        let mut offers = vec![landing_offer["offers"][0].take(), theme_offer["offers"][0].take()];
        for (offer, id, extra) in [(0, "offer-13", landing), (1, "offer-sk", theme)] {
            let fields: Value = serde_json::from_str(extra).unwrap();
            offers[offer]["id"] = id.into();
            for (key, value) in fields.as_object().unwrap() {
                offers[offer][key] = value.clone();
            }
        }
        serde_json::json!({ "offers": offers }).to_string()
    }

    /// A subscription Nektar line carrying both the landing source and the page stamp.
    fn dual_anchor(id: &str) -> String {
        let mut line: Value = serde_json::from_str(&theme_line(id, "nektar-sub", "nektar", 1, true, SK_PAGE)).unwrap();
        line["promoMetadata"] = serde_json::json!({
            "value": serde_json::json!({ "_promo_page_url": SK_PAGE, "__landing_source": "nektar-13-offer" }).to_string(),
        });
        line.to_string()
    }

    fn stacking_free_lines(anchors: &[&str], config: &str) -> Vec<String> {
        let mut lines: Vec<String> = anchors.iter().map(|id| dual_anchor(id)).collect();
        lines.push(scoped_line(
            "gid://shopify/CartLine/g13", "gid://shopify/ProductVariant/g13", "gid://shopify/Product/g13",
            "10.00", 1, Some("nektar-13-offer"), None,
        ));
        lines.push(theme_line("frother", "frother", "frother-p", 1, false, SK_PAGE));
        lines.push(theme_line("otg", "otg", "otg-p", 1, false, SK_PAGE));
        let payload = cart_json(&format!("[{}]", lines.join(",")), "100.00", config);
        let result = run_function_with_input(run, &payload).unwrap();
        free_units_by_line(&result)
            .into_keys()
            .map(|id| id.trim_start_matches("gid://shopify/CartLine/").to_string())
            .collect()
    }

    #[test]
    fn one_anchor_unlocks_both_gift_offers_when_stacking_is_on() {
        let config = stacking_config(r#"{"priority":50}"#, r#"{"priority":100}"#);
        assert_eq!(stacking_free_lines(&["1"], &config), ["frother", "g13", "otg"]);
    }

    #[test]
    fn one_anchor_unlocks_only_the_higher_priority_non_stacking_offer() {
        let config = stacking_config(
            r#"{"priority":50,"canStackWithGiftOffers":false}"#,
            r#"{"priority":100,"canStackWithGiftOffers":false}"#,
        );
        assert_eq!(stacking_free_lines(&["1"], &config), ["g13"]);
        let swapped = stacking_config(
            r#"{"priority":100,"canStackWithGiftOffers":false}"#,
            r#"{"priority":50,"canStackWithGiftOffers":false}"#,
        );
        assert_eq!(stacking_free_lines(&["1"], &swapped), ["frother", "otg"]);
    }

    #[test]
    fn equal_priority_non_stacking_offers_resolve_by_offer_id() {
        let config = stacking_config(
            r#"{"priority":100,"canStackWithGiftOffers":false}"#,
            r#"{"priority":100,"canStackWithGiftOffers":false}"#,
        );
        assert_eq!(stacking_free_lines(&["1"], &config), ["g13"]);
    }

    #[test]
    fn two_anchor_lines_unlock_both_non_stacking_offers() {
        let config = stacking_config(
            r#"{"priority":50,"canStackWithGiftOffers":false}"#,
            r#"{"priority":100,"canStackWithGiftOffers":false}"#,
        );
        assert_eq!(stacking_free_lines(&["1", "4"], &config), ["frother", "g13", "otg"]);
    }

    #[test]
    fn a_non_stacking_offer_takes_the_anchor_only_from_offers_after_it() {
        let first = stacking_config(
            r#"{"priority":50,"canStackWithGiftOffers":false}"#,
            r#"{"priority":100}"#,
        );
        assert_eq!(stacking_free_lines(&["1"], &first), ["g13"]);
        let last = stacking_config(
            r#"{"priority":50}"#,
            r#"{"priority":100,"canStackWithGiftOffers":false}"#,
        );
        assert_eq!(stacking_free_lines(&["1"], &last), ["frother", "g13", "otg"]);
    }

    // ---- per-customer usage and per-cart caps (`mpu`, `ri`, `mpc`) ----

    fn with_fields(config: &str, fields: &str) -> String {
        config.replace(r#""id":"offer-1","#, &format!(r#""id":"offer-1",{fields},"#))
    }

    /// Gift cart for `strict_gift_offer_config`. `customer`: None = guest, Some(None) = customer
    /// without the usage metafield, Some(Some(raw)) = customer with that metafield value.
    fn gift_units_for(config: &str, customer: Option<Option<&str>>) -> BTreeMap<String, i64> {
        let lines = format!(
            "[{},{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "60.00", 1),
            gift_line_with_metadata(
                "gid://shopify/CartLine/2",
                "gid://shopify/ProductVariant/gift-v1",
                "gid://shopify/Product/gift-p1",
                ("offer-1", "reward-1", "3"),
                "20.00",
                1,
            ),
        );
        let mut payload: Value = serde_json::from_str(&cart_json(&lines, "120.00", config)).unwrap();
        if let Some(usage) = customer {
            let mut customer = serde_json::json!({
                "numberOfOrders": 0, "hasTags": [], "amountSpent": { "amount": "0.00" }
            });
            if let Some(raw) = usage {
                customer["usage"] = serde_json::json!({ "value": raw });
            }
            payload["cart"]["buyerIdentity"] = serde_json::json!({ "customer": customer });
        }
        free_units_by_line(&run_function_with_input(run, &payload.to_string()).unwrap())
    }

    fn gift_applies(fields: &str, customer: Option<Option<&str>>) -> bool {
        let config = with_fields(strict_gift_offer_config(), fields);
        gift_units_for(&config, customer).get("gid://shopify/CartLine/2") == Some(&1)
    }

    #[test]
    fn absent_limit_fields_ignore_usage_and_guests() {
        assert!(gift_applies(r#""x":1"#, None));
        assert!(gift_applies(r#""x":1"#, Some(Some(r#"{"v":1,"u":{"offer-1":99}}"#))));
        let config: CompiledConfig = serde_json::from_str(strict_gift_offer_config()).unwrap();
        let offer = &config.offers[0];
        assert_eq!((offer.max_per_cart, offer.max_per_customer, offer.require_identified), (None, None, false));
        assert_eq!(config.dc, None);
    }

    #[test]
    fn per_customer_limit_applies_below_and_not_at_the_limit() {
        let check = |count: i64| {
            let raw = format!(r#"{{"v":1,"u":{{"offer-1":{count}}}}}"#);
            gift_applies(r#""mpu":2"#, Some(Some(raw.as_str())))
        };
        assert!(check(0) && check(1));
        assert!(!check(2) && !check(3));
    }

    #[test]
    fn missing_key_missing_metafield_and_null_customer_count_as_zero_uses() {
        assert!(gift_applies(r#""mpu":1"#, Some(Some(r#"{"v":1,"u":{"other-offer":5}}"#))));
        assert!(gift_applies(r#""mpu":1"#, Some(Some(r#"{"v":1,"u":{}}"#))));
        assert!(gift_applies(r#""mpu":1"#, Some(None)));
        assert!(gift_applies(r#""mpu":1"#, None));
    }

    #[test]
    fn unreadable_usage_fails_open() {
        for raw in ["not json", r#"{"v":2,"u":{"offer-1":9}}"#, r#"{"u":{"offer-1":9}}"#, r#"{"v":1,"u":[1]}"#] {
            assert!(gift_applies(r#""mpu":1"#, Some(Some(raw))), "{raw}");
        }
    }

    #[test]
    fn require_identified_blocks_a_null_customer_only() {
        assert!(!gift_applies(r#""mpu":1,"ri":true"#, None));
        assert!(!gift_applies(r#""ri":true"#, None));
        assert!(gift_applies(r#""ri":true"#, Some(None)));
        assert!(gift_applies(r#""mpu":1,"ri":true"#, Some(Some(r#"{"v":1,"u":{}}"#))));
        assert!(!gift_applies(r#""mpu":1,"ri":true"#, Some(Some(r#"{"v":1,"u":{"offer-1":1}}"#))));
    }

    #[test]
    fn discount_classes_come_from_the_config() {
        let lines = format!(
            "[{}]",
            regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/a", "gid://shopify/Product/a", "40.00", 1)
        );
        let config = r#"{"offers":[{"id":"offer-1","version":1,"offerType":"discount","priority":1,"currencyCode":"USD","discountType":"percentage","discountValue":10}]}"#;
        let discounted = |payload: String| free_units_by_line(&run_function_with_input(run, &payload).unwrap()).len();
        // cart_json_with_customer writes no `dc`: both classes, so the product discount applies.
        assert_eq!(discounted(cart_json_with_customer(&lines, "40.00", config, 0, "0.00")), 1);
        assert_eq!(discounted(cart_json_with_classes(&lines, "40.00", config, r#"["PRODUCT"]"#)), 1);
        assert_eq!(discounted(cart_json_with_classes(&lines, "40.00", config, r#"["ORDER"]"#)), 0);
    }

    fn legacy_discount_units(fields: &str, quantities: &[i64]) -> Vec<i64> {
        let config = format!(
            r#"{{"offers":[{{"id":"offer-1",{fields}"version":1,"offerType":"discount","priority":1,"currencyCode":"USD","discountType":"percentage","discountValue":10}}]}}"#
        );
        let lines: Vec<String> = quantities
            .iter()
            .enumerate()
            .map(|(index, quantity)| {
                regular_line(
                    &format!("gid://shopify/CartLine/{index}"),
                    &format!("gid://shopify/ProductVariant/v{index}"),
                    &format!("gid://shopify/Product/p{index}"),
                    "10.00",
                    *quantity,
                )
            })
            .collect();
        let payload = cart_json(&format!("[{}]", lines.join(",")), "100.00", &config);
        let units = free_units_by_line(&run_function_with_input(run, &payload).unwrap());
        (0..quantities.len())
            .map(|index| units.get(&format!("gid://shopify/CartLine/{index}")).copied().unwrap_or(0))
            .collect()
    }

    #[test]
    fn per_cart_cap_limits_units_of_a_plain_discount() {
        assert_eq!(legacy_discount_units("", &[3, 2]), [3, 2]);
        assert_eq!(legacy_discount_units(r#""mpc":4,"#, &[3, 2]), [3, 1]);
        assert_eq!(legacy_discount_units(r#""mpc":1,"#, &[3, 2]), [1, 0]);
        assert_eq!(legacy_discount_units(r#""mpc":50,"#, &[3, 2]), [3, 2], "never raises");
    }

    fn reward_units(reward_extra: &str, offer_fields: &str, quantity: i64) -> i64 {
        let config = format!(
            r#"{{"offers":[{{"id":"offer-1",{offer_fields}"version":1,"offerType":"discount","priority":1,"currencyCode":"USD",
            "productRewards":[{{"id":"r","targetProductIds":[],"targetVariantIds":[],"discountType":"percentage","discountValue":10{reward_extra}}}]}}]}}"#
        );
        let line = regular_line("gid://shopify/CartLine/1", "gid://shopify/ProductVariant/v1", "gid://shopify/Product/p1", "10.00", quantity);
        let payload = cart_json(&format!("[{line}]"), "100.00", &config);
        free_units_by_line(&run_function_with_input(run, &payload).unwrap()).values().sum()
    }

    #[test]
    fn per_cart_cap_counts_tier_packs_and_lowers_but_never_raises_a_unit_cap() {
        assert_eq!(reward_units("", "", 7), 7);
        assert_eq!(reward_units("", r#""mpc":3,"#, 7), 3);
        let quantity_tier = r#","quantityTiers":[{"minimumQuantity":2,"discountType":"percentage","discountValue":20}]"#;
        assert_eq!(reward_units(quantity_tier, "", 7), 7);
        assert_eq!(reward_units(quantity_tier, r#""mpc":2,"#, 7), 4);
        let discounted_pack = r#","quantityTiers":[{"minimumQuantity":2,"discountType":"percentage","discountValue":20,"discountedQuantity":2}]"#;
        assert_eq!(reward_units(discounted_pack, r#""mpc":5,"#, 7), 2, "a pack cap already below mpc stays");
        let price_tier = r#","priceTiers":[{"quantity":3,"targetPricePerUnit":8}]"#;
        assert_eq!(reward_units(price_tier, "", 7), 7);
        assert_eq!(reward_units(price_tier, r#""mpc":1,"#, 7), 3);
        assert_eq!(reward_units(r#","maxUnitsTotal":2"#, r#""mpc":9,"#, 7), 2);
        assert_eq!(reward_units(r#","maxUnitsTotal":9"#, r#""mpc":2,"#, 7), 2);
    }

    #[test]
    fn per_cart_cap_lowers_gift_sets_and_picker_totals() {
        let reward2 = [("g2", "gift-v2", "gift-p2", 3)];
        let capped = with_fields(strict_gift_offer_config(), r#""mpc":1"#);
        assert_eq!(gift_cart(&reward2, strict_gift_offer_config(), None).values().sum::<i64>(), 2);
        assert_eq!(gift_cart(&reward2, &capped, None).values().sum::<i64>(), 1);
        let loose = with_fields(strict_gift_offer_config(), r#""mpc":9"#);
        assert_eq!(gift_cart(&reward2, &loose, None).values().sum::<i64>(), 2, "never raises");

        let picker = picker_config(r#","selectionCount":2,"maxQuantity":3"#);
        let gifts = [("g1", "gift-v1", "gift-p1", 3), ("g2", "gift-v2", "gift-p2", 3), ("g3", "gift-v3", "gift-p3", 3)];
        assert_eq!(gift_cart(&gifts, &picker, Some("pick")).values().sum::<i64>(), 6);
        let capped_picker = with_fields(&picker, r#""mpc":1"#);
        assert_eq!(gift_cart(&gifts, &capped_picker, Some("pick")).values().sum::<i64>(), 2);
    }

    #[test]
    fn per_cart_cap_limits_quiz_bundles() {
        let bundle = |id: &str, bundle_id: &str| {
            scoped_line(
                &format!("gid://shopify/CartLine/{id}"), "gid://shopify/ProductVariant/p1", "gid://shopify/Product/p1",
                "50.00", 1, None, Some((bundle_id, "3000", "1", false)),
            )
        };
        let lines = format!("[{},{}]", bundle("1", "bundle-a"), bundle("2", "bundle-b"));
        let discounted = |config: &str| {
            let payload = cart_json(&lines, "100.00", config);
            free_units_by_line(&run_function_with_input(run, &payload).unwrap()).len()
        };
        let config = quiz_config("fixed_price", "30");
        assert_eq!(discounted(&config), 2);
        assert_eq!(discounted(&with_fields(&config, r#""mpc":1"#)), 1);
        assert_eq!(discounted(&with_fields(&config, r#""mpc":5"#)), 2);
    }

    #[test]
    fn shipping_offers_in_the_cart_config_are_inert() {
        const COMPACT: &str = include_str!("fixtures/ambrosia-function-config.compact.json");
        let mut config: serde_json::Value = serde_json::from_str(COMPACT).unwrap();
        assert!(config.get("shippingOffers").is_some_and(|v| v.as_array().is_some_and(|a| !a.is_empty())));
        let with = config.to_string();
        config.as_object_mut().unwrap().remove("shippingOffers");
        let without = config.to_string();
        let lines = format!(
            "[{},{}]",
            regular_line(
                "gid://shopify/CartLine/1",
                "gid://shopify/ProductVariant/50000000000001",
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
        let run_with = |config: &str| {
            let payload = cart_json_with_classes(&lines, "110.00", config, r#"["PRODUCT","ORDER"]"#);
            format!("{:?}", run_function_with_input(run, &payload).expect("valid input"))
        };
        let output = run_with(&with);
        assert!(output.contains("Add"), "fixture cart must exercise live offers");
        assert_eq!(output, run_with(&without));
    }
}
