#!/usr/bin/env bash
# Install Rust toolchain and cargo-component for Shopify Functions
set -e

echo "→ Installing Rust (stable)..."
if ! command -v rustup &>/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
  source "$HOME/.cargo/env"
fi

echo "→ Adding wasm32-wasip1 target..."
rustup target add wasm32-wasip1

echo "→ Installing cargo-component..."
cargo install cargo-component --locked

echo "→ Installing wasm-opt (optional, for smaller binaries)..."
cargo install wasm-opt --locked 2>/dev/null || echo "  wasm-opt skipped (optional)"

echo ""
echo "✅ Rust toolchain ready."
echo "   Build a function: cd extensions/discount-function && cargo build --release --target wasm32-wasip1"
echo "   Run tests:        cd extensions/discount-function && cargo test"
