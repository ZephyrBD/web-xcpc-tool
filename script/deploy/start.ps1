# CUIT XCPC TOOL (TS) quick start: install deps, build admin if missing, run server.
$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot "..\.." | Resolve-Path
Set-Location $root

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Error "Bun is not installed. See script/deploy/deploy.md"
}

$static = Join-Path $root "apps\server\static"
if (-not (Test-Path $static) -or -not (Get-ChildItem $static -ErrorAction SilentlyContinue)) {
  Write-Host "Building admin frontend..."
  Push-Location (Join-Path $root "apps\admin")
  bun install
  bun run build
  Pop-Location
}

Set-Location (Join-Path $root "apps\server")
bun install
bun run src/index.ts
