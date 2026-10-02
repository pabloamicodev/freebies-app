/*!
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
use shopify_function::wasm_api::{self, Context, Serialize as ShopifySerialize};

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct FunctionInput {
    pub cart: Cart,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct Cart {
    pub lines: Vec<CartLine>,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct CartLine {
    pub id: String,
    pub quantity: i32,
    pub line_type: Option<Attribute>,
    pub bundle_components: Option<Attribute>,
    pub bundle_title: Option<Attribute>,
    pub bundle_image_url: Option<Attribute>,
    pub selling_plan_allocation: Option<SellingPlanAllocation>,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct Attribute {
    pub value: Option<String>,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct SellingPlanAllocation {
    pub selling_plan: SellingPlan,
}

#[derive(Debug, Deserialize, shopify_function::Deserialize)]
#[serde(rename_all = "camelCase")]
#[shopify_function(rename_all = "camelCase")]
pub struct SellingPlan {
    pub id: String,
}

// ─── Output ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionOutput {
    pub operations: Vec<CartOperation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CartOperation {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expand: Option<ExpandOperation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateOperation>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandOperation {
    pub cart_line_id: String,
    pub expanded_cart_items: Vec<ExpandedItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<Image>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandedItem {
    pub merchandise_id: String,
    pub quantity: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOperation {
    pub cart_line_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<Image>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub url: String,
}

impl ShopifySerialize for FunctionOutput {
    fn serialize(&self, context: &mut Context) -> Result<(), wasm_api::write::Error> {
        context.write_object(
            |context| {
                context.write_utf8_str("operations")?;
                ShopifySerialize::serialize(&self.operations, context)
            },
            1,
        )
    }
}

impl ShopifySerialize for CartOperation {
    fn serialize(&self, context: &mut Context) -> Result<(), wasm_api::write::Error> {
        context.write_object(
            |context| {
                if let Some(expand) = &self.expand {
                    context.write_utf8_str("expand")?;
                    ShopifySerialize::serialize(expand, context)
                } else if let Some(update) = &self.update {
                    context.write_utf8_str("update")?;
                    ShopifySerialize::serialize(update, context)
                } else {
                    unreachable!("cart operation must contain exactly one action")
                }
            },
            1,
        )
    }
}

impl ShopifySerialize for ExpandOperation {
    fn serialize(&self, context: &mut Context) -> Result<(), wasm_api::write::Error> {
        context.write_object(
            |context| {
                context.write_utf8_str("cartLineId")?;
                ShopifySerialize::serialize(&self.cart_line_id, context)?;
                context.write_utf8_str("expandedCartItems")?;
                ShopifySerialize::serialize(&self.expanded_cart_items, context)?;
                context.write_utf8_str("price")?;
                context.write_null()?;
                context.write_utf8_str("title")?;
                ShopifySerialize::serialize(&self.title, context)?;
                context.write_utf8_str("image")?;
                ShopifySerialize::serialize(&self.image, context)
            },
            5,
        )
    }
}

impl ShopifySerialize for ExpandedItem {
    fn serialize(&self, context: &mut Context) -> Result<(), wasm_api::write::Error> {
        context.write_object(
            |context| {
                context.write_utf8_str("merchandiseId")?;
                ShopifySerialize::serialize(&self.merchandise_id, context)?;
                context.write_utf8_str("quantity")?;
                ShopifySerialize::serialize(&self.quantity, context)?;
                context.write_utf8_str("price")?;
                context.write_null()
            },
            3,
        )
    }
}

impl ShopifySerialize for UpdateOperation {
    fn serialize(&self, context: &mut Context) -> Result<(), wasm_api::write::Error> {
        context.write_object(
            |context| {
                context.write_utf8_str("cartLineId")?;
                ShopifySerialize::serialize(&self.cart_line_id, context)?;
                context.write_utf8_str("title")?;
                ShopifySerialize::serialize(&self.title, context)?;
                context.write_utf8_str("image")?;
                ShopifySerialize::serialize(&self.image, context)?;
                context.write_utf8_str("price")?;
                context.write_null()
            },
            4,
        )
    }
}

impl ShopifySerialize for Image {
    fn serialize(&self, context: &mut Context) -> Result<(), wasm_api::write::Error> {
        context.write_object(
            |context| {
                context.write_utf8_str("url")?;
                ShopifySerialize::serialize(&self.url, context)
            },
            1,
        )
    }
}

// ─── Main function ────────────────────────────────────────────────────────────

pub fn function(input: FunctionInput) -> FunctionOutput {
    let mut operations: Vec<CartOperation> = Vec::new();

    for line in &input.cart.lines {
        // Skip lines with selling plans — transform operations are rejected for these
        if line.selling_plan_allocation.is_some() {
            continue;
        }

        let line_type = attribute_value(&line.line_type);

        match line_type {
            "bundle_parent" => {
                // This is a bundle parent line — expand into components
                if let Some(op) = expand_bundle_parent(line) {
                    operations.push(CartOperation { expand: Some(op), update: None });
                }
            }
            "bundle_component" => {
                // Component lines are managed by the runtime — no transform needed
                // lineUpdate for title customization (Plus only)
                let bundle_title = attribute_value(&line.bundle_title);
                if !bundle_title.is_empty() {
                    operations.push(CartOperation {
                        expand: None,
                        update: Some(UpdateOperation {
                            cart_line_id: line.id.clone(),
                            title: Some(bundle_title.to_string()),
                            image: None,
                            price: None,
                        }),
                    });
                }
            }
            _ => {}
        }
    }

    FunctionOutput { operations }
}

#[shopify_function::shopify_function]
fn run(input: FunctionInput) -> shopify_function::Result<FunctionOutput> {
    Ok(function(input))
}

fn expand_bundle_parent(line: &CartLine) -> Option<ExpandOperation> {
    // Components stored as JSON in line attribute: [{"variantId": "gid://...", "quantity": 1}, ...]
    let components_json = attribute_value(&line.bundle_components);
    if components_json.is_empty() {
        return None;
    }

    // Parse per element so one malformed component is dropped instead of failing the whole line.
    let raw: Vec<serde_json::Value> = serde_json::from_str(components_json).ok()?;
    let expanded_cart_items: Vec<ExpandedItem> = raw
        .into_iter()
        .filter_map(|value| {
            let c: BundleComponent = serde_json::from_value(value).ok()?;
            if !c.variant_id.starts_with(VARIANT_GID_PREFIX)
                || c.variant_id.len() == VARIANT_GID_PREFIX.len()
                || c.variant_id.len() > MAX_GID_LEN
            {
                return None;
            }
            if !(1..=MAX_COMPONENT_QUANTITY).contains(&c.quantity) {
                return None;
            }
            let quantity = c.quantity.checked_mul(line.quantity)?;
            if !(1..=MAX_COMPONENT_QUANTITY).contains(&quantity) {
                return None;
            }
            Some(ExpandedItem {
                merchandise_id: c.variant_id,
                quantity,
                price: None, // let Discount Function handle pricing
            })
        })
        .collect();
    if expanded_cart_items.is_empty() {
        return None;
    }

    let bundle_title = attribute_value(&line.bundle_title);
    let image_url = attribute_value(&line.bundle_image_url);
    let image_url = if is_valid_image_url(image_url) { image_url } else { "" };

    Some(ExpandOperation {
        cart_line_id: line.id.clone(),
        expanded_cart_items,
        price: None,
        title: if bundle_title.is_empty() { None } else { Some(bundle_title.to_string()) },
        image: if image_url.is_empty() {
            None
        } else {
            Some(Image { url: image_url.to_string() })
        },
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleComponent {
    variant_id: String,
    quantity: i32,
}

const VARIANT_GID_PREFIX: &str = "gid://shopify/ProductVariant/";
const MAX_GID_LEN: usize = 128;
const MAX_COMPONENT_QUANTITY: i32 = 2000;
const MAX_IMAGE_URL_LEN: usize = 2048;

/// Line properties are buyer-controlled: only plain https URLs of sane length become the bundle image.
fn is_valid_image_url(url: &str) -> bool {
    url.len() > "https://x".len()
        && url.len() <= MAX_IMAGE_URL_LEN
        && url.starts_with("https://")
        && !url.bytes().any(|b| b <= b' ' || b == 0x7f || b == b'"' || b == b'<' || b == b'>' || b == 0x5c)
}

fn attribute_value(attribute: &Option<Attribute>) -> &str {
    attribute.as_ref().and_then(|value| value.value.as_deref()).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_bundle_parent(line_id: &str, components_json: &str, qty: i32) -> CartLine {
        CartLine {
            id: line_id.to_string(),
            quantity: qty,
            line_type: Some(Attribute { value: Some("bundle_parent".to_string()) }),
            bundle_components: Some(Attribute { value: Some(components_json.to_string()) }),
            bundle_title: Some(Attribute { value: Some("My Bundle".to_string()) }),
            bundle_image_url: None,
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

        if let Some(op) = &output.operations[0].expand {
            assert_eq!(op.cart_line_id, "line-1");
            assert_eq!(op.expanded_cart_items.len(), 2);
            assert_eq!(op.expanded_cart_items[0].quantity, 2);
            assert_eq!(op.expanded_cart_items[1].quantity, 1);
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

        if let Some(op) = &output.operations[0].expand {
            assert_eq!(op.expanded_cart_items[0].quantity, 3); // 1 × 3 = 3
        } else {
            panic!("Expected Expand operation");
        }
    }

    #[test]
    fn test_subscription_line_skipped() {
        let components = r#"[{"variantId":"gid://shopify/ProductVariant/v1","quantity":1}]"#;
        let mut line = make_bundle_parent("line-1", components, 1);
        line.selling_plan_allocation = Some(SellingPlanAllocation {
            selling_plan: SellingPlan { id: "sp-1".to_string() },
        });
        let cart = Cart { lines: vec![line] };
        let output = function(FunctionInput { cart });

        assert!(output.operations.is_empty());
    }

    fn expand_of(components: &str, image: Option<&str>, qty: i32) -> Option<ExpandOperation> {
        let mut line = make_bundle_parent("line-1", components, qty);
        line.bundle_image_url = image.map(|u| Attribute { value: Some(u.to_string()) });
        function(FunctionInput { cart: Cart { lines: vec![line] } })
            .operations
            .into_iter()
            .next()
            .and_then(|op| op.expand)
    }

    const V1: &str = r#"{"variantId":"gid://shopify/ProductVariant/1","quantity":1}"#;

    #[test]
    fn valid_https_image_is_kept() {
        let op = expand_of(&format!("[{V1}]"), Some("https://cdn.shopify.com/s/files/a.png?v=1"), 1).unwrap();
        assert_eq!(op.image.unwrap().url, "https://cdn.shopify.com/s/files/a.png?v=1");
    }

    #[test]
    fn invalid_images_are_dropped_but_bundle_still_expands() {
        let long = format!("https://cdn.shopify.com/{}", "a".repeat(3000));
        for bad in [
            "http://cdn.shopify.com/a.png",
            "javascript:alert(1)",
            "data:image/png;base64,AAAA",
            "//cdn.shopify.com/a.png",
            "https://cdn.shopify.com/a b.png",
            "https://",
            long.as_str(),
        ] {
            let op = expand_of(&format!("[{V1}]"), Some(bad), 1).expect(bad);
            assert!(op.image.is_none(), "{bad}");
            assert_eq!(op.expanded_cart_items.len(), 1);
        }
    }

    #[test]
    fn invalid_components_are_dropped_not_fatal() {
        let components = format!(
            r#"[{V1},{{"variantId":"gid://shopify/Product/9","quantity":1}},{{"variantId":"gid://shopify/ProductVariant/2","quantity":0}},{{"variantId":"gid://shopify/ProductVariant/3","quantity":99999}},{{"variantId":"gid://shopify/ProductVariant/4","quantity":"x"}},{{"nope":1}},"junk",{{"variantId":"gid://shopify/ProductVariant/5","quantity":2}}]"#
        );
        let op = expand_of(&components, None, 1).unwrap();
        let ids: Vec<&str> = op.expanded_cart_items.iter().map(|i| i.merchandise_id.as_str()).collect();
        assert_eq!(ids, ["gid://shopify/ProductVariant/1", "gid://shopify/ProductVariant/5"]);
    }

    #[test]
    fn all_components_invalid_or_bad_json_leaves_the_line_alone() {
        assert!(expand_of(r#"[{"variantId":"evil","quantity":1}]"#, None, 1).is_none());
        assert!(expand_of("not json", None, 1).is_none());
        assert!(expand_of("{}", None, 1).is_none());
    }

    #[test]
    fn component_overflowing_line_quantity_is_dropped() {
        let components = r#"[{"variantId":"gid://shopify/ProductVariant/1","quantity":1000},{"variantId":"gid://shopify/ProductVariant/2","quantity":1}]"#;
        let op = expand_of(components, None, 5).unwrap();
        assert_eq!(op.expanded_cart_items.len(), 1);
        assert_eq!(op.expanded_cart_items[0].quantity, 5);
    }

    #[test]
    fn payload_roundtrip_through_the_wasm_input_shape() {
        let payload = r#"{"cart":{"lines":[{"id":"l1","quantity":1,
            "lineType":{"value":"bundle_parent"},
            "bundleComponents":{"value":"[{\"variantId\":\"gid://shopify/ProductVariant/1\",\"quantity\":1}]"},
            "bundleTitle":null,"bundleImageUrl":{"value":"http://insecure/x.png"},"sellingPlanAllocation":null}]}}"#;
        let output: FunctionOutput = shopify_function::run_function_with_input(super::run, payload).unwrap();
        let op = output.operations[0].expand.as_ref().unwrap();
        assert!(op.image.is_none());
    }

    #[test]
    fn test_empty_cart_returns_no_changes() {
        let cart = Cart { lines: vec![] };
        let output = function(FunctionInput { cart });
        assert!(output.operations.is_empty());
    }

    #[test]
    fn serializes_current_cart_transform_contract() {
        let components = r#"[{"variantId":"gid://shopify/ProductVariant/v1","quantity":1}]"#;
        let output = function(FunctionInput { cart: Cart { lines: vec![make_bundle_parent("line-1", components, 1)] } });
        let json = serde_json::to_value(output).unwrap();
        let operation = &json["operations"][0];
        assert!(operation.get("type").is_none());
        assert_eq!(operation["expand"]["cartLineId"], "line-1");
        assert_eq!(operation["expand"]["expandedCartItems"][0]["merchandiseId"], "gid://shopify/ProductVariant/v1");
    }
}
