#!/bin/sh
# Single-OBS deployment regression check for lyblive.
# Usage: scripts/single-obs-regress.sh
# Overrides: LYBLIVE_HOME, LYBLIVE_WEB_UNIT, LYBLIVE_OBS_UNIT,
#            LYBLIVE_PORT, LYBLIVE_OBS_UNIT_FILE, LYBLIVE_WEB_UNIT_FILE,
#            LYBLIVE_OBS_ENV_FILE (diagnostic file fixtures).
# Offline/local only: no credentials, no remote writes, no service restarts.
set -eu
if [ -n "${LYBLIVE_HOME:-}" ]; then
  HOME_DIR=$LYBLIVE_HOME
elif [ -n "${HOME:-}" ]; then
  HOME_DIR=$HOME
else
  HOME_DIR=$(getent passwd "$(id -u)" | cut -d: -f6)
fi
[ -n "$HOME_DIR" ] || { printf 'FAIL cannot resolve account HOME\n' >&2; exit 1; }
export HOME="$HOME_DIR"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] || export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export DISPLAY="${DISPLAY:-:0}"
WEB_UNIT=${LYBLIVE_WEB_UNIT:-lyblive.service}
OBS_UNIT=${LYBLIVE_OBS_UNIT:-lyblive-obs.service}
FAILED=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; FAILED=$((FAILED+1)); }
check() { if "$@" >/dev/null 2>&1; then ok "$*"; else bad "$*"; fi; }
value() { systemctl --user show "$1" -p "$2" --value; }
unit_port() { systemctl --user cat "$1" 2>/dev/null | awk -F= '/^Environment=LYBLIVE_PORT=/{sub(/^Environment=LYBLIVE_PORT=/,""); print; exit}' || true; }
launcher_ok() {
  [ -r "$1" ] && [ -x "$1" ] || return 1
  sh -n "$1" >/dev/null 2>&1 || return 1
  for v in WAYLAND_DISPLAY SESSION_MANAGER DESKTOP_STARTUP_ID XDG_ACTIVATION_TOKEN; do
    grep -Fq -- "-u $v" "$1" || return 1
  done
  grep -Fq 'QT_QPA_PLATFORM=xcb' "$1" || return 1
  grep -Fq 'XDG_SESSION_TYPE=x11' "$1" || return 1
  grep -Fq '/usr/bin/obs --multi --disable-updater' "$1" || return 1
}

UNIT_PORT=$(unit_port "$WEB_UNIT")
DEFAULT_PORT=${LYBLIVE_PORT:-8768}
PORT=${UNIT_PORT:-$DEFAULT_PORT}
if [ -n "$UNIT_PORT" ]; then ok "$WEB_UNIT declares LYBLIVE_PORT=$UNIT_PORT"; else bad "$WEB_UNIT does not declare LYBLIVE_PORT"; fi
if [ -n "${LYBLIVE_PORT:-}" ] && [ "$LYBLIVE_PORT" != "$PORT" ]; then bad "LYBLIVE_PORT=$LYBLIVE_PORT does not match $WEB_UNIT port $PORT"; else ok "effective web console port $PORT"; fi

