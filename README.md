# Peekaboo

[![CI](https://github.com/aahil-khan/Peekaboo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/aahil-khan/Peekaboo/actions/workflows/ci.yml)

**An AI overlay that actually works on Linux, and isn't locked to one vendor's model.**

Hit `Ctrl+Alt+Space` anywhere (`Option+Space` on a Mac, and you can change it in Settings). Ask. Get an answer. It disappears.

Peekaboo is a keyboard-summoned overlay — not a window you alt-tab to, not a browser tab you leave pinned. It appears over whatever you're doing, answers, and gets out of the way.

> **Status:** pre-1.0 and under active development. It works and is used daily on Fedora/GNOME, but interfaces and storage may still change between versions.

---

## Why this exists

There is no official ChatGPT or Claude desktop app on Linux. The usual fallback is a pinned browser tab, which means alt-tabbing away from your work, describing your situation in words, and copying the answer back by hand.

Peekaboo takes a different shape:

- **It's an overlay, not an app you switch to.** Summon it over your current window, dismiss it when done. No window management.
- **It's model-agnostic.** Ollama, llama.cpp, OpenAI, Anthropic, and Gemini are all first-class. Switch providers from a keystroke. Your history and memories are yours, in a local SQLite file, regardless of which model produced them.
- **It runs fully local if you want.** Point it at Ollama or a llama.cpp server and nothing leaves your machine.
- **It's Linux-first.** Wayland and X11, GNOME and elsewhere, built and tested on Fedora.

---

## Features

**The overlay**
- Global summon hotkey, registered natively so there's no startup lag. Default `Ctrl+Alt+Space` (`Option+Space` on macOS); record your own in Settings → General
- Transparent, always-on-top, auto-sizing surface that grows with the answer
- Auto-hides on focus loss; tray icon for show/settings/quit, and `Ctrl+Q` in the overlay quits on desktops without a tray
- Dismiss mid-answer (`Esc`) and it keeps generating in the background, then notifies you

**Models**
- Ollama, llama.cpp, OpenAI, Anthropic, Gemini — plus any model exposed by a plugin
- Full llama.cpp process management: launch/stop the server from Settings with per-profile context size, GPU layers, flash-attention, batch sizes
- Vision-model detection, with image attachments enabled only where they're supported
- Per-message model tracking, so you can see what answered what

**Context in**
- Paste an image straight into the prompt
- `Alt+S` captures a screen region into the conversation (via xdg-desktop-portal)
- `/` opens context plugin commands to pull in structured context
- Text selection capture via an input plugin

**Context out**
- `Alt+C` copies the last answer to the clipboard
- Optional copy-on-dismiss (off by default — it replaces your clipboard)

**Local storage**
- SQLite-backed session history with search, rename, and delete
- Configurable retention (default 90 days)
- A memory system with pinning, usage tracking, and search

---

## Install

**Requirements:** Rust (stable), Node 18+, and the usual Tauri Linux dependencies (`webkit2gtk4.1`, `libappindicator`, `librsvg2`).

On Fedora:

```bash
sudo dnf install webkit2gtk4.1-devel libappindicator-gtk3-devel librsvg2-devel
```

Then:

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # produces installable bundles
```

On first run, a setup window walks you through picking a backend.

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+Alt+Space` (macOS: `Option+Space`) | Summon or hide. Configurable in Settings → General |
| `Enter` | Send |
| `Shift+Enter` | Line break |
| `/` | Context plugin commands |
| `Alt+N` | New chat |
| `Alt+Q` | Stop streaming |
| `Alt+S` | Capture screen region |
| `Alt+C` | Copy last answer |
| `Alt+H` | History |
| `Alt+R` | Memories |
| `Alt+M` | Model switcher |
| `Alt+,` | Settings |
| `Alt+/` | Shortcut legend |
| `Alt+←` / `Alt+→` | Previous / next exchange |
| `Esc` | Dismiss |
| `Ctrl+Q` (macOS: `⌘Q`) | Quit Peekaboo |

The hotkey is saved in `hotkey.json` in the app's config directory (`~/.config/com.peekaboo.app/` on Linux), separately from the other settings, because it is registered before the UI loads. Delete the file to go back to the default.

If your desktop will not let Peekaboo grab the hotkey, bind the `peekaboo-app` command to any key in your desktop's own keyboard settings instead: launching the binary while it is already running toggles the overlay.

---

## Plugins

Drop a directory into `~/.config/peekaboo/plugins/`:

```
~/.config/peekaboo/plugins/my-plugin/
├── plugin.toml
└── index.js          # or dist/index.js
```

```toml
api_version = 1

[plugin]
id = "my-plugin"
name = "My Plugin"
version = "1.0.0"
type = "context"      # input | output | context | model

[context]
command = "mything"   # exposes /mything
```

```js
export default {
  type: 'context',
  search: async (query, ctx) => [{ id: 'a', title: 'Something' }],
  resolve: async (id, ctx) => [{ id, type: 'text', label: 'Something', content: '...' }],
};
```

The four plugin types:

- **`input`** — runs when the overlay opens, can attach context automatically
- **`context`** — invoked by a `/command`, searchable, resolves to attachments
- **`output`** — runs on every completed answer
- **`model`** — provides a model backend

Plugins receive a context object with clipboard access, primary-selection reads, notifications, file I/O, and screen capture.

---

## Platform notes

Peekaboo is built and tested on **Fedora / GNOME / Wayland**. Some capabilities are constrained by the Wayland security model rather than by Peekaboo. On GNOME the tray icon needs an AppIndicator extension; without one, quit with `Ctrl+Q` from the overlay.

| Capability | Status |
| --- | --- |
| Global shortcuts | X11, and GNOME Wayland (Mutter honours the XWayland grab). **Does not fire on KDE Wayland, Sway or Hyprland**, where the underlying `global-hotkey` crate has no backend; use your desktop's keyboard settings to bind the `peekaboo-app` command (see Keyboard shortcuts) until the planned portal-based implementation lands. |
| Primary selection capture | Works (Wayland via `wl-paste`, X11 via `xclip`) |
| Screen region capture | Works via `xdg-desktop-portal`. GNOME's private screenshot API is denied to unwhitelisted callers on GNOME 50, so the portal is the only path — it prompts once, then remembers. |
| Active window / app detection | **Not available on GNOME Wayland.** `org.gnome.Shell.Introspect.GetWindows` is whitelist-gated and there is no portal equivalent. Would require a GNOME Shell extension. |
| Typing answers into other apps | Not yet implemented. Feasible on Wayland via the RemoteDesktop portal (no root or `ydotool` needed); tracked for a future release. |

On Windows and macOS, CI builds the whole app and runs the Rust unit tests on every change, but the app has not yet been run on either: screen region capture is Linux-only, and on Windows user-installed plugins and plugin file access do not work yet.

---

## License

MIT — see [LICENSE](LICENSE).
