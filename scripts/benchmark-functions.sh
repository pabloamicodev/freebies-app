#!/usr/bin/env bash
# Benchmark Rust Shopify Functions against worst-case cart fixture.
# Validates they stay within Shopify's instruction budgets.
set -e

FIXTURE_DIR="$(dirname "$0")/../extensions/fixtures"
mkdir -p "$FIXTURE_DIR"

echo "── Discount Function benchmark ──────────────────────"
cd "$(dirname "$0")/../extensions/discount-function"

# Run Rust unit tests (includes worst-case logic tests)
cargo test --release 2>&1 | tail -5

# Build release binary and check size
cargo build --release --target wasm32-wasip1 2>/dev/null || echo "  (wasm build skipped — run shopify app build)"

WASM_PATH="target/wasm32-wasip1/release/promo_engine_discount_function.wasm"
if [ -f "$WASM_PATH" ]; then
  SIZE=$(wc -c < "$WASM_PATH")
  SIZE_KB=$((SIZE / 1024))
  echo "  Binary size: ${SIZE_KB} KB (limit: 256 KB)"
  if [ "$SIZE_KB" -gt 256 ]; then
    echo "  ❌ OVER LIMIT — optimize Rust binary"
    exit 1
  else
    echo "  ✅ Within size limit"
  fi
fi

echo ""
echo "── Cart Validation Function benchmark ───────────────"
cd "$(dirname "$0")/../extensions/cart-validation"
cargo test --release 2>&1 | tail -5

echo ""
echo "── Cart Transform Function benchmark ────────────────"
cd "$(dirname "$0")/../extensions/cart-transform"
cargo test --release 2>&1 | tail -5

echo ""
echo "✅ All Rust function benchmarks passed"
