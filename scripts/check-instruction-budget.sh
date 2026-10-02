#!/usr/bin/env bash
# CI hook: Function instruction-budget tests are Rust tests whose name contains `instruction_budget`
# (WS-A1's full-Ambrosia-config + 40 stamped lines test). Fails if none exist, so the guard cannot silently disappear.
set -euo pipefail
out=$(cargo test --workspace --release -- instruction_budget 2>&1) || { echo "$out"; exit 1; }
echo "$out" | tail -20
if ! echo "$out" | grep -E "test result: ok\. [1-9][0-9]* passed" >/dev/null; then
  echo "::error::no instruction_budget test ran; add one per discount Function (see docs/RUNBOOK.md)"
  exit 1
fi
