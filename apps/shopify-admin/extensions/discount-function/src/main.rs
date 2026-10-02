use std::process;

pub mod cart_lines_discounts_generate_run;
#[macro_use]
mod de;
mod config;
mod discount_logic;
mod page_match;
#[cfg(test)]
mod parity_tests;

use shopify_function::typegen;

#[typegen("schema.graphql")]
pub mod schema {
    #[query("src/cart_lines_discounts_generate_run.graphql")]
    pub mod cart_lines_discounts_generate_run {}
}

fn main() {
    // Only reached if invoked without a named export; no message to keep wasm small.
    process::exit(1);
}
