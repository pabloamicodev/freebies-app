use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Shopify Discount Function input — matches the GraphQL query defined in input.graphql
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInput {
    pub cart: Cart,
    pub discount_node: DiscountNode,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cart {
    pub lines: Vec<CartLine>,
    pub buyer_identity: Option<BuyerIdentity>,
    pub discount_codes: Vec<DiscountCode>,
    pub cost: CartCost,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CartLine {
    pub id: String,
    pub quantity: i64,
    pub cost: LineCost,
    pub merchandise: Merchandise,
    pub attributes: Vec<Attribute>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineCost {
    pub amount_per_quantity: Money,
    pub subtotal_amount: Money,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Money {
    /// String representation from Shopify (e.g., "49.99")
    pub amount: String,
    pub currency_code: String,
}

impl Money {
    /// Parse to integer cents — safe for discount calculations.
    pub fn to_cents(&self) -> i64 {
        let amount: f64 = self.amount.parse().unwrap_or(0.0);
        // Zero-decimal currencies
        if matches!(
            self.currency_code.as_str(),
            "JPY" | "KRW" | "VND" | "BIF" | "CLP" | "GNF" | "ISK" | "KMF"
                | "MGA" | "PYG" | "RWF" | "UGX" | "VUV" | "XAF" | "XOF" | "XPF"
        ) {
            return amount.round() as i64;
        }
        (amount * 100.0).round() as i64
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Merchandise {
    pub id: String,   // variant GID
    pub product: Product,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Product {
    pub id: String,
    pub tags: Vec<String>,
    pub vendor: String,
    pub product_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attribute {
    pub key: String,
    pub value: Option<String>,
}

impl Attribute {
    pub fn value_str(&self) -> &str {
        self.value.as_deref().unwrap_or("")
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuyerIdentity {
    pub customer: Option<Customer>,
    pub country_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Customer {
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscountCode {
    pub code: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CartCost {
    pub subtotal_amount: Money,
}

/// Compiled offer config stored in the discount node metafield.
/// Precompiled by the backend offer-publisher worker on every offer publish.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscountNode {
    pub metafield: Option<Metafield>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metafield {
    pub value: String,
}

/// Compiled config — parsed from metafield JSON value.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledConfig {
    pub offers: Vec<CompiledOffer>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompiledOffer {
    pub id: String,
    pub version: i32,
    pub offer_type: String,
    pub priority: i32,
    pub stop_lower_priority: bool,
    pub required_product_ids: Vec<String>,
    pub required_variant_ids: Vec<String>,
    pub excluded_product_ids: Vec<String>,
    pub gift_variant_ids: Vec<String>,
    pub gift_product_ids: Vec<String>,
    pub cart_value_threshold_cents: Option<i64>,
    pub cart_quantity_threshold: Option<i64>,
    pub max_gift_quantity: Option<i64>,
    pub discount_type: String,
    pub discount_value: f64,
    pub currency_code: String,
    /// Multi-currency threshold overrides: { "EUR": 4500, "GBP": 3800 }
    pub currency_overrides: Option<HashMap<String, i64>>,
    pub combines_with_order_discounts: bool,
    pub combines_with_shipping_discounts: bool,
    pub combines_with_product_discounts: bool,
}

// ─── Output types ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionOutput {
    pub discounts: Vec<Discount>,
    pub discount_application_strategy: DiscountApplicationStrategy,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DiscountApplicationStrategy {
    First,
    Maximum,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discount {
    pub targets: Vec<Target>,
    pub value: DiscountValue,
    pub message: Option<String>,
    pub conditions: Option<Vec<()>>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub cart_line: CartLineTarget,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CartLineTarget {
    pub id: String,
    pub quantity: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "percentage", rename_all = "camelCase")]
pub enum DiscountValue {
    Percentage { value: String },
    FixedAmount { amount: MoneyInput, applies_to_each_item: bool },
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MoneyInput {
    pub amount: String,
    pub currency_code: String,
}