[ "$(value "$WEB_UNIT" ActiveState)" = active ] && ok "$WEB_UNIT ActiveState=active" || bad "$WEB_UNIT ActiveState not active"
[ "$(value "$WEB_UNIT" UnitFileState)" = enabled ] && ok "$WEB_UNIT enabled" || bad "$WEB_UNIT not enabled"
[ "$(value "$WEB_UNIT" Result)" = success ] && ok "$WEB_UNIT Result=success" || bad "$WEB_UNIT Result not success"
[ "$(value "$OBS_UNIT" ActiveState)" = active ] && ok "$OBS_UNIT ActiveState=active" || bad "$OBS_UNIT ActiveState not active"
[ "$(value "$OBS_UNIT" UnitFileState)" = enabled ] && ok "$OBS_UNIT enabled" || bad "$OBS_UNIT not enabled"
[ "$(value "$OBS_UNIT" Result)" = success ] && ok "$OBS_UNIT Result=success" || bad "$OBS_UNIT Result not success"
[ "$(value "$OBS_UNIT" NRestarts)" = 0 ] && ok "$OBS_UNIT NRestarts=0" || bad "$OBS_UNIT restarted"
WEB_PID=$(value "$WEB_UNIT" MainPID)
OBS_PID=$(value "$OBS_UNIT" MainPID)
MAIN_PID=$(pgrep -x obs | head -n 1 || true)
[ "$OBS_PID" = "$MAIN_PID" ] && ok "single OBS process ($MAIN_PID)" || bad "OBS MainPID=$OBS_PID pgrep=$MAIN_PID"
[ "$(pgrep -x -c obs || true)" = 1 ] && ok 'exactly one obs process' || bad 'not exactly one obs process'
ENV_SOURCE=${LYBLIVE_OBS_ENV_FILE:-/proc/$OBS_PID/environ}
check test -r "$ENV_SOURCE"
OBS_ENV=$(tr '\0' '\n' < "$ENV_SOURCE" 2>/dev/null || true)
if [ -n "$OBS_ENV" ]; then ok 'OBS process environment readable'; else bad 'OBS process environment unreadable'; fi
if printf '%s\n' "$OBS_ENV" | grep -q '^WAYLAND_DISPLAY='; then bad 'WAYLAND_DISPLAY inherited by OBS'; else ok 'WAYLAND_DISPLAY unset in OBS'; fi
if printf '%s\n' "$OBS_ENV" | grep -q '^SESSION_MANAGER='; then bad 'SESSION_MANAGER inherited by OBS'; else ok 'SESSION_MANAGER unset in OBS'; fi
if printf '%s\n' "$OBS_ENV" | grep -q '^DESKTOP_STARTUP_ID='; then bad 'DESKTOP_STARTUP_ID inherited by OBS'; else ok 'DESKTOP_STARTUP_ID unset in OBS'; fi
if printf '%s\n' "$OBS_ENV" | grep -q '^XDG_ACTIVATION_TOKEN='; then bad 'XDG_ACTIVATION_TOKEN inherited by OBS'; else ok 'XDG_ACTIVATION_TOKEN unset in OBS'; fi
if printf '%s\n' "$OBS_ENV" | grep -q '^QT_QPA_PLATFORM=xcb$'; then ok 'QT_QPA_PLATFORM=xcb'; else bad 'QT_QPA_PLATFORM not xcb'; fi
if printf '%s\n' "$OBS_ENV" | grep -q '^XDG_SESSION_TYPE=x11$'; then ok 'XDG_SESSION_TYPE=x11'; else bad 'XDG_SESSION_TYPE not x11'; fi
MGR_ENV=$(systemctl --user show-environment 2>/dev/null || true)
MGR_XAUTH=$(printf '%s\n' "$MGR_ENV" | sed -n 's/^XAUTHORITY=//p' | head -n 1)
MGR_DISPLAY=$(printf '%s\n' "$MGR_ENV" | sed -n 's/^DISPLAY=//p' | head -n 1)
OBS_XAUTH=$(printf '%s\n' "$OBS_ENV" | sed -n 's/^XAUTHORITY=//p' | head -n 1)
OBS_DISPLAY=$(printf '%s\n' "$OBS_ENV" | sed -n 's/^DISPLAY=//p' | head -n 1)
if [ -z "$(value "$OBS_UNIT" PassEnvironment)" ]; then ok 'effective PassEnvironment is empty (systemd --user inherits env)'; else bad 'effective PassEnvironment still set (no-op for systemd --user)'; fi
if [ -n "$OBS_XAUTH" ]; then ok 'OBS process XAUTHORITY is set'; else bad 'OBS process XAUTHORITY missing (session manager inheritance broken)'; fi
if [ -n "$MGR_XAUTH" ] && [ "$OBS_XAUTH" = "$MGR_XAUTH" ]; then ok 'OBS XAUTHORITY matches session manager'; else bad 'OBS XAUTHORITY does not match session manager'; fi
if [ -n "$OBS_XAUTH" ] && [ -r "$OBS_XAUTH" ]; then ok 'XAUTHORITY cookie file readable'; else bad "XAUTHORITY cookie file unreadable: $OBS_XAUTH"; fi
if [ -n "$OBS_DISPLAY" ] && [ "$OBS_DISPLAY" = "$MGR_DISPLAY" ]; then ok 'OBS DISPLAY matches session manager'; else bad 'OBS DISPLAY does not match session manager'; fi
unset OBS_ENV MGR_ENV
CMDLINE=$(tr '\0' ' ' < "/proc/$OBS_PID/cmdline" 2>/dev/null || true)
case "$CMDLINE" in
  *"obs --multi --disable-updater"*) ok 'OBS cmdline uses --multi --disable-updater' ;;
  *) bad "unexpected OBS cmdline: $CMDLINE" ;;
esac

