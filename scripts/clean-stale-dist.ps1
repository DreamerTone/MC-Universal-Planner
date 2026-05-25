# Removes leftover dist/ from packages whose Vite-aliased source is canonical,
# plus Vite's optimized-dep cache. Run from the repo root before pnpm dev if
# you suspect stale builds are being served instead of the source on disk.

$paths = @(
  'packages/renderer-core/dist',
  'packages/world-engine/dist',
  'packages/ecs/dist',
  'apps/desktop/node_modules/.vite'
)

foreach ($p in $paths) {
  if (Test-Path $p) {
    Remove-Item -Recurse -Force $p
    Write-Host "removed $p"
  } else {
    Write-Host "skip    $p (not present)"
  }
}
