# MC Universal Planner — Architecture Reference

## System Overview

```
mc-universal-planner/
├── apps/
│   └── desktop/                    ← Electron application shell
│       ├── electron/               ← Main process (Node.js)
│       │   ├── main.ts             ← Entry point, window management
│       │   ├── ipc/                ← Typed IPC handler registry
│       │   │   ├── index.ts        ← Registers all handlers
│       │   │   ├── assetHandlers.ts← JAR loading, asset access
│       │   │   ├── projectHandlers.ts← Project file I/O
│       │   │   └── systemHandlers.ts← App info, dialogs
│       │   └── windows/
│       │       └── appDirectories.ts← Data directory management
│       ├── preload/
│       │   └── index.ts            ← Typed contextBridge IPC bridge
│       └── renderer/               ← Vite + React UI (renderer process)
│           └── src/
│               ├── main.tsx        ← React entry point
│               ├── global.d.ts     ← window.electronAPI type injection
│               ├── components/     ← React UI components
│               └── styles/         ← CSS design tokens
│
├── packages/
│   ├── shared/                     ← Cross-process types (NO runtime deps)
│   │   └── src/types/
│   │       ├── ipc.ts              ← All IPC request/response types
│   │       ├── ElectronAPI.ts      ← window.electronAPI interface
│   │       └── minecraft.ts        ← Core Minecraft data model types
│   │
│   ├── ecs/                        ← Entity Component System
│   │   └── src/
│   │       ├── World.ts            ← Central ECS container
│   │       ├── EntityManager.ts    ← u32 entity ID pool (generation counters)
│   │       ├── ComponentStore.ts   ← Typed component storage
│   │       ├── Query.ts            ← Cached entity queries
│   │       └── SystemScheduler.ts  ← Topological system ordering
│   │
│   ├── renderer-core/              ← Three.js / WebGL2 rendering engine
│   │   └── src/
│   │       ├── RendererCore.ts     ← WebGL context, scene, RAF loop
│   │       ├── baking/             ← [NEXT] Model baker, BakedQuad
│   │       ├── atlas/              ← [NEXT] Texture atlas builder
│   │       ├── meshing/            ← [NEXT] Greedy mesher
│   │       ├── ao/                 ← [NEXT] Ambient occlusion
│   │       ├── shaders/            ← [NEXT] Custom GLSL shaders
│   │       └── instancing/         ← [NEXT] GPU instancing
│   │
│   ├── asset-pipeline/             ← JAR parsing and asset indexing
│   │   └── src/
│   │       ├── JarLoader.ts        ← ZIP extraction, progress streaming
│   │       ├── AssetRegistry.ts    ← In-memory asset store
│   │       └── CacheManager.ts     ← Disk cache (SHA-256 keyed)
│   │
│   ├── world-engine/               ← [NEXT] Chunk system, block storage
│   ├── simulation-engine/          ← [PENDING] 20 TPS ECS simulation
│   ├── recipe-engine/              ← [PENDING] Recipe parsing + solving
│   ├── create-sim/                 ← [PENDING] Create mod simulation
│   ├── networking/                 ← [PENDING] Multiplayer collaboration
│   └── serialization/              ← [PENDING] NBT, .mcplan format
│
└── native/
    ├── rust-mesher/               ← [PENDING] Fast greedy mesh generation
    ├── rust-atlas/                ← [PENDING] GPU atlas packing
    ├── rust-solver/               ← [PENDING] Recipe/automation solver
    └── rust-simulation/           ← [PENDING] Deterministic sim core
```

## Threading Model

```
┌─────────────────────────────────────────────────────────────┐
│ Electron Main Process (Node.js)                             │
│  - IPC handler dispatch                                     │
│  - JAR file I/O (asset-pipeline)                            │
│  - Project file I/O                                         │
│  - Native module (.node) calls                              │
└──────────────────────┬──────────────────────────────────────┘
                       │ IPC (contextBridge)
┌──────────────────────▼──────────────────────────────────────┐
│ Renderer Process (Chromium / V8)                            │
│  - React UI (2D overlay)                                    │
│  - Three.js render loop (60 FPS RAF)                        │
│  - ECS world (non-heavy: render state, user input)          │
│  - Camera / controls                                        │
│                      │ postMessage / SharedArrayBuffer       │
│           ┌──────────▼────────────┐                        │
│           │ Simulation Worker     │                        │
│           │ - 20 TPS fixed tick   │                        │
│           │ - Belt/machine ECS    │                        │
│           │ - Deterministic       │                        │
│           └──────────────────────┘                        │
│           ┌──────────────────────┐                        │
│           │ Mesh Worker           │                        │
│           │ - Greedy meshing      │                        │
│           │ - AO generation       │                        │
│           │ - transferable geom   │                        │
│           └──────────────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

## Data-Driven Design Principle

The engine NEVER hardcodes block behaviors. Instead:

1. **JAR loaded** → asset-pipeline extracts blockstates/models/textures
2. **Blockstate JSON** → blockstate-compiler builds variant/multipart state machines
3. **Model JSON** → model-resolver walks parent inheritance, resolves textures
4. **Baked models** → model-baker flattens to BakedQuad[] with UV/AO/tint
5. **Chunk dirty** → mesh-worker runs greedy mesher over BakedQuads
6. **GPU upload** → chunk mesh rendered via custom block shader

Adding a new mod = loading its JAR. Zero code changes.

## Development Order (Current Progress)

- [x] Stage 1: Monorepo foundation (turbo, pnpm workspaces, tsconfigs)
- [x] Stage 2: Electron foundation (main, preload, IPC, window management)
- [x] Stage 2: Asset pipeline (JarLoader, AssetRegistry, CacheManager)
- [x] Stage 3: ECS foundation (World, EntityManager, ComponentStore, Query, Scheduler)
- [x] Stage 3: Renderer bootstrap (RendererCore, Three.js init, RAF loop)
- [ ] Stage 4: World/chunk system (ChunkStorage, BlockStateStore, Section)
- [ ] Stage 5: Blockstate compiler (variant evaluator, multipart rules)
- [ ] Stage 6: Model resolver (parent inheritance, texture variables)
- [ ] Stage 7: Texture atlas builder (GPU stitch, sprite map)
- [ ] Stage 8: Model baker (BakedQuad, UV transform, cullfaces)
- [ ] Stage 9: Greedy mesher (chunk geometry, worker thread)
- [ ] Stage 10: AO generation (per-vertex ambient occlusion)
- [ ] Stage 11: GPU rendering (custom shader, frustum culling, instancing)
- [ ] Stage 12: Dynamic adjacency (fence/wall/pane/stair connectivity)
- [ ] Stage 13: Recipe engine
- [ ] Stage 14: Automation simulation
- [ ] Stage 15: Create mod kinetics
