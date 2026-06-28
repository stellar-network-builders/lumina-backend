# PowerShell build script for Windows

# Build all contracts
Write-Host "Building vesting vault contract..."
Set-Location vesting-vault
cargo build --target wasm32-unknown-unknown --release

Write-Host "Building malicious contract..."
Set-Location ..\malicious-contract
cargo build --target wasm32-unknown-unknown --release

Write-Host "Building reentrancy tests..."
Set-Location ..\reentrancy-tests
cargo build --target wasm32-unknown-unknown --release

Write-Host "Running tests..."
cargo test

# Dependency vulnerability scan (issue #12).
# Fails the build when a known RustSec advisory affects the contract
# dependency tree. Set $env:SKIP_AUDIT = "1" to bypass (e.g. offline builds).
Set-Location ..
if ($env:SKIP_AUDIT -eq "1") {
    Write-Host "Skipping cargo audit (SKIP_AUDIT=1)."
} else {
    Write-Host "Auditing contract dependencies for known vulnerabilities..."
    if (-not (Get-Command cargo-audit -ErrorAction SilentlyContinue)) {
        Write-Host "cargo-audit not found - installing..."
        cargo install cargo-audit --locked
    }
    cargo audit
    if ($LASTEXITCODE -ne 0) { throw "cargo audit found vulnerabilities (exit $LASTEXITCODE)." }
}

Write-Host "Build, tests and audit completed!"
