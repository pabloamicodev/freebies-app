use std::process;

#[path = "../../discount-function/src/cart_delivery_options_discounts_generate_run.rs"]
pub mod cart_delivery_options_discounts_generate_run;
mod config;
#[path = "../../discount-function/src/delivery_discount_logic.rs"]
mod delivery_discount_logic;
#[path = "../../discount-function/src/page_match.rs"]
#[allow(dead_code)]
mod page_match;

use shopify_function::typegen;

#[typegen("../discount-function/schema.graphql")]
pub mod schema {
    #[query("src/input.graphql")]
    pub mod cart_delivery_options_discounts_generate_run {}
}

fn main() {
    eprintln!("Please invoke a named export.");
    process::exit(1);
}
