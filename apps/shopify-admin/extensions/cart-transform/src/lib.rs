/**
 * Cart Transform Function — Shopify Plus only.
 * Handles bundle line expansion (lineExpand) and presentation (lineUpdate).
 *
 * Available operations on Shopify Plus:
 * - lineExpand: expand bundle parent line into component lines
 * - linesMerge: merge component lines into parent bundle presentation
 * - lineUpdate: update title/image/price of existing line (Plus + dev stores)
 *
 * IMPORTANT: Lines with selling plans are REJECTED by all operations.
 * Do NOT attempt to expand/merge/update subscription lines.
 */

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInput {
    pub cart: Cart,
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
    pub selling_plan_allocation: Option<serde_json::Value>,
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
    pub title: String,
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
    pub currency_code: String,
}

// ─── Output ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionOutput {
    pub operations: Vec<CartOperation>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CartOperation {
    #[serde(rename = "noChanges")]
    NoChanges,
    Expand(ExpandOperation),
    Merge(MergeOperation),
    #[serde(rename = "lineUpdate")]
    LineUpdate(LineUpdateOperation),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandOperation {
    pub cart_line_id: String,
    pub expand_with: Vec<ExpandedComponent>,
    pub price: Option<Price>,
    pub title: Option<String>,
    pub image: Option<Image>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandedComponent {
    pub merchandise_id: String,
    pub quantity: i64,
    pub price: Option<Price>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOperation {
    pub parent_variant_id: String,
    pub cart_lines: Vec<MergeLine>,
    pub title: Option<String>,
    pub image: Option<Image>,
    pub price: Option<Price>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeLine {
    pub cart_line_id: String,
    pub quantity: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineUpdateOperation {
    pub cart_line_id: String,
    pub title: Option<String>,
    pub image: Option<Image>,
    pub price: Option<Price>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Price {
    pub subtotal_amount: MoneyInput,
    pub per_unit_amount: MoneyInput,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MoneyInput {
    pub amount: String,
    pub currency_code: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub url: String,
    pub alt_text: Option<String>,
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BUNDLE_LINE_TYPE_ATTR: &str = "_promo_engine_line_type";
const BUNDLE_ID_ATTR: &str = "_promo_engine_bundle_id";
const BUNDLE_COMPONENTS_ATTR: &str = "_promo_engine_bundle_components";
const BUNDLE_TITLE_ATTR: &str = "_promo_engine_bundle_title";
const BUNDLE_IMAGE_URL_ATTR: &str = "_promo_engine_bundle_image_url";

// ─── Main function ────────────────────────────────────────────────────────────

pub fn function(input: FunctionInput) -> FunctionOutput {
    let mut operations: Vec<CartOperation> = Vec::new();

    for line in &input.cart.lines {
        // Skip lines with selling plans — transform operations are rejected for these
        if line.selling_plan_allocation.is_some() {
            continue;
        }

        let line_type = get_attr(&line.attributes, BUNDLE_LINE_TYPE_ATTR);

        match line_type {
            "bundle_parent" => {
                // This is a bundle parent line — expand into components
                if let Some(op) = expand_bundle_parent(line) {
                    operations.push(CartOperation::Expand(op));
                }
            }
            "bundle_component" => {
                // Component lines are managed by the runtime — no transform needed
                // lineUpdate for title customization (Plus only)
                let bundle_title = get_attr(&line.attributes, BUNDLE_TITLE_ATTR);
                if !bundle_title.is_empty() {
                    operations.push(CartOperation::LineUpdate(LineUpdateOperation {
                        cart_line_id: line.id.clone(),
                        title: Some(bundle_title.to_string()),
                        image: None,
                        price: None,
                    }));
                }
            }
            _ => {}
        }
    }

    if operations.is_empty() {
        operations.push(CartOperation::NoChanges);
    }

    FunctionOutput { operations }
}

fn expand_bundle_parent(line: &CartLine) -> Option<ExpandOperation> {
    // Components stored as JSON in line attribute: [{"variantId": "gid://...", "quantity": 1}, ...]
    let components_json = get_attr(&line.attributes, BUNDLE_COMPONENTS_ATTR);
    if components_json.is_empty() {
        return None;
    }

    let components: Vec<BundleComponent> = serde_json::from_str(components_json).ok()?;
    if components.is_empty() {
        return None;
    }

    let bundle_title = get_attr(&line.attributes, BUNDLE_TITLE_ATTR);
    let image_url = get_attr(&line.attributes, BUNDLE_IMAGE_URL_ATTR);

    let expand_with: Vec<ExpandedComponent> = components
        .into_iter()
        .map(|c| ExpandedComponent {
            merchandise_id: c.variant_id,
            quantity: c.quantity * line.quantity, // multiply by parent quantity
            price: None, // let Discount Function handle pricing
        })
        .collect();

    Some(ExpandOperation {
        cart_line_id: line.id.clone(),
        expand_with,
        price: None,
        title: if bundle_title.is_empty() { None } else { Some(bundle_title.to_string()) },
        image: if image_url.is_empty() {
            None
        } else {
            Some(Image { url: image_url.to_string(), alt_text: Some(bundle_title.to_string()) })
        },
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleComponent {
    variant_id: String,
    quantity: i64,
}

fn get_attr<'a>(attrs: &'a [Attribute], key: &str) -> &'a str {
    attrs
        .iter()
        .find(|a| a.key == key)
        .and_then(|a| a.value.as_deref())
        .unwrap_or("")
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

    fn make_bundle_parent(line_id: &str, components_json: &str, qty: i64) -> CartLine {
        CartLine {
            id: line_id.to_string(),
            quantity: qty,
            merchandise: Merchandise {
                id: "gid://shopify/ProductVariant/bundle-parent".to_string(),
                product: Product {
                    id: "gid://shopify/Product/bundle-product".to_string(),
                    title: "Test Bundle".to_string(),
                    tags: vec!["promo-engine-bundle".to_string()],
                },
            },
            attributes: vec![
                Attribute {
                    key: BUNDLE_LINE_TYPE_ATTR.to_string(),
                    value: Some("bundle_parent".to_string()),
                },
                Attribute {
                    key: BUNDLE_COMPONENTS_ATTR.to_string(),
                    value: Some(components_json.to_string()),
                },
                Attribute {
                    key: BUNDLE_TITLE_ATTR.to_string(),
                    value: Some("My Bundle".to_string()),
                },
            ],
            cost: LineCost {
                amount_per_quantity: Money {
                    amount: "99.00".to_string(),
                    currency_code: "USD".to_string(),
                },
            },
            selling_plan_allocation: None,
        }
    }

    #[test]
    fn test_bundle_parent_expands_to_components() {
        let components = r#"[{"variantId":"gid://shopify/ProductVariant/v1","quantity":2},{"variantId":"gid://shopify/ProductVariant/v2","quantity":1}]"#;
        let line = make_bundle_parent("line-1", components, 1);
        let cart = Cart { lines: vec![line] };
        let input = FunctionInput { cart };

        let output = function(input);
        assert_eq!(output.operations.len(), 1);

        if let CartOperation::Expand(op) = &output.operations[0] {
            assert_eq!(op.cart_line_id, "line-1");
            assert_eq!(op.expand_with.len(), 2);
            assert_eq!(op.expand_with[0].quantity, 2);
            assert_eq!(op.expand_with[1].quantity, 1);
            assert_eq!(op.title.as_deref(), Some("My Bundle"));
        } else {
            panic!("Expected Expand operation");
        }
    }

    #[test]
    fn test_bundle_parent_quantity_multiplied_by_line_quantity() {
        let components = r#"[{"variantId":"gid://shopify/ProductVariant/v1","quantity":1}]"#;
        let line = make_bundle_parent("line-1", components, 3); // 3 bundles
        let cart = Cart { lines: vec![line] };
        let output = function(FunctionInput { cart });

        if let CartOperation::Expand(op) = &output.operations[0] {
            assert_eq!(op.expand_with[0].quantity, 3); // 1 × 3 = 3
        } else {
            panic!("Expected Expand operation");
        }
    }

    #[test]
    fn test_subscription_line_skipped() {
        let components = r#"[{"variantId":"gid://shopify/ProductVariant/v1","quantity":1}]"#;
        let mut line = make_bundle_parent("line-1", components, 1);
        line.selling_plan_allocation = Some(serde_json::json!({ "sellingPlan": { "id": "sp-1" } }));
        let cart = Cart { lines: vec![line] };
        let output = function(FunctionInput { cart });

        // Should return NoChanges since subscription lines are skipped
        assert!(matches!(output.operations[0], CartOperation::NoChanges));
    }

    #[test]
    fn test_empty_cart_returns_no_changes() {
        let cart = Cart { lines: vec![] };
        let output = function(FunctionInput { cart });
        assert!(matches!(output.operations[0], CartOperation::NoChanges));
    }
}
