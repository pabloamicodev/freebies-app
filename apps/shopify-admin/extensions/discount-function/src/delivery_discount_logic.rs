use crate::config::{minor_units, round_amount, to_cents, CompiledConfig, CompiledShippingOffer};
use crate::page_match::line_matches;
use crate::schema;
use schema::cart_delivery_options_discounts_generate_run::input::cart::{DeliveryGroups, Lines};
use schema::cart_delivery_options_discounts_generate_run::Input;
use shopify_function::Result;

/// Tiered shipping discounts by cart subtotal, with sitewide, landing-source,
/// and complete-quiz-bundle qualification modes.
pub fn run(input: Input) -> Result<schema::CartDeliveryOptionsDiscountsGenerateRunResult> {
    let has_shipping_discount = input
        .discount()
        .discount_classes()
        .iter()
        .any(|class| matches!(class, schema::DiscountClass::Shipping));
    if !has_shipping_discount {
        return Ok(empty_result());
    }

    let config = match parse_config(&input) {
        Some(c) => c,
        None => return Ok(empty_result()),
    };
    if config.shipping_offers.is_empty() {
        return Ok(empty_result());
    }

    let entered = entered_codes(&input);
    let accept = accept_operation(&config.shipping_offers, &entered);
    let mut result = apply_offers(&input, &config, &entered)?;
    if let Some(op) = accept {
        result.operations.insert(0, op);
    }
    Ok(result)
}

/// Entered codes, trimmed and deduped as typed, paired with their hash.
fn entered_codes(input: &Input) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for entered in input.entered_discount_codes() {
        let code = entered.code().trim_ascii();
        if code.is_empty() || out.iter().any(|(c, _)| c == code) {
            continue;
        }
        out.push((code.to_string(), code_hash(code)));
    }
    out
}

/// FNV-1a 64 over the ASCII-uppercased, trimmed code; first 12 lowercase hex digits.
pub fn code_hash(code: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in code.trim_ascii().bytes() {
        hash ^= u64::from(byte.to_ascii_uppercase());
        hash = hash.wrapping_mul(0x100000001b3);
    }
    let mut out = String::with_capacity(12);
    for i in 0..12 {
        let nibble = ((hash >> (60 - 4 * i)) & 0xf) as u8;
        out.push(char::from(if nibble < 10 { b'0' + nibble } else { b'a' + nibble - 10 }));
    }
    out
}

fn offer_has_code(offer: &CompiledShippingOffer, entered: &[(String, String)]) -> bool {
    entered
        .iter()
        .any(|(_, hash)| offer.code_hashes.iter().any(|h| h == hash))
}

fn accept_operation(
    offers: &[CompiledShippingOffer],
    entered: &[(String, String)],
) -> Option<schema::DeliveryOperation> {
    let codes: Vec<schema::DiscountCode> = entered
        .iter()
        .filter(|(_, hash)| {
            offers
                .iter()
                .any(|o| o.accept_codes && o.code_hashes.iter().any(|h| h == hash))
        })
        .map(|(code, _)| schema::DiscountCode { code: code.clone() })
        .collect();
    if codes.is_empty() {
        return None;
    }
    Some(schema::DeliveryOperation::EnteredDiscountCodesAccept(
        schema::EnteredDiscountCodesAcceptOperation { codes },
    ))
}

fn apply_offers(
    input: &Input,
    config: &CompiledConfig,
    entered: &[(String, String)],
) -> Result<schema::CartDeliveryOptionsDiscountsGenerateRunResult> {
    let delivery_groups = input.cart().delivery_groups();
    if delivery_groups.is_empty() {
        return Ok(empty_result());
    }

    let has_subscription_line = delivery_groups
        .iter()
        .any(delivery_group_has_subscription_line);

    let subtotal_currency = input
        .cart()
        .cost()
        .subtotal_amount()
        .currency_code()
        .to_string();
    // Tier thresholds and fixed amounts are in the shop currency; the cart is in the
    // presentment currency. Thresholds are minor units, so the rate also has to absorb a
    // zero-decimal (JPY/KRW) currency on either side.
    let rate = input.presentment_currency_rate().as_f64();
    let presentment_cents = qualifying_subtotal_cents(
        input.cart().lines(),
        input.cart().cost().subtotal_amount().amount().as_f64(),
        &subtotal_currency,
    );

    let mut offers = config.shipping_offers.clone();
    offers.sort_by(|left, right| {
        let left_scope_rank = if left.scope_mode == "sitewide" { 1 } else { 0 };
        let right_scope_rank = if right.scope_mode == "sitewide" { 1 } else { 0 };
        (left_scope_rank, left.priority, &left.id).cmp(&(
            right_scope_rank,
            right.priority,
            &right.id,
        ))
    });

    for offer in &offers {
        if !offer.code_hashes.is_empty() && !offer_has_code(offer, entered) {
            continue;
        }
        if !shipping_offer_qualifies(offer, input.cart().lines()) {
            continue;
        }
        let is_scoped = offer.scope_mode != "sitewide";
        let subtotal_cents = (presentment_cents as f64
            / cents_rate(rate, &subtotal_currency, &offer.currency_code))
        .floor() as i64;
        let value = tiered_delivery_discount_value(
            offer,
            subtotal_cents,
            has_subscription_line,
            rate,
            &subtotal_currency,
        );
        let Some(value) = value else {
            // A scoped (landing/quiz) offer that qualifies wins outright —
            // no falling through to a lower-priority or sitewide offer when
            // it simply has no matching tier (source: shippingDiscountResult
            // returns immediately once a scoped rule's gate passes).
            if is_scoped {
                return Ok(empty_result());
            }
            continue;
        };

        let eligible_groups = targeted_delivery_groups(offer, delivery_groups);
        if eligible_groups.is_empty() {
            if is_scoped {
                return Ok(empty_result());
            }
            continue;
        }

        return Ok(schema::CartDeliveryOptionsDiscountsGenerateRunResult {
            operations: vec![schema::DeliveryOperation::DeliveryDiscountsAdd(
                schema::DeliveryDiscountsAddOperation {
                    selection_strategy: schema::DeliveryDiscountSelectionStrategy::All,
                    candidates: vec![schema::DeliveryDiscountCandidate {
                        associated_discount_code: None,
                        message: offer.title.clone(),
                        targets: eligible_groups
                            .iter()
                            .map(|group| {
                                schema::DeliveryDiscountCandidateTarget::DeliveryGroup(
                                    schema::DeliveryGroupTarget {
                                        id: group.id().clone(),
                                    },
                                )
                            })
                            .collect(),
                        value,
                    }],
                },
            )],
        });
    }

    Ok(empty_result())
}

fn cents_rate(rate: f64, presentment_currency: &str, shop_currency: &str) -> f64 {
    let (presentment, shop) = (minor_units(presentment_currency), minor_units(shop_currency));
    if presentment == shop {
        rate
    } else {
        rate * presentment / shop
    }
}

