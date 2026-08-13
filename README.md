# DevDeck

DevDeck is a local-first desktop project manager for running and monitoring development services.

## Architecture

```text
React UI
   ↓ Tauri IPC (`invoke()` and events)
Rust commands
   ↓
OS / Git / Docker / local processes
```

The application has no local HTTP backend. Project configuration is persisted as JSON at
`%APPDATA%/DevDeck/projects.json` on Windows. Runtime process state and the latest 500 log
entries per service are held in Tauri-managed memory.

The Rust layer owns project persistence, process lifecycle, Windows process-tree cleanup, port
checks, Docker Compose handling, and realtime log/status events. External tools such as Node.js,
Git, and Docker are used only when a registered service requires them.

Project actions also include Git Pull. DevDeck loads the local branches, marks the current branch,
and runs `git pull --no-edit origin <branch>` through a Rust command. Each service has an optional
Build command; when it is empty, the Build button runs `npm run build` in that service's cwd.

## Development

```text
npm install
npm run tauri:dev
```

The Vite development server is started automatically for the Tauri window. No Express server,
localhost API port, or second terminal is required.

## Checks

```text
npm run typecheck
npm run lint
npm run build
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

## Production

```text
npm run tauri:build
```

The resulting desktop application contains the React UI and Rust command layer. It does not
require Node.js or an Express process at runtime; only intentionally managed developer tools
need to be installed on the machine.
