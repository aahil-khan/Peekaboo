#!/bin/sh
# What WebKitWebDriver launches instead of the app binary.
#
# The driver inherits its environment to whatever it starts, but one driver
# serves every test, and each test wants its own profile. The profile comes in
# as a browser argument instead, and this script turns it into the variables
# that decide where the app reads and writes:
#
#   HOME             ~/.config/peekaboo/plugins and ~/.local/share/peekaboo
#   XDG_CONFIG_HOME  the SQLite history and hotkey.json (Tauri's app_config_dir)
#   XDG_DATA_HOME    the WebKit data directory (localStorage, cookies, cache)
#   XDG_CACHE_HOME   WebKit's disk cache
#
# TAURI_WEBVIEW_AUTOMATION is what makes Tauri allow a WebDriver session at all.
# Everything about the display and the bus is inherited from the driver.
set -u
profile=""
for arg in "$@"; do
  case "$arg" in
    --profile=*) profile="${arg#--profile=}" ;;
  esac
done
if [ -z "$profile" ]; then
  echo "launch.sh: --profile=DIR is required" >&2
  exit 2
fi
if [ -z "${PEEKABOO_E2E_BIN:-}" ]; then
  echo "launch.sh: PEEKABOO_E2E_BIN is not set" >&2
  exit 2
fi

mkdir -p "$profile/home" "$profile/config" "$profile/data" "$profile/cache"
export HOME="$profile/home"
export XDG_CONFIG_HOME="$profile/config"
export XDG_DATA_HOME="$profile/data"
export XDG_CACHE_HOME="$profile/cache"
export TAURI_WEBVIEW_AUTOMATION=true

# The harness reads these back to prove the app ran where it was told to.
echo $$ > "$profile/app.pid"
env | sort > "$profile/app.env"

# The driver passes nothing the app understands, so its arguments are dropped.
exec "$PEEKABOO_E2E_BIN" >> "$profile/app.log" 2>&1