/// Lines the offer's own rewards never apply to: gifts, cart-gift tiers and free quiz gifts.
fn is_gift_line(line: &Lines) -> bool {
    line.line_type_attribute()
        .and_then(|attribute| attribute.value())
        .is_some_and(|value| value == "gift")
        || line.cart_gift_tier_attribute().is_some()
        || line
            .quiz_free_gift_attribute()
            .and_then(|attribute| attribute.value())
            .is_some_and(|value| value == "true")
}

fn is_app_added_line(line: &Lines) -> bool {
    line.line_type_attribute()
        .and_then(|attribute| attribute.value())
        .is_some_and(|value| value == "gift" || value == "upsell")
}

/// D2: exclude mode needs at least one matched non-gift line; reject mode needs every
/// non-gift line matched (app-added gift/upsell lines are exempt from the reject check).
fn page_conditions_pass(offer: &CompiledShippingOffer, lines: &[Lines]) -> bool {
    if offer.page_url_conditions.is_empty() {
        return true;
    }
    let matches = |line: &Lines| {
        line_matches(
            line.promo_metadata()
                .and_then(|attribute| attribute.value())
                .map(|value| value.as_str()),
            &offer.page_url_conditions,
        )
    };
    let candidates = || {
        lines
            .iter()
            .filter(|line| *line.quantity() > 0 && !is_gift_line(line))
    };
    if !candidates().any(matches) {
        return false;
    }
    !offer.reject_unmatched_lines
        || candidates().all(|line| is_app_added_line(line) || matches(line))
}

fn shipping_offer_qualifies(offer: &CompiledShippingOffer, lines: &[Lines]) -> bool {
    if !page_conditions_pass(offer, lines) {
        return false;
    }
    match offer.scope_mode.as_str() {
        "landing" => {
            landing_anchor_quantity(offer, lines) >= offer.required_anchor_min_quantity.max(1)
        }
        "quiz_bundle" => has_complete_quiz_bundle(lines),
        _ => true,
    }
}

fn qualifying_subtotal_cents(lines: &[Lines], fallback_subtotal: f64, currency: &str) -> i64 {
    if lines.is_empty() {
        return to_cents(fallback_subtotal, currency);
    }

    lines
        .iter()
        .filter(|line| {
            let promo_gift = line
                .line_type_attribute()
                .and_then(|attribute| attribute.value())
                .map(|value| value == "gift")
                .unwrap_or(false);
            let cart_gift_tier = line.cart_gift_tier_attribute().is_some();
            let quiz_gift = line
                .quiz_free_gift_attribute()
                .and_then(|attribute| attribute.value())
                .map(|value| value == "true")
                .unwrap_or(false);
            !promo_gift && !cart_gift_tier && !quiz_gift
        })
        .map(|line| {
            let amount = line.cost().subtotal_amount().amount().as_f64();
            let line_currency = line.cost().subtotal_amount().currency_code().to_string();
            to_cents(amount, &line_currency)
        })
        .sum()
}

fn landing_anchor_quantity(offer: &CompiledShippingOffer, lines: &[Lines]) -> i64 {
    let Some(required_value) = offer.required_line_attribute_value.as_deref() else {
        return 0;
    };

    lines
        .iter()
        .filter(|line| {
            line.landing_source_attribute()
                .and_then(|attribute| attribute.value())
                .map(|value| value == required_value)
                .unwrap_or(false)
        })
        .filter(|line| {
            if offer.required_anchor_variant_ids.is_empty() {
                return true;
            }
            match line.merchandise() {
                schema::cart_delivery_options_discounts_generate_run::input::cart::lines::Merchandise::ProductVariant(variant) => {
                    offer.required_anchor_variant_ids.iter().any(|id| id == variant.id())
                }
                _ => false,
            }
        })
        .filter(|line| !offer.requires_anchor_subscription || line.selling_plan_allocation().is_some())
        .map(|line| i64::from(*line.quantity()))
        .sum()
}

fn has_complete_quiz_bundle(lines: &[Lines]) -> bool {
    use std::collections::HashMap;

    let mut groups: HashMap<String, (i64, Option<i64>)> = HashMap::new();
    for line in lines {
        let Some(bundle_id) = line
            .quiz_bundle_id_attribute()
            .and_then(|attribute| attribute.value())
            .cloned()
        else {
            continue;
        };
        let group = groups.entry(bundle_id).or_insert((0, None));
        let is_free_gift = line
            .quiz_free_gift_attribute()
            .and_then(|attribute| attribute.value())
            .map(|value| value == "true")
            .unwrap_or(false);
        if !is_free_gift {
            group.0 += 1;
        }
        if group.1.is_none() {
            group.1 = line
                .quiz_expected_paid_count_attribute()
                .and_then(|attribute| attribute.value())
                .and_then(|value| value.parse::<i64>().ok());
        }
    }

    groups
        .values()
        .any(|(paid_line_count, expected)| expected.is_some_and(|count| *paid_line_count >= count))
}

fn empty_result() -> schema::CartDeliveryOptionsDiscountsGenerateRunResult {
    schema::CartDeliveryOptionsDiscountsGenerateRunResult { operations: vec![] }
}

/// CartDeliveryGroupType::ONE_TIME_PURCHASE covers "a one-time purchase OR a
/// FIRST delivery of subscription merchandise" — only SUBSCRIPTION is
/// exclusively recurring shipments — so we check the group's own lines for a
/// selling plan rather than trusting groupType alone (matches hpn's
/// deliveryGroupHasSubscriptionLine).
fn delivery_group_has_subscription_line(group: &DeliveryGroups) -> bool {
    group
        .cart_lines()
        .iter()
        .any(|line| line.selling_plan_allocation().is_some())
}

fn tiered_delivery_discount_value(
    offer: &CompiledShippingOffer,
    subtotal_cents: i64,
    has_subscription_line: bool,
    rate: f64,
    presentment_currency: &str,
) -> Option<schema::DeliveryDiscountCandidateValue> {
    let active_condition = if has_subscription_line {
        "has_subscription"
    } else {
        "one_time_only"
    };

    let matching_tier = offer
        .tiers
        .iter()
        .filter(|tier| match tier.applies_when.as_deref() {
            Some(condition) if condition == "has_subscription" || condition == "one_time_only" => {
                condition == active_condition
            }
            _ => true,
        })
        .filter(|tier| {
            subtotal_cents >= tier.minimum_subtotal_cents
                && tier
                    .maximum_subtotal_cents
                    .is_none_or(|maximum| subtotal_cents <= maximum)
        })
        .max_by_key(|tier| tier.minimum_subtotal_cents)?;

    // The highest qualifying tier is selected first; only then do we check its
    // own value. A 0% tier must not fall through to a lower, non-zero tier.
    if matching_tier.discount_value <= 0.0 {
        return None;
    }

    match matching_tier.discount_type.as_str() {
        "percentage" => Some(schema::DeliveryDiscountCandidateValue::Percentage(
            schema::Percentage {
                value: shopify_function::scalars::Decimal(matching_tier.discount_value.min(100.0)),
            },
        )),
        "fixed_amount" => {
            let amount = round_amount(matching_tier.discount_value * rate, presentment_currency);
            if amount <= 0.0 {
                return None;
            }
            Some(schema::DeliveryDiscountCandidateValue::FixedAmount(
                schema::FixedAmount {
                    amount: shopify_function::scalars::Decimal(amount),
                },
            ))
        }
        _ => None,
    }
}