HEALTH=$(curl -sS -m 3 -H "Host: 127.0.0.1:$PORT" "http://127.0.0.1:$PORT/api/health" || true)
if printf '%s' "$HEALTH" | grep -Eq '"ok":[[:space:]]*true'; then ok 'health ok:true'; else bad "health response: $HEALTH"; fi
CONNS=$(ss -tnp 2>/dev/null || true)
if printf '%s\n' "$CONNS" | grep -F "127.0.0.1:$PORT" | grep -Fq "users:((\"lyblive\",pid=$WEB_PID"; then ok 'health port owner matches web unit'; else bad 'loopback port not owned by web unit'; fi
if printf '%s\n' "$CONNS" | grep -F "127.0.0.1:$PORT" | grep -q 'obs-browser-pag'; then ok 'dock browser connected to loopback health port'; else bad 'no obs-browser-page to loopback connection'; fi

USER_INI="$HOME_DIR/.config/obs-studio/user.ini"
if [ -r "$USER_INI" ] && grep -Eq "^ExtraBrowserDocks=.*\"title\"[[:space:]]*:[[:space:]]*\"lyblive\".*\"url\"[[:space:]]*:[[:space:]]*\"http://127\.0\.0\.1:$PORT/\"" "$USER_INI"; then ok 'user.ini has lyblive dock URL'; else bad 'user.ini missing lyblive dock URL'; fi
SCENES="$HOME_DIR/.config/obs-studio/basic/scenes"
if [ -d "$SCENES" ] && ! grep -Rqs 'browser_source' "$SCENES"; then ok 'scene collection has no Browser Source'; else bad 'unexpected browser_source or missing scene directory'; fi

LOG=$(find "$HOME_DIR/.config/obs-studio/logs" -maxdepth 2 -type f -name '*.txt' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n 1 | cut -d' ' -f2-)
if [ -n "$LOG" ] && [ -r "$LOG" ]; then ok 'latest OBS log readable'; else bad 'latest OBS log missing'; LOG=''; fi
if [ -n "$LOG" ] && grep -q 'Using EGL/X11' "$LOG"; then ok 'latest OBS log: Using EGL/X11'; else bad 'latest OBS log lacks Using EGL/X11'; fi
if [ -n "$LOG" ] && grep -q 'Session Type: x11' "$LOG"; then ok 'latest OBS log: Session Type: x11'; else bad 'latest OBS log lacks Session Type: x11'; fi
if [ -n "$LOG" ] && grep -q 'obs-browser' "$LOG"; then ok 'latest OBS log: obs-browser loaded'; else bad 'latest OBS log lacks obs-browser'; fi
if [ -n "$LOG" ] && ! grep -q 'Shutting down' "$LOG"; then ok 'latest OBS log has no shutdown'; else bad 'latest OBS log contains Shutting down'; fi

UNIT_FILE=$(systemctl --user show "$OBS_UNIT" -p FragmentPath --value)
CHECK_UNIT_FILE=${LYBLIVE_OBS_UNIT_FILE:-$UNIT_FILE}
USER_UNIT_DIR="$HOME_DIR/.config/systemd/user"
graphical_link="$USER_UNIT_DIR/graphical-session.target.wants/$OBS_UNIT"
default_link="$USER_UNIT_DIR/default.target.wants/$OBS_UNIT"
if [ -r "$CHECK_UNIT_FILE" ]; then ok "OBS unit file readable"; else bad "OBS unit file missing"; fi
if [ "$(value graphical-session.target ActiveState)" = active ]; then ok "graphical-session.target ActiveState=active"; else bad "graphical-session.target not active"; fi
if [ -r "$CHECK_UNIT_FILE" ] && grep -Fxq "WantedBy=graphical-session.target" "$CHECK_UNIT_FILE"; then ok "unit WantedBy=graphical-session.target"; else bad "unit not WantedBy=graphical-session.target"; fi
if [ -r "$CHECK_UNIT_FILE" ] && grep -Fxq "PartOf=graphical-session.target" "$CHECK_UNIT_FILE"; then ok "unit PartOf=graphical-session.target"; else bad "unit missing PartOf=graphical-session.target"; fi
if [ -r "$CHECK_UNIT_FILE" ] && grep -Fxq "After=graphical-session.target" "$CHECK_UNIT_FILE"; then ok "unit After=graphical-session.target"; else bad "unit missing After=graphical-session.target"; fi
if [ -r "$CHECK_UNIT_FILE" ] && grep -Fxq "Wants=$WEB_UNIT" "$CHECK_UNIT_FILE"; then ok "unit Wants=$WEB_UNIT"; else bad "unit missing Wants=$WEB_UNIT"; fi
if [ -r "$CHECK_UNIT_FILE" ] && grep -Fxq "After=$WEB_UNIT" "$CHECK_UNIT_FILE"; then ok "unit After=$WEB_UNIT"; else bad "unit missing After=$WEB_UNIT"; fi
WANTS=$(value graphical-session.target Wants)
case " $WANTS " in
  *" $OBS_UNIT "*) ok "graphical-session.target Wants=$OBS_UNIT" ;;
  *) bad "graphical-session.target does not Wants=$OBS_UNIT" ;;
