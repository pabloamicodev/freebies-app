use std::process;

#[path = "../../discount-function/src/cart_lines_discounts_generate_run.rs"]
pub mod cart_lines_discounts_generate_run;
#[macro_use]
#[path = "../../discount-function/src/de.rs"]
mod de;
#[path = "../../discount-function/src/config.rs"]
mod config;
#[path = "../../discount-function/src/discount_logic.rs"]
mod discount_logic;
#[path = "../../discount-function/src/page_match.rs"]
mod page_match;
#[cfg(test)]
#[path = "../../discount-function/src/parity_tests.rs"]
mod parity_tests;

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
