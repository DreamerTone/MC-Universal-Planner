# Setup & Development Guide

## Prerequisites

- Node.js >= 20.0.0
- pnpm >= 9.0.0
- Rust >= 1.77 (for native modules, optional at this stage)

## Install

```bash
# Install pnpm globally if not present
npm install -g pnpm@9

# Install all dependencies
pnpm install

# Verify workspace links
pnpm ls --depth=1
```

## Development

```bash
# Start Vite dev server (port 5173) + Electron watcher
pnpm dev

# Typecheck all packages
pnpm typecheck

# Build for production
pnpm build
```

## Package Structure

Each package in `packages/` is a TypeScript library with:
- `src/index.ts` — public API
- `tsconfig.json` — extends `../../tsconfig.base.json`
- `package.json` — workspace:* dependencies

## Adding a New Package

1. Create `packages/<name>/`
2. Add `package.json` with `"name": "@mc-planner/<name>"`
3. Add `tsconfig.json` extending base
4. Add `src/index.ts`
5. Add to `pnpm-workspace.yaml` (already covered by `packages/*`)
6. Reference in consuming packages as `"@mc-planner/<name>": "workspace:*"`

## Native Modules (Future)

Rust native modules in `native/` are compiled via napi-rs:

```bash
cd native/rust-mesher
cargo build --release
```

The compiled `.node` file is loaded conditionally at runtime.
If unavailable, the TypeScript fallback implementation is used.
