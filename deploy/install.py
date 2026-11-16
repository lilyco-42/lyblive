#!/usr/bin/env python3
"""Install lyblive's portable single-OBS systemd --user deployment.

Default is a read-only plan. --apply writes units/launcher/binary, creates
backups, and optionally reloads+enables user units. It never restarts a
running service. --fixture is for offline tests: it refuses the real home and
confines all write targets (including backups and symlink-resolved paths)
to the temporary HOME. It gives repeated backups unique atomic names,
repairs canonical permission bits and strips special bits without rewriting unchanged file content. Non-UTF-8 text gets a
readable error or a safe backup/replacement, a missing OBS dock is created,
and a dock symlink is written through to its target instead of replaced. A
missing dock is created only when OBS is not running. OBS detection is bounded
and a hung process lister becomes a readable refusal before any write.
preflight rejects non-regular/unreadable destinations and blocked parent paths
before --plan or --apply, so user data is never overwritten through a
traceback. Every systemd --user subprocess is bounded so a hung manager
cannot leave --plan/--apply waiting indefinitely. A missing, non-UTF-8,
hardcoded-path, or marker-drift deploy template becomes a readable argparse
error before any plan output or write.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path


def read_raw(path: Path) -> str:
    """Read UTF-8 text without universal-newline translation (preserve CRLF)."""
    try:
        with open(path, "r", encoding="utf-8", newline="") as f:
            return f.read()
    except (UnicodeDecodeError, OSError) as exc:
        raise RuntimeError("cannot read " + str(path) + " as UTF-8: " + str(exc)) from exc


def read_raw_or_none(path: Path) -> str | None:
    """Non-UTF-8 existing files are a content mismatch, not a traceback; unreadable paths are rejected by preflight."""
    try:
        return read_raw(path)
    except RuntimeError:
        return None

ROOT = Path(__file__).resolve().parent.parent
DEPLOY = ROOT / "deploy"
def system_home() -> Path:
    """Resolve the account home without trusting an overridden HOME (fixtures)."""
    try:
        import pwd  # POSIX only
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    except (ImportError, AttributeError):
        drive = os.environ.get("HOMEDRIVE", "")
        homepath = os.environ.get("HOMEPATH", "")
        candidate = os.environ.get("USERPROFILE") or (drive + homepath) or str(Path.home())
        return Path(candidate).resolve()

REAL_HOME = system_home()
def configured_path(name: str, default: str) -> Path:
    """Only expand '~' when it is a real account home; never create a path during parsing."""
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return Path(default)
    if raw == "~" or raw.startswith("~/") or raw.startswith("~\\") or (os.name == "nt" and (raw.startswith("~") and ("\\" in raw))):
        home = Path(REAL_HOME)
        if raw == "~":
            return home
        return home / raw[2:]
    return Path(raw)

def user_path(raw: str) -> Path:
    """Expand CLI tilde paths from the real account home, never from a fixture HOME."""
    if raw == "~":
        return Path(REAL_HOME)
    if raw.startswith("~/") or raw.startswith("~\\") or (os.name == "nt" and raw.startswith("~") and "\\" in raw):
        return Path(REAL_HOME) / raw[2:]
    return Path(raw)

HOME = configured_path("HOME", str(REAL_HOME))
XDG_CONFIG_HOME = configured_path("XDG_CONFIG_HOME", str(HOME / ".config"))
HOME_ABSOLUTE = HOME.is_absolute()
XDG_CONFIG_HOME_ABSOLUTE = XDG_CONFIG_HOME.is_absolute()
BIN_DIR = HOME / ".local" / "bin"
UNIT_DIR = XDG_CONFIG_HOME / "systemd" / "user"
OBS_INI = XDG_CONFIG_HOME / "obs-studio" / "user.ini"
UNITS = ("lyblive.service", "lyblive-obs.service")
SYSTEMD_TIMEOUT = 15  # seconds; a stuck user manager must not hang plan/apply forever
OBS_DETECT_TIMEOUT = 5  # seconds; a hung process lister must not hang plan/apply forever

parser = argparse.ArgumentParser(description="Install lyblive systemd --user deployment")
parser.add_argument("--apply", action="store_true", help="write files; default only prints a plan")
parser.add_argument("--plan", action="store_true", help="explicit read-only plan (default)")
parser.add_argument("--configure-dock", action="store_true", help="update OBS Custom Browser Dock in user.ini")
parser.add_argument("--no-systemctl", action="store_true", help="skip verify/daemon-reload/enable")
parser.add_argument("--fixture", action="store_true", help="offline test mode: implies --no-systemctl and refuses the real home")
parser.add_argument("--bin", default=None, help="lyblive binary to install (default: target/release/lyblive)")
parser.add_argument("--no-binary", action="store_true", help="keep the already installed ~/.local/bin/lyblive")
parser.add_argument("--dock-ini", default=None, help="override OBS user.ini path (offline fixtures)")
args = parser.parse_args()

if not HOME_ABSOLUTE:
    parser.error("HOME must be an absolute path; got " + repr(os.environ.get("HOME")))
if not XDG_CONFIG_HOME_ABSOLUTE:
    parser.error("XDG_CONFIG_HOME must be an absolute path; got " + repr(os.environ.get("XDG_CONFIG_HOME")))
if args.plan and args.apply:
    parser.error("--plan and --apply are mutually exclusive")
if args.fixture and HOME.resolve() == REAL_HOME:
    parser.error("--fixture refuses the real user home; it is only for offline copies")
if args.fixture:
    args.no_systemctl = True
if args.dock_ini and not args.configure_dock:
    parser.error("--dock-ini requires --configure-dock")

def workdir_spec() -> str:
    """Keep the repo location portable: %h/<relative> under HOME, else an absolute path."""
    if args.fixture:
        return "%h/code/lyblive"
    try:
        rel = ROOT.resolve().relative_to(HOME.resolve())
        return "%h" if str(rel) == "." else "%h/" + rel.as_posix()
    except ValueError:
        return str(ROOT.resolve())
if args.no_binary and args.bin:
    parser.error("--no-binary and --bin are mutually exclusive")
DOCK_INI = user_path(args.dock_ini) if args.dock_ini else OBS_INI

def within(path: Path, root: Path) -> bool:
    """Resolve symlinks before checking path containment (portable Python >= 3.7)."""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except (OSError, ValueError, RuntimeError):
        return False

if args.fixture:
    if within(REAL_HOME, HOME):
        parser.error("--fixture HOME must not contain the real user home")
    WRITE_FILES = (("lyblive.service", UNIT_DIR / UNITS[0]),
                   ("lyblive-obs.service", UNIT_DIR / UNITS[1]),
                   ("lyblive-obs", BIN_DIR / "lyblive-obs"),
                   ("binary", BIN_DIR / "lyblive"),
                   ("--dock-ini", DOCK_INI))
    # Resolve directories, output files and backup paths before writing; a symlink
    # at any of these destinations must not redirect fixture writes outside HOME.
    for label, candidate in (("XDG_CONFIG_HOME", XDG_CONFIG_HOME), ("UNIT_DIR", UNIT_DIR), ("BIN_DIR", BIN_DIR)) + WRITE_FILES:
        if candidate.is_symlink() or not within(candidate, HOME) or within(candidate, REAL_HOME):
            parser.error("--fixture requires " + label + " to stay inside the temporary HOME and outside the real home: " + str(candidate))
    for label, candidate in WRITE_FILES:
        backup = candidate.with_name(candidate.name + ".dsh-portable-backup")
        if backup.is_symlink() or not within(backup, HOME) or within(backup, REAL_HOME):
            parser.error("--fixture requires " + label + " backup to stay inside the temporary HOME and outside the real home: " + str(backup))

def dock_write_path() -> Path:
    """Write through a user.ini symlink to its resolved target; keep the link."""
    if not DOCK_INI.is_symlink():
        return DOCK_INI
    try:
        return DOCK_INI.resolve()
    except (OSError, RuntimeError) as exc:
        parser.error("cannot resolve OBS dock symlink " + str(DOCK_INI) + ": " + str(exc))

DOCK_WRITE = dock_write_path()

try:
    PORT = int(os.environ.get("LYBLIVE_PORT", "8768"))
except ValueError:
    parser.error("LYBLIVE_PORT must be an integer")
if not 1 <= PORT <= 65535:
    parser.error("LYBLIVE_PORT must be in 1..65535")

def bundle_error(name: str, detail: str) -> None:
    """Corrupt or incomplete deploy/ files must fail with argparse, not a traceback."""
    parser.error("deployment template " + name + " is invalid: " + detail + "; restore deploy/ from the release bundle")


def read_template(name: str) -> str:
    p = DEPLOY / name
    try:
        if not p.is_file():
            bundle_error(name, "missing file at " + str(p))
        return p.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as exc:
        bundle_error(name, "cannot be read as UTF-8: " + str(exc))

def assert_portable(text: str, name: str) -> None:
    forbidden = ("/home/lilyco", "/run/user/", "DISPLAY=:", "XAUTHORITY=", "PassEnvironment=")
    for needle in forbidden:
        if needle in text:
            bundle_error(name, "hardcodes " + needle)

WEB_UNIT = read_template("lyblive.service")
OBS_UNIT = read_template("lyblive-obs.service")
LAUNCHER = read_template("lyblive-obs")
WORKDIR_MARKER = "WorkingDirectory=%h/code/lyblive"
assert_portable(WEB_UNIT, "lyblive.service")
assert_portable(OBS_UNIT, "lyblive-obs.service")
assert_portable(LAUNCHER, "lyblive-obs")
WORKDIR = workdir_spec()
for unit_name, unit_text in (("lyblive.service", WEB_UNIT), ("lyblive-obs.service", OBS_UNIT)):
    if unit_text.count(WORKDIR_MARKER) != 1:
        bundle_error(unit_name, "WorkingDirectory marker drift: expected exactly one " + WORKDIR_MARKER)
WEB_UNIT = WEB_UNIT.replace(WORKDIR_MARKER, f"WorkingDirectory={WORKDIR}")
OBS_UNIT = OBS_UNIT.replace(WORKDIR_MARKER, f"WorkingDirectory={WORKDIR}")
marker = "Environment=LYBLIVE_PORT=8768"
if WEB_UNIT.count(marker) != 1:
    bundle_error("lyblive.service", "port marker drift: expected exactly one " + marker)
WEB_UNIT = WEB_UNIT.replace(marker, f"Environment=LYBLIVE_PORT={PORT}")
for marker_text in ("%h", "WantedBy=default.target"):
    if marker_text not in WEB_UNIT:
        bundle_error("lyblive.service", "missing " + marker_text)
for marker_text in ("%h", "WantedBy=graphical-session.target", "PartOf=graphical-session.target"):
    if marker_text not in OBS_UNIT:
        bundle_error("lyblive-obs.service", "missing " + marker_text)

if args.bin:
    BIN_SRC = user_path(args.bin)
    if not BIN_SRC.is_file():
        parser.error("--bin is not a file: " + str(BIN_SRC))
elif args.no_binary or args.fixture:
    BIN_SRC = None
else:
    candidate = ROOT / "target" / "release" / "lyblive"
    if candidate.is_file():
        BIN_SRC = candidate
    elif (BIN_DIR / "lyblive").is_file():
        BIN_SRC = None
    else:
        parser.error("build target/release/lyblive, pass --bin, or use --no-binary")

if args.no_binary and args.apply and not args.fixture and not (BIN_DIR / "lyblive").is_file():
    parser.error("--no-binary requires an existing " + str(BIN_DIR / "lyblive"))

def unit_dest(name: str) -> Path:
    return UNIT_DIR / name

def backup_copy(dest: Path) -> None:
    """Back up through a fresh sibling file; never write through a backup symlink."""
    prefix = dest.name + ".dsh-portable-backup"
    preferred = dest.with_name(prefix)
    fd, tmp = tempfile.mkstemp(prefix=prefix + ".", dir=str(dest.parent))
    backup = None
    try:
        with os.fdopen(fd, "wb") as out, dest.open("rb") as inp:
            shutil.copyfileobj(inp, out)
        # Never follow a symlink at the preferred backup path.
        if not preferred.exists() and not preferred.is_symlink():
            try:
                os.link(tmp, preferred)
                backup = preferred
            except (FileExistsError, OSError):
                backup = None
        if backup is None:
            # mkstemp is collision-free even for a frozen clock or repeated writes.
            backup = Path(tmp)
            tmp = None
    finally:
        if tmp is not None and os.path.exists(tmp):
            os.unlink(tmp)
    print("backup " + str(dest) + " -> " + str(backup))

def atomic_copy(src: Path, dest: Path, mode: int) -> None:
    """Replace the destination with a fresh regular file (never follow a dest symlink)."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=dest.name + ".", dir=str(dest.parent))
    try:
        with os.fdopen(fd, "wb") as out, src.open("rb") as inp:
            shutil.copyfileobj(inp, out)
        os.chmod(tmp, mode)
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

