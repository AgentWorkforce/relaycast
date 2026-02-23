$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$manifest = Join-Path $root "packages\local\Cargo.toml"
$outDir = Join-Path $root "packages\local\dist"
$bin = Join-Path $root "packages\local\target\release\local.exe"
$asset = "local-windows-x64.exe"

cargo build --release --manifest-path $manifest

New-Item -ItemType Directory -Path $outDir -Force | Out-Null
Copy-Item -Path $bin -Destination (Join-Path $outDir $asset) -Force

Write-Output "Built $(Join-Path $outDir $asset)"