esac
if [ ! -e "$default_link" ] && [ ! -L "$default_link" ]; then ok "no default.target.wants/$OBS_UNIT symlink"; else bad "stale default.target.wants/$OBS_UNIT symlink"; fi
LINK_TARGET=$(readlink -f "$graphical_link" 2>/dev/null || true)
if [ -L "$graphical_link" ] && [ "$LINK_TARGET" = "$UNIT_FILE" ]; then ok "graphical-session.target.wants symlink points to unit"; else bad "missing or wrong graphical-session.target.wants symlink"; fi
if [ -r "$CHECK_UNIT_FILE" ] && grep -Fxq "Restart=on-failure" "$CHECK_UNIT_FILE"; then ok "unit Restart=on-failure"; else bad "unit missing Restart=on-failure"; fi
if [ "$(value "$OBS_UNIT" Restart)" = on-failure ]; then ok "effective Restart=on-failure"; else bad "effective Restart not on-failure"; fi
if [ -r "$CHECK_UNIT_FILE" ] && grep -Fxq "RestartSec=5" "$CHECK_UNIT_FILE"; then ok "unit RestartSec=5"; else bad "unit missing RestartSec=5"; fi
if [ "$(value "$OBS_UNIT" RestartUSec)" = 5s ]; then ok "effective RestartUSec=5s"; else bad "effective RestartUSec not 5s"; fi
EXEC_START=$(awk -F= '/^ExecStart=/{print $2;exit}' "$UNIT_FILE" 2>/dev/null || true)
EXEC_START=$(echo "$EXEC_START" | sed "s|%h|$HOME_DIR|g")
LAUNCHER=$(echo "$EXEC_START" | awk '{print $1;exit}')
if [ -n "$LAUNCHER" ] && launcher_ok "$LAUNCHER"; then ok "launcher clears session vars and forces X11"; else bad "launcher missing or misconfigured: $LAUNCHER"; fi
check systemd-analyze --user verify "$UNIT_FILE"
SCRIPT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEPLOY_DIR="$SCRIPT_ROOT/deploy"
DEPLOY_WEB_UNIT="$DEPLOY_DIR/lyblive.service"
DEPLOY_OBS_UNIT="$DEPLOY_DIR/lyblive-obs.service"
DEPLOY_LAUNCHER="$DEPLOY_DIR/lyblive-obs"
if [ -r "$DEPLOY_WEB_UNIT" ] && [ -r "$DEPLOY_OBS_UNIT" ] && [ -r "$DEPLOY_LAUNCHER" ] && [ -r "$DEPLOY_DIR/install.py" ] && [ -r "$DEPLOY_DIR/README.md" ]; then ok 'portable deploy templates readable'; else bad 'portable deploy templates missing'; fi
if [ -r "$DEPLOY_WEB_UNIT" ] && [ -r "$DEPLOY_OBS_UNIT" ] && [ -r "$DEPLOY_LAUNCHER" ] && ! grep -Eq '/home/lilyco|/run/user/|DISPLAY=:|XAUTHORITY=|PassEnvironment=' "$DEPLOY_WEB_UNIT" "$DEPLOY_OBS_UNIT" "$DEPLOY_LAUNCHER"; then ok 'portable deploy templates have no machine/session hardcodes'; else bad 'portable deploy templates hardcode machine/session values'; fi
if grep -Fq 'Environment=HOME=%h' "$DEPLOY_WEB_UNIT" && grep -Fq 'ExecStart=%h/.local/bin/lyblive --web --no-browser' "$DEPLOY_WEB_UNIT"; then ok 'portable web unit uses %h'; else bad 'portable web unit lost %h'; fi
if grep -Fq 'ExecStart=%h/.local/bin/lyblive-obs' "$DEPLOY_OBS_UNIT" && grep -Fq 'WantedBy=graphical-session.target' "$DEPLOY_OBS_UNIT"; then ok 'portable OBS unit uses %h and graphical session'; else bad 'portable OBS unit drift'; fi
if [ -r "$DEPLOY_DIR/install.py" ] && grep -Fq 'def workdir_spec' "$DEPLOY_DIR/install.py" && grep -Fq -- '--fixture refuses the real user home' "$DEPLOY_DIR/install.py"; then ok 'portable installer guards intact'; else bad 'portable installer guards missing'; fi
if [ -r "$DEPLOY_DIR/README.md" ] && grep -Fq 'no-op' "$DEPLOY_DIR/README.md" && grep -Fq -- '--deploy' "$DEPLOY_DIR/README.md"; then ok 'deploy README documents no-op and --deploy'; else bad 'deploy README stale'; fi
INSTALLER="$DEPLOY_DIR/install.py"
INI_STATIC_OK=1
for marker in \
  'def section_name' \
  'def is_dock_key' \
  'def read_raw' \
  'newline=""' \
  'basic_lines = [i for i, line in enumerate(lines) if section_name(line) == "BasicWindow"]' \
  'lines.append("[BasicWindow]" + eol)' \
  'render_dock(read_raw(DOCK_INI))' \
  "text.lstrip(\"\\ufeff\")" \
  "bom = \"\\ufeff\" if text.startswith(\"\\ufeff\") else \"\"" \
  'return bom + "".join(lines)' \
  "stripped = text.lstrip(\"\\ufeff\").lstrip()" \
  'Qt readIniLine accepts leading whitespace before the bracket' \
  'def qt_value' \
  'elif ch == ";" and not in_quotes:'
