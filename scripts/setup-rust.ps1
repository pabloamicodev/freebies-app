# Install Rust toolchain for Windows (PowerShell)
Set-StrictMode -Version Latest

Write-Host "→ Installing Rust (stable)..."
if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    $rustupUrl = "https://win.rustup.rs/x86_64"
    Invoke-WebRequest -Uri $rustupUrl -OutFile "$env:TEMP\rustup-init.exe"
    & "$env:TEMP\rustup-init.exe" -y --default-toolchain stable
    $env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
}

# Prefer rustup's shims over standalone Rust installations. This guarantees
# that the target installed below is the target Cargo uses during Shopify builds.
$rustupBin = "$env:USERPROFILE\.cargo\bin"
$pathEntries = $env:PATH -split ';' | Where-Object { $_ -and $_ -ne $rustupBin }
$env:PATH = (@($rustupBin) + $pathEntries) -join ';'

Write-Host "→ Adding wasm32-wasip1 target..."
rustup target add wasm32-wasip1

Write-Host "→ Installing cargo-component..."
cargo install cargo-component --locked

Write-Host ""
Write-Host "✅ Rust toolchain ready."
Write-Host "   Test a function: cd apps/shopify-admin/extensions/discount-function; cargo test"
Write-Host "   Build for Shopify: shopify app build"
