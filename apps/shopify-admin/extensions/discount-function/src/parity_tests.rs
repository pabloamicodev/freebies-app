//! Golden parity: replays `packages/rule-engine/test-fixtures/parity/*.json` (written by the
//! rule-engine workstream) through the Function, plus an instruction-budget guard.
//! Included by both discount crates; fixtures with entered codes run only in the code-gate build.

use crate::discount_logic::run;
use crate::schema::{CartLinesDiscountsGenerateRunResult, CartOperation, ProductDiscountCandidateTarget};
use serde_json::{json, Value};
use shopify_function::run_function_with_input;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../packages/rule-engine/test-fixtures/parity")
}

fn string_set(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// The config with every offer's title replaced by its id: the Function copies the title onto
/// each candidate message, which is how outcomes are attributed back to offers.
fn attributable_config(config: &Value) -> Value {
    let mut config = config.clone();
    if let Some(offers) = config["offers"].as_array_mut() {
        for offer in offers {
            offer["title"] = offer["id"].clone();
        }
    }
    config
}

fn line_json(line: &Value, currency: &str) -> Value {
    let quantity = line["quantity"].as_i64().unwrap_or(1);
    let unit_price: f64 = line["unitPrice"].as_str().and_then(|price| price.parse().ok()).unwrap_or(0.0);
    let subtotal = format!("{:.2}", unit_price * quantity as f64);
    let mut metadata = line["metadata"].as_object().cloned().unwrap_or_default();
    let line_type = line["lineType"].as_str();
    if let Some(kind) = line_type {
        metadata.insert("_promo_engine_line_type".to_string(), json!(kind));
    }
    let attribute = |value: Option<&str>| value.map(|value| json!({ "value": value }));
    let metadata: serde_json::Map<String, Value> = metadata
        .into_iter()
        .map(|(key, value)| (key, json!(value.as_str().map(str::to_string).unwrap_or_else(|| value.to_string()))))
        .collect();
    json!({
        "id": line["id"],
        "quantity": quantity,
        "cost": {
            "amountPerQuantity": { "amount": format!("{unit_price:.2}"), "currencyCode": currency },
            "subtotalAmount": { "amount": subtotal, "currencyCode": currency }
        },
        "merchandise": {
            "__typename": "ProductVariant",
            "id": line["variantId"],
            "product": { "id": line["productId"], "volumeDiscountTiers": null }
        },
        "sellingPlanAllocation": if line["sellingPlan"] == true { json!({ "sellingPlan": { "id": "gid://shopify/SellingPlan/1" } }) } else { Value::Null },
        "lineType": attribute(line_type),
        "landingSource": null,
        "volumeDiscountBundleItem": null,
        "volumeDiscountNektarGlp1": null,
        "promoMetadata": if metadata.is_empty() { Value::Null } else { json!({ "value": Value::Object(metadata).to_string() }) }
    })
}

fn function_input(fixture: &Value) -> Value {
    let cart = &fixture["cart"];
    let currency = cart["currency"].as_str().unwrap_or("USD");
    let lines: Vec<Value> = cart["lines"]
        .as_array()
        .map(|lines| lines.iter().map(|line| line_json(line, currency)).collect())
        .unwrap_or_default();
    let subtotal: f64 = lines
        .iter()
        .map(|line| line["cost"]["subtotalAmount"]["amount"].as_str().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0))
        .sum();
    let customer_tags = string_set(&cart["customerTags"]);
    let mut all_tags = BTreeSet::new();
    for offer in fixture["config"]["offers"].as_array().into_iter().flatten() {
        all_tags.extend(string_set(&offer["requiredCustomerTags"]));
        all_tags.extend(string_set(&offer["excludedCustomerTags"]));
    }
    let buyer_identity = if customer_tags.is_empty() {
        Value::Null
    } else {
        let has_tags: Vec<Value> = all_tags
            .iter()
            .map(|tag| json!({ "tag": tag, "hasTag": customer_tags.contains(tag) }))
            .collect();
        json!({ "customer": { "numberOfOrders": 0, "hasTags": has_tags, "amountSpent": { "amount": "0.00" } } })
    };
    let entered: Vec<Value> = string_set(&cart["enteredCodes"])
        .into_iter()
        .map(|code| json!({ "code": code, "rejectable": true }))
        .collect();
    json!({
        "discount": {
            "discountClasses": ["PRODUCT", "ORDER"],
            "metafield": { "value": attributable_config(&fixture["config"]).to_string() }
        },
        "enteredDiscountCodes": entered,
        "cart": {
            "buyerIdentity": buyer_identity,
            "lines": lines,
            "cost": { "subtotalAmount": { "amount": format!("{subtotal:.2}"), "currencyCode": currency } }
        },
        "presentmentCurrencyRate": cart["presentmentCurrencyRate"].as_f64().unwrap_or(1.0).to_string(),
        "localization": { "country": { "isoCode": cart["country"].as_str().unwrap_or("US") } }
    })
}

