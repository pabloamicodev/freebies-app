//! Golden parity: replays `packages/rule-engine/test-fixtures/parity/*.json` (written by the
//! rule-engine workstream) through the Function, plus an instruction-budget guard.
//! Included by both discount crates; fixtures with entered codes run only in the code-gate build.

use crate::discount_logic::run;
use crate::schema::{CartLinesDiscountsGenerateRunResult, CartOperation, ProductDiscountCandidateTarget};
use serde_json::{json, Value};
use crate::de::run_function_with_input;
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
            "subtotalAmount": { "amount": subtotal, "currencyCode": currency }
        },
        "merchandise": {
            "__typename": "ProductVariant",
            "id": line["variantId"],
            "product": { "id": line["productId"], "volumeDiscountTiers": line.get("volumeDiscountTiers").map(|tiers| json!({ "value": tiers.to_string() })) }
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
    // `cart.customer`: absent or null is a guest; an object is an identified customer whose optional
    // `usage` map becomes the `{"v":1,"u":{...}}` metafield.
    let identified = cart.get("customer").filter(|customer| !customer.is_null());
    let buyer_identity = if customer_tags.is_empty() && identified.is_none() {
        Value::Null
    } else {
        let has_tags: Vec<Value> = all_tags
            .iter()
            .map(|tag| json!({ "tag": tag, "hasTag": customer_tags.contains(tag) }))
            .collect();
        let mut customer = json!({ "numberOfOrders": 0, "hasTags": has_tags, "amountSpent": { "amount": "0.00" } });
        if let Some(usage) = identified.and_then(|customer| customer.get("usage")) {
            customer["usage"] = json!({ "value": json!({ "v": 1, "u": usage }).to_string() });
        }
        json!({ "customer": customer })
    };
    let entered: Vec<Value> = string_set(&cart["enteredCodes"])
        .into_iter()
        .map(|code| json!({ "code": code, "rejectable": true }))
        .collect();
    json!({
        "discount": {
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

/// MCP acceptance (2026-11-13): the offer built by promo_create for "Protein & Creatine Bundle 1x -> 20%, 2x -> 30%"
/// must make the Function discount 1 unit at 20% and 2 units at 30% (the golden fixtures above check only lines/units).
#[cfg(not(feature = "code_gate"))]
#[test]
fn mcp_quantity_tier_fixtures_discount_20_then_30_percent() {
    for (file, expected_units, expected_percent) in [("mcp-quantity-tiers-single.json", 1, 20.0), ("mcp-quantity-tiers.json", 2, 30.0)] {
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(fixture_dir().join(file)).unwrap()).unwrap();
        let result = run_function_with_input(run, &function_input(&fixture).to_string()).expect("function runs");
        let mut seen = Vec::new();
        for operation in &result.operations {
            if let CartOperation::ProductDiscountsAdd(add) = operation {
                for candidate in &add.candidates {
                    let units: i64 = candidate
                        .targets
                        .iter()
                        .map(|target| {
                            let ProductDiscountCandidateTarget::CartLine(line) = target;
                            i64::from(line.quantity.unwrap_or(0))
                        })
                        .sum();
                    let percent = match &candidate.value {
                        crate::schema::ProductDiscountCandidateValue::Percentage(pct) => pct.value.0,
                        _ => f64::NAN,
                    };
                    seen.push((units, percent));
                }
            }
        }
        assert_eq!(seen, vec![(expected_units, expected_percent)], "{file}");
    }
}

/// ~120 offers over a ~100-line cart (every plain parity fixture merged, then padded) with long packed id lists:
/// the heaviest realistic input. Committed as `fixtures/stress-120-offers-100-lines.input.json` so the wasm
/// comparison (`scripts/compare-function-outputs.mjs`) always has it; regenerate with UPDATE_STRESS_FIXTURE=1.
#[cfg(not(feature = "code_gate"))]
#[test]
fn stress_input_matches_the_committed_fixture_and_runs() {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(fixture_dir())
        .unwrap()
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
        .collect();
    paths.sort();
    let (mut offers, mut lines, mut template) = (Vec::<Value>::new(), Vec::<Value>::new(), None);
    for (index, path) in paths.iter().enumerate() {
        let fixture: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        if !string_set(&fixture["cart"]["enteredCodes"]).is_empty() {
            continue;
        }
        for offer in fixture["config"]["offers"].as_array().into_iter().flatten() {
            let mut offer = offer.clone();
            offer["id"] = json!(format!("f{index}-{}", offer["id"].as_str().unwrap_or("offer")));
            offers.push(offer);
        }
        for line in fixture["cart"]["lines"].as_array().into_iter().flatten() {
            let mut line = line.clone();
            line["id"] = json!(format!("f{index}-{}", line["id"].as_str().unwrap_or("line")));
            lines.push(line);
        }
        template.get_or_insert(fixture);
    }
    let mut template = template.expect("plain parity fixtures");
    let (base_offers, base_lines) = (offers.clone(), lines.clone());
    let mut copy = 0;
    while offers.len() < 120 {
        let mut offer = base_offers[copy % base_offers.len()].clone();
        offer["id"] = json!(format!("{}-dup{copy}", offer["id"].as_str().unwrap()));
        offers.push(offer);
        copy += 1;
    }
    while lines.len() < 100 {
        let mut line = base_lines[copy % base_lines.len()].clone();
        line["id"] = json!(format!("{}-dup{copy}", line["id"].as_str().unwrap()));
        lines.push(line);
        copy += 1;
    }
    for (position, offer) in offers.iter_mut().enumerate().filter(|(position, _)| position % 5 == 0) {
        let packed: Vec<String> = (1..=400).map(|id| (9_000_000 + position * 1000 + id).to_string()).collect();
        offer["excludedProductIds"] = json!(packed.join(","));
    }
    template["config"]["offers"] = json!(offers);
    template["cart"]["lines"] = json!(lines);
    template["cart"]["enteredCodes"] = json!([]);
    let input = function_input(&template);

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/fixtures/stress-120-offers-100-lines.input.json");
    if std::env::var_os("UPDATE_STRESS_FIXTURE").is_some() {
        std::fs::write(&path, format!("{input}
")).unwrap();
    }
    let committed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(committed, input, "stress fixture is stale: run with UPDATE_STRESS_FIXTURE=1");
    run_function_with_input(run, &input.to_string()).expect("stress input runs");
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

    /// Allocations and wall time per run of one prepared Function input.
    fn measure_input(input: &str) -> (u64, f64) {
        run_function_with_input(run, input).expect("should not error");
        const RUNS: u32 = 20;
        let before = ALLOCATIONS.with(Cell::get);
        let started = Instant::now();
        for _ in 0..RUNS {
            run_function_with_input(run, input).expect("should not error");
        }
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0 / f64::from(RUNS);
        ((ALLOCATIONS.with(Cell::get) - before) / u64::from(RUNS), elapsed_ms)
    }

    /// Gift tiers recompute the cart value (and its projected volume discount) once per qualifying tiered
    /// offer. Ten tiered gift offers (three tiers each) over a 100-line cart whose products all carry volume
    /// tiers must stay close to the same offers without tiers.
    #[test]
    fn ten_tiered_gift_offers_over_a_100_line_cart_stay_inside_the_instruction_budget() {
        let offers = |tiered: bool| -> Vec<Value> {
            (0..10)
                .map(|offer| {
                    let rewards: Vec<Value> = (0..3)
                        .map(|tier| {
                            let mut reward = json!({
                                "id": format!("reward-{offer}-{tier}"),
                                "targetProductIds": [format!("gid://shopify/Product/{}", 1000 + offer * 3 + tier)],
                                "targetVariantIds": [format!("gid://shopify/ProductVariant/{}", 1000 + offer * 3 + tier)],
                                "discountType": "free",
                                "discountValue": 100,
                                "maxQuantity": 1
                            });
                            if tiered {
                                reward["mcs"] = json!(5000 * (tier + 1));
                            }
                            reward
                        })
                        .collect();
                    let mut config = json!({
                        "id": format!("offer-{offer}"),
                        "version": 1,
                        "offerType": "gift",
                        "priority": 100 + offer,
                        "giftRewards": rewards,
                        "cartValueThresholdCents": 5000,
                        "maxGiftQuantity": 1
                    });
                    if tiered && offer % 2 == 0 {
                        config["tm"] = json!("h");
                    }
                    config
                })
                .collect()
        };
        let input = |tiered: bool| {
            let mut lines: Vec<Value> = (0..100)
                .map(|index| {
                    json!({
                        "id": format!("l{index}"),
                        "variantId": format!("gid://shopify/ProductVariant/{index}"),
                        "productId": format!("gid://shopify/Product/{index}"),
                        "quantity": 2,
                        "unitPrice": "20.00",
                        "lineType": Value::Null,
                        "metadata": Value::Null,
                        "volumeDiscountTiers": [{ "qty": 2, "percent": 10 }]
                    })
                })
                .collect();
            for offer in 0..10 {
                for tier in 0..3 {
                    lines.push(json!({
                        "id": format!("g{offer}-{tier}"),
                        "variantId": format!("gid://shopify/ProductVariant/{}", 1000 + offer * 3 + tier),
                        "productId": format!("gid://shopify/Product/{}", 1000 + offer * 3 + tier),
                        "quantity": 1,
                        "unitPrice": "10.00",
                        "lineType": "gift",
                        "metadata": {
                            "_promo_engine_offer_id": format!("offer-{offer}"),
                            "_promo_engine_reward_id": format!("reward-{offer}-{tier}"),
                        }
                    }));
                }
            }
            let fixture = json!({
                "config": { "offers": offers(tiered), "version": "budget", "compiledAt": "t" },
                "cart": { "currency": "USD", "presentmentCurrencyRate": 1, "country": "US", "customerTags": [], "enteredCodes": [], "lines": lines },
            });
            function_input(&fixture).to_string()
        };
        let (plain_allocations, plain_ms) = measure_input(&input(false));
        let (tiered_allocations, tiered_ms) = measure_input(&input(true));
        println!(
            "budget[tiered 10x3, 100 lines]: {tiered_allocations} allocations/run, {tiered_ms:.3} ms/run (untiered: {plain_allocations}, {plain_ms:.3} ms)"
        );
        // Wall time is only printed: this cart is far heavier than the Ambrosia one the 3 ms limit was set for, and
        // the untiered run alone takes about as long. The ratio is what tiers add.
        assert!(tiered_allocations * 2 < plain_allocations * 3, "tiers added over 50% allocations: {tiered_allocations} vs {plain_allocations}");
        assert!(tiered_allocations < 30_000, "{tiered_allocations} allocations per run");
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

    /// 2026-11-10 dev-store proof: offers padded with 140 inert product ids made the whole node apply nothing.
    /// The Function itself is not the cause: three %-offers (the seed's nc-filler, c-a, c-b shape) holding
    /// 140/300/600 target ids, compact and full GIDs, over a 30-line cart, discount exactly the padding-free
    /// result, and the cost per run grows linearly with the ids (one parse + one HashSet per reward).
    #[test]
    fn large_target_product_id_lists_stay_inside_the_instruction_budget() {
        let input = |padding: usize, compact: bool, packed: bool| {
            let id = |n: usize| if compact { n.to_string() } else { format!("gid://shopify/Product/{n}") };
            let pad: Vec<String> = (0..padding).map(|n| id(900_000 + n)).collect();
            let offer = |key: &str, priority: i32, real: Option<usize>, percent: f64| {
                let mut ids: Vec<String> = real.map(id).into_iter().collect();
                ids.extend(pad.iter().cloned());
                let ids = if packed { json!(ids.join(",")) } else { json!(ids) };
                json!({
                    "id": key, "title": key, "version": 1, "offerType": "discount", "priority": priority,
                    "cartQuantityThreshold": 1,
                    "productRewards": [{ "targetProductIds": ids, "discountType": "percentage", "discountValue": percent }],
                })
            };
            let mut offers = vec![offer("c-a", 20, Some(1), 20.0), offer("c-b", 21, Some(2), 10.0)];
            if padding > 0 {
                offers.push(offer("nc-filler", 11, None, 5.0));
            }
            let lines: Vec<Value> = (0..30)
                .map(|index| {
                    json!({
                        "id": format!("l{index}"),
                        "variantId": format!("gid://shopify/ProductVariant/{index}"),
                        "productId": format!("gid://shopify/Product/{index}"),
                        "quantity": 1, "unitPrice": "24.95", "lineType": Value::Null, "metadata": Value::Null,
                    })
                })
                .collect();
            let fixture = json!({
                "config": { "offers": offers, "version": "budget", "compiledAt": "t" },
                "cart": { "currency": "USD", "presentmentCurrencyRate": 1, "country": "US", "customerTags": [], "enteredCodes": [], "lines": lines },
            });
            function_input(&fixture).to_string()
        };
        let (base_allocations, base_ms) = measure_input(&input(0, true, false));
        let expected = outcomes(&run_function_with_input(run, &input(0, true, false)).expect("should not error"));
        assert_eq!(expected.get("c-a").and_then(|lines| lines.get("l1")), Some(&1));
        assert_eq!(expected.get("c-b").and_then(|lines| lines.get("l2")), Some(&1));
        for padding in [140, 300, 600] {
            for (compact, packed) in [(true, false), (false, false), (true, true), (false, true)] {
                let input = input(padding, compact, packed);
                let result = run_function_with_input(run, &input).expect("should not error");
                assert_eq!(outcomes(&result), expected, "{padding} ids, compact {compact}, packed {packed}");
                let (allocations, ms) = measure_input(&input);
                println!(
                    "budget[{padding} ids x3 offers, compact {compact}, packed {packed}, 30 lines]: {allocations} allocations/run, {ms:.3} ms/run (no padding: {base_allocations}, {base_ms:.3} ms)"
                );
                // Parsing allocates each id once (plus the GID rebuild when compact); nothing scales with ids x lines.
                assert!(allocations < base_allocations + 4 * 3 * padding as u64, "{padding} ids: {allocations} allocations per run");
            }
        }
    }

    // Measured ~6.6k (7.0k before the cache); the rest is the 400 candidates themselves.
    const PAGE_CONDITIONED_LIMIT: u64 = 8_000;
    const ALLOCATION_LIMIT: u64 = 13_000;
}

/// An offer too big for one node is published as parts (a slice of one list each, same offer id). The parts must
/// discount exactly what the whole offer does, here with the 10 kB metafield limit lifted. The fixture is written by
/// `app/lib/sync/offer-split.parity.test.ts` from the real splitter.
#[cfg(not(feature = "code_gate"))]
mod split_parity {
    use super::*;

    const FIXTURE: &str = include_str!("fixtures/split-parity.json");

    fn discounted(config: &Value, cart: &Value) -> BTreeMap<String, BTreeMap<String, i64>> {
        let input = function_input(&json!({ "config": config, "cart": cart })).to_string();
        outcomes(&run_function_with_input(run, &input).expect("the function runs"))
    }

    #[test]
    fn split_offers_discount_the_same_lines_and_units_as_the_whole_offer() {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(fixture["parts"]["anchor"], 3, "the anchor offer is split three ways");
        assert!(fixture["parts"]["set"].as_i64().unwrap() >= 2, "the gift reward set is split across parts");
        let scenarios = fixture["scenarios"].as_array().unwrap();
        assert!(scenarios.len() >= 6);
        for scenario in scenarios {
            let name = scenario["name"].as_str().unwrap();
            let family = &fixture["families"][scenario["family"].as_str().unwrap()];
            let whole = discounted(&family["unsplit"], &scenario["cart"]);
            if scenario["family"] == "selfAnchor" {
                // The splitter refuses this shape: slicing the targets would make each part's targets the other's anchor.
                assert!(whole.is_empty(), "{name}: the whole offer discounts nothing, got {whole:?}");
                let naive = discounted(&family["naive"], &scenario["cart"]);
                assert!(!naive.is_empty(), "{name}: a naive one-target-per-part split would free both targets");
                continue;
            }
            let parts = discounted(&family["split"], &scenario["cart"]);
            assert_eq!(parts, whole, "{name}: parts differ from the whole offer");
            let expects_discount = scenario["discounts"].as_bool().unwrap();
            assert_eq!(!whole.is_empty(), expects_discount, "{name}: the whole offer {whole:?}");
            if scenario["family"] != "anchor" {
                for lines in whole.values() {
                    for (line, units) in lines {
                        assert_eq!(*units, 2, "{name}: {line} keeps the limit of 2 units per gift product");
                    }
                }
            }
        }
    }
}

/// FIX-cap-12: what Shopify does with several nodes of ours. Each node runs the Function on its own offers;
/// nodes whose combination settings allow each other apply together, otherwise Shopify applies the best set
/// for the customer cart-wide. The planner puts offers that do not combine in their own node, so against the
/// one-node result the only carts that may differ are those where such a node and another node both emit.
#[cfg(not(feature = "code_gate"))]
mod combination_groups {
    use super::*;

    struct Node {
        combines_with_product_discounts: bool,
        offers: Vec<Value>,
    }

    fn product(id: u32) -> String {
        format!("gid://shopify/Product/{id}")
    }

    fn offer(id: &str, product_id: u32, percent: f64) -> Value {
        json!({
            "id": id, "version": 1, "offerType": "discount", "title": id, "priority": 10,
            "productRewards": [{
                "id": format!("{id}-reward"), "targetProductIds": [product(product_id)],
                "discountType": "percentage", "discountValue": percent, "scopeMode": "sitewide"
            }]
        })
    }

    fn cart(lines: &[(u32, i64)]) -> Value {
        let lines: Vec<Value> = lines
            .iter()
            .map(|(product_id, quantity)| {
                json!({
                    "id": format!("gid://shopify/CartLine/{product_id}"),
                    "variantId": format!("gid://shopify/ProductVariant/{}", product_id * 10),
                    "productId": product(*product_id), "quantity": quantity, "unitPrice": "20.00",
                    "lineType": null, "metadata": {}
                })
            })
            .collect();
        json!({ "currency": "USD", "presentmentCurrencyRate": 1, "country": "US", "customerTags": [], "enteredCodes": [], "lines": lines })
    }

    fn config(offers: &[Value]) -> Value {
        json!({ "c1": "_promo_engine_unused", "c2": "_promo_engine_unused", "c3": "_promo_engine_unused", "customerTags": [], "offers": offers })
    }

    type Outcome = BTreeMap<String, BTreeMap<String, i64>>;

    fn run_node(offers: &[Value], cart: &Value) -> Outcome {
        let input = function_input(&json!({ "config": config(offers), "cart": cart })).to_string();
        outcomes(&run_function_with_input(run, &input).expect("the function runs"))
    }

    fn all_offers(nodes: &[Node]) -> Vec<Value> {
        nodes.iter().flat_map(|node| node.offers.clone()).collect()
    }

    /// Money saved: units x unit price x the offer percentage.
    fn saving(outcome: &Outcome, offers: &[Value]) -> f64 {
        outcome
            .iter()
            .map(|(offer_id, lines)| {
                let percent = offers
                    .iter()
                    .find(|offer| offer["id"] == *offer_id)
                    .map(|offer| offer["productRewards"][0]["discountValue"].as_f64().unwrap())
                    .unwrap_or(0.0);
                lines.values().map(|units| *units as f64 * 20.0 * percent / 100.0).sum::<f64>()
            })
            .sum()
    }

    fn one_node(nodes: &[Node], cart: &Value) -> Outcome {
        run_node(&all_offers(nodes), cart)
    }

    /// Shopify resolution: the best set of emitting nodes that all allow each other (a pair combines when both allow product discounts).
    fn resolved(nodes: &[Node], cart: &Value) -> Outcome {
        let all = all_offers(nodes);
        let emitted: Vec<(usize, Outcome)> = nodes
            .iter()
            .enumerate()
            .map(|(index, node)| (index, run_node(&node.offers, cart)))
            .filter(|(_, outcome)| !outcome.is_empty())
            .collect();
        let mut best: Option<(f64, Outcome)> = None;
        for mask in 1u32..(1 << emitted.len()) {
            let chosen: Vec<&(usize, Outcome)> =
                emitted.iter().enumerate().filter(|(bit, _)| mask & (1 << bit) != 0).map(|(_, entry)| entry).collect();
            let compatible = chosen.len() == 1 || chosen.iter().all(|(index, _)| nodes[*index].combines_with_product_discounts);
            if !compatible {
                continue;
            }
            let merged: Outcome = chosen.iter().flat_map(|(_, outcome)| outcome.clone()).collect();
            let value = saving(&merged, &all);
            if best.as_ref().map_or(true, |(top, _)| value > *top) {
                best = Some((value, merged));
            }
        }
        best.map(|(_, outcome)| outcome).unwrap_or_default()
    }

    /// What the planner produces for a shop with an offer that does not combine: it keeps slot 0, the rest get their own nodes.
    fn planned() -> Vec<Node> {
        vec![
            Node { combines_with_product_discounts: false, offers: vec![offer("nc-gift", 3, 100.0)] },
            Node { combines_with_product_discounts: true, offers: vec![offer("sale-a", 1, 10.0), offer("sale-b", 2, 20.0)] },
            Node { combines_with_product_discounts: true, offers: vec![offer("sale-c", 4, 30.0)] },
        ]
    }

    #[test]
    fn carts_where_no_offer_that_does_not_combine_qualifies_match_the_one_node_result() {
        let nodes = planned();
        for lines in [vec![(1, 1)], vec![(1, 2), (2, 1)], vec![(1, 1), (2, 1), (4, 3)], vec![(9, 1)]] {
            let cart = cart(&lines);
            assert_eq!(resolved(&nodes, &cart), one_node(&nodes, &cart), "cart {lines:?}");
        }
    }

    #[test]
    fn two_combining_nodes_stack_on_different_lines_like_one_node() {
        let nodes = planned();
        let cart = cart(&[(1, 1), (4, 2)]);
        let both = resolved(&nodes, &cart);
        assert_eq!(both.keys().cloned().collect::<Vec<_>>(), vec!["sale-a".to_string(), "sale-c".to_string()]);
        assert_eq!(both, one_node(&nodes, &cart));
    }

    #[test]
    fn a_cart_that_only_the_non_combining_node_discounts_matches_the_one_node_result() {
        let nodes = planned();
        let cart = cart(&[(3, 1), (9, 2)]);
        assert_eq!(resolved(&nodes, &cart), one_node(&nodes, &cart));
        assert!(resolved(&nodes, &cart).contains_key("nc-gift"));
    }

    #[test]
    fn a_cart_where_a_non_combining_node_and_another_node_both_emit_gets_the_better_set_only() {
        let nodes = planned();
        let all = all_offers(&nodes);
        // The free gift (20 saved) beats one unit of the 10 % sale (2 saved): Shopify applies only the gift node.
        let gift_wins = cart(&[(3, 1), (1, 1)]);
        let best = resolved(&nodes, &gift_wins);
        assert_eq!(best.keys().cloned().collect::<Vec<_>>(), vec!["nc-gift".to_string()]);
        assert_ne!(best, one_node(&nodes, &gift_wins), "today both stack: the documented difference (E1)");
        assert!(saving(&best, &all) < saving(&one_node(&nodes, &gift_wins), &all));

        // Five units of each combinable sale (10 + 20 saved) beat one free unit (20 saved): the sales apply together, the gift does not.
        let sales_win = cart(&[(3, 1), (1, 5), (2, 5)]);
        let best = resolved(&nodes, &sales_win);
        assert_eq!(best.keys().cloned().collect::<Vec<_>>(), vec!["sale-a".to_string(), "sale-b".to_string()]);
        assert_ne!(best, one_node(&nodes, &sales_win));
    }

    #[test]
    fn the_resolved_set_never_saves_more_than_the_one_node_result() {
        let nodes = planned();
        let all = all_offers(&nodes);
        for lines in [vec![(3, 1), (1, 1)], vec![(3, 2), (4, 1), (2, 2)], vec![(1, 1), (2, 1)], vec![(3, 1)]] {
            let cart = cart(&lines);
            assert!(saving(&resolved(&nodes, &cart), &all) <= saving(&one_node(&nodes, &cart), &all) + 1e-9, "cart {lines:?}");
        }
    }

    #[test]
    fn when_every_node_combines_sharding_changes_nothing() {
        let mut nodes = planned();
        nodes[0].combines_with_product_discounts = true;
        for lines in [vec![(3, 1), (1, 1)], vec![(3, 2), (4, 1), (2, 2)], vec![(1, 1), (2, 1)]] {
            let cart = cart(&lines);
            assert_eq!(resolved(&nodes, &cart), one_node(&nodes, &cart), "cart {lines:?}");
        }
    }
}

/// Capacity workaround `use_whole_products`: a product reward that lists every variant of its products is rewritten
/// in place to list the products. The Function must discount the same lines and units for every cart built from
/// today's catalog (a variant added to the product later is covered on purpose, so no cart here has one).
#[cfg(not(feature = "code_gate"))]
mod whole_product_targets {
    use super::*;

    const PRODUCTS: [(u32, [u32; 3]); 2] = [(1, [11, 12, 13]), (2, [21, 22, 23])];

    fn product(id: u32) -> String {
        format!("gid://shopify/Product/{id}")
    }

    fn variant(id: u32) -> String {
        format!("gid://shopify/ProductVariant/{id}")
    }

    fn offer(listed_by_variant: bool, shape: &Value) -> Value {
        let mut reward = shape.clone();
        reward["id"] = json!("reward");
        reward["scopeMode"] = json!("sitewide");
        if listed_by_variant {
            reward["targetVariantIds"] = json!(PRODUCTS.iter().flat_map(|(_, variants)| variants.iter().map(|id| variant(*id))).collect::<Vec<_>>());
        } else {
            reward["targetProductIds"] = json!(PRODUCTS.iter().map(|(id, _)| product(*id)).collect::<Vec<_>>());
        }
        json!({ "offers": [{ "id": "whole", "version": 1, "offerType": "discount", "title": "whole", "priority": 10, "productRewards": [reward] }] })
    }

    fn cart(lines: &[(u32, u32, i64)]) -> Value {
        let lines: Vec<Value> = lines
            .iter()
            .map(|(product_id, variant_id, quantity)| {
                json!({
                    "id": format!("gid://shopify/CartLine/{variant_id}"), "variantId": variant(*variant_id),
                    "productId": product(*product_id), "quantity": quantity, "unitPrice": "20.00",
                    "lineType": null, "metadata": {}
                })
            })
            .collect();
        json!({ "currency": "USD", "presentmentCurrencyRate": 1, "country": "US", "customerTags": [], "enteredCodes": [], "lines": lines })
    }

    fn discounted(config: &Value, cart: &Value) -> BTreeMap<String, BTreeMap<String, i64>> {
        let config = json!({ "c1": "_promo_engine_unused", "c2": "_promo_engine_unused", "c3": "_promo_engine_unused", "customerTags": [], "offers": config["offers"] });
        let input = function_input(&json!({ "config": config, "cart": cart })).to_string();
        outcomes(&run_function_with_input(run, &input).expect("the function runs"))
    }

    #[test]
    fn product_level_targets_discount_the_same_lines_and_units_as_the_variant_list() {
        let shapes = [
            json!({ "discountType": "percentage", "discountValue": 10 }),
            json!({ "discountType": "percentage", "discountValue": 15, "maxUnitsTotal": 3 }),
            json!({ "discountType": "percentage", "discountValue": 0, "quantityTiers": [
                { "minimumQuantity": 2, "discountType": "percentage", "discountValue": 5 },
                { "minimumQuantity": 4, "discountType": "percentage", "discountValue": 12 }
            ] }),
        ];
        let carts = [
            vec![(1, 11, 1)],
            vec![(1, 11, 2), (1, 12, 1)],
            vec![(1, 11, 1), (2, 21, 1), (2, 23, 3)],
            vec![(9, 91, 2)],
            vec![(9, 91, 1), (2, 22, 5)],
            vec![(1, 13, 4), (9, 91, 1)],
        ];
        let mut discounting = 0;
        for shape in &shapes {
            for lines in &carts {
                let cart = cart(lines);
                let by_variant = discounted(&offer(true, shape), &cart);
                let by_product = discounted(&offer(false, shape), &cart);
                assert_eq!(by_product, by_variant, "shape {shape} cart {lines:?}");
                discounting += usize::from(!by_variant.is_empty());
            }
        }
        assert!(discounting >= 10, "the carts must actually discount something, got {discounting}");
    }
}
