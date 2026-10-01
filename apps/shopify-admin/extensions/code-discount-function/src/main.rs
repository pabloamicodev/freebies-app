use std::process;

#[path = "../../discount-function/src/cart_lines_discounts_generate_run.rs"]
pub mod cart_lines_discounts_generate_run;
#[path = "../../discount-function/src/config.rs"]
mod config;
#[path = "../../discount-function/src/discount_logic.rs"]
mod discount_logic;

use shopify_function::typegen;

#[typegen("../discount-function/schema.graphql")]
pub mod schema {
    #[query("src/cart_lines_discounts_generate_run.graphql")]
    pub mod cart_lines_discounts_generate_run {}
}

#[cfg(test)]
mod code_tests;

fn main() {
    // Only reached if invoked without a named export; no message to keep wasm small.
    process::exit(1);
}