def owner_mode_ok(path: Path, mode: int) -> bool:
    """Legacy name: require the full canonical POSIX mode, not just owner bits."""
    if os.name != "posix":
        return True  # Windows chmod cannot represent POSIX execute bits.
    try:
        current = path.lstat().st_mode & 0o7777
    except OSError:
        return False
    # Exact canonical mode: missing group/other bits and setuid/setgid/sticky
    # bits must be repaired, not mistaken for a content-only unchanged match.
    return current == (mode & 0o777)

def regular_owner_mode_ok(path: Path, mode: int) -> bool:
    """Never chmod a symlink target; a symlink must be atomically replaced."""
    return path.is_file() and not path.is_symlink() and owner_mode_ok(path, mode)

def repair_owner_mode(path: Path, mode: int) -> None:
    """Canonicalize permission bits and strip special bits without following links."""
    if os.name == "posix":
        if path.is_symlink():
            raise RuntimeError("refusing to chmod a symlink: " + str(path))
        os.chmod(path, mode & 0o777)  # strips special bits; never follows a link

def dock_target_text() -> str:
    try:
        if not DOCK_WRITE.is_file():
            return render_dock("")
        return render_dock(read_raw(DOCK_INI))
    except RuntimeError as exc:
        parser.error(str(exc))  # readable argparse error, never a traceback

