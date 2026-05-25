# Removes build debris that can cause Vite to serve stale code instead of
# the source on disk. Run from the repo root before `pnpm dev` if you
# suspect a stale install:
#
#   powershell -ExecutionPolicy Bypass -File scripts/clean-stale-dist.ps1
#
# Why each path:
#  - packages/*/dist                : tsc -b output. Vite aliases bypass
#    these, but if anything resolves the package via its package.json#main
#    fallback, dist wins. Wiping forces source.
#  - packages/*/src/**/*.js(.map)   : THE bug we hit on Windows. Some old
#    build wrote .js next to .ts inside src/. Vite's resolver prefers .js
#    over .ts (Node convention), so it served those stale compiled files
#    instead of source forever after. Nuking them every clean ensures
#    Vite only ever sees .ts here.
#  - apps/desktop/node_modules/.vite: Vite's optimised-deps cache.

$distPaths = @(
  'packages/renderer-core/dist',
  'packages/asset-pipeline/dist',
  'packages/world-engine/dist',
  'packages/ecs/dist',
  'packages/shared/dist',
  'packages/serialization/dist',
  'packages/simulation-engine/dist',
  'packages/recipe-engine/dist',
  'packages/networking/dist',
  'packages/create-sim/dist',
  'apps/desktop/node_modules/.vite',
  'apps/desktop/dist'
)

foreach ($p in $distPaths) {
  if (Test-Path $p) {
    Remove-Item -Recurse -Force $p
    Write-Host "removed $p"
  } else {
    Write-Host "skip    $p (not present)"
  }
}

# Wipe stray .js / .js.map / .d.ts(.map) inside packages/*/src/ — these are
# build debris and Vite will prefer them over the .ts source if present.
# global.d.ts is the only legitimate .d.ts under src and is preserved.
$strayCount = 0
Get-ChildItem -Path packages -Recurse -Include *.js, *.js.map, *.d.ts, *.d.ts.map -ErrorAction SilentlyContinue |
  Where-Object {
    $_.FullName -match '\\src\\' -and
    $_.FullName -notmatch 'node_modules' -and
    $_.Name -ne 'global.d.ts'
  } |
  ForEach-Object {
    Remove-Item -Force $_.FullName
    Write-Host "removed $($_.FullName)"
    $strayCount++
  }

Write-Host ""
Write-Host "Done. $strayCount stray .js/.d.ts files removed from packages/*/src/."