do
  grep -Fq -- "$marker" "$INSTALLER" || INI_STATIC_OK=0
done
if [ "$INI_STATIC_OK" -eq 1 ] && ! grep -Fq 'if lines[i].startswith("ExtraBrowserDocks=")' "$INSTALLER" && ! grep -Fq 'lstrip().startswith("[") and lines[i].rstrip().endswith("]")' "$INSTALLER"; then ok 'render_dock uses Qt-equivalent INI parsing and raw CRLF-safe writes'; else bad 'render_dock regressed to stale INI matching or newline translation'; fi
SMOKE_TEST="$SCRIPT_ROOT/scripts/deploy-install-smoke.mjs"
CONTAIN_STATIC_OK=1
for marker in \
  'def within' \
  'path.resolve().relative_to(root.resolve())' \
  'except (OSError, ValueError, RuntimeError):' \
  'WRITE_FILES =' \
  'backup.is_symlink()' \
  'def backup_copy' \
  'os.link(tmp, preferred)' \
  'mkstemp is collision-free even for a frozen clock or repeated writes' \
  'def atomic_copy' \
  'dest.is_file() and not dest.is_symlink()' \
  'atomic_copy(src, dest, 0o755)' \
  'not within(candidate, HOME) or within(candidate, REAL_HOME)' \
  'to stay inside the temporary HOME and outside the real home'
do
  grep -Fq -- "$marker" "$INSTALLER" || CONTAIN_STATIC_OK=0
done
for marker in \
  'symlinkSync' \
  '--fixture requires --dock-ini' \
  '--fixture requires XDG_CONFIG_HOME' \
  'fixture symlink escape overwrote target outside HOME' \
  'makeContainmentHome' \
  '--fixture requires lyblive.service' \
  '--fixture requires binary' \
  'symlinked unit destination wrote outside HOME' \
  'symlinked backup wrote outside HOME' \
  'symlinked binary destination wrote outside HOME' \
  'binary destination was not atomically replaced' \
  'relaxed unchanged fast path followed a binary symlink to its source' \
  'symlink-to-source binary was not atomically replaced' \
  'backup_copy did not create a fresh regular backup beside any write-through link' \
  'LYBLIVE_SMOKE_FORCE_NO_SYMLINK' \
  'linkSync' \
  'supportsSymlinks' \
  'Windows/hard-link fallback exercised' \
  'Windows hard-link fallback wrote through to outside sentinel' \
  'Windows hard-link backup fallback wrote through to outside sentinel' \
  'backup_copy did not preserve a regular backup beside a hard link'
do
  grep -Fq -- "$marker" "$SMOKE_TEST" || CONTAIN_STATIC_OK=0
