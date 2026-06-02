# Install Rust toolchain for Windows (PowerShell)
Set-StrictMode -Version Latest

Write-Host "→ Installing Rust (stable)..."
if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    $rustupUrl = "https://win.rustup.rs/x86_64"
    Invoke-WebRequest -Uri $rustupUrl -OutFile "$env:TEMP\rustup-init.exe"
    & "$env:TEMP\rustup-init.exe" -y --default-toolchain stable
    $env:PATH += ";$env:USERPROFILE\.cargo\bin"
}

Write-Host "→ Adding wasm32-wasip1 target..."
rustup target add wasm32-wasip1

Write-Host "→ Installing cargo-component..."
cargo install cargo-component --locked

Write-Host ""
Write-Host "✅ Rust toolchain ready."
Write-Host "   Test a function: cd extensions/discount-function; cargo test"
Write-Host "   Build for Shopify: shopify app build"
