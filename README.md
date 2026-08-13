# DevDeck

DevDeck is a local-first desktop project manager for running and monitoring development services.

## Phase 1 and Phase 2

The repository is an npm workspace monorepo containing:

- `apps/desktop` — React + Vite frontend and Tauri 2 shell
- `apps/server` — local Express backend
- `packages/shared` — shared TypeScript contracts

The Phase 1 development command starts Vite on `http://127.0.0.1:1420` and Express on `http://127.0.0.1:4317`.

Phase 2 adds project registration and local persistence. Projects are stored in `%APPDATA%/DevDeck/projects.json` on Windows. Set `DEVDECK_DATA_DIR` to override the storage directory during development or tests.

The desktop UI supports adding and editing project paths and service definitions. In the Tauri window, `Browse` opens the native folder picker; when running the Vite page directly, the path can be entered manually.

Phase 3 adds backend-owned process controls: start, stop, restart, start all, stop all, runtime status polling, Windows process-tree cleanup, and shutdown cleanup. Removing a project also stops its managed services first.

Phase 4 adds realtime service output. The server captures stdout and stderr, keeps the latest 500 entries per service in memory, exposes history at `/api/projects/:projectId/services/:serviceId/logs`, and broadcasts log/status events over `ws://127.0.0.1:4317/ws`.

Phase 5 adds port checks, Windows port-owner messages, Docker Compose detached-service detection, Docker Compose stop handling, and persistent project ordering. Use the up/down controls beside each project to change its order.

## Development

```text
npm install
npm run dev
```

To run the Tauri desktop window with both local services:

```text
npm run tauri:dev
```

Checks:

```text
npm run typecheck
npm run lint
npm run build
```
