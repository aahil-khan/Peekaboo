# Peekaboo

A keyboard-summoned AI overlay for the desktop, built with Tauri v2 (Rust) + React 19 + TypeScript + Tailwind v4 + Zustand. Model-agnostic (Ollama, llama.cpp, OpenAI, Anthropic, Gemini, plugin models). Local SQLite storage for history and memories. See `README.md` for features and the plugin format.

**Direction:** `docs/AUDIT-2026-10.md` is the current product plan. Peekaboo is becoming an AI action layer (select text or a screen region, one hotkey, pick an action, the answer goes back into the app), on Linux first, then Windows and macOS. Read its roadmap before proposing features.

## Layout
- `src/`: the React frontend (`components/`, `store/` for Zustand slices, `providers/` for model backends, `db/` for SQLite access, `hooks/`, `lib/`).
- `src-tauri/`: the Rust shell (`src/lib.rs` holds most native code and the unit tests; `capabilities/` holds Tauri permissions; `tauri.conf.json`).
- `plugins/`: built-in plugins (clipboard, file, openai-compatible, selection-capture). The plugin contract is documented in `plugins/README.md`.
- `src/providers/http.ts`: the one HTTP path for every provider (Rust client inside Tauri, `fetch` in a plain browser). New network code goes through it, not `window.fetch`.
- `docs/AUDIT-2026-10.md`: the audit and roadmap.

## Install, run, test
- `npm ci` installs the frontend dependencies.
- `npm run typecheck` runs `tsc --noEmit`, and `npm run build` runs tsc and a Vite build. **Every PR must pass both.**
- `npm run dev` starts only the Vite frontend (use `$PORT`). Tauri APIs are missing in a plain browser, so this is only good for rough UI checks and screenshots.
- `npm run tauri dev` / `npm run tauri build` run the full app. They need Rust and the webkit2gtk-4.1 dev libraries.
- Frontend tests: `npm test` (vitest; tests live beside the code as `*.test.ts`). New pure logic gets a test.
- Rust tests: `cd src-tauri && cargo test --lib`. Run `npm run build` first: Cargo needs `dist/` to exist.
- CI (`.github/workflows/ci.yml`) runs typecheck, build, frontend tests, and the Rust tests plus a full debug build on Linux, Windows and macOS for every PR. Windows and macOS are supported targets: write portable code (`app.path()` rather than `$HOME`, `cfg` gates for OS-specific code), and never hide a failing job with `continue-on-error`.
- **Workers must not launch the desktop app.** The user's own instance may be running, and the single-instance plugin would toggle their overlay. Verify with builds and tests, and list in the PR what still needs a hand test in the running app.

**Where to build:** the laptop (aahil-fedora) has the full toolchain and is where workers normally run. aahil-server has **no Rust toolchain and no webkit/GTK dev libraries**. Workers there cannot build or test `src-tauri/`, and must not try to install them system-wide. When a change touches Rust, say so plainly in the PR and mark the Rust side as "unverified: needs `cargo test` / `npm run tauri dev` on the laptop". Keep Rust changes small and careful.

## Conventions
- TypeScript is strict. Don't use `any` without a comment explaining why.
- State lives in Zustand stores under `src/store/`. Don't add a new state library.
- Styling uses Tailwind v4 and the existing theme tokens. Themes are whole palettes, so don't hard-code colours.
- Keep UI motion subtle, using framer-motion.
- Plugins must keep `api_version = 1` compatibility unless the task explicitly bumps it.
- Commits use conventional prefixes (`feat:`, `fix:`, `chore:`, `feat(ui):`...), in lower case and imperative mood.

## Deploy
Peekaboo is a desktop app, so there is no server deployment. Releases are built on the laptop with `npm run tauri build`.

Orchestrator may deploy after a merge: no
