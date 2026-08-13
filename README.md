# DevDeck

DevDeck is a local-first desktop project manager for running and monitoring development services.

## Phase 1

The repository is an npm workspace monorepo containing:

- `apps/desktop` — React + Vite frontend and Tauri 2 shell
- `apps/server` — local Express backend
- `packages/shared` — shared TypeScript contracts

The Phase 1 development command starts Vite on `http://127.0.0.1:1420` and Express on `http://127.0.0.1:4317`.

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