done
if [ "$CONTAIN_STATIC_OK" -eq 1 ]; then ok 'fixture containment guards intact (symlink-resolved outputs, backups and atomic replacement)'; else bad 'fixture containment guards missing'; fi
MODE_STATIC_OK=1
for marker in \
  'def owner_mode_ok' \
  'return current == (mode & 0o777)' \
  'def repair_owner_mode' \
  'os.chmod(path, mode & 0o777)' \
  'def dock_target_text' \
  'parser.error(str(exc))' \
  'def plan_text_state' \
  '# Validate the dock before any apply writes' \
  'dock_text = dock_target_text() if' \
  'state = plan_text_state(dest, text, mode)' \
  'binary_state = "keep existing / mode repair"' \
  'binary mode repaired' \
  'def read_raw_or_none' \
  'def dock_write_path' \
  'DOCK_WRITE = dock_write_path()' \
  'atomic_write(DOCK_WRITE, dock_text, old_mode)' \
  "def check_readable_source" \
  "def check_write_target" \
  "def preflight_write_targets" \
  "preflight_write_targets()" \
  "check_readable_source(\"binary\", BIN_SRC)" \
  "cannot read installer source " \
  "refusing to replace " \
  "destination is not a regular file" \
  "parent path is blocked by a non-directory" \
  "cannot read existing " \
  "cannot write " \
  "parent directory is not writable" \
  "os.W_OK | os.X_OK" \
  "OBS_DETECT_TIMEOUT = 5" \
  "timeout=OBS_DETECT_TIMEOUT" \
  "def obs_detection_probe" \
  "def obs_detection_problem" \
  "OBS detection timed out after " \
  "obs_problem = None" \
  "OBS process check: " \
  "def systemctl_preflight" \
  "systemd --user: UNREACHABLE" \
  "systemd --user is not reachable from this shell" \
  "Re-run with --no-systemctl" \
  "files are installed but systemd --user activation failed" \
  "systemctl_problem = None if args.no_systemctl else systemctl_preflight()" \
  '["systemctl", "--user", "show-environment"]' \
  "capture_output=True" \
  "text=True" \
  "timeout=SYSTEMD_TIMEOUT" \
  "SYSTEMD_TIMEOUT = 15" \
  "except subprocess.TimeoutExpired as exc:" \
  "systemctl --user show-environment timed out after " \
  "check=True, timeout=SYSTEMD_TIMEOUT" \
  "HOME must be an absolute path" \
  "XDG_CONFIG_HOME must be an absolute path" \
  "HOME_ABSOLUTE = HOME.is_absolute()" \
  "XDG_CONFIG_HOME_ABSOLUTE = XDG_CONFIG_HOME.is_absolute()" \
  "if not HOME_ABSOLUTE:" \
  "if not XDG_CONFIG_HOME_ABSOLUTE:" \
  "def configured_path(" \
  'raw == "~"' \
  "home / raw[2:]" \
  "def user_path(" \
  "Expand CLI tilde paths from the real account home" \
  "user_path(args.dock_ini)" \
  "user_path(args.bin)" \
  "def bundle_error" \
  "deployment template " \
  "restore deploy/ from the release bundle" \
  "hardcoded-path, or marker-drift deploy template" \
  "bundle_error(name, \"missing file at \" + str(p))" \
  "bundle_error(name, \"cannot be read as UTF-8: \" + str(exc))" \
  "bundle_error(name, \"hardcodes \" + needle)" \
  "bundle_error(unit_name, \"WorkingDirectory marker drift"
do
  grep -Fq -- "$marker" "$INSTALLER" || MODE_STATIC_OK=0
done
for marker in \
  'statSync' \
  'chmodSync' \
  'canonicalMode' \
  'expectMode' \
  'owner executable-bit repair' \
  'extra/special permission-bit repair' \
  '--plan dock errors' \
  "includes('[mode repair]')" \
  "includes('[keep existing / mode repair]')" \
  'atomic bad-JSON rejection' \
  'bad JSON abort left partial writes' \
  'Web unit canonical mode was not repaired' \
  'Web unit extra/special bits were not stripped' \
  "planBad.status === 2 && planOut.includes(bad.expect)" \
  'non-UTF-8 unit --plan exposed a Python traceback' \
  'non-UTF-8 unit backup lost original bytes' \
  'readable non-UTF-8 error missing' \
  'non-UTF-8 dock abort left partial writes' \
  'missing OBS dock [create] not reported' \
  'missing OBS dock [create] was not read-only' \
  'created OBS dock is not mode 0644' \
  'created OBS dock lacks canonical lyblive entry' \
  'readable --no-binary guard did not fire' \
  'missing OBS dock OBS-running guard did not fire' \
  'OBS-running missing-dock guard created user.ini' \
  'dock symlink was replaced instead of writing through' \
  'dock symlink target was not updated' \
  'POSIX dock symlink write-through exercised' \
  'frozen-backup-home' \
  'frozen-clock backup_copy overwrote a prior version' \
  "non-regular/unreadable/blocked-parent destination preflight" \
  "function expectPreflight" \
  "function preflightHome" \
  "DO_NOT_TOUCH" \
  "blocked parent destination preflight did not fire" \
  "blocked parent destination was modified" \
  "blocked parent destination preflight left partial writes" \
  "parent path is blocked by a non-directory" \
  "directory destination preflight did not fire" \
  "unreadable destination preflight did not fire" \
  "non-writable parent preflight did not fire" \
  "unreadable binary source preflight did not fire" \
  "broken destination symlink preflight did not fire" \
  "directory destination preflight left partial writes" \
  "unreadable binary source was installed" \
  "broken destination symlink was overwritten" \
  "cannot read installer source binary" \
  "parent directory is not writable" \
  "destination is not a regular file" \
  "cannot read existing lyblive.service" \
  "systemd --user: UNREACHABLE" \
  "systemd --user is not reachable from this shell" \
  "LYBLIVE_SMOKE_OBS_STATE" \
  "obs-detect-sim" \
  "raise subprocess.TimeoutExpired" \
  "hung OBS detection guard did not fire" \
  "bounded OBS detection exercised" \
  "unreachable-systemd preflight with bounded timeouts" \
  "sitecustomize.py" \
  "hung systemd user manager" \
  "systemd --user show-environment timed out after " \
  "systemd --apply left partial writes" \
  "--no-systemctl plan line missing" \
  "UTF-8 BOM dock prefix was lost" \
  "BOM dock gained a duplicate [BasicWindow] section" \
  "BOM dock left duplicate ExtraBrowserDocks keys" \
  "BOM dock second --apply was not idempotent" \
  "BOM+inline-comment repair" \
  "indented [Other] dock key was absorbed into BasicWindow" \
  "indented [Other] dock key was destroyed" \
  "indented [BasicWindow] fixture gained a duplicate section" \
  "indented-header section boundaries" \
  "quoted-semicolon dock values" \
  'quoted ";" in a dock URL was truncated' \
  "name: 'relative HOME'" \
  "name: 'relative XDG_CONFIG_HOME'" \
  "5 input guards (including relative HOME/XDG_CONFIG_HOME, no traceback), 4 corrupt-bundle guards" \
  "tilde HOME did not expand to the real account home" \
  "const homeMatch = tildeOut.match" \
  "isAbsolute(homeMatch[1])" \
  "const tildeBinPath = join(tildeRealHome, tildeBinName)" \
  "tilde --bin did not resolve from the real account home" \
  "tilde --dock-ini did not resolve from the real account home" \
  "'OBS dock -> ' + tildeDockPath + ' [create]'" \
  "tilde --dock-ini --plan wrote outside the temporary fixture" \
  "exposed a Python traceback" \
  "corrupt bundle " \
  "const corruptRoot" \
  "non-UTF-8 template" \
  "hardcoded path" \
  "marker drift" \
  "deployment template " \
  "restore deploy/ from the release bundle" \
  "corrupt-bundle guards"