/// offer id -> discounted line id -> units, for every offer that produced a candidate.
fn outcomes(result: &CartLinesDiscountsGenerateRunResult) -> BTreeMap<String, BTreeMap<String, i64>> {
    let mut by_offer: BTreeMap<String, BTreeMap<String, i64>> = BTreeMap::new();
    for operation in &result.operations {
        match operation {
            CartOperation::ProductDiscountsAdd(add) => {
                for candidate in &add.candidates {
                    let entry = by_offer.entry(candidate.message.clone().unwrap_or_default()).or_default();
                    for target in &candidate.targets {
                        let ProductDiscountCandidateTarget::CartLine(line) = target;
                        *entry.entry(line.id.clone()).or_insert(0) += i64::from(line.quantity.unwrap_or(0));
                    }
                }
            }
            CartOperation::OrderDiscountsAdd(add) => {
                for candidate in &add.candidates {
                    by_offer.entry(candidate.message.clone().unwrap_or_default()).or_default();
                }
            }
            _ => {}
        }
    }
    by_offer
}

#[test]
fn golden_parity_fixtures_match_the_function() {
    let dir = fixture_dir();
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok().map(|entry| entry.path()))
                .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
                .collect()
        })
        .unwrap_or_default();
    paths.sort();
    if paths.is_empty() {
        println!("parity: no fixtures in {}, skipping", dir.display());
        return;
    }
    let code_gate = cfg!(feature = "code_gate");
    let (mut ran, mut failures) = (0, Vec::new());
    for path in &paths {
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap())
            .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
        let name = fixture["name"].as_str().unwrap_or("?").to_string();
        let has_codes = !string_set(&fixture["cart"]["enteredCodes"]).is_empty();
        if has_codes != code_gate {
            println!("parity: {name} skipped (runs in the {} build)", if has_codes { "code-gate" } else { "plain" });
            continue;
        }
        let input = function_input(&fixture);
        let result = run_function_with_input(run, &input.to_string())
            .unwrap_or_else(|error| panic!("{name}: function failed: {error}"));
        let actual = outcomes(&result);
        let expected_qualified = string_set(&fixture["expected"]["qualifiedOfferIds"]);
        let actual_qualified: BTreeSet<String> = actual.keys().cloned().collect();
        if actual_qualified != expected_qualified {
            failures.push(format!("{name}: qualified offers {actual_qualified:?}, expected {expected_qualified:?}"));
        }
        let expected_lines = fixture["expected"]["discountedLineIds"].as_object().cloned().unwrap_or_default();
        let offer_ids: BTreeSet<&String> = actual.keys().chain(expected_lines.keys()).collect();
        for offer_id in offer_ids {
            let expected = expected_lines.get(offer_id).map(string_set).unwrap_or_default();
            let got: BTreeSet<String> = actual.get(offer_id).map(|lines| lines.keys().cloned().collect()).unwrap_or_default();
            if got != expected {
                failures.push(format!("{name}: offer {offer_id} discounted {got:?}, expected {expected:?}"));
            }
        }
        for (offer_id, lines) in fixture["expected"]["discountedQuantities"].as_object().into_iter().flatten() {
            for (line_id, units) in lines.as_object().into_iter().flatten() {
                let got = actual.get(offer_id).and_then(|lines| lines.get(line_id)).copied().unwrap_or(0);
                if Some(got) != units.as_i64() {
                    failures.push(format!("{name}: offer {offer_id} line {line_id} discounted {got} unit(s), expected {units}"));
                }
            }
        }
        ran += 1;
    }
    println!("parity: {ran} fixture(s) checked");
    assert!(failures.is_empty(), "parity mismatches:\n{}", failures.join("\n"));
}

