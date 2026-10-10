# Peekaboo

A keyboard-summoned AI overlay for Linux desktops (`Ctrl+Space`), built with Tauri v2 (Rust) + React 19 + TypeScript + Tailwind v4 + Zustand. Model-agnostic (Ollama, llama.cpp, OpenAI, Anthropic, Gemini, plugin models). Local SQLite storage for history and memories. See `README.md` for features and the plugin format.

## Layout
- `src/`: the React frontend (`components/`, `store/` for Zustand slices, `providers/` for model backends, `db/` for SQLite access, `hooks/`, `lib/`).
- `src-tauri/`: the Rust shell (`src/lib.rs` holds most native code and the unit tests; `capabilities/` holds Tauri permissions; `tauri.conf.json`).
- `plugins/`: built-in plugins (clipboard, file, openai-compatible, selection-capture). The plugin contract is documented in `plugins/README.md`.
- `docs/build plan.md`: the original design plan. Parts of it are out of date (for example, it says Ollama-only and React 18).

## Install, run, test
- `npm ci` installs the frontend dependencies.
- `npm run typecheck` runs `tsc --noEmit`, and `npm run build` runs tsc and a Vite build. **Every PR must pass both.**
- `npm run dev` starts only the Vite frontend (use `$PORT`). Tauri APIs are missing in a plain browser, so this is only good for rough UI checks and screenshots.
- `npm run tauri dev` / `npm run tauri build` run the full app. They need Rust and the webkit2gtk-4.1 dev libraries.
- Rust tests: `cd src-tauri && cargo test`.

**Server limitation:** aahil-server has **no Rust toolchain and no webkit/GTK dev libraries**. Workers there cannot build or test `src-tauri/`, and must not try to install them system-wide. When a change touches Rust, say so plainly in the PR and mark the Rust side as "unverified: needs `cargo test` / `npm run tauri dev` on the laptop". Keep Rust changes small and careful.

## Conventions
- TypeScript is strict. Don't use `any` without a comment explaining why.
- State lives in Zustand stores under `src/store/`. Don't add a new state library.
- Styling uses Tailwind v4 and the existing theme tokens. Themes are whole palettes, so don't hard-code colours.
- Keep UI motion subtle, using framer-motion.
- Plugins must keep `api_version = 1` compatibility unless the task explicitly bumps it.
- Commits use conventional prefixes (`feat:`, `fix:`, `chore:`, `feat(ui):`...), in lower case and imperative mood.
- The empty stray files `peekaboo-app@0.1.0` and `tauri` at the repo root are accidents. Leave them unless a task says otherwise.

## Deploy
Peekaboo is a desktop app, so there is no server deployment. Releases are built on the laptop with `npm run tauri build`.

Orchestrator may deploy after a merge: no