fn targeted_delivery_groups<'a>(
    offer: &CompiledShippingOffer,
    delivery_groups: &'a [DeliveryGroups],
) -> Vec<&'a DeliveryGroups> {
    let Some(configured_group_types) = &offer.target_group_types else {
        return delivery_groups.iter().collect();
    };
    if configured_group_types.is_empty() {
        return vec![];
    }

    let include_one_time = configured_group_types
        .iter()
        .any(|t| t == "ONE_TIME_PURCHASE");
    let include_subscription = configured_group_types.iter().any(|t| t == "SUBSCRIPTION");

    delivery_groups
        .iter()
        .filter(|group| {
            if matches!(
                group.group_type(),
                schema::CartDeliveryGroupType::Subscription
            ) || delivery_group_has_subscription_line(group)
            {
                include_subscription
            } else {
                include_one_time
            }
        })
        .collect()
}

fn parse_config(input: &Input) -> Option<CompiledConfig> {
    let value = input.discount().metafield()?.value();
    serde_json::from_str(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::run_function_with_input;

    fn shipping_config(offers_json: &str) -> String {
        format!(r#"{{"offers":[],"shippingOffers":{offers_json}}}"#)
    }

    fn one_tier_offer(
        min_cents: i64,
        discount_type: &str,
        value: f64,
        applies_when: &str,
    ) -> String {
        let applies_when_json = if applies_when.is_empty() {
            "null".to_string()
        } else {
            format!(r#""{applies_when}""#)
        };
        format!(
            r#"{{
                "id":"ship-1","priority":100,"targetGroupTypes":null,
                "tiers":[{{"minimumSubtotalCents":{min_cents},"discountType":"{discount_type}","discountValue":{value},"appliesWhen":{applies_when_json}}}]
            }}"#
        )
    }

    fn payload(discount_classes: &str, subtotal: &str, config: &str, groups_json: &str) -> String {
        payload_with_lines(discount_classes, subtotal, config, groups_json, "[]")
    }

    fn payload_with_lines(
        discount_classes: &str,
        subtotal: &str,
        config: &str,
        groups_json: &str,
        lines_json: &str,
    ) -> String {
        payload_full(discount_classes, subtotal, config, groups_json, lines_json, "[]")
    }

    fn payload_full(
        discount_classes: &str,
        subtotal: &str,
        config: &str,
        groups_json: &str,
        lines_json: &str,
        codes_json: &str,
    ) -> String {
        format!(
            r#"{{
                "presentmentCurrencyRate": "1.0",
                "enteredDiscountCodes": {codes_json},
                "discount": {{
                    "discountClasses": {discount_classes},
                    "metafield": {{ "value": {config} }}
                }},
                "cart": {{
                    "cost": {{ "subtotalAmount": {{ "amount": "{subtotal}", "currencyCode": "USD" }} }},
                    "lines": {lines_json},
                    "deliveryGroups": {groups_json}
                }}
            }}"#,
            config = serde_json::to_string(config).unwrap(),
        )
    }

    fn group(id: &str, group_type: &str, has_subscription_line: bool) -> String {
        let selling_plan_allocation = if has_subscription_line {
            r#"{"sellingPlan": {"id": "gid://shopify/SellingPlan/1"}}"#
        } else {
            "null"
        };
        format!(
            r#"{{
                "id": "{id}", "groupType": "{group_type}",
                "cartLines": [{{ "sellingPlanAllocation": {selling_plan_allocation} }}]
            }}"#
        )
    }

    fn run_with(
        discount_classes: &str,
        subtotal: &str,
        config: &str,
        groups_json: &str,
    ) -> schema::CartDeliveryOptionsDiscountsGenerateRunResult {
        let json = payload(discount_classes, subtotal, config, groups_json);
        run_function_with_input(super::run, &json).expect("should not error")
    }

    fn run_with_lines(
        discount_classes: &str,
        subtotal: &str,
        config: &str,
        groups_json: &str,
        lines_json: &str,
    ) -> schema::CartDeliveryOptionsDiscountsGenerateRunResult {
        let json = payload_with_lines(discount_classes, subtotal, config, groups_json, lines_json);
        run_function_with_input(super::run, &json).expect("should not error")
    }

    fn run_with_codes(
        config: &str,
        codes: &[&str],
    ) -> schema::CartDeliveryOptionsDiscountsGenerateRunResult {
        let codes_json = format!(
            "[{}]",
            codes
                .iter()
                .map(|c| format!(r#"{{"code":{}}}"#, serde_json::to_string(c).unwrap()))
                .collect::<Vec<_>>()
                .join(",")
        );
        let groups = format!(
            "[{}]",
            group("gid://shopify/CartDeliveryGroup/1", "ONE_TIME_PURCHASE", false)
        );
        let json = payload_full(r#"["SHIPPING"]"#, "10.00", config, &groups, "[]", &codes_json);
        run_function_with_input(super::run, &json).expect("should not error")
    }

    fn coded_offer(id: &str, priority: i32, pct: f64, extra: &str) -> String {
        format!(
            r#"{{"id":"{id}","priority":{priority},"targetGroupTypes":null,{extra}
            "tiers":[{{"minimumSubtotalCents":0,"discountType":"percentage","discountValue":{pct},"appliesWhen":null}}]}}"#
        )
    }

    fn discount_pct(result: &schema::CartDeliveryOptionsDiscountsGenerateRunResult) -> Option<f64> {
        result.operations.iter().find_map(|op| match op {
            schema::DeliveryOperation::DeliveryDiscountsAdd(add) => {
                match &add.candidates[0].value {
                    schema::DeliveryDiscountCandidateValue::Percentage(p) => Some(p.value.0),
                    _ => None,
                }
            }
            _ => None,
        })
    }

    fn accepted(result: &schema::CartDeliveryOptionsDiscountsGenerateRunResult) -> Vec<String> {
        result
            .operations
            .iter()
            .filter_map(|op| match op {
                schema::DeliveryOperation::EnteredDiscountCodesAccept(a) => {
                    Some(a.codes.iter().map(|c| c.code.clone()).collect::<Vec<_>>())
                }
                _ => None,
            })
            .flatten()
            .collect()
    }

    #[test]
    fn code_hash_vectors() {
        assert_eq!(code_hash("SUMMER10"), "9e35947c8d25");
        assert_eq!(code_hash("VIP-2026"), "e8cf18d732cc");
        assert_eq!(code_hash("A"), "af63fc4c8602");
        assert_eq!(code_hash("AMAZON_PROMO"), "5f2c120b2677");
        assert_eq!(code_hash("  summer10 "), "9e35947c8d25");
    }

    #[test]
    fn gated_offer_needs_its_code() {
        let config = shipping_config(&format!(
            "[{}]",
            coded_offer("g", 1, 100.0, r#""codeHashes":["9e35947c8d25"],"#)
        ));
        assert_eq!(discount_pct(&run_with_codes(&config, &["SUMMER10"])), Some(100.0));
        assert_eq!(discount_pct(&run_with_codes(&config, &[])), None);
        assert_eq!(discount_pct(&run_with_codes(&config, &["WRONG"])), None);
        assert_eq!(discount_pct(&run_with_codes(&config, &["  summer10  "])), Some(100.0));
        assert_eq!(discount_pct(&run_with_codes(&config, &["nope", "Summer10"])), Some(100.0));
    }

    #[test]
    fn gated_and_ungated_offers_coexist() {
        let config = shipping_config(&format!(
            "[{},{}]",
            coded_offer("gated", 1, 100.0, r#""codeHashes":["9e35947c8d25"],"#),
            coded_offer("open", 2, 10.0, "")
        ));
        assert_eq!(discount_pct(&run_with_codes(&config, &[])), Some(10.0));
        assert_eq!(discount_pct(&run_with_codes(&config, &["SUMMER10"])), Some(100.0));
    }

    #[test]
    fn gated_scoped_offer_without_code_does_not_block_sitewide() {
        let scoped = coded_offer(
            "quiz",
            1,
            50.0,
            r#""scopeMode":"quiz_bundle","codeHashes":["9e35947c8d25"],"#,
        );
        let config = shipping_config(&format!("[{scoped},{}]", coded_offer("open", 2, 10.0, "")));
        let bundle = r#"[{"quantity":1,"cost":{"subtotalAmount":{"amount":"4.00","currencyCode":"USD"}},"lineTypeAttribute":null,"cartGiftTierAttribute":null,"landingSourceAttribute":null,"quizBundleIdAttribute":{"value":"q"},"quizFreeGiftAttribute":{"value":"false"},"quizExpectedPaidCountAttribute":{"value":"1"},"sellingPlanAllocation":null,"merchandise":{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/1"}}]"#;
        let groups = format!(
            "[{}]",
            group("gid://shopify/CartDeliveryGroup/1", "ONE_TIME_PURCHASE", false)
        );
        let run = |codes: &str| {
            let json = payload_full(r#"["SHIPPING"]"#, "10.00", &config, &groups, bundle, codes);
            run_function_with_input(super::run, &json).unwrap()
        };
        assert_eq!(discount_pct(&run("[]")), Some(10.0));
        assert_eq!(discount_pct(&run(r#"[{"code":"summer10"}]"#)), Some(50.0));
    }

    #[test]
    fn accept_codes_offer_emits_accept_first_with_and_without_discount() {
        let config = shipping_config(&format!(
            "[{}]",
            coded_offer("g", 1, 100.0, r#""codeHashes":["9e35947c8d25"],"acceptCodes":true,"#)
        ));
        let result = run_with_codes(&config, &[" summer10 ", "summer10", "WRONG"]);
        assert!(matches!(
            result.operations[0],
            schema::DeliveryOperation::EnteredDiscountCodesAccept(_)
        ));
        assert_eq!(accepted(&result), vec!["summer10".to_string()]);
        assert_eq!(discount_pct(&result), Some(100.0));

        let failing_tier = r#"{"id":"g","priority":1,"targetGroupTypes":null,"codeHashes":["9e35947c8d25"],"acceptCodes":true,
            "tiers":[{"minimumSubtotalCents":999999,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}]}"#;
        let config = shipping_config(&format!("[{failing_tier}]"));
        let result = run_with_codes(&config, &["SUMMER10"]);
        assert_eq!(accepted(&result), vec!["SUMMER10".to_string()]);
        assert_eq!(discount_pct(&result), None);

        assert!(run_with_codes(&config, &["WRONG"]).operations.is_empty());
        assert!(run_with_codes(&config, &[]).operations.is_empty());
    }

    #[test]
    fn non_accept_offers_never_emit_accept() {
        let config = shipping_config(&format!(
            "[{}]",
            coded_offer("g", 1, 100.0, r#""codeHashes":["9e35947c8d25"],"#)
        ));
        let result = run_with_codes(&config, &["SUMMER10"]);
        assert!(accepted(&result).is_empty());
        assert_eq!(discount_pct(&result), Some(100.0));
    }

    #[test]
    fn offers_without_codes_ignore_entered_codes() {
        let config = shipping_config(&format!("[{}]", coded_offer("open", 1, 10.0, "")));
        let result = run_with_codes(&config, &["SUMMER10"]);
        assert!(accepted(&result).is_empty());
        assert_eq!(discount_pct(&result), Some(10.0));
    }

    #[test]
    fn no_op_without_shipping_discount_class() {
        let config = shipping_config(&format!("[{}]", one_tier_offer(0, "percentage", 100.0, "")));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result = run_with(r#"["PRODUCT"]"#, "80.00", &config, &groups);
        assert!(result.operations.is_empty());
    }

    #[test]
    fn no_op_with_no_shipping_offers_configured() {
        let config = shipping_config("[]");
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result = run_with(r#"["SHIPPING"]"#, "80.00", &config, &groups);
        assert!(result.operations.is_empty());
    }

    #[test]
    fn no_op_with_no_delivery_groups() {
        let config = shipping_config(&format!("[{}]", one_tier_offer(0, "percentage", 100.0, "")));
        let result = run_with(r#"["SHIPPING"]"#, "80.00", &config, "[]");
        assert!(result.operations.is_empty());
    }

    #[test]
    fn applies_percentage_discount_when_subtotal_meets_threshold() {
        let config = shipping_config(&format!(
            "[{}]",
            one_tier_offer(5000, "percentage", 100.0, "")
        ));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result = run_with(r#"["SHIPPING"]"#, "80.00", &config, &groups);

        assert_eq!(result.operations.len(), 1);
        match &result.operations[0] {
            schema::DeliveryOperation::DeliveryDiscountsAdd(op) => {
                assert_eq!(op.candidates.len(), 1);
                assert_eq!(op.candidates[0].targets.len(), 1);
                match &op.candidates[0].value {
                    schema::DeliveryDiscountCandidateValue::Percentage(p) => {
                        assert_eq!(p.value.0, 100.0)
                    }
                    other => panic!("expected Percentage, got {other:?}"),
                }
            }
            other => panic!("expected DeliveryDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn no_discount_below_threshold() {
        let config = shipping_config(&format!(
            "[{}]",
            one_tier_offer(5000, "percentage", 100.0, "")
        ));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result = run_with(r#"["SHIPPING"]"#, "30.00", &config, &groups);
        assert!(result.operations.is_empty());
    }

    #[test]
    fn no_discount_above_explicit_tier_maximum() {
        let offer = r#"{
            "id":"ship-1","priority":100,"targetGroupTypes":null,
            "tiers":[{"minimumSubtotalCents":0,"maximumSubtotalCents":4999,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}]
        }"#;
        let config = shipping_config(&format!("[{offer}]"));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result = run_with(r#"["SHIPPING"]"#, "60.00", &config, &groups);
        assert!(result.operations.is_empty());
    }

    #[test]
    fn highest_qualifying_tier_wins() {
        let offer =
            r#"{
                "id":"ship-1","priority":100,"targetGroupTypes":null,
                "tiers":[
                    {"minimumSubtotalCents":0,"discountType":"percentage","discountValue":10.0,"appliesWhen":null},
                    {"minimumSubtotalCents":5000,"discountType":"percentage","discountValue":50.0,"appliesWhen":null},
                    {"minimumSubtotalCents":10000,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}
                ]
            }"#.to_string();
        let config = shipping_config(&format!("[{offer}]"));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result = run_with(r#"["SHIPPING"]"#, "80.00", &config, &groups);

        match &result.operations[0] {
            schema::DeliveryOperation::DeliveryDiscountsAdd(op) => match &op.candidates[0].value {
                schema::DeliveryDiscountCandidateValue::Percentage(p) => {
                    assert_eq!(p.value.0, 50.0)
                }
                other => panic!("expected Percentage, got {other:?}"),
            },
            other => panic!("expected DeliveryDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn fixed_amount_discount_type() {
        let config = shipping_config(&format!(
            "[{}]",
            one_tier_offer(0, "fixed_amount", 1.99, "")
        ));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result = run_with(r#"["SHIPPING"]"#, "10.00", &config, &groups);

        match &result.operations[0] {
            schema::DeliveryOperation::DeliveryDiscountsAdd(op) => match &op.candidates[0].value {
                schema::DeliveryDiscountCandidateValue::FixedAmount(a) => {
                    assert_eq!(a.amount.0, 1.99)
                }
                other => panic!("expected FixedAmount, got {other:?}"),
            },
            other => panic!("expected DeliveryDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn has_subscription_tier_only_matches_when_cart_has_a_subscription_line() {
        let config = shipping_config(&format!(
            "[{}]",
            one_tier_offer(0, "percentage", 100.0, "has_subscription")
        ));

        let one_time_groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result_one_time = run_with(r#"["SHIPPING"]"#, "10.00", &config, &one_time_groups);
        assert!(
            result_one_time.operations.is_empty(),
            "should not match a one-time-only cart"
        );

        let subscription_groups = format!(
            "[{}]",
            group("gid://shopify/CartDeliveryGroup/1", "SUBSCRIPTION", true)
        );
        let result_subscription =
            run_with(r#"["SHIPPING"]"#, "10.00", &config, &subscription_groups);
        assert_eq!(
            result_subscription.operations.len(),
            1,
            "should match a cart with a subscription line"
        );
    }

    #[test]
    fn one_time_only_tier_does_not_match_when_cart_has_a_subscription_line() {
        let config = shipping_config(&format!(
            "[{}]",
            one_tier_offer(0, "percentage", 100.0, "one_time_only")
        ));
        let groups = format!(
            "[{}]",
            group("gid://shopify/CartDeliveryGroup/1", "SUBSCRIPTION", true)
        );
        let result = run_with(r#"["SHIPPING"]"#, "10.00", &config, &groups);
        assert!(result.operations.is_empty());
    }

    #[test]
    fn tier_with_no_applies_when_matches_regardless_of_subscription_state() {
        let config = shipping_config(&format!("[{}]", one_tier_offer(0, "percentage", 100.0, "")));
        let sub_groups = format!(
            "[{}]",
            group("gid://shopify/CartDeliveryGroup/1", "SUBSCRIPTION", true)
        );
        let result = run_with(r#"["SHIPPING"]"#, "10.00", &config, &sub_groups);
        assert_eq!(result.operations.len(), 1);
    }

    #[test]
    fn target_group_types_restricts_which_groups_get_the_candidate() {
        let offer = r#"{
            "id":"ship-1","priority":100,"targetGroupTypes":["SUBSCRIPTION"],
            "tiers":[{"minimumSubtotalCents":0,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}]
        }"#;
        let config = shipping_config(&format!("[{offer}]"));
        let groups = format!(
            "[{},{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            ),
            group("gid://shopify/CartDeliveryGroup/2", "SUBSCRIPTION", true),
        );
        let result = run_with(r#"["SHIPPING"]"#, "10.00", &config, &groups);

        match &result.operations[0] {
            schema::DeliveryOperation::DeliveryDiscountsAdd(op) => {
                assert_eq!(op.candidates[0].targets.len(), 1);
                match &op.candidates[0].targets[0] {
                    schema::DeliveryDiscountCandidateTarget::DeliveryGroup(t) => {
                        assert_eq!(t.id, "gid://shopify/CartDeliveryGroup/2");
                    }
                    other => panic!("expected DeliveryGroup target, got {other:?}"),
                }
            }
            other => panic!("expected DeliveryDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn empty_target_group_types_matches_no_groups() {
        let offer = r#"{
            "id":"ship-1","priority":100,"targetGroupTypes":[],
            "tiers":[{"minimumSubtotalCents":0,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}]
        }"#;
        let config = shipping_config(&format!("[{offer}]"));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result = run_with(r#"["SHIPPING"]"#, "10.00", &config, &groups);
        assert!(result.operations.is_empty());
    }

    #[test]
    fn first_matching_offer_by_priority_wins() {
        let low_priority_offer = r#"{
            "id":"ship-low","priority":1,"targetGroupTypes":null,
            "tiers":[{"minimumSubtotalCents":0,"discountType":"percentage","discountValue":10.0,"appliesWhen":null}]
        }"#;
        let high_priority_offer = r#"{
            "id":"ship-high","priority":100,"targetGroupTypes":null,
            "tiers":[{"minimumSubtotalCents":0,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}]
        }"#;
        let config = shipping_config(&format!("[{low_priority_offer},{high_priority_offer}]"));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result = run_with(r#"["SHIPPING"]"#, "10.00", &config, &groups);

        match &result.operations[0] {
            schema::DeliveryOperation::DeliveryDiscountsAdd(op) => match &op.candidates[0].value {
                schema::DeliveryDiscountCandidateValue::Percentage(p) => {
                    assert_eq!(p.value.0, 10.0)
                }
                other => panic!("expected Percentage, got {other:?}"),
            },
            other => panic!("expected DeliveryDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn falls_through_to_a_lower_priority_offer_when_a_higher_one_has_no_matching_tier() {
        let non_matching_offer = r#"{
            "id":"ship-1","priority":1,"targetGroupTypes":null,
            "tiers":[{"minimumSubtotalCents":999999,"discountType":"percentage","discountValue":10.0,"appliesWhen":null}]
        }"#;
        let matching_offer = r#"{
            "id":"ship-2","priority":2,"targetGroupTypes":null,
            "tiers":[{"minimumSubtotalCents":0,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}]
        }"#;
        let config = shipping_config(&format!("[{non_matching_offer},{matching_offer}]"));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result = run_with(r#"["SHIPPING"]"#, "10.00", &config, &groups);

        match &result.operations[0] {
            schema::DeliveryOperation::DeliveryDiscountsAdd(op) => match &op.candidates[0].value {
                schema::DeliveryDiscountCandidateValue::Percentage(p) => {
                    assert_eq!(p.value.0, 100.0)
                }
                other => panic!("expected Percentage, got {other:?}"),
            },
            other => panic!("expected DeliveryDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn landing_scope_requires_matching_anchor_lines() {
        let offer = r#"{
            "id":"landing","priority":100,"scopeMode":"landing",
            "requiredLineAttributeValue":"tru-landing",
            "requiredAnchorVariantIds":["gid://shopify/ProductVariant/11"],
            "requiredAnchorMinQuantity":2,"requiresAnchorSubscription":true,
            "targetGroupTypes":["SUBSCRIPTION"],
            "tiers":[{"minimumSubtotalCents":0,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}]
        }"#;
        let config = shipping_config(&format!("[{offer}]"));
        let groups = format!(
            "[{}]",
            group("gid://shopify/CartDeliveryGroup/1", "SUBSCRIPTION", true)
        );
        let incomplete_line = r#"[{
            "quantity":1,
            "cost":{"subtotalAmount":{"amount":"10.00","currencyCode":"USD"}},
            "lineTypeAttribute":null,"cartGiftTierAttribute":null,
            "landingSourceAttribute":{"value":"tru-landing"},
            "quizBundleIdAttribute":null,"quizFreeGiftAttribute":null,"quizExpectedPaidCountAttribute":null,
            "sellingPlanAllocation":{"sellingPlan":{"id":"gid://shopify/SellingPlan/1"}},
            "merchandise":{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/11"}
        }]"#;
        let complete_line = incomplete_line.replace("\"quantity\":1", "\"quantity\":2");

        let incomplete = run_with_lines(
            r#"["SHIPPING"]"#,
            "10.00",
            &config,
            &groups,
            incomplete_line,
        );
        assert!(incomplete.operations.is_empty());

        let complete = run_with_lines(r#"["SHIPPING"]"#, "10.00", &config, &groups, &complete_line);
        assert_eq!(complete.operations.len(), 1);
    }

    #[test]
    fn complete_quiz_bundle_qualifies_and_beats_sitewide_offer() {
        let sitewide = r#"{
            "id":"sitewide","priority":1,"scopeMode":"sitewide","targetGroupTypes":null,
            "tiers":[{"minimumSubtotalCents":0,"discountType":"percentage","discountValue":10.0,"appliesWhen":null}]
        }"#;
        let quiz = r#"{
            "id":"quiz","priority":999,"scopeMode":"quiz_bundle","targetGroupTypes":null,
            "tiers":[{"minimumSubtotalCents":0,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}]
        }"#;
        let config = shipping_config(&format!("[{sitewide},{quiz}]"));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let complete_bundle = r#"[
          {"quantity":1,"cost":{"subtotalAmount":{"amount":"4.00","currencyCode":"USD"}},"lineTypeAttribute":null,"cartGiftTierAttribute":null,"landingSourceAttribute":null,"quizBundleIdAttribute":{"value":"quiz-1"},"quizFreeGiftAttribute":{"value":"false"},"quizExpectedPaidCountAttribute":{"value":"2"},"sellingPlanAllocation":null,"merchandise":{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/1"}},
          {"quantity":1,"cost":{"subtotalAmount":{"amount":"4.00","currencyCode":"USD"}},"lineTypeAttribute":null,"cartGiftTierAttribute":null,"landingSourceAttribute":null,"quizBundleIdAttribute":{"value":"quiz-1"},"quizFreeGiftAttribute":{"value":"false"},"quizExpectedPaidCountAttribute":{"value":"2"},"sellingPlanAllocation":null,"merchandise":{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/2"}},
          {"quantity":1,"cost":{"subtotalAmount":{"amount":"2.00","currencyCode":"USD"}},"lineTypeAttribute":null,"cartGiftTierAttribute":null,"landingSourceAttribute":null,"quizBundleIdAttribute":{"value":"quiz-1"},"quizFreeGiftAttribute":{"value":"true"},"quizExpectedPaidCountAttribute":{"value":"2"},"sellingPlanAllocation":null,"merchandise":{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/3"}}
        ]"#;
        let result = run_with_lines(
            r#"["SHIPPING"]"#,
            "10.00",
            &config,
            &groups,
            complete_bundle,
        );

        match &result.operations[0] {
            schema::DeliveryOperation::DeliveryDiscountsAdd(op) => match &op.candidates[0].value {
                schema::DeliveryDiscountCandidateValue::Percentage(p) => {
                    assert_eq!(p.value.0, 100.0)
                }
                other => panic!("expected Percentage, got {other:?}"),
            },
            other => panic!("expected DeliveryDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn cart_gift_tier_value_does_not_unlock_a_shipping_threshold() {
        let offer = one_tier_offer(5000, "percentage", 100.0, "");
        let config = shipping_config(&format!("[{offer}]"));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let lines = r#"[
          {"quantity":1,"cost":{"subtotalAmount":{"amount":"40.00","currencyCode":"USD"}},"lineTypeAttribute":null,"cartGiftTierAttribute":null,"landingSourceAttribute":null,"quizBundleIdAttribute":null,"quizFreeGiftAttribute":null,"quizExpectedPaidCountAttribute":null,"sellingPlanAllocation":null,"merchandise":{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/paid"}},
          {"quantity":1,"cost":{"subtotalAmount":{"amount":"20.00","currencyCode":"USD"}},"lineTypeAttribute":null,"cartGiftTierAttribute":{"value":"tier-1"},"landingSourceAttribute":null,"quizBundleIdAttribute":null,"quizFreeGiftAttribute":null,"quizExpectedPaidCountAttribute":null,"sellingPlanAllocation":null,"merchandise":{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/gift"}}
        ]"#;
        let result = run_with_lines(r#"["SHIPPING"]"#, "60.00", &config, &groups, lines);
        assert!(result.operations.is_empty());
    }

    #[test]
    fn landing_shipping_beats_sitewide_regardless_of_priority_or_size() {
        let sitewide = r#"{
            "id":"sitewide","priority":1,"scopeMode":"sitewide","targetGroupTypes":null,
            "tiers":[{"minimumSubtotalCents":0,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}]
        }"#;
        let landing = r#"{
            "id":"landing","priority":999,"scopeMode":"landing",
            "requiredLineAttributeValue":"lp","requiredAnchorVariantIds":[],"requiredAnchorMinQuantity":1,
            "targetGroupTypes":null,
            "tiers":[{"minimumSubtotalCents":2000,"discountType":"percentage","discountValue":25.0,"appliesWhen":null}]
        }"#;
        let config = shipping_config(&format!("[{sitewide},{landing}]"));
        let groups = format!("[{}]", group("gid://shopify/CartDeliveryGroup/1", "ONE_TIME_PURCHASE", false));
        let line = |source: &str, amount: &str| {
            let attribute = if source.is_empty() { "null".to_string() } else { format!(r#"{{"value":"{source}"}}"#) };
            format!(
                r#"[{{"quantity":1,"cost":{{"subtotalAmount":{{"amount":"{amount}","currencyCode":"USD"}}}},"lineTypeAttribute":null,"cartGiftTierAttribute":null,"landingSourceAttribute":{attribute},"quizBundleIdAttribute":null,"quizFreeGiftAttribute":null,"quizExpectedPaidCountAttribute":null,"sellingPlanAllocation":null,"merchandise":{{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/1"}}}}]"#
            )
        };
        let percentage = |result: &schema::CartDeliveryOptionsDiscountsGenerateRunResult| -> f64 {
            let schema::DeliveryOperation::DeliveryDiscountsAdd(op) = &result.operations[0] else {
                panic!("expected a delivery discount");
            };
            match &op.candidates[0].value {
                schema::DeliveryDiscountCandidateValue::Percentage(pct) => pct.value.0,
                other => panic!("expected percentage, got {other:?}"),
            }
        };

        let landing_cart = run_with_lines(r#"["SHIPPING"]"#, "30.00", &config, &groups, &line("lp", "30.00"));
        assert_eq!(percentage(&landing_cart), 25.0, "landing rule must win over the bigger sitewide one");

        let plain_cart = run_with_lines(r#"["SHIPPING"]"#, "30.00", &config, &groups, &line("", "30.00"));
        assert_eq!(percentage(&plain_cart), 100.0, "carts without the landing source get the sitewide rule");

        let below_landing_tier = run_with_lines(r#"["SHIPPING"]"#, "10.00", &config, &groups, &line("lp", "10.00"));
        assert!(
            below_landing_tier.operations.is_empty(),
            "a qualifying landing cart with no matching tier gets no discount, not a sitewide fallback"
        );
    }

    #[test]
    fn zero_percent_highest_tier_wins_and_yields_no_discount() {
        let offer = r#"{
            "id":"ship-1","priority":100,"targetGroupTypes":null,
            "tiers":[
                {"minimumSubtotalCents":0,"discountType":"percentage","discountValue":50.0,"appliesWhen":null},
                {"minimumSubtotalCents":5000,"discountType":"percentage","discountValue":0.0,"appliesWhen":null}
            ]
        }"#;
        let config = shipping_config(&format!("[{offer}]"));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result = run_with(r#"["SHIPPING"]"#, "80.00", &config, &groups);
        assert!(
            result.operations.is_empty(),
            "the highest qualifying tier is 0% — it must win, not fall through to the 50% tier"
        );
    }

    #[test]
    fn shipping_candidate_message_is_the_offer_title() {
        let offer = one_tier_offer(0, "percentage", 100.0, "").replace(
            "\"id\":\"ship-1\"",
            "\"id\":\"ship-1\",\"title\":\"Free shipping over $50\"",
        );
        let config = shipping_config(&format!("[{offer}]"));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let result = run_with(r#"["SHIPPING"]"#, "10.00", &config, &groups);
        match &result.operations[0] {
            schema::DeliveryOperation::DeliveryDiscountsAdd(op) => {
                assert_eq!(
                    op.candidates[0].message.as_deref(),
                    Some("Free shipping over $50")
                );
            }
            other => panic!("expected DeliveryDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn scoped_offer_qualifying_with_no_matching_tier_returns_no_discount() {
        let sitewide = r#"{
            "id":"sitewide","priority":1,"scopeMode":"sitewide","targetGroupTypes":null,
            "tiers":[{"minimumSubtotalCents":0,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}]
        }"#;
        let quiz = r#"{
            "id":"quiz","priority":999,"scopeMode":"quiz_bundle","targetGroupTypes":null,
            "tiers":[{"minimumSubtotalCents":999999,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}]
        }"#;
        let config = shipping_config(&format!("[{sitewide},{quiz}]"));
        let groups = format!(
            "[{}]",
            group(
                "gid://shopify/CartDeliveryGroup/1",
                "ONE_TIME_PURCHASE",
                false
            )
        );
        let complete_bundle = r#"[
          {"quantity":1,"cost":{"subtotalAmount":{"amount":"4.00","currencyCode":"USD"}},"lineTypeAttribute":null,"cartGiftTierAttribute":null,"landingSourceAttribute":null,"quizBundleIdAttribute":{"value":"quiz-1"},"quizFreeGiftAttribute":{"value":"false"},"quizExpectedPaidCountAttribute":{"value":"1"},"sellingPlanAllocation":null,"merchandise":{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/1"}}
        ]"#;
        let result = run_with_lines(r#"["SHIPPING"]"#, "10.00", &config, &groups, complete_bundle);
        assert!(
            result.operations.is_empty(),
            "the qualifying quiz-bundle offer has no matching tier, so it must not fall back to sitewide"
        );
    }

    // ── D2: page conditions on shipping offers ──────────────────────────────

    fn page_line(line_type: Option<&str>, page: Option<&str>, amount: &str) -> String {
        let line_type = line_type
            .map(|t| format!(r#"{{"value":"{t}"}}"#))
            .unwrap_or_else(|| "null".to_string());
        let metadata = page
            .map(|p| {
                let raw = serde_json::json!({ "_promo_page_url": p }).to_string();
                format!(r#"{{"value":{}}}"#, serde_json::to_string(&raw).unwrap())
            })
            .unwrap_or_else(|| "null".to_string());
        format!(
            r#"{{"quantity":1,"cost":{{"subtotalAmount":{{"amount":"{amount}","currencyCode":"USD"}}}},"lineTypeAttribute":{line_type},"cartGiftTierAttribute":null,"landingSourceAttribute":null,"quizBundleIdAttribute":null,"quizFreeGiftAttribute":null,"quizExpectedPaidCountAttribute":null,"promoMetadata":{metadata},"sellingPlanAllocation":null,"merchandise":{{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/1"}}}}"#
        )
    }

    fn page_offer(extra: &str) -> String {
        format!(
            r#"{{"id":"p","priority":1,"targetGroupTypes":null,
            "pageUrlConditions":[{{"patterns":["/pages/sale"],"matchMode":"exact","caseSensitive":false}}],{extra}
            "tiers":[{{"minimumSubtotalCents":5000,"discountType":"percentage","discountValue":100.0,"appliesWhen":null}}]}}"#
        )
    }

    fn run_page(offer: &str, lines: &[String]) -> bool {
        let config = shipping_config(&format!("[{offer}]"));
        let groups = format!("[{}]", group("gid://shopify/CartDeliveryGroup/1", "ONE_TIME_PURCHASE", false));
        let lines_json = format!("[{}]", lines.join(","));
        // The cart subtotal comes from the lines; 60 USD in all cases so the 50 USD tier is met.
        !run_with_lines(r#"["SHIPPING"]"#, "60.00", &config, &groups, &lines_json)
            .operations
            .is_empty()
    }

    #[test]
    fn exclude_mode_needs_one_matched_non_gift_line_and_thresholds_count_the_whole_cart() {
        let offer = page_offer("");
        let matched = page_line(None, Some("/pages/sale?utm_source=x"), "20.00");
        let other = page_line(None, Some("/products/y"), "40.00");
        let unstamped = page_line(None, None, "40.00");
        // 60 USD cart, only 20 USD of it matched: the 50 USD tier is still met.
        assert!(run_page(&offer, &[matched.clone(), other.clone()]));
        assert!(!run_page(&offer, &[other.clone(), unstamped.clone()]));
        assert!(!run_page(&offer, &[unstamped.clone()]));
        // A matched gift line does not count as the required anchor.
        let matched_gift = page_line(Some("gift"), Some("/pages/sale"), "20.00");
        let other_big = page_line(None, Some("/products/y"), "60.00");
        assert!(!run_page(&offer, &[matched_gift, other_big]));
        // No conditions: unchanged behaviour.
        let plain = page_offer("").replace(
            r#""pageUrlConditions":[{"patterns":["/pages/sale"],"matchMode":"exact","caseSensitive":false}],"#,
            "",
        );
        assert!(run_page(&plain, &[page_line(None, None, "60.00")]));
    }

    #[test]
    fn reject_mode_needs_every_non_gift_line_matched() {
        let offer = page_offer(r#""rejectUnmatchedLines":true,"#);
        let matched = page_line(None, Some("/pages/sale"), "30.00");
        let matched2 = page_line(None, Some("/pages/sale?x=1"), "30.00");
        let other = page_line(None, Some("/products/y"), "30.00");
        let unstamped = page_line(None, None, "30.00");
        assert!(run_page(&offer, &[matched.clone(), matched2]));
        assert!(!run_page(&offer, &[matched.clone(), other]));
        assert!(!run_page(&offer, &[matched.clone(), unstamped]));
        // App-added gift/upsell lines are exempt from the reject check; a gift line is ignored entirely.
        let gift = page_line(Some("gift"), None, "0.00");
        let upsell = page_line(Some("upsell"), None, "30.00");
        let matched_big = page_line(None, Some("/pages/sale"), "60.00");
        assert!(run_page(&offer, &[matched_big, gift]));
        assert!(run_page(&offer, &[matched.clone(), upsell]));
    }

    #[test]
    fn page_gated_scoped_offer_does_not_block_sitewide() {
        let landing = r#"{"id":"landing","priority":1,"scopeMode":"landing","requiredLineAttributeValue":"lp",
            "pageUrlConditions":[{"patterns":["/pages/sale"],"matchMode":"exact"}],
            "targetGroupTypes":null,
            "tiers":[{"minimumSubtotalCents":0,"discountType":"percentage","discountValue":25.0,"appliesWhen":null}]}"#;
        let config = shipping_config(&format!("[{landing},{}]", coded_offer("open", 2, 10.0, "")));
        let groups = format!("[{}]", group("gid://shopify/CartDeliveryGroup/1", "ONE_TIME_PURCHASE", false));
        let line = page_line(None, Some("/products/y"), "60.00")
            .replace(r#""landingSourceAttribute":null"#, r#""landingSourceAttribute":{"value":"lp"}"#);
        let result = run_with_lines(r#"["SHIPPING"]"#, "60.00", &config, &groups, &format!("[{line}]"));
        assert_eq!(discount_pct(&result), Some(10.0));
    }

    // ── JPY / KRW minor units and fixed-amount rounding ─────────────────────

    fn currency_payload(
        currency: &str,
        rate: &str,
        subtotal: &str,
        config: &str,
        lines_json: &str,
    ) -> String {
        let groups = format!("[{}]", group("gid://shopify/CartDeliveryGroup/1", "ONE_TIME_PURCHASE", false));
        payload_with_lines(r#"["SHIPPING"]"#, subtotal, config, &groups, lines_json)
            .replace(
                r#""presentmentCurrencyRate": "1.0""#,
                &format!(r#""presentmentCurrencyRate": "{rate}""#),
            )
            .replace(r#""currencyCode": "USD""#, &format!(r#""currencyCode": "{currency}""#))
    }

    fn currency_line(currency: &str, amount: &str) -> String {
        format!(
            r#"[{{"quantity":1,"cost":{{"subtotalAmount":{{"amount":"{amount}","currencyCode":"{currency}"}}}},"lineTypeAttribute":null,"cartGiftTierAttribute":null,"landingSourceAttribute":null,"quizBundleIdAttribute":null,"quizFreeGiftAttribute":null,"quizExpectedPaidCountAttribute":null,"promoMetadata":null,"sellingPlanAllocation":null,"merchandise":{{"__typename":"ProductVariant","id":"gid://shopify/ProductVariant/1"}}}}]"#
        )
    }

    fn run_currency(currency: &str, rate: &str, amount: &str, offer: &str) -> schema::CartDeliveryOptionsDiscountsGenerateRunResult {
        let config = shipping_config(&format!("[{offer}]"));
        let json = currency_payload(currency, rate, amount, &config, &currency_line(currency, amount));
        run_function_with_input(super::run, &json).expect("should not error")
    }

    #[test]
    fn jpy_presentment_converts_to_usd_threshold_through_minor_units() {
        // Free shipping from 50.00 USD (5000 cents), 1 USD = 150 JPY: 7,500 JPY qualifies, 7,400 does not.
        // The pre-fix ratio divided 7,500 by 150 and compared 50 against 5000.
        let offer = one_tier_offer(5000, "percentage", 100.0, "");
        assert_eq!(run_currency("JPY", "150.0", "7500", &offer).operations.len(), 1);
        assert!(run_currency("JPY", "150.0", "7400", &offer).operations.is_empty());
    }

    #[test]
    fn jpy_shop_currency_thresholds_are_whole_yen() {
        // Shop currency JPY: threshold 5000 means 5,000 JPY, no x100 scaling.
        let offer = one_tier_offer(5000, "percentage", 100.0, "").replace(
            r#""id":"ship-1""#,
            r#""id":"ship-1","currencyCode":"JPY""#,
        );
        assert_eq!(run_currency("JPY", "1.0", "5000", &offer).operations.len(), 1);
        assert!(run_currency("JPY", "1.0", "4999", &offer).operations.is_empty());
    }

    #[test]
    fn usd_shop_with_eur_presentment_is_unchanged() {
        let offer = one_tier_offer(5000, "percentage", 100.0, "");
        // 1 USD = 0.9 EUR: 45.00 EUR is exactly 50.00 USD.
        assert_eq!(run_currency("EUR", "0.9", "45.00", &offer).operations.len(), 1);
        assert!(run_currency("EUR", "0.9", "44.99", &offer).operations.is_empty());
    }

    fn fixed_amount_of(result: &schema::CartDeliveryOptionsDiscountsGenerateRunResult) -> f64 {
        match &result.operations[0] {
            schema::DeliveryOperation::DeliveryDiscountsAdd(op) => match &op.candidates[0].value {
                schema::DeliveryDiscountCandidateValue::FixedAmount(a) => a.amount.0,
                other => panic!("expected FixedAmount, got {other:?}"),
            },
            other => panic!("expected DeliveryDiscountsAdd, got {other:?}"),
        }
    }

    #[test]
    fn fixed_amount_is_rounded_per_presentment_currency() {
        let offer = one_tier_offer(0, "fixed_amount", 5.0, "");
        // 5 USD at 0.9137 EUR/USD = 4.5685 EUR -> 4.57
        assert_eq!(fixed_amount_of(&run_currency("EUR", "0.9137", "100.00", &offer)), 4.57);
        // 5 USD at 149.37 JPY/USD = 746.85 JPY -> 747 whole yen
        assert_eq!(fixed_amount_of(&run_currency("JPY", "149.37", "9000", &offer)), 747.0);
        // A fixed amount that rounds to zero in a zero-decimal currency is no discount.
        let tiny = one_tier_offer(0, "fixed_amount", 0.001, "");
        assert!(run_currency("JPY", "149.37", "9000", &tiny).operations.is_empty());
    }
}
