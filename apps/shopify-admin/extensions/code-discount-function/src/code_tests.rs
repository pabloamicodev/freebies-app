use crate::discount_logic::{code_hash, run};
use crate::schema::{CartOperation, CartLinesDiscountsGenerateRunResult};
use shopify_function::run_function_with_input;

fn offer(id: &str, hashes: &[&str], threshold_cents: i64) -> String {
    let hashes = serde_json::to_string(hashes).unwrap();
    format!(
        r#"{{"id":"{id}","version":1,"offerType":"discount","priority":100,"stopLowerPriority":false,
        "requiredProductIds":[],"requiredVariantIds":[],"excludedProductIds":[],
        "cartValueThresholdCents":{threshold_cents},
        "discountType":"percentage","discountValue":10,"currencyCode":"USD",
        "codeHashes":{hashes}}}"#
    )
}

fn run_with(offers: &[String], entered: &[&str], subtotal: &str) -> CartLinesDiscountsGenerateRunResult {
    let config = format!(r#"{{"offers":[{}]}}"#, offers.join(","));
    let entered: Vec<_> = entered
        .iter()
        .map(|code| serde_json::json!({ "code": code, "rejectable": true }))
        .collect();
    let payload = serde_json::json!({
        "discount": {
            "discountClasses": ["PRODUCT", "ORDER"],
            "metafield": { "value": config }
        },
        "enteredDiscountCodes": entered,
        "cart": {
            "lines": [{
                "id": "gid://shopify/CartLine/1", "quantity": 1,
                "cost": {
                    "amountPerQuantity": { "amount": subtotal, "currencyCode": "USD" },
                    "subtotalAmount": { "amount": subtotal, "currencyCode": "USD" }
                },
                "merchandise": {
                    "__typename": "ProductVariant", "id": "gid://shopify/ProductVariant/v1",
                    "product": { "id": "gid://shopify/Product/p1", "volumeDiscountTiers": null }
                },
                "sellingPlanAllocation": null, "lineType": null, "landingSource": null,
                "volumeDiscountBundleItem": null, "volumeDiscountNektarGlp1": null, "promoMetadata": null
            }],
            "cost": { "subtotalAmount": { "amount": subtotal, "currencyCode": "USD" } }
        },
        "presentmentCurrencyRate": "1.0",
        "localization": { "country": { "isoCode": "US" } }
    });
    run_function_with_input(run, &payload.to_string()).expect("should not error")
}

fn accepted(result: &CartLinesDiscountsGenerateRunResult) -> Vec<String> {
    result
        .operations
        .iter()
        .flat_map(|op| match op {
            CartOperation::EnteredDiscountCodesAccept(accept) => {
                accept.codes.iter().map(|c| c.code.clone()).collect()
            }
            _ => vec![],
        })
        .collect()
}

fn has_discount(result: &CartLinesDiscountsGenerateRunResult) -> bool {
    result.operations.iter().any(|op| {
        matches!(
            op,
            CartOperation::ProductDiscountsAdd(_) | CartOperation::OrderDiscountsAdd(_)
        )
    })
}

#[test]
fn hash_vectors() {
    assert_eq!(code_hash("SUMMER10"), "9e35947c8d25");
    assert_eq!(code_hash("VIP-2026"), "e8cf18d732cc");
    assert_eq!(code_hash("A"), "af63fc4c8602");
    assert_eq!(code_hash("AMAZON_PROMO"), "5f2c120b2677");
    assert_eq!(code_hash("summer10"), code_hash("SUMMER10"));
}

#[test]
fn valid_code_is_accepted_and_discount_applied() {
    let result = run_with(&[offer("o1", &["9e35947c8d25"], 0)], &["SUMMER10"], "50.00");
    assert_eq!(accepted(&result), vec!["SUMMER10"]);
    assert!(has_discount(&result));
    assert!(matches!(result.operations[0], CartOperation::EnteredDiscountCodesAccept(_)));
}

#[test]
fn invalid_code_gets_no_accept_and_no_discount() {
    let result = run_with(&[offer("o1", &["9e35947c8d25"], 0)], &["NOPE"], "50.00");
    assert!(result.operations.is_empty());
}

#[test]
fn no_entered_codes_gives_nothing() {
    let result = run_with(&[offer("o1", &["9e35947c8d25"], 0)], &[], "50.00");
    assert!(result.operations.is_empty());
}

#[test]
fn match_is_case_and_whitespace_insensitive_and_keeps_typed_code() {
    let result = run_with(&[offer("o1", &["9e35947c8d25"], 0)], &["  summer10 "], "50.00");
    assert_eq!(accepted(&result), vec!["summer10"]);
    assert!(has_discount(&result));
}

#[test]
fn duplicate_entries_are_deduped() {
    let result = run_with(&[offer("o1", &["9e35947c8d25"], 0)], &["SUMMER10", "summer10"], "50.00");
    assert_eq!(accepted(&result), vec!["SUMMER10"]);
}

#[test]
fn offer_with_other_code_is_skipped_even_when_conditions_pass() {
    let offers = [offer("o1", &["e8cf18d732cc"], 0), offer("o2", &["9e35947c8d25"], 0)];
    let result = run_with(&offers[..1], &["SUMMER10"], "50.00");
    assert!(result.operations.is_empty());
    // Two offers, only o2 matches: exactly one product operation with a single candidate.
    let result = run_with(&offers, &["SUMMER10"], "50.00");
    let candidates: usize = result
        .operations
        .iter()
        .map(|op| match op {
            CartOperation::ProductDiscountsAdd(add) => add.candidates.len(),
            _ => 0,
        })
        .sum();
    assert_eq!(candidates, 1);
}

#[test]
fn offer_without_code_hashes_is_not_eligible() {
    let result = run_with(&[offer("o1", &[], 0)], &["SUMMER10"], "50.00");
    assert!(result.operations.is_empty());
}

#[test]
fn accept_is_emitted_even_when_conditions_fail() {
    // Cart is $50 but the offer needs $100: code is valid, so it must not show as invalid.
    let result = run_with(&[offer("o1", &["9e35947c8d25"], 10000)], &["SUMMER10"], "50.00");
    assert_eq!(accepted(&result), vec!["SUMMER10"]);
    assert!(!has_discount(&result));
    assert_eq!(result.operations.len(), 1);
}

/// Two lines: one added from an Amazon-UTM landing page, one from elsewhere.
fn run_amazon_cart(entered: &[&str], utm_value: &str) -> CartLinesDiscountsGenerateRunResult {
    let config = format!(
        r#"{{"offers":[{{"id":"o1","version":1,"offerType":"discount","priority":100,
        "currencyCode":"USD","discountType":"percentage","discountValue":10,
        "productRewards":[{{"id":"r1","discountType":"percentage","discountValue":20}}],
        "pageUrlConditions":[{{"matchMode":"contains","paramName":"utm_source","paramValue":"{utm_value}"}}],
        "restrictToMatchedLines":true,"codeHashes":["9e35947c8d25"]}}]}}"#
    );
    let entered: Vec<_> = entered.iter().map(|code| serde_json::json!({ "code": code, "rejectable": true })).collect();
    let line = |index: usize, price: &str, url: &str| {
        serde_json::json!({
            "id": format!("gid://shopify/CartLine/{index}"), "quantity": 1,
            "cost": {
                "amountPerQuantity": { "amount": price, "currencyCode": "USD" },
                "subtotalAmount": { "amount": price, "currencyCode": "USD" }
            },
            "merchandise": {
                "__typename": "ProductVariant", "id": format!("gid://shopify/ProductVariant/v{index}"),
                "product": { "id": format!("gid://shopify/Product/p{index}"), "volumeDiscountTiers": null }
            },
            "sellingPlanAllocation": null, "lineType": null, "landingSource": null,
            "volumeDiscountBundleItem": null, "volumeDiscountNektarGlp1": null,
            "promoMetadata": { "value": serde_json::json!({ "_promo_page_url": url }).to_string() }
        })
    };
    let payload = serde_json::json!({
        "discount": { "discountClasses": ["PRODUCT", "ORDER"], "metafield": { "value": config } },
        "enteredDiscountCodes": entered,
        "cart": {
            "lines": [line(1, "40.00", "/pages/prime?utm_source=amazon"), line(2, "60.00", "/collections/all")],
            "cost": { "subtotalAmount": { "amount": "100.00", "currencyCode": "USD" } }
        },
        "presentmentCurrencyRate": "1.0",
        "localization": { "country": { "isoCode": "US" } }
    });
    run_function_with_input(run, &payload.to_string()).expect("should not error")
}