do
  grep -Fq -- "$marker" "$SMOKE_TEST" || MODE_STATIC_OK=0
done
if [ "$MODE_STATIC_OK" -eq 1 ] && ! grep -Fq 'time.strftime("%Y%m%d%H%M%S")' "$INSTALLER" && ! grep -Fq 'os.replace(tmp, backup)' "$INSTALLER"; then ok 'frozen-clock collision-free, missing-dock/dock-symlink, bounded OBS/tilde-HOME/CLI validation, corrupt-bundle and unreachable-systemd guards intact'; else bad 'frozen-clock backup collision, missing-dock/dock-symlink or unreachable-systemd guard drift'; fi

BILI_CLIENT="$SCRIPT_ROOT/src/bili/client.rs"
BILI_BRANCH_LINE="$(grep -Fn 'if code == 60043' "$BILI_CLIENT" | head -n 1 | cut -d: -f1 || true)"
BILI_RETURN_LINE="$(grep -Fn 'Err(anyhow!("{text}")' "$BILI_CLIENT" | head -n 1 | cut -d: -f1 || true)"
BILI_STATIC_OK=1
[ -n "$BILI_BRANCH_LINE" ] && [ -n "$BILI_RETURN_LINE" ] && [ "$BILI_RETURN_LINE" -gt "$BILI_BRANCH_LINE" ] || BILI_STATIC_OK=0
if [ "$BILI_STATIC_OK" -eq 1 ]; then
  BILI_SECTION="$(sed -n "${BILI_BRANCH_LINE},${BILI_RETURN_LINE}p" "$BILI_CLIENT")"
  for marker in \
    "text.push_str(concat!(" \
    "关播状态且 OBS 未推流" \
    "B 站手机客户端或官方直播姬" \
    "不会索取或保存账号凭据"
  do
    printf '%s\n' "$BILI_SECTION" | grep -Fq -- "$marker" || BILI_STATIC_OK=0
  done
fi
for marker in \
  "if code == 60043" \
  "code_60043_adds_official_face_verification_guidance" \
  "unrelated_api_codes_do_not_claim_face_verification" \
  '!e.contains("人脸认证")'
do
  grep -Fq -- "$marker" "$BILI_CLIENT" || BILI_STATIC_OK=0