def binary_mode_result(dest: Path) -> str:
    """Called only after content equality: repair exe bit without rewriting bytes."""
    if regular_owner_mode_ok(dest, 0o755):
        return "unchanged"
    repair_owner_mode(dest, 0o755)
    return "mode repaired"

def plan_text_state(dest: Path, text: str, mode: int) -> str:
    if not dest.is_file() or dest.is_symlink():
        return "write/update"
    if read_raw_or_none(dest) != text:
        return "write/update"
    return "unchanged" if owner_mode_ok(dest, mode) else "mode repair"
def atomic_write(dest: Path, text: str, mode: int) -> str:
    current = read_raw_or_none(dest) if dest.is_file() and not dest.is_symlink() else None
    if current == text:
        if owner_mode_ok(dest, mode):
            return "unchanged"
        repair_owner_mode(dest, mode)
        return "mode repaired"
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        backup_copy(dest)
    fd, tmp = tempfile.mkstemp(prefix=dest.name + ".", dir=str(dest.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return "written"

def install_binary(src: Path | None, dest: Path) -> str:
    if src is None:
        if dest.is_file() and not dest.is_symlink():
            if owner_mode_ok(dest, 0o755):
                return "skipped binary (offline fixture)" if args.fixture else "kept existing binary"
            repair_owner_mode(dest, 0o755)
            return "binary mode repaired"
        if dest.is_symlink() and dest.is_file():
            # Replace a linked binary with a regular owned copy; never chmod its target.
            src = dest.resolve()
        else:
            return "skipped binary (offline fixture)" if args.fixture else "kept existing binary"
    # A symlink at dest is replaced, not followed; only a regular file can be unchanged.
    if dest.is_file() and not dest.is_symlink() and src.resolve() == dest.resolve():
        return binary_mode_result(dest)
    if dest.is_file() and not dest.is_symlink() and dest.read_bytes() == src.read_bytes():
        return binary_mode_result(dest)
    if args.apply:
        dest.parent.mkdir(parents=True, exist_ok=True)  # atomic replacement: never shutil.copy2(src, dest)
        if dest.exists():
            backup_copy(dest)
        atomic_copy(src, dest, 0o755)
        return "written"
    return "would write"

def section_name(text: str) -> str | None:
    """Return an INI section name the way Qt does, or None.

    Qt readIniLine accepts leading whitespace before the bracket and content
    after the closing bracket (for example "  [Panels] ; comment"), so an
    indented header must still terminate the previous section.  ; lines are
    comments.  A UTF-8 BOM is stripped before parsing and restored at byte 0.
    """
    stripped = text.lstrip("\ufeff").lstrip()
    if not stripped.startswith("["):
        return None
    close = stripped.find("]")
    if close < 0:
        return None
    return stripped[1:close].strip()


def is_dock_key(text: str) -> bool:
    stripped = text.lstrip()
    return stripped.split("=", 1)[0].strip().casefold() == "extrabrowserdocks" and "=" in stripped


def qt_value(text: str) -> str:
    """Return the value Qt readIniLine would keep from an INI value.

    Qt only treats an unquoted ";" as a comment terminator: a ";" inside a
    double-quoted run belongs to the value (dock URLs such as
    "http://127.0.0.1:9/api;jsessionid=abc" must survive), and a backslash
    escapes the character after it.  Truncating at the first ";" regardless of
    quoting would reject perfectly valid ExtraBrowserDocks JSON.
    """
    in_quotes = False
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if ch == chr(34):
            in_quotes = not in_quotes
        elif ch == ";" and not in_quotes:
            return text[:i]
        i += 1
    return text


def render_dock(text: str) -> str:
    """Merge every Qt-visible BasicWindow dock key into one canonical key.

    QSettings groups repeated [BasicWindow] sections into one logical section,
    accepts leading whitespace on keys/headers and content after the closing
    bracket, and on this Linux build compares section/key names case-sensitively.
    Be stricter on keys (casefold) so a case variant cannot survive as a second
    key, but never absorb keys belonging to another section.
    Values keep quoted ";" characters, matching Qt readIniLine (an unquoted ";"
    """
    bom = "\ufeff" if text.startswith("\ufeff") else ""
    if bom:
        text = text[1:]
    lines = text.splitlines(keepends=True)
    basic_lines = [i for i, line in enumerate(lines) if section_name(line) == "BasicWindow"]
    ranges = []
    for n, start in enumerate(basic_lines):
        end = basic_lines[n + 1] if n + 1 < len(basic_lines) else len(lines)
        next_header = next((i for i in range(start + 1, end) if section_name(lines[i]) is not None), end)
        ranges.append((start + 1, next_header))

    dock_idx = [i for start, end in ranges for i in range(start, end) if is_dock_key(lines[i])]
    docks = []
    for i in dock_idx:
        raw = qt_value(lines[i].lstrip().split("=", 1)[1]).strip()
        try:
            part = json.loads(raw)
        except (ValueError, TypeError) as exc:
            raise RuntimeError("ExtraBrowserDocks is not valid JSON; refusing to overwrite: " + str(exc)) from exc
        if not isinstance(part, list):
            raise RuntimeError("ExtraBrowserDocks is not a JSON array; refusing to overwrite")
        docks.extend(part)

    old_uuid = next(
        (str(d.get("uuid")) for d in docks if isinstance(d, dict) and d.get("title") == "lyblive" and d.get("uuid")),
        str(uuid.uuid5(uuid.NAMESPACE_URL, "lyblive/obs-dock")),
    )
    docks = [d for d in docks if not (isinstance(d, dict) and d.get("title") == "lyblive")]
    docks.append({"title": "lyblive", "url": f"http://127.0.0.1:{PORT}/", "uuid": old_uuid})
    canonical = "ExtraBrowserDocks=" + json.dumps(docks, ensure_ascii=False)
    eol = "\r\n" if "\r\n" in text else "\n"

    if dock_idx:
        first = dock_idx[0]
        line_eol = lines[first][len(lines[first].rstrip("\r\n")):]
        lines[first] = canonical + (line_eol or eol)
        for i in reversed(dock_idx[1:]):
            del lines[i]
    elif basic_lines:
        # BasicWindow exists but has no dock key: insert before the next header,
        # repairing a missing trailing newline so the key is never concatenated.
        insert = ranges[0][1]
        if insert > 0 and lines[insert - 1] and lines[insert - 1][-1] not in ("\n", "\r"):
            lines[insert - 1] += eol
        lines.insert(insert, canonical + eol)
    else:
        # No [BasicWindow] at all: create it. A bare top-level key would be read
        # as General/Panels/ExtraBrowserDocks, never by OBS's BasicWindow dock.
        if lines and lines[-1] and lines[-1][-1] not in ("\n", "\r"):
            lines[-1] += eol
        lines.append("[BasicWindow]" + eol)
        lines.append(canonical + eol)
    return bom + "".join(lines)

def systemctl_preflight() -> str | None:
    """Return None when systemd --user is drivable, else the reason it is not.

    The unit files are portable, but verify/daemon-reload/enable need a reachable
    user manager. Probing here keeps --apply from writing units and then dying with
    a CalledProcessError/FileNotFoundError traceback halfway through activation.
    """
    missing = [tool for tool in ("systemd-analyze", "systemctl") if shutil.which(tool) is None]
    if missing:
        return "not found on PATH: " + ", ".join(missing)
    try:
        probe = subprocess.run(["systemctl", "--user", "show-environment"], capture_output=True, text=True, timeout=SYSTEMD_TIMEOUT)
    except subprocess.TimeoutExpired as exc:
        return "systemctl --user show-environment timed out after " + str(exc.timeout) + " seconds"
    except (OSError, subprocess.SubprocessError) as exc:
        return "cannot execute systemctl --user: " + str(exc)
    if probe.returncode != 0:
        lines = [line.strip() for line in (probe.stderr or probe.stdout or "").splitlines() if line.strip()]
        return lines[-1] if lines else "systemctl --user show-environment exited " + str(probe.returncode)
    return None

def obs_detection_probe() -> list[str]:
    """Command used to detect a live OBS; offline fixtures patch subprocess.run."""
    if os.name == "nt":
        return ["tasklist", "/FI", "IMAGENAME eq obs64.exe"]
    return ["pgrep", "-x", "obs"]

def obs_detection_problem() -> str | None:
    """Return None when no OBS is detected, or a readable reason to refuse edits."""
    cmd = obs_detection_probe()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=OBS_DETECT_TIMEOUT)
    except subprocess.TimeoutExpired as exc:
        return "OBS detection timed out after " + str(exc.timeout) + " seconds"
    except (OSError, subprocess.SubprocessError) as exc:
        return "cannot check for OBS: " + str(exc)
    if cmd[0] == "tasklist":
        out = (r.stdout or "").lower()
        return "OBS is running" if "obs64.exe" in out and "no tasks" not in out else None
    return "OBS is running" if r.returncode == 0 else None

PLANNED = [("lyblive.service", unit_dest("lyblive.service"), WEB_UNIT, 0o644),
           ("lyblive-obs.service", unit_dest("lyblive-obs.service"), OBS_UNIT, 0o644),
           ("lyblive-obs", BIN_DIR / "lyblive-obs", LAUNCHER, 0o755)]

def check_readable_source(label: str, src: Path) -> None:
    """Reject an unreadable binary source before a plan can claim it will install."""
    if not src.is_file():
        parser.error("missing " + label + ": " + str(src))
    try:
        with src.open("rb") as f:
            f.read(1)
    except OSError as exc:
        parser.error("cannot read installer source " + label + " at " + str(src) + ": " + str(exc) + "; fix permissions before --apply")

def check_write_target(label: str, dest: Path) -> None:
    """Reject unsafe/unwritable destinations before --plan claims a write is possible."""
    ancestor = dest.parent
    while True:
        if ancestor.exists() or ancestor.is_symlink():
            if not ancestor.is_dir():
                parser.error("refusing to write " + label + ": parent path is blocked by a non-directory: " + str(ancestor))
            break
        if ancestor == ancestor.parent:
            break
        ancestor = ancestor.parent
    # mkstemp and sibling backups need write+search access on the nearest existing
    # parent. Check before any plan/apply output; otherwise --apply dies with a
    # PermissionError traceback after --plan has already claimed a write is possible.
    if not os.access(str(ancestor), os.W_OK | os.X_OK):
        parser.error("cannot write " + label + ": parent directory is not writable: " + str(ancestor) + "; fix permissions before --apply")
    if dest.is_symlink():
        if not dest.is_file():
            parser.error("refusing to replace " + label + ": destination is not a regular file: " + str(dest))
        try:
            with dest.open("rb") as f:
                f.read(1)
        except OSError as exc:
            parser.error("cannot read existing " + label + " symlink target at " + str(dest) + ": " + str(exc) + "; fix permissions or move it aside before --apply")
        return  # os.replace atomically replaces the link, never writes through it
    if not dest.exists():
        return
    if not dest.is_file():
        parser.error("refusing to replace " + label + ": destination is not a regular file: " + str(dest))
    try:
        with dest.open("rb") as f:
            f.read(1)
    except OSError as exc:
        parser.error("cannot read existing " + label + " at " + str(dest) + ": " + str(exc) + "; fix permissions or move it aside before --apply")

def preflight_write_targets() -> None:
    """Validate every input/output path before any plan text or apply writes."""
    for label, dest, _text, _mode in PLANNED:
        check_write_target(label, dest)
    check_write_target("binary", BIN_DIR / "lyblive")
    if args.configure_dock:
        check_write_target("OBS dock", DOCK_WRITE)
    if BIN_SRC is not None:
        check_readable_source("binary", BIN_SRC)

preflight_write_targets()

# Validate the dock before any apply writes; malformed JSON must abort atomically.
dock_text = dock_target_text() if args.configure_dock else None
obs_problem = None
if args.configure_dock and not args.fixture:
    obs_problem = obs_detection_problem()

print("lyblive deployment plan: HOME=" + str(HOME) + " config=" + str(XDG_CONFIG_HOME) + " port=" + str(PORT))
for label, dest, text, mode in PLANNED:
    state = plan_text_state(dest, text, mode)
    print("  " + label + " -> " + str(dest) + " [" + state + "]")
binary_dest = BIN_DIR / "lyblive"
if BIN_SRC:
    binary_state = "source " + str(BIN_SRC)
elif binary_dest.exists() and (binary_dest.is_symlink() or not owner_mode_ok(binary_dest, 0o755)):
    binary_state = "keep existing / mode repair"
else:
    binary_state = "keep existing"
print("  binary -> " + str(binary_dest) + " [" + binary_state + "]")
if args.configure_dock:
    dock_current = False
    if DOCK_WRITE.is_file():
        raw_dock = read_raw_or_none(DOCK_INI)
        dock_current = raw_dock is not None and dock_text == raw_dock
    dock_state = "already current" if dock_current else ("create" if not DOCK_WRITE.is_file() else "write/update")
    print("  OBS dock -> " + str(DOCK_INI) + " [" + dock_state + "]")
    if args.fixture:
        print("  OBS process check: skipped (--fixture)")
    elif obs_problem:
        print("  OBS process check: " + obs_problem + "; --apply will refuse")
    else:
        print("  OBS process check: clear")
systemctl_problem = None if args.no_systemctl else systemctl_preflight()
if args.no_systemctl:
    print("  systemd --user: skipped (--no-systemctl); enable both units manually")
elif systemctl_problem:
    print("  systemd --user: UNREACHABLE (" + systemctl_problem + ")")
    print("    --apply refuses in this state; pass --no-systemctl and enable both units manually")
else:
    print("  systemd --user: daemon-reload + enable both units (no restart)")
print("  running services are NOT restarted by this installer")

if not args.apply:
    sys.exit(0)

if systemctl_problem:
    parser.error("systemd --user is not reachable from this shell (" + systemctl_problem + "); nothing was written. Re-run with --no-systemctl and enable lyblive.service plus lyblive-obs.service manually, or run inside a login/graphical session")

if args.configure_dock and not args.fixture and obs_problem:
    parser.error(obs_problem + ": refusing to edit or create " + str(DOCK_INI) + "; stop OBS first or use --fixture with a copied home for offline tests")

for label, dest, text, mode in PLANNED:
    result = atomic_write(dest, text, mode)
    print(label + ": " + result)
print("binary: " + install_binary(BIN_SRC, BIN_DIR / "lyblive"))
if args.configure_dock:
    old_mode = DOCK_WRITE.stat().st_mode & 0o777 if DOCK_WRITE.is_file() else 0o644
    result = atomic_write(DOCK_WRITE, dock_text, old_mode)
    print("OBS dock: " + result)
if not args.no_systemctl:
    try:
        for unit in UNITS:
            subprocess.run(["systemd-analyze", "--user", "verify", str(unit_dest(unit))], check=True, timeout=SYSTEMD_TIMEOUT)
        subprocess.run(["systemctl", "--user", "daemon-reload"], check=True, timeout=SYSTEMD_TIMEOUT)
        for unit in UNITS:
            subprocess.run(["systemctl", "--user", "enable", unit], check=True, timeout=SYSTEMD_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as exc:
        parser.error("files are installed but systemd --user activation failed: " + str(exc) + "; run systemctl --user daemon-reload and enable lyblive.service lyblive-obs.service manually")
    print("systemd --user: verified, reloaded, enabled (no restart)")
print("apply complete: restart units manually only when you want the new configuration to take effect")