fn discounted_lines(result: &CartLinesDiscountsGenerateRunResult) -> Vec<String> {
    result
        .operations
        .iter()
        .flat_map(|op| match op {
            CartOperation::ProductDiscountsAdd(add) => add
                .candidates
                .iter()
                .flat_map(|candidate| candidate.targets.iter())
                .filter_map(|target| match target {
                    crate::schema::ProductDiscountCandidateTarget::CartLine(line) => Some(line.id.clone()),
                    #[allow(unreachable_patterns)]
                    _ => None,
                })
                .collect::<Vec<_>>(),
            _ => vec![],
        })
        .collect()
}

#[test]
fn code_with_matching_utm_discounts_only_the_line_added_from_the_landing() {
    let result = run_amazon_cart(&["SUMMER10"], "amazon");
    assert_eq!(accepted(&result), vec!["SUMMER10"]);
    assert_eq!(discounted_lines(&result), vec!["gid://shopify/CartLine/1"]);
}

#[test]
fn code_without_a_utm_match_is_accepted_but_discounts_nothing() {
    let result = run_amazon_cart(&["SUMMER10"], "facebook");
    assert_eq!(accepted(&result), vec!["SUMMER10"]);
    assert!(!has_discount(&result));
}

#[test]
fn matching_utm_without_the_code_discounts_nothing() {
    let result = run_amazon_cart(&[], "amazon");
    assert!(result.operations.is_empty());
}