done
if [ "$BILI_STATIC_OK" -eq 1 ] && grep -Fq "code 60043" "$SCRIPT_ROOT/README.md" && grep -Fq "不是 lyblive 或 OBS 的功能入口" "$SCRIPT_ROOT/README.md"; then ok 'code 60043 official-client guidance, negative test and boundary docs intact'; else bad 'code 60043 face-verification guidance drift'; fi
if [ -r "$SMOKE_TEST" ] && node "$SMOKE_TEST" >/dev/null 2>&1; then ok 'portable installer offline smoke test passed'; else bad 'portable installer offline smoke test missing or failed'; fi
if [ -r "$SMOKE_TEST" ] && LYBLIVE_SMOKE_FORCE_NO_SYMLINK=1 node "$SMOKE_TEST" >/dev/null 2>&1; then ok 'Windows-like hard-link installer smoke passed'; else bad 'Windows-like hard-link installer smoke missing or failed'; fi
CI_WORKFLOW="$SCRIPT_ROOT/.github/workflows/ci.yml"
CI_CONTRACT="$SCRIPT_ROOT/scripts/ci-contract.mjs"
if [ -r "$CI_WORKFLOW" ] && [ -r "$CI_CONTRACT" ] && \
   [ "$(grep -Ec "^[[:space:]]*-[[:space:]]*uses: actions/setup-python@v5[[:space:]]*\$" "$CI_WORKFLOW" || true)" -ge 2 ] && \
   [ "$(grep -Ec "^[[:space:]]*python-version: ('3[.]12'|\"3[.]12\")[[:space:]]*\$" "$CI_WORKFLOW" || true)" -ge 2 ]; then
  ok 'CI pins Python 3.12 in both jobs'
else
  bad 'CI Python setup/version drift'
fi
if [ -r "$CI_WORKFLOW" ] && [ "$(grep -Fc -- "LYBLIVE_SMOKE_FORCE_NO_SYMLINK: '1'" "$CI_WORKFLOW" || true)" -ge 2 ] && [ "$(grep -Fc -- 'run: node scripts/deploy-install-smoke.mjs' "$CI_WORKFLOW" || true)" -ge 4 ]; then
  ok 'CI runs normal + Windows-like installer smoke in both jobs'
else
  bad 'CI normal/Windows-like installer smoke drift'
fi
if [ -r "$CI_CONTRACT" ] && node "$CI_CONTRACT" >/dev/null 2>&1 && node "$CI_CONTRACT" --deploy >/dev/null 2>&1; then ok 'CI contract (base + --deploy) passes'; else bad 'CI contract failed'; fi
if [ -r "$CHECK_UNIT_FILE" ] && ! grep -Fq 'PassEnvironment=' "$CHECK_UNIT_FILE"; then ok 'unit avoids no-op PassEnvironment (systemd --user)'; else bad 'unit still uses no-op PassEnvironment or missing'; fi
WEB_UNIT_FILE=$(value "$WEB_UNIT" FragmentPath)
CHECK_WEB_UNIT_FILE=${LYBLIVE_WEB_UNIT_FILE:-$WEB_UNIT_FILE}
web_default_link="$USER_UNIT_DIR/default.target.wants/$WEB_UNIT"
web_graphical_link="$USER_UNIT_DIR/graphical-session.target.wants/$WEB_UNIT"
if [ -r "$CHECK_WEB_UNIT_FILE" ] && grep -Fxq 'WantedBy=default.target' "$CHECK_WEB_UNIT_FILE"; then ok "$WEB_UNIT WantedBy=default.target (headless)"; else bad "$WEB_UNIT not WantedBy=default.target"; fi
if [ -r "$CHECK_WEB_UNIT_FILE" ] && ! grep -Fxq 'WantedBy=graphical-session.target' "$CHECK_WEB_UNIT_FILE"; then ok "$WEB_UNIT not WantedBy=graphical-session.target"; else bad "$WEB_UNIT wrongly WantedBy=graphical-session.target"; fi
DEFAULT_WANTS=$(value default.target Wants)
case " $DEFAULT_WANTS " in
  *" $WEB_UNIT "*) ok "default.target Wants=$WEB_UNIT (headless backend)";;
  *) bad "default.target does not Wants=$WEB_UNIT";;
esac
WEB_LINK_TARGET=$(readlink -f "$web_default_link" 2>/dev/null || true)
if [ -L "$web_default_link" ] && [ "$WEB_LINK_TARGET" = "$WEB_UNIT_FILE" ]; then ok "default.target.wants/$WEB_UNIT symlink points to web unit"; else bad "missing or wrong default.target.wants/$WEB_UNIT symlink"; fi
if [ ! -e "$web_graphical_link" ] && [ ! -L "$web_graphical_link" ]; then ok "no graphical-session.target.wants/$WEB_UNIT symlink"; else bad "stale graphical-session.target.wants/$WEB_UNIT symlink"; fi
printf 'RESULT %s checks failed\n' "$FAILED"
[ "$FAILED" -eq 0 ]
