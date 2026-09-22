use super::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

#[shopify_function]
fn cart_delivery_options_discounts_generate_run(
    input: schema::cart_delivery_options_discounts_generate_run::Input,
) -> Result<schema::CartDeliveryOptionsDiscountsGenerateRunResult> {
    crate::delivery_discount_logic::run(input)
}
