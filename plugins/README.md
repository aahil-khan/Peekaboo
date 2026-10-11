# Peekaboo plugins

A plugin is a directory containing a `plugin.toml` manifest and an `index.js`
ES module. That is the whole format — no build step, no package manager, no
framework.

## Where plugins live

Peekaboo loads from two places and merges them:

| Source | Location | Notes |
| --- | --- | --- |
| Built-in | compiled into the binary from this directory | Always present, always matches the app version |
| User | `~/.config/peekaboo/plugins/` | Anything you drop in |

A user plugin whose `plugin.id` matches a built-in **replaces** it. That is the
supported way to modify a bundled plugin: copy it out of this directory, change
it, and drop it in the user directory.

Built-ins are embedded rather than copied to disk on first run. A copy would go
stale the moment the app updated, leaving people running last version's plugin
with no indication anything was wrong.

## Manifest

```toml
api_version = 1

[plugin]
id = "clipboard"        # unique; also the override key
name = "Clipboard"      # shown in Settings
version = "1.0.0"
type = "context"        # context | input | output | model

[context]               # required for type = "context"
command = "clipboard"   # what you type after "/"

[settings]              # optional; passed through as ctx.settings
apiKey = ""
```

## Plugin types

**`context`** — invoked deliberately from the `/` menu.

```js
export default {
  type: 'context',
  search: async (query, ctx) => [ /* MenuItem[] */ ],
  resolve: async (itemId, ctx) => [ /* ContextFragment[] */ ],
};
```

`search` populates the menu as you type; `resolve` runs when you pick a row and
returns the fragments actually attached to your message. A `MenuItem` with
`kind: 'group'` renders as a non-selectable heading, which is also how you
surface a "nothing found" or error state.

**`input`** — runs automatically on every message you send. Returns one
`ContextFragment` or `null`.

**`output`** — runs after a response completes. Returns nothing.

**`model`** — provides an `async *stream(messages, options)` generator that
yields text chunks, making a new backend selectable in the model switcher.
`options` is your manifest's `[settings]` table. See `openai-compatible/` for a
working one; copy its SSE buffering rather than reinventing it.

## `api_version`

Checked at discovery. A manifest declaring a version this build does not
support is not loaded, and appears in Settings under "Not loaded" with the
reason — it is refused visibly rather than dropped. The current version is `1`.

## Time limits

Plugins are raced against a deadline and their result discarded if they miss it.
A slow plugin degrades to absent, never to a hung overlay.

| Hook | Budget |
| --- | --- |
| `input.run` | 200 ms |
| `context.search` | 800 ms |
| `context.resolve` | 2 s |
| `output.run` | 2 s |

`search` in particular runs on a 150 ms debounce as you type, so it should be
cheap enough to run on every keystroke.

## The `ctx` object

```
ctx.pluginId            string
ctx.settings            the [settings] table from your manifest
ctx.logger              .info / .warn / .error, prefixed with your plugin id

ctx.getSelection()      the primary selection on Linux; '' elsewhere (no native read yet)
ctx.getClipboard()      clipboard text
ctx.writeClipboard(s)
ctx.getSystemInfo()     { cpu, memory, disks } — measured on call
ctx.searchFiles(query)  [{ path, name }] under $HOME, allowlisted
ctx.readFile(path)      UTF-8 only; allowlisted
ctx.writeFile(path, s)  allowlisted
ctx.loadFile(path)      { media_type, encoding, content, truncated }
ctx.captureRegion()     interactive region capture, base64 PNG
ctx.notify(title, body)
ctx.typeText(s)         paste s into the app the user summoned Peekaboo from:
                        hides the overlay, verifies focus, presses Ctrl+V / Cmd+V,
                        restores the clipboard. Resolves { outcome: 'pasted' } or
                        { outcome: 'copied', reason } (s is left on the clipboard)
ctx.getActiveWindow()   not available on GNOME Wayland — see the README
```

### Attaching files

`readFile` is a plain UTF-8 read and fails on anything else. To attach a file
whose type you do not control, use `loadFile`, which picks a representation:

| Input | `media_type` | `encoding` |
| --- | --- | --- |
| UTF-8 text | `text/plain` | `utf8` |
| PNG, JPEG, GIF, WebP, BMP | `image/*` | `base64` |
| PDF | `text/plain` | `utf8` (with `extracted_from: 'pdf'`) |
| Anything else | rejects with a reason | |

Return the `media_type` as your fragment's `type` and the host routes it: an
`image/*` fragment reaches the model as an image, and is refused with a toast
when the selected model has no vision support.

Text is truncated past 512 KB and images are capped at 8 MB. A PDF that is a
scan has no text to extract, so it rejects — attach the page as an image
instead.

Reject loudly. Returning `[]` from `resolve` attaches nothing and says nothing,
which is indistinguishable from the app ignoring the click; `ctx.notify` is
there for exactly this.

### Filesystem access is scoped

`readFile`, `writeFile` and `searchFiles` reject anything outside:

- your home directory, **excluding** any path with a dot-component
  (`~/.ssh/id_ed25519`, `~/.aws/credentials` and `~/.bashrc` are all refused), and
- your own data directory, `~/.local/share/peekaboo/plugin-data/<plugin-id>/`,
  which is yours to write to freely.

Paths are canonicalised before the check, so a symlink pointing out of the
allowed area is refused too.

This is a real boundary but not a sandbox: plugin JavaScript runs in the app's
webview and can still make network requests. Install plugins you trust.

## Trying one out

```
mkdir -p ~/.config/peekaboo/plugins/hello
cd ~/.config/peekaboo/plugins/hello
```

`plugin.toml`:

```toml
api_version = 1
[plugin]
id = "hello"
name = "Hello"
version = "1.0.0"
type = "context"
[context]
command = "hello"
```

`index.js`:

```js
export default {
  type: 'context',
  search: async (query) => [{ id: 'greet', title: `Greet ${query || 'world'}` }],
  resolve: async () => [{ id: 'greet', type: 'text/plain', content: 'Hello!' }],
};
```

Reopen the overlay and type `/hello`. Discovery re-runs on load, so there is no
install step.
