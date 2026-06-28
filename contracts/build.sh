#!/bin/bash

# Build all contracts
echo "Building vesting vault contract..."
cd vesting-vault
cargo build --target wasm32-unknown-unknown --release

echo "Building malicious contract..."
cd ../malicious-contract
cargo build --target wasm32-unknown-unknown --release

echo "Building reentrancy tests..."
cd ../reentrancy-tests
cargo build --target wasm32-unknown-unknown --release

echo "Running tests..."
cargo test

# Dependency vulnerability scan (issue #12).
# Fails the build when a known RustSec advisory affects the contract
# dependency tree. Set SKIP_AUDIT=1 to bypass (e.g. offline builds).
cd ..
if [ "${SKIP_AUDIT:-0}" = "1" ]; then
  echo "Skipping cargo audit (SKIP_AUDIT=1)."
else
  echo "Auditing contract dependencies for known vulnerabilities..."
  if ! command -v cargo-audit >/dev/null 2>&1; then
    echo "cargo-audit not found — installing..."
    cargo install cargo-audit --locked
  fi
  cargo audit
fi

echo "Build, tests and audit completed!"