#[cfg(not(feature = "code_gate"))]
mod budget {
    use super::*;
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;
    use std::time::Instant;

    thread_local! {
        static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
    }

    struct CountingAllocator;

    unsafe impl GlobalAlloc for CountingAllocator {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            ALLOCATIONS.with(|count| count.set(count.get() + 1));
            unsafe { System.alloc(layout) }
        }
        unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
            unsafe { System.dealloc(pointer, layout) }
        }
    }

    #[global_allocator]
    static ALLOCATOR: CountingAllocator = CountingAllocator;

    const COMPACT: &str = include_str!("fixtures/ambrosia-function-config.compact.json");
    const FULL: &str = include_str!("fixtures/ambrosia-function-config.full.json");

    /// 40 stamped lines spread over the fixture's anchors and targets, tagged with each landing source.
    fn stamped_cart(config: &str) -> Value {
        let parsed: Value = serde_json::from_str(config).unwrap();
        let mut variants = Vec::new();
        let mut sources = Vec::new();
        for offer in parsed["offers"].as_array().unwrap() {
            for reward in offer["productRewards"].as_array().into_iter().flatten() {
                variants.extend(string_set(&reward["requiredAnchorVariantIds"]));
                variants.extend(string_set(&reward["targetVariantIds"]));
                variants.extend(string_set(&reward["targetProductIds"]));
                if let Some(source) = reward["requiredLineAttributeValue"].as_str() {
                    sources.push(source.to_string());
                }
            }
        }
        let lines: Vec<Value> = (0..40)
            .map(|index| {
                let variant = variants.get(index % variants.len().max(1)).cloned().unwrap_or_default();
                let source = &sources[index % sources.len().max(1)];
                let mut metadata = json!({
                    "_promo_page_url": format!("/en/products/item-{index}?utm_source=email&utm_campaign=spring"),
                    "_promo_landing_url": "/pages/launch?utm_source=email&utm_medium=newsletter",
                    "__landing_source": source,
                    "_promo_engine_metadata_padding": "x".repeat(40),
                });
                if index % 9 == 0 {
                    metadata["_promo_engine_line_type"] = json!("gift");
                    metadata["_promo_engine_offer_id"] = json!("00000001-0000-4000-8000-000000000003");
                    metadata["_promo_engine_reward_id"] = json!("reward-1");
                }
                json!({
                    "id": format!("gid://shopify/CartLine/{index}"),
                    "variantId": variant.replace("/Product/", "/ProductVariant/"),
                    "productId": variant.replace("/ProductVariant/", "/Product/"),
                    "quantity": 1 + (index % 3) as i64,
                    "unitPrice": "19.00",
                    "lineType": Value::Null,
                    "metadata": metadata,
                })
            })
            .collect();
        json!({
            "name": "budget",
            "config": parsed,
            "cart": { "currency": "USD", "presentmentCurrencyRate": 1, "country": "US", "customerTags": [], "enteredCodes": [], "lines": lines },
        })
    }

    fn measure(config: &str) -> (u64, f64, usize) {
        let input = function_input(&stamped_cart(config)).to_string();
        let first = run_function_with_input(run, &input).expect("should not error");
        let operations = first.operations.len();
        let units: i64 = first
            .operations
            .iter()
            .map(|operation| match operation {
                CartOperation::ProductDiscountsAdd(add) => add
                    .candidates
                    .iter()
                    .flat_map(|candidate| &candidate.targets)
                    .map(|target| {
                        let ProductDiscountCandidateTarget::CartLine(line) = target;
                        i64::from(line.quantity.unwrap_or(0))
                    })
                    .sum(),
                _ => 0,
            })
            .sum();
        println!("outcome: {operations} operation(s), {units} discounted unit(s)");
        const RUNS: u32 = 50;
        let before = ALLOCATIONS.with(Cell::get);
        let started = Instant::now();
        for _ in 0..RUNS {
            run_function_with_input(run, &input).expect("should not error");
        }
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0 / f64::from(RUNS);
        let allocations = (ALLOCATIONS.with(Cell::get) - before) / u64::from(RUNS);
        (allocations, elapsed_ms, operations)
    }

    /// Shopify allows 11M wasm instructions. `function-runner` is not installed here, so this is a
    /// native proxy: allocations per run (deterministic, tracks parse/clone cost) and wall time per
    /// run in release builds. Measured now: ~4.4k allocations, ~0.75 ms; before the metadata
    /// parse-once fix: ~30.6k allocations, ~3.5 ms. The limits sit in between, so a regression back to
    /// the old cost trips both.
    #[test]
    fn ambrosia_config_with_40_stamped_lines_stays_inside_the_instruction_budget() {
        for (label, config) in [("compact", COMPACT), ("full", FULL)] {
            let (allocations, elapsed_ms, operations) = measure(config);
            println!("budget[{label}]: {allocations} allocations/run, {elapsed_ms:.3} ms/run, {operations} operation(s)");
            assert!(operations > 0, "the fixture cart should trigger discounts");
            assert!(allocations < ALLOCATION_LIMIT, "{label}: {allocations} allocations per run");
            if !cfg!(debug_assertions) {
                assert!(elapsed_ms < 3.0, "{label}: {elapsed_ms:.3} ms per run");
            }
        }
    }

    /// Live Ambrosia kinetic landing reward (free, no configured limit, two target products): the
    /// limit defaults to one gift SET, so each target product gets one free unit however many
    /// anchors or target units the cart holds. Before D5 every tagged unit was free.
    #[test]
    fn ambrosia_landing_reward_frees_one_unit_of_each_target_product() {
        let parsed: Value = serde_json::from_str(COMPACT).unwrap();
        let reward = parsed["offers"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|offer| offer["productRewards"].as_array().into_iter().flatten())
            .find(|reward| reward["requiredLineAttributeValue"] == "kinetic-sk-otg")
            .expect("kinetic landing reward");
        let anchor = reward["requiredAnchorVariantIds"][0].as_str().unwrap().to_string();
        let products: Vec<String> = reward["targetProductIds"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_string()).collect();
        let line = |id: &str, variant: &str, product: &str, quantity: i64| {
            json!({
                "id": id, "variantId": variant, "productId": product, "quantity": quantity, "unitPrice": "30.00",
                "lineType": Value::Null, "sellingPlan": true,
                "metadata": { "__landing_source": "kinetic-sk-otg" },
            })
        };
        for (anchor_quantity, target_quantity) in [(1, 1), (1, 50), (2, 1), (5, 50)] {
            let fixture = json!({
                "config": parsed,
                "cart": { "currency": "USD", "presentmentCurrencyRate": 1, "country": "US", "customerTags": [], "enteredCodes": [], "lines": [
                    line("anchor", &anchor, "gid://shopify/Product/anchor-product", anchor_quantity),
                    line("target-a", "gid://shopify/ProductVariant/ta", &products[0], target_quantity),
                    line("target-b", "gid://shopify/ProductVariant/tb", &products[1], target_quantity),
                ] },
            });
            let result = run_function_with_input(run, &function_input(&fixture).to_string()).expect("should not error");
            let units: Vec<i64> = ["target-a", "target-b"]
                .iter()
                .map(|id| outcomes(&result).values().filter_map(|lines| lines.get(*id)).sum())
                .collect();
            println!("ambrosia landing: anchor {anchor_quantity}, target qty {target_quantity} -> {units:?} free unit(s)");
            assert_eq!(units, vec![1, 1]);
        }
    }

    fn page_conditioned_cart(offers: usize) -> String {
        page_conditioned_cart_with(&vec!["product"; offers])
    }

    /// One offer per entry, each restricted to lines added from the given page type.
    fn page_conditioned_cart_with(page_types: &[&str]) -> String {
        let offer = |index: usize| {
            json!({
                "id": format!("offer-{index}"), "version": 1, "offerType": "discount", "priority": 100 + index as i64,
                "stopLowerPriority": false, "requiredProductIds": [], "requiredVariantIds": [], "excludedProductIds": [],
                "giftVariantIds": [], "giftProductIds": [], "discountType": "percentage", "discountValue": 10,
                "currencyCode": "USD", "combinesWithOrderDiscounts": true, "combinesWithShippingDiscounts": true,
                "combinesWithProductDiscounts": true, "requirements": [], "orderRewards": [],
                "restrictToMatchedLines": true,
                "pageUrlConditions": [{ "patterns": [page_types[index]], "matchMode": "page_type" }],
                "productRewards": [{
                    "id": format!("reward-{index}"), "rewardType": "product_discount", "targetProductIds": [], "targetVariantIds": [],
                    "discountType": "percentage", "discountValue": 10, "subscriptionMode": "any", "scopeMode": "sitewide",
                    "requiredAnchorVariantIds": [], "requiredAnchorMinQuantity": 1, "requiresAnchorSubscription": false,
                    "priceTiers": [], "discountPercentageOnGifts": 100
                }]
            })
        };
        let lines: Vec<Value> = (0..40)
            .map(|index| {
                json!({
                    "id": format!("gid://shopify/CartLine/{index}"),
                    "variantId": format!("gid://shopify/ProductVariant/{index}"),
                    "productId": format!("gid://shopify/Product/{index}"),
                    "quantity": 1, "unitPrice": "19.00", "lineType": Value::Null,
                    "metadata": { "_promo_page_url": format!("/en/products/item-{index}?utm_source=email") },
                })
            })
            .collect();
        let fixture = json!({
            "config": { "offers": (0..page_types.len()).map(offer).collect::<Vec<_>>() },
            "cart": { "currency": "USD", "presentmentCurrencyRate": 1, "country": "US", "customerTags": [], "enteredCodes": [], "lines": lines },
        });
        function_input(&fixture).to_string()
    }

    fn allocations_per_run(input: &str) -> (u64, usize) {
        let first = run_function_with_input(run, input).expect("should not error");
        let discounted: usize = outcomes(&first).values().map(|lines| lines.len()).sum();
        let before = ALLOCATIONS.with(Cell::get);
        for _ in 0..10 {
            run_function_with_input(run, input).expect("should not error");
        }
        ((ALLOCATIONS.with(Cell::get) - before) / 10, discounted)
    }

    /// Page matching is cached per line per distinct condition set, so ten offers sharing the same
    /// page conditions cost one match per line rather than ten.
    #[test]
    fn ten_page_conditioned_offers_over_40_lines_do_not_rematch_each_line_per_offer() {
        let (one, discounted_one) = allocations_per_run(&page_conditioned_cart(1));
        let (ten, discounted_ten) = allocations_per_run(&page_conditioned_cart(10));
        println!("page-conditioned: 1 offer {one} allocations/run, 10 offers {ten} allocations/run");
        assert_eq!(discounted_one, 40);
        assert!(discounted_ten >= 40, "every offer's lines still get discounted");
        assert!(ten < PAGE_CONDITIONED_LIMIT, "10 offers x 40 lines: {ten} allocations per run");
    }

    #[test]
    fn different_page_condition_sets_do_not_share_cached_matches() {
        let input = page_conditioned_cart_with(&["product", "collection"]);
        let result = run_function_with_input(run, &input).expect("should not error");
        let discounted = outcomes(&result);
        assert_eq!(discounted.get("offer-0").map(|lines| lines.len()), Some(40));
        assert!(!discounted.contains_key("offer-1"), "collection offer must not match product-page lines");
    }

    // Measured ~6.6k (7.0k before the cache); the rest is the 400 candidates themselves.
    const PAGE_CONDITIONED_LIMIT: u64 = 8_000;
    const ALLOCATION_LIMIT: u64 = 13_000;
}
