#!/usr/bin/env python3
"""Claude CLI Hot Profile Switcher — single file (GUI + CLI).

    python claude_swap.py                 # mở GUI
    python claude_swap.py list|current
    python claude_swap.py save <name> [--force]
    python claude_swap.py new <name> [--force]
    python claude_swap.py swap <name>
    python claude_swap.py delete <name>
    python claude_swap.py usage           # quota 5h/7 ngày của mọi profile
    python claude_swap.py folder          # mở thư mục chứa profile
    python claude_swap.py import <dir> [--force]   # nhập profile từ thư mục khác

CLI chỉ dùng thư viện chuẩn. GUI dùng pywebview (HTML/CSS), icon thanh trên cùng dùng
pystray + Pillow; thiếu thư viện nào app hiện lệnh cài kèm nút Copy.
Đóng gói: pyinstaller --onefile --noconsole claude_swap.py

Một profile = phần auth của ~/.claude.json + token OAuth
(~/.claude/.credentials.json trên Linux/Windows, Keychain trên macOS).
Swap chỉ merge các key auth vào ~/.claude.json, không ghi đè cả file:
file đó còn chứa state project mà session CLI đang chạy liên tục ghi lại.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

# urllib / concurrent.futures / datetime import muộn trong phần usage: CLI & GUI mở nhanh hơn ~20ms

AUTH_KEYS = ("oauthAccount", "primaryApiKey", "customApiKeyResponses")
KEYCHAIN_SERVICE = "Claude Code-credentials"
USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1"
WARN_PCT = 80
USAGE_LIMITS = (("five_hour", "5 giờ"), ("seven_day", "7 ngày"),
                ("seven_day_opus", "7 ngày Opus"), ("seven_day_sonnet", "7 ngày Sonnet"))
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")


class SwapError(Exception):
    pass


class ProfileExists(SwapError):
    pass


# ---------------------------------------------------------------- core

def claude_json(home: Path) -> Path:
    return home / ".claude.json"


def credentials_file(home: Path) -> Path:
    return home / ".claude" / ".credentials.json"


def profiles_dir(home: Path) -> Path:
    d = home / ".config" / "claude-cli-profiles"
    d.mkdir(parents=True, exist_ok=True)
    try:
        d.chmod(0o700)
    except OSError:
        pass
    return d


def _check_name(name: str) -> str:
    if not NAME_RE.match(name or ""):
        raise SwapError(f"Tên profile không hợp lệ: {name!r} (chỉ dùng chữ, số, _ . -)")
    return name


def _profile_path(home: Path, name: str) -> Path:
    return profiles_dir(home) / f"{_check_name(name)}.json"


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _backup(path: Path) -> None:
    if path.exists():
        bak = path.with_name(path.name + ".bak")
        shutil.copy2(path, bak)
        os.chmod(bak, 0o600)


def _use_keychain(home: Path) -> bool:
    return sys.platform == "darwin" and not credentials_file(home).exists()


# ponytail: `security -w <secret>` lộ token trên argv trong tích tắc với `ps` cùng user;
# đổi sang Security.framework qua ctypes nếu cần chặt hơn.
def read_credentials(home: Path) -> str | None:
    if _use_keychain(home):
        r = subprocess.run(["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
                           capture_output=True, text=True)
        if r.returncode != 0:
            return None
        return r.stdout.strip() or None
    f = credentials_file(home)
    return f.read_text(encoding="utf-8") if f.exists() else None


def write_credentials(home: Path, data: str) -> None:
    if _use_keychain(home):
        r = subprocess.run(["security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE,
                            "-a", getpass.getuser(), "-w", data], capture_output=True, text=True)
        if r.returncode != 0:
            raise SwapError(f"Không ghi được Keychain: {r.stderr.strip()}")
        return
    f = credentials_file(home)
    _backup(f)
    _atomic_write(f, data)


def clear_credentials(home: Path) -> None:
    """Profile chỉ có API key: bỏ token OAuth của tài khoản trước, nếu không CLI vẫn dùng nó."""
    if _use_keychain(home):
        subprocess.run(["security", "delete-generic-password", "-s", KEYCHAIN_SERVICE], capture_output=True)
        return
    f = credentials_file(home)
    _backup(f)
    f.unlink(missing_ok=True)


def _load_claude_json(home: Path) -> dict:
    p = claude_json(home)
    if not p.exists():
        raise SwapError(f"Không tìm thấy {p}.\nHãy chạy `claude` và đăng nhập (/login) trước.")
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SwapError(f"{p} bị hỏng JSON: {e}") from e


def list_profiles(home: Path) -> list[str]:
    return sorted(p.stem for p in profiles_dir(home).glob("*.json") if NAME_RE.match(p.stem))


def _read_current(home: Path) -> str:
    f = profiles_dir(home) / ".current"
    return f.read_text(encoding="utf-8").strip() if f.exists() else ""


def current_profile(home: Path) -> str | None:
    name = _read_current(home)
    return name if name and (profiles_dir(home) / f"{name}.json").exists() else None


def _set_current(home: Path, name: str | None) -> None:
    f = profiles_dir(home) / ".current"
    if name:
        _atomic_write(f, name)
    else:
        f.unlink(missing_ok=True)


def profile_email(home: Path, name: str) -> str:
    try:
        data = json.loads(_profile_path(home, name).read_text(encoding="utf-8"))
        return (data.get("claude_json", {}).get("oauthAccount") or {}).get("emailAddress", "")
    except (OSError, ValueError, AttributeError, SwapError):
        return ""


def open_profiles_folder(home: Path) -> Path:
    """Mở thư mục profile trong trình quản lý file (để thả file profile từ máy khác vào)."""
    d = profiles_dir(home)
    if sys.platform == "win32":
        os.startfile(d)  # type: ignore[attr-defined]
    else:
        subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(d)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return d


def _profile_from_claude_dir(folder: Path) -> dict | None:
    """Thư mục cấu hình Claude gốc (CLAUDE_CONFIG_DIR như ~/.claude-work, hoặc một 'home' khác):
    .credentials.json (+ .claude.json) → một profile. None nếu không có gì đăng nhập."""
    creds = next((p for p in (folder / ".credentials.json", folder / ".claude" / ".credentials.json")
                  if p.is_file()), None)
    cj = folder / ".claude.json"
    auth = {}
    if cj.is_file():
        try:
            data = json.loads(cj.read_text(encoding="utf-8"))
            auth = {k: data[k] for k in AUTH_KEYS if isinstance(data, dict) and k in data}
        except (OSError, ValueError):
            pass
    text = creds.read_text(encoding="utf-8") if creds else None
    if not auth and not text:
        return None
    return {"claude_json": auth, "credentials": text}


def find_claude_dirs(home: Path) -> list[Path]:
    """Thư mục cấu hình Claude của tài khoản khác (~/.claude-work, ~/.config/claude-x, …) để gợi ý nhập.
    Đều là thư mục ẩn: hộp thoại chọn thư mục mặc định không hiện chúng."""
    found = []
    for base in (home, home / ".config"):
        try:
            entries = sorted(base.iterdir())
        except OSError:
            continue
        for d in entries:
            if (d.name.lstrip(".").lower().startswith("claude") and d != home / ".claude"
                    and (d / ".credentials.json").is_file()):
                found.append(d)
    return found


def _name_from_folder(folder: Path) -> str:
    name = re.sub(r"[^A-Za-z0-9_.-]+", "-", folder.name.lstrip(".")).strip("-.")[:64]
    return name if NAME_RE.match(name) else "imported"


def import_profiles(home: Path, folder: Path, overwrite: bool = False) -> dict[str, list[str]]:
    """Nhập vào kho profile: mọi *.json do app này lưu (có key 'claude_json') trong `folder`,
    hoặc chính `folder` nếu nó là thư mục cấu hình Claude của tài khoản khác."""
    folder = Path(folder).expanduser()
    if not folder.is_dir():
        raise SwapError(f"Không phải thư mục: {folder}")
    result: dict[str, list[str]] = {"added": [], "exists": [], "invalid": []}
    if folder.resolve() == profiles_dir(home).resolve():
        return result
    try:
        candidates = sorted(folder.glob("*.json"))
    except OSError as e:
        raise SwapError(f"Không đọc được thư mục {folder}: {e.strerror or e}") from e
    raw = _profile_from_claude_dir(folder)
    if raw is not None:
        name = _name_from_folder(folder)
        target = _profile_path(home, name)
        if target.exists() and not overwrite:
            result["exists"].append(name)
        else:
            _atomic_write(target, json.dumps(raw, indent=2, ensure_ascii=False))
            result["added"].append(name)
    for f in candidates:
        if f.name in (".claude.json", ".credentials.json"):
            continue
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            ok = (NAME_RE.match(f.stem) and isinstance(data, dict) and isinstance(data.get("claude_json"), dict)
                  and isinstance(data.get("credentials"), (str, type(None))))
        except (OSError, ValueError):
            ok = False
        if not ok:
            result["invalid"].append(f.name)
            continue
        target = _profile_path(home, f.stem)
        if target.exists() and not overwrite:
            result["exists"].append(f.stem)
            continue
        _atomic_write(target, json.dumps(data, indent=2, ensure_ascii=False))
        result["added"].append(f.stem)
    return result


def profile_exists(home: Path, name: str) -> bool:
    return _profile_path(home, name).exists()


def save_profile(home: Path, name: str, force: bool = False) -> Path:
    target = _profile_path(home, name)
    if target.exists() and not force:
        raise ProfileExists(f"Profile '{name}' đã tồn tại.")
    data = _load_claude_json(home)
    profile = {
        "claude_json": {k: data[k] for k in AUTH_KEYS if k in data},
        "credentials": read_credentials(home),
    }
    if not profile["claude_json"] and not profile["credentials"]:
        raise SwapError("Không thấy thông tin đăng nhập nào. Hãy /login trong Claude CLI trước.")
    _atomic_write(target, json.dumps(profile, indent=2, ensure_ascii=False))
    _set_current(home, name)
    return target


def swap_profile(home: Path, name: str) -> None:
    src = _profile_path(home, name)
    if not src.exists():
        raise SwapError(f"Không có profile '{name}'.")
    try:
        profile = json.loads(src.read_text(encoding="utf-8"))
        auth = dict(profile["claude_json"])
    except (json.JSONDecodeError, KeyError, TypeError, ValueError) as e:
        raise SwapError(f"File profile '{name}' bị hỏng: {e}") from e

    cj = claude_json(home)
    data = _load_claude_json(home) if cj.exists() else {}
    # CLI tự refresh token → cập nhật lại snapshot của profile đang active trước khi rời đi,
    # chỉ khi vẫn đúng tài khoản đó (tránh ghi đè sau khi user /login tay sang acc khác).
    cur = current_profile(home)
    if cur:
        try:
            cur_auth = json.loads(_profile_path(home, cur).read_text(encoding="utf-8"))["claude_json"]
            cur_id = _account_id(cur_auth.get("oauthAccount"))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            cur_id = None
        if cur_id and cur_id == _account_id(data.get("oauthAccount")):
            save_profile(home, cur, force=True)
            if cur == name:  # đã active: ghi lại snapshot cũ sẽ đè token CLI vừa refresh
                return
    for k in AUTH_KEYS:
        data.pop(k, None)
    data.update({k: v for k, v in auth.items() if k in AUTH_KEYS})
    _backup(cj)
    _atomic_write(cj, json.dumps(data, indent=2, ensure_ascii=False))
    if profile.get("credentials"):
        write_credentials(home, profile["credentials"])
    else:
        clear_credentials(home)
    _set_current(home, name)


def _account_id(oauth_account) -> str | None:
    """CLI tự cập nhật các trường khác của oauthAccount (role, billing…): so theo danh tính."""
    if not isinstance(oauth_account, dict):
        return None
    return oauth_account.get("accountUuid") or oauth_account.get("emailAddress")


def delete_profile(home: Path, name: str) -> None:
    f = _profile_path(home, name)
    if not f.exists():
        raise SwapError(f"Không có profile '{name}'.")
    f.unlink()
    if _read_current(home) == name:
        _set_current(home, None)


# ---------------------------------------------------------------- autostart

AUTOSTART_ID = "claude-swap"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def autostart_command() -> list[str]:
    if getattr(sys, "frozen", False):  # PyInstaller binary
        return [sys.executable, "--tray"]
    exe = sys.executable
    if sys.platform == "win32":
        pythonw = Path(exe).with_name("pythonw.exe")
        exe = str(pythonw) if pythonw.exists() else exe
    return [exe, str(Path(__file__).resolve()), "--tray"]


def _autostart_file(home: Path) -> Path:
    if sys.platform == "darwin":
        return home / "Library" / "LaunchAgents" / f"com.{AUTOSTART_ID}.plist"
    return home / ".config" / "autostart" / f"{AUTOSTART_ID}.desktop"


def _desktop_quote(arg: str) -> str:
    if re.fullmatch(r"[\w./+-]+", arg):
        return arg
    return '"' + re.sub(r'(["`$\\])', r"\\\1", arg) + '"'


def autostart_enabled(home: Path) -> bool:
    if sys.platform == "win32":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
                winreg.QueryValueEx(key, AUTOSTART_ID)
            return True
        except OSError:
            return False
    return _autostart_file(home).exists()


def set_autostart(home: Path, enabled: bool) -> None:
    cmd = autostart_command()
    if sys.platform == "win32":
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
            if enabled:
                winreg.SetValueEx(key, AUTOSTART_ID, 0, winreg.REG_SZ, subprocess.list2cmdline(cmd))
            else:
                try:
                    winreg.DeleteValue(key, AUTOSTART_ID)
                except FileNotFoundError:
                    pass
        return
    f = _autostart_file(home)
    if not enabled:
        f.unlink(missing_ok=True)
    elif sys.platform == "darwin":
        import plistlib
        _atomic_write(f, plistlib.dumps({"Label": f"com.{AUTOSTART_ID}", "ProgramArguments": cmd,
                                         "RunAtLoad": True}).decode())
    else:
        _atomic_write(f, "[Desktop Entry]\nType=Application\nName=Claude Profile Switcher\n"
                         f"Exec={' '.join(_desktop_quote(a) for a in cmd)}\n"
                         "Terminal=false\nX-GNOME-Autostart-enabled=true\n")


# ---------------------------------------------------------------- usage

def fetch_usage(token: str) -> dict:
    import urllib.request
    req = urllib.request.Request(USAGE_URL, headers={
        "Authorization": f"Bearer {token}",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-swap",
    })
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def _fmt_reset(value) -> str:
    from datetime import datetime
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone().strftime("%d/%m %H:%M")
    except ValueError:
        return ""


def parse_limits(data: dict) -> list[tuple[str, float, str]]:
    """(nhãn, % đã dùng, giờ reset): cửa sổ chung + quota theo model (Fable, ...) trong limits[]."""
    out: dict[str, tuple[str, float, str]] = {}
    for key, label in USAGE_LIMITS:
        lim = data.get(key)
        if isinstance(lim, dict) and lim.get("utilization") is not None:
            out[label] = (label, float(lim["utilization"]), _fmt_reset(lim.get("resets_at")))
    for lim in data.get("limits") or []:
        if not isinstance(lim, dict) or lim.get("kind") != "weekly_scoped" or lim.get("percent") is None:
            continue
        model = ((lim.get("scope") or {}).get("model") or {}).get("display_name")
        if model:
            label = f"7 ngày {model}"
            out[label] = (label, float(lim["percent"]), _fmt_reset(lim.get("resets_at")))
    return list(out.values())


# The usage endpoint is rate-limited per account (HTTP 429), and Claude Code itself polls it for the
# active account: reuse a reading for USAGE_TTL and honour Retry-After, sharing one cache on disk
# between the GUI, the quick panel, the CLI and the plugin.
USAGE_TTL = 300
USAGE_BACKOFF = 600  # wait after a 429 that carries no Retry-After


def _usage_cache_file(home: Path) -> Path:
    return profiles_dir(home) / ".usage-cache.json"  # dot-name: never listed as a profile


def _load_usage_cache(home: Path) -> dict:
    try:
        data = json.loads(_usage_cache_file(home).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _retry_after(err) -> float:
    try:
        return min(max(float(err.headers.get("Retry-After")), 30.0), 3600.0)
    except (AttributeError, TypeError, ValueError):
        return USAGE_BACKOFF


def _rate_limited_note(hit: dict, has_data: bool) -> str:
    def hhmm(ts):
        return time.strftime("%H:%M", time.localtime(ts))
    note = f"Anthropic đang giới hạn tần suất (HTTP 429), thử lại sau {hhmm(hit['retry_at'])}"
    return note + (f" — đang hiện số liệu lúc {hhmm(hit['at'])}" if has_data and hit.get("at") else "")


# ponytail: profile không active dùng access token đã lưu; hết hạn thì báo, không tự refresh
# (refresh xoay vòng refresh token, dễ làm session đang chạy mất đăng nhập).
def profile_usage(home: Path, name: str, active: bool, fetch=fetch_usage,
                  cache: dict | None = None, force: bool = False) -> dict:
    import urllib.error
    cache = {} if cache is None else cache
    row = {"name": name, "active": active, "email": "", "limits": [], "note": ""}
    try:
        profile = json.loads(_profile_path(home, name).read_text(encoding="utf-8"))
        creds = read_credentials(home) if active else profile.get("credentials")
        oauth = json.loads(creds or "{}").get("claudeAiOauth") or {}
        token, expires = oauth.get("accessToken"), oauth.get("expiresAt")
    except (OSError, ValueError, TypeError, AttributeError, SwapError):
        return {**row, "note": "file profile bị hỏng"}
    row["email"] = profile_email(home, name)
    if not token:
        return {**row, "note": "không có token OAuth (API key không có quota gói)"}
    if isinstance(expires, (int, float)) and expires / 1000 < time.time():
        return {**row, "note": f"token đã hết hạn — chuyển sang profile này (swap {name}) để CLI làm mới"}
    key = f"{name}|{row['email']}"  # a re-saved profile on another account must not reuse old numbers
    hit = cache.get(key) if isinstance(cache.get(key), dict) else {}
    cached = [tuple(lim) for lim in hit.get("limits") or []]
    now = time.time()
    if hit.get("retry_at", 0) > now:  # still inside the server's back-off window: don't ask again
        return {**row, "limits": cached, "note": _rate_limited_note(hit, bool(cached))}
    if cached and not force and now - hit.get("at", 0) < USAGE_TTL:
        return {**row, "limits": cached}
    try:
        limits = parse_limits(fetch(token))
    except urllib.error.HTTPError as e:
        if e.code == 429:
            cache[key] = hit = {**hit, "retry_at": now + _retry_after(e)}
            return {**row, "limits": cached, "note": _rate_limited_note(hit, bool(cached))}
        return {**row, "note": f"lỗi HTTP {e.code}" + (" (token hết hạn/bị thu hồi)" if e.code == 401 else "")}
    except (OSError, ValueError) as e:  # URLError, timeout, connection reset mid-read
        return {**row, "note": f"lỗi mạng: {getattr(e, 'reason', e)}"}
    cache[key] = {"limits": limits, "at": now}
    return {**row, "limits": limits, "note": "" if limits else "không có dữ liệu quota"}


def usage_rows(home: Path, fetch=fetch_usage, force: bool = False) -> list[dict]:
    from concurrent.futures import ThreadPoolExecutor
    cur = current_profile(home)
    cache = _load_usage_cache(home)
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(lambda n: profile_usage(home, n, n == cur, fetch, cache, force), list_profiles(home)))
    try:
        _atomic_write(_usage_cache_file(home), json.dumps(cache, ensure_ascii=False))
    except OSError:
        pass  # a cache that can't be written just means fetching again next time
    return rows


def bar(pct: float, width: int = 20) -> str:
    filled = round(max(0.0, min(pct, 100.0)) / 100 * width)
    return "█" * filled + "░" * (width - filled)


def usage_report(home: Path, fetch=fetch_usage, force: bool = False) -> str:
    rows = usage_rows(home, fetch, force)
    if not rows:
        return "Chưa có profile nào."
    lines = []
    for r in rows:
        lines.append(f"{r['name']}{' (Active)' if r['active'] else ''}  {r['email']}".rstrip())
        for label, pct, reset in r["limits"]:
            icon = status_icon(pct)
            warn = " ⚠" if pct >= WARN_PCT else ""
            lines.append(f"  {icon} {label:<12}{bar(pct)} {int(pct):>3}%{warn}" + (f"  reset {reset}" if reset else ""))
        if r["note"]:
            lines.append(f"  {r['note']}")
    return "\n".join(lines)


def profile_list_report(home: Path, color: bool | None = None) -> str:
    profiles = list_profiles(home)
    if not profiles:
        return "Chưa có profile nào. Tạo bằng: /profile new <tên>"
    cur = current_profile(home)
    cache = _load_usage_cache(home)
    if color is None:
        color = sys.stdout.isatty()
    lines = []
    for n in profiles:
        active = (n == cur)
        email = profile_email(home, n)
        icon = "🟢" if active else "⚪"
        active_str = " (Active)" if active else ""

        # Check cached usage
        summary = ""
        key = f"{n}|{email}"
        hit = cache.get(key) if isinstance(cache.get(key), dict) else {}
        cached_limits = hit.get("limits")
        if cached_limits:
            summary_parts = []
            for lim in cached_limits[:2]:
                lbl = lim[0].replace("5 giờ", "5h").replace("7 ngày", "7d")
                pct = int(lim[1])
                warn = " ⚠" if pct >= WARN_PCT else ""
                summary_parts.append(f"{lbl} {pct}%{warn}")
            if summary_parts:
                summary = f"  [{' · '.join(summary_parts)}]"

        email_str = f"  👤 {email}" if email else ""

        if color:
            name_colored = f"\033[1;32m{n}\033[0m" if active else f"\033[1m{n}\033[0m"
            act_colored = "\033[32m (Active)\033[0m" if active else ""
            email_colored = f"  \033[90m👤 {email}\033[0m" if email else ""
            summary_colored = f"  \033[36m{summary.strip()}\033[0m" if summary else ""
            lines.append(f"{icon} {name_colored}{act_colored}{email_colored}{summary_colored}")
        else:
            lines.append(f"{icon} {n}{active_str}{email_str}{summary}")
    return "\n".join(lines)


# ---------------------------------------------------------------- cli

def run_cli(argv: list[str], home: Path) -> int:
    ap = argparse.ArgumentParser(prog="claude_swap", description="Claude CLI Hot Profile Switcher")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sub.add_parser("current")
    sub.add_parser("usage").add_argument("--refresh", action="store_true",
                                         help=f"bỏ qua số liệu đã lưu (<{USAGE_TTL // 60} phút)")
    sub.add_parser("folder", help="mở thư mục chứa profile")
    imp = sub.add_parser("import", help="nhập profile từ một thư mục")
    imp.add_argument("path")
    imp.add_argument("--force", action="store_true", help="ghi đè profile trùng tên")
    for cmd in ("save", "new"):
        s = sub.add_parser(cmd, help="lưu tài khoản đang đăng nhập thành profile")
        s.add_argument("name")
        s.add_argument("--force", action="store_true", help="ghi đè nếu đã tồn tại")
    for cmd in ("swap", "delete"):
        sub.add_parser(cmd).add_argument("name")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "list":
            print(profile_list_report(home))
        elif a.cmd == "current":
            print(current_profile(home) or "")
        elif a.cmd == "usage":
            print(usage_report(home, force=a.refresh))
        elif a.cmd == "folder":
            d = profiles_dir(home)
            try:
                open_profiles_folder(home)
                print(f"Đã mở: {d}")
            except OSError:
                print(f"Không mở được trình quản lý file. Thư mục: {d}")
        elif a.cmd == "import":
            r = import_profiles(home, Path(a.path), a.force)
            print(f"Đã nhập: {', '.join(r['added']) or '(không có)'}")
            if r["exists"]:
                print(f"Trùng tên, bỏ qua (dùng --force để ghi đè): {', '.join(r['exists'])}")
            if r["invalid"]:
                print(f"Không phải file profile: {', '.join(r['invalid'])}")
        elif a.cmd in ("save", "new"):
            verb = "tạo" if a.cmd == "new" else "lưu"
            print(f"Đã {verb}: {save_profile(home, a.name, a.force)}")
        elif a.cmd == "swap":
            swap_profile(home, a.name)
            print(f"Đã chuyển sang '{a.name}'. Không cần tắt session; Claude CLI dùng tài khoản mới ở lần "
                  "kiểm tra đăng nhập kế tiếp (có thể chưa ngay prompt sau). Xem /status để chắc chắn.")
        elif a.cmd == "delete":
            delete_profile(home, a.name)
            print(f"Đã xoá '{a.name}'.")
    except SwapError as e:
        print(f"Lỗi: {e}", file=sys.stderr)
        return 1
    return 0


# ---------------------------------------------------------------- gui: shared

# dark navy theme — the web page mirrors these in CSS variables
BG, SURFACE, BORDER = "#0f1a2e", "#16243d", "#26395a"
INK, MUTED = "#e6edf7", "#9aa8bf"
ACCENT, ACCENT_HOVER = "#2f6bd0", "#2557a8"
# status palette (good / warning / serious / critical); % + ⚠ đi kèm nên màu không mang nghĩa một mình
STATUS = ((50, "#0ca30c"), (WARN_PCT, "#fab219"), (95, "#ec835a"), (float("inf"), "#d03b3b"))


# lighter steps of the same hues for text: ≥ 5.9:1 on every surface (the bar fills are ~3:1)
STATUS_TEXT = ((50, "#7ee787"), (WARN_PCT, "#ffd166"), (95, "#ffab70"), (float("inf"), "#ff8a80"))


def status_color(pct: float) -> str:
    return next(color for limit, color in STATUS if pct < limit)


def status_text_color(pct: float) -> str:
    return next(color for limit, color in STATUS_TEXT if pct < limit)


def status_icon(pct: float) -> str:
    if pct < 50:
        return "🟢"
    elif pct < WARN_PCT:
        return "🟡"
    elif pct < 95:
        return "🟠"
    return "🔴"


def usage_summary(row: dict) -> str:
    """Một dòng ngắn cho bảng nhanh: '5h 37% · 7d 62% ⚠'."""
    if not row["limits"]:
        return "hết hạn" if "hết hạn" in row["note"] else "bị giới hạn" if "429" in row["note"] else "—"
    short = {"5 giờ": "5h", "7 ngày": "7d"}
    return " · ".join(f"{short.get(label, label)} {int(pct)}%" + (" ⚠" if pct >= WARN_PCT else "")
                      for label, pct, _ in row["limits"][:2])


# module, tên hiển thị, dùng cho, bắt buộc, gói apt, gói pip
DEPS = (
    ("webview", "pywebview", "giao diện", True, "python3-webview", "pywebview"),
    ("pystray", "pystray", "icon trên thanh trên cùng", False, "python3-pystray", "pystray"),
    ("PIL", "Pillow", "vẽ icon trên thanh trên cùng", False, "python3-pil", "pillow"),
)
DEP_KEYS = ("module", "name", "why", "required", "apt", "pip")
APT_WEBKIT = "sudo apt install python3-gi gir1.2-webkit2-4.1"


def missing_deps() -> list[dict]:
    import importlib
    from importlib.util import find_spec
    importlib.invalidate_caches()  # "Kiểm tra lại" right after an install in another terminal
    return [dict(zip(DEP_KEYS, d)) for d in DEPS if find_spec(d[0]) is None]


def install_commands(missing: list[dict]) -> list[str]:
    """Lệnh cài cho đúng Python đang chạy app: apt cho Python hệ thống Debian/Ubuntu, pip cho còn lại."""
    if not missing:
        return []
    exe = sys.executable
    if (sys.platform.startswith("linux") and exe.startswith("/usr/") and not exe.startswith("/usr/local/")
            and shutil.which("apt")):
        return ["sudo apt install " + " ".join(d["apt"] for d in missing)]
    exe = f'"{exe}"' if " " in exe else exe
    cmds = [f"{exe} -m pip install " + " ".join(d["pip"] for d in missing)]
    if sys.platform.startswith("linux") and any(d["module"] == "webview" for d in missing):
        from importlib.util import find_spec
        if find_spec("gi") is None:
            cmds.append(APT_WEBKIT)
    return cmds


def copy_text(text: str) -> bool:
    """Clipboard còn giữ sau khi app đóng, qua công cụ hệ thống; False nếu máy không có công cụ nào."""
    if sys.platform == "darwin":
        tools = [["pbcopy"]]
    elif sys.platform == "win32":
        tools = [["clip"]]
    else:
        tools = ([["wl-copy"]] if os.environ.get("WAYLAND_DISPLAY") else []) + \
                [["xclip", "-selection", "clipboard"], ["xsel", "-ib"]]
    for cmd in tools:
        if shutil.which(cmd[0]):
            try:
                # wl-copy/xclip stay alive to serve the clipboard: never hand them our stdout/stderr pipes
                subprocess.run(cmd, input=text, text=True, check=True, timeout=3,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return True
            except (OSError, subprocess.SubprocessError):
                continue
    return False


# ---------------------------------------------------------------- gui: missing-library window (Tk)

def build_setup_window(missing: list[dict], commands: list[str], error: str = ""):
    """Cửa sổ nhỏ (Tk có sẵn trong Python) liệt kê thư viện thiếu + lệnh cài + nút Copy."""
    import tkinter as tk

    root = tk.Tk()
    root.title("Claude Profiles — cần cài thêm thư viện")
    root.configure(bg=BG, padx=22, pady=18)
    root.resizable(False, False)
    font = ("TkDefaultFont", 10)
    tk.Label(root, text="Cần cài thêm thư viện", bg=BG, fg=INK,
             font=("TkDefaultFont", 15, "bold")).pack(anchor="w")
    for d in missing:
        tk.Label(root, text=f"•  {d['name']} — {d['why']}" + ("" if d["required"] else " (tuỳ chọn)"),
                 bg=BG, fg=MUTED, font=font).pack(anchor="w", pady=(4, 0))
    if error:
        tk.Label(root, text=error, bg=BG, fg="#ec835a", font=font, wraplength=520,
                 justify="left").pack(anchor="w", pady=(8, 0))
    tk.Label(root, text="Chạy lệnh sau trong Terminal, xong bấm “Kiểm tra lại”:", bg=BG, fg=INK,
             font=font).pack(anchor="w", pady=(14, 6))

    def copied(cmd: str, btn) -> None:
        if not copy_text(cmd):
            root.clipboard_clear()  # Tk clipboard: dán được khi cửa sổ này còn mở
            root.clipboard_append(cmd)
        btn.configure(text="Đã copy ✓")
        root.after(1500, lambda: btn.winfo_exists() and btn.configure(text="Copy"))

    for cmd in commands:
        row = tk.Frame(root, bg=SURFACE)
        row.pack(fill="x", pady=3)
        tk.Label(row, text=cmd, bg=SURFACE, fg=INK, font=("TkFixedFont", 10), padx=12, pady=10,
                 anchor="w").pack(side="left", fill="x", expand=True)
        btn = tk.Button(row, text="Copy", bg=ACCENT, fg="white", activebackground=ACCENT_HOVER,
                        activeforeground="white", relief="flat", bd=0, padx=16, pady=6,
                        cursor="hand2", font=("TkDefaultFont", 10, "bold"))
        btn.configure(command=lambda c=cmd, b=btn: copied(c, b))
        btn.pack(side="right", padx=8, pady=6)

    status = tk.Label(root, text="", bg=BG, fg=MUTED, font=font)
    status.pack(anchor="w", pady=(10, 0))

    def retry() -> None:
        still = [d["name"] for d in missing_deps() if d["required"]]
        if still:
            status.configure(text="Vẫn thiếu: " + ", ".join(still))
            return
        root.destroy()
        argv = sys.argv if getattr(sys, "frozen", False) else [sys.executable, *sys.argv]
        os.execv(sys.executable, argv)  # restart into the real app

    actions = tk.Frame(root, bg=BG)
    actions.pack(fill="x", pady=(12, 0))
    for text, cmd, bg in (("Đóng", root.destroy, SURFACE), ("Kiểm tra lại", retry, ACCENT)):
        tk.Button(actions, text=text, command=cmd, bg=bg, fg="white" if bg == ACCENT else INK,
                  activebackground=BORDER, activeforeground=INK, relief="flat", bd=0, padx=16, pady=8,
                  cursor="hand2", font=("TkDefaultFont", 10, "bold")).pack(side="right", padx=(8, 0))
    return root


def show_setup_window(missing: list[dict], commands: list[str], error: str = "") -> None:
    try:
        root = build_setup_window(missing, commands, error)
    except Exception:  # no tkinter / no display: the terminal is all we have
        print("Cần cài thêm: " + ", ".join(d["name"] for d in missing), file=sys.stderr)
        if error:
            print(error, file=sys.stderr)
        for cmd in commands:
            print(f"  {cmd}", file=sys.stderr)
        return
    root.mainloop()


# ---------------------------------------------------------------- gui: web UI (pywebview)

class Api:
    """window.pywebview.api.* for the page. Each call runs on a pywebview worker thread."""

    def __init__(self, home: Path, fetch=fetch_usage, missing: list[dict] | None = None):
        self._home, self._fetch, self._missing = home, fetch, missing or []
        self._lock = threading.Lock()
        self._mutate = threading.Lock()  # tray thread + page may swap at once
        self._main = self._mini = self._icon = None
        self._mini_visible = self._quitting = False

    def _do(self, fn):  # SwapError/OSError → {"error": …} for the page's snackbar
        try:
            with self._mutate:
                return fn()
        except SwapError as e:
            return {"error": str(e)}
        except OSError as e:
            return {"error": f"Lỗi hệ thống: {e}"}

    def _changed(self) -> None:  # keep every surface in sync after a mutation
        for w in (self._main, self._mini):
            if w is not None:
                try:
                    w.evaluate_js("window.app && app.refresh()")
                except Exception:
                    pass
        if self._icon is not None:
            self._icon.update_menu()

    def state(self) -> dict:
        h = self._home
        cur = current_profile(h)
        return {"profiles": [{"name": n, "email": profile_email(h, n), "active": n == cur}
                             for n in list_profiles(h)],
                "current": cur, "autostart": autostart_enabled(h), "tray": self._icon is not None,
                "missing": [d["name"] for d in self._missing], "commands": install_commands(self._missing)}

    def swap(self, name: str):
        def run():
            swap_profile(self._home, name)
            self._changed()
            return {"ok": True}
        return self._do(run)

    def save(self, name: str, force: bool = False):
        def run():
            if not force and profile_exists(self._home, name):
                return {"exists": True}
            save_profile(self._home, name, force=True)
            self._changed()
            return {"ok": True}
        return self._do(run)

    def delete(self, name: str):
        def run():
            delete_profile(self._home, name)
            self._changed()
            return {"ok": True}
        return self._do(run)

    def import_folder(self, folder: str | None = None, overwrite: bool = False):
        path = folder or self._pick_folder()  # outside _mutate: the user may keep the dialog open a while
        if not path:
            return {"cancelled": True}

        def run():
            r = import_profiles(self._home, Path(path), overwrite)
            if r["added"]:
                self._changed()
            return {**r, "folder": str(path)}
        return self._do(run)

    def import_candidates(self) -> list[dict]:
        """Claude config folders found in home, offered as one-click imports."""
        out = []
        for d in find_claude_dirs(self._home):
            raw = _profile_from_claude_dir(d) or {}
            name = _name_from_folder(d)
            out.append({"path": str(d), "name": name, "exists": profile_exists(self._home, name),
                        "email": ((raw.get("claude_json") or {}).get("oauthAccount") or {}).get("emailAddress", "")})
        return out

    def _pick_folder(self) -> str | None:
        title = "Chọn thư mục chứa profile hoặc thư mục cấu hình Claude"
        if "gi.repository.Gtk" in sys.modules:  # pywebview runs on GTK: our own chooser, hidden folders shown
            return _gtk_pick_folder(title, Path.home())
        import webview
        kind = webview.FileDialog.FOLDER if hasattr(webview, "FileDialog") else webview.FOLDER_DIALOG
        picked =self._main.create_file_dialog(kind, directory=str(Path.home()))
        return (picked[0] if isinstance(picked, (list, tuple)) else picked) if picked else None

    def open_folder(self):
        return self._do(lambda: {"path": str(open_profiles_folder(self._home))})

    def usage(self, force: bool = False) -> list[dict]:
        with self._lock:  # main page + quick panel may ask at once: the second one reads the fresh cache
            rows = usage_rows(self._home, self._fetch, force)
        return [{**r, "summary": usage_summary(r),
                 "limits": [{"label": label, "pct": pct, "reset": reset, "color": status_color(pct),
                             "text": status_text_color(pct), "icon": status_icon(pct), "warn": pct >= WARN_PCT}
                            for label, pct, reset in r["limits"]]}
                for r in rows]

    def set_autostart(self, on: bool):
        def run():
            set_autostart(self._home, bool(on))
            self._changed()
            return {"ok": True, "on": autostart_enabled(self._home)}
        return self._do(run)

    def copy(self, text: str) -> bool:
        return copy_text(text)

    def hide_main(self) -> dict:
        if self._icon is not None:
            self._main.hide()
        else:
            self._main.minimize()
        return {"tray": self._icon is not None}

    def show_main(self, view: str = "") -> None:
        self.hide_mini()
        self._main.show()
        self._main.restore()
        if view:
            self._main.evaluate_js(f"app.open({json.dumps(view)})")

    def toggle_mini(self) -> None:
        if self._mini is None:
            return
        if self._mini_visible:
            self.hide_mini()
            return
        try:
            import webview
            width = webview.screens[0].width
        except Exception:
            width = 1920
        self._mini.move(width - 352, 40)  # under the top bar, right edge
        self._mini.show()
        self._mini_visible = True
        self._mini.evaluate_js("app.shown()")

    def hide_mini(self) -> None:
        if self._mini is not None and self._mini_visible:
            self._mini.hide()
            self._mini_visible = False

    def quit(self) -> None:
        self._quitting = True
        if self._icon is not None:
            self._icon.stop()
        for w in (self._mini, self._main):
            if w is not None:
                w.destroy()

    def _on_closing(self):  # close button: hide to the tray when there is one
        if self._icon is not None and not self._quitting:
            self._main.hide()
            return False
        if self._mini is not None:
            self._mini.destroy()
        return None


def _gtk_pick_folder(title: str, start: Path) -> str | None:
    """GTK folder chooser with hidden folders shown — pywebview's own dialog hides ~/.claude-*.
    Runs on the GTK loop pywebview already owns; the calling worker thread waits for the answer."""
    from gi.repository import GLib, Gtk

    done, out = threading.Event(), {}

    def run():
        dlg = Gtk.FileChooserDialog(title=title, action=Gtk.FileChooserAction.SELECT_FOLDER)
        dlg.add_buttons("Huỷ", Gtk.ResponseType.CANCEL, "Chọn", Gtk.ResponseType.ACCEPT)
        dlg.set_show_hidden(True)
        dlg.set_default_size(820, 560)
        dlg.set_current_folder(str(start))
        dlg.set_keep_above(True)
        try:
            if dlg.run() == Gtk.ResponseType.ACCEPT:
                out["path"] = dlg.get_filename()
        finally:
            dlg.destroy()
            done.set()
        return False

    GLib.idle_add(run)
    done.wait()
    return out.get("path")


def make_tray(api: Api):
    import pystray
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((2, 2, 62, 62), fill=ACCENT)
    draw.polygon([(16, 22), (38, 22), (38, 14), (50, 26), (38, 38), (38, 30), (16, 30)], fill="white")
    draw.polygon([(48, 42), (26, 42), (26, 34), (14, 46), (26, 58), (26, 50), (48, 50)], fill="white")

    def bg(fn):  # menu callbacks run on the GTK loop; pywebview calls must not block it
        return lambda: threading.Thread(target=fn, daemon=True).start()

    def swap_item(n):
        return pystray.MenuItem(n, bg(lambda: api.swap(n)),
                                checked=lambda item: n == current_profile(api._home), radio=True)

    def items():
        yield pystray.MenuItem("Bảng nhanh", bg(api.toggle_mini), default=True)
        yield pystray.Menu.SEPARATOR
        yield from (swap_item(n) for n in list_profiles(api._home))
        yield pystray.Menu.SEPARATOR
        yield pystray.MenuItem("Usage", bg(lambda: api.show_main("usage")))
        yield pystray.MenuItem("Nhập profile từ thư mục…", bg(lambda: api.show_main("import")))
        yield pystray.MenuItem("Mở thư mục profile", bg(api.open_folder))
        yield pystray.MenuItem("Mở cửa sổ chính", bg(api.show_main))
        yield pystray.MenuItem("Khởi động cùng máy", bg(lambda: api.set_autostart(not autostart_enabled(api._home))),
                               checked=lambda item: autostart_enabled(api._home))
        yield pystray.MenuItem("Thoát", bg(api.quit))

    return pystray.Icon("claude-swap", img, "Claude Profiles", menu=pystray.Menu(items))


def build_windows(home: Path, missing: list[dict], start_hidden: bool = False, tray: bool = True):
    """Create the main window (+ quick panel and tray when available). Call webview.start() next."""
    import webview

    tray = tray and not any(d["module"] in ("pystray", "PIL") for d in missing)
    api = Api(home, missing=missing)
    api._main = webview.create_window(
        "Claude Profiles", html=PAGE.replace("__MODE__", "main"), js_api=api, width=460, height=660,
        min_size=(400, 520), background_color=BG, hidden=start_hidden and tray)
    api._main.events.closing += api._on_closing
    if tray:
        api._mini = webview.create_window(
            "Claude Profiles panel", html=PAGE.replace("__MODE__", "mini"), js_api=api,
            width=340, height=440, frameless=True, on_top=True, hidden=True, background_color=BG)
        api._icon = make_tray(api)
        api._icon.run_detached()  # shares pywebview's GTK main loop
    return api


class Instance:
    """One GUI per user. An OS file lock decides who runs (the kernel drops it if the app crashes);
    a local socket lets a later launch wake the running app ("show") instead of opening a duplicate."""

    def __init__(self, home: Path):
        d = profiles_dir(home)
        self._lock_path, self._sock_path, self._port_path = d / ".gui.lock", d / ".gui.sock", d / ".gui.port"
        self._lock = self._server = None
        self._unix = sys.platform != "win32"

    def acquire(self) -> bool:
        f = open(self._lock_path, "a+")
        try:
            if self._unix:
                import fcntl
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                import msvcrt
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            f.close()
            return False
        self._lock = f
        return True

    def release(self) -> None:
        if self._server is not None:
            self._server.close()
            self._server = None
            if self._unix:
                self._sock_path.unlink(missing_ok=True)
        if self._lock is not None:
            self._lock.close()  # closing the file drops the lock
            self._lock = None

    def serve(self, handler) -> None:
        """Listen for messages from later launches; `handler(msg)` runs on a background thread."""
        import socket
        if self._unix:
            self._sock_path.unlink(missing_ok=True)  # left by a crashed run: we hold the lock, so it's stale
            srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            srv.bind(str(self._sock_path))
            os.chmod(self._sock_path, 0o600)
        else:
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.bind(("127.0.0.1", 0))
            _atomic_write(self._port_path, str(srv.getsockname()[1]))
        srv.listen(4)
        self._server = srv

        def loop():
            while True:
                try:
                    conn, _ = srv.accept()
                except OSError:  # closed by release()
                    return
                with conn:
                    try:
                        conn.settimeout(2)
                        msg = conn.recv(64).decode(errors="replace").strip()
                        conn.sendall(b"ok")
                    except OSError:
                        continue
                try:
                    handler(msg)
                except Exception:
                    pass
        threading.Thread(target=loop, daemon=True).start()

    def notify(self, msg: str, attempts: int = 15) -> bool:
        """Tell the running app `msg`; retries while it may still be starting up. False if nobody answers."""
        import socket
        for i in range(attempts):
            try:
                if self._unix:
                    s, addr = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM), str(self._sock_path)
                else:
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    addr = ("127.0.0.1", int(self._port_path.read_text()))
                with s:
                    s.settimeout(2)
                    s.connect(addr)
                    s.sendall(msg.encode())
                    if s.recv(8) == b"ok":
                        return True
            except (OSError, ValueError):
                pass
            if i + 1 < attempts:
                time.sleep(0.2)
        return False


DETACH_ENV = "CLAUDE_SWAP_DETACHED"


def started_from_terminal() -> bool:
    return os.environ.get(DETACH_ENV) != "1" and bool(sys.stdin) and sys.stdin.isatty()


def detach_command(home: Path) -> tuple[list[str], dict]:
    """argv + Popen options that relaunch this GUI outside the terminal's session, so closing the
    terminal (SIGHUP on Linux/macOS, console close on Windows) no longer kills it."""
    exe = sys.executable
    if sys.platform == "win32" and not getattr(sys, "frozen", False):
        pythonw = Path(exe).with_name("pythonw.exe")  # no console window of its own
        exe = str(pythonw) if pythonw.exists() else exe
    cmd = [exe] + ([] if getattr(sys, "frozen", False) else [str(Path(__file__).resolve())]) + sys.argv[1:]
    log = open(profiles_dir(home) / ".gui.log", "w", encoding="utf-8")  # last run's errors, for debugging
    kw: dict = {"stdin": subprocess.DEVNULL, "stdout": log, "stderr": log, "close_fds": True,
                "env": {**os.environ, DETACH_ENV: "1"}}
    if sys.platform == "win32":
        kw["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True  # setsid: no controlling terminal → no SIGHUP
    return cmd, kw


def run_gui(home: Path, start_hidden: bool = False, foreground: bool = False) -> int:
    missing = missing_deps()
    if any(d["required"] for d in missing):  # stays in the terminal: its fallback prints there
        show_setup_window(missing, install_commands(missing))
        return 1
    instance = Instance(home)
    if not instance.acquire():
        # autostart (--tray) while the app already runs: stay quiet; a manual launch brings it forward
        if instance.notify("ping" if start_hidden else "show"):
            print("Claude Profiles đang chạy rồi — đã đưa cửa sổ lên trước.")
        else:
            print("Claude Profiles đang chạy rồi (chưa phản hồi, thử lại sau giây lát).")
        return 0
    if not foreground and started_from_terminal():
        cmd, kw = detach_command(home)
        instance.release()  # the detached child takes the lock over
        try:
            proc = subprocess.Popen(cmd, **kw)
        finally:
            kw["stdout"].close()
        print(f"Claude Profiles đã chạy nền (pid {proc.pid}) — có thể đóng terminal. "
              "Chạy kèm --foreground để giữ app trong terminal.")
        return 0
    try:
        return _run_webview(home, missing, start_hidden, instance)
    finally:
        instance.release()


def _run_webview(home: Path, missing: list[dict], start_hidden: bool, instance: Instance) -> int:
    tray = not any(d["module"] in ("pystray", "PIL") for d in missing)
    if tray and sys.platform.startswith("linux") and os.environ.get("WAYLAND_DISPLAY"):
        os.environ.setdefault("GDK_BACKEND", "x11")  # Wayland ignores window positions; the quick panel needs one
    import webview
    try:
        api = build_windows(home, missing, start_hidden, tray)
        instance.serve(lambda msg: msg == "show" and api.show_main())
        webview.start()
    except Exception as e:  # e.g. WebKitGTK missing even though pywebview imports
        webview_dep = [dict(zip(DEP_KEYS, DEPS[0]))]
        cmds = ([APT_WEBKIT] if sys.platform.startswith("linux")
                else install_commands(webview_dep))
        show_setup_window(webview_dep, cmds, error=f"Không mở được giao diện: {e}")
        return 1
    return 0


PAGE = r"""<!doctype html>
<html lang="vi"><head><meta charset="utf-8">
<style>
:root{--bg:#0b1326;--surface:#111e36;--surface2:#172948;--surface3:#1e355c;--border:rgba(255,255,255,0.08);--border-hover:rgba(96,165,250,0.3);--ink:#f1f5f9;--muted:#94a3b8;
  --accent:#3b82f6;--accent-h:#2563eb;--link:#60a5fa;--good:#34d399;--chip:#123524;--warn:#f97316;--danger:#ef4444}
*{box-sizing:border-box;margin:0}
html,body{height:100%}
body{background:var(--bg);color:var(--ink);font:14px/1.4 Roboto,"Noto Sans","Segoe UI",system-ui,sans-serif;
  overflow:hidden;user-select:none;-webkit-user-select:none}
#root{display:flex;flex-direction:column;height:100%}
button{font:inherit;color:inherit;border:0;cursor:pointer;background:none}
svg{width:18px;height:18px;fill:currentColor;flex:none}
.bar{display:flex;align-items:center;gap:10px;padding:14px 16px;background:linear-gradient(180deg,#152541 0%,#0e1a2f 100%);border-bottom:1px solid var(--border);box-shadow:0 4px 16px #0008;z-index:2}
.bar h1{font-size:18px;font-weight:700;letter-spacing:-.01em}
.bar small{color:var(--muted);font-size:12px}
.grow{flex:1;min-width:0}
.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;background:var(--surface2);
  color:var(--muted);font-weight:700;font-size:12px;white-space:nowrap;border:1px solid var(--border)}
.chip.on{background:rgba(16,185,129,0.12);color:var(--good);border-color:rgba(52,211,153,0.3);box-shadow:0 0 8px rgba(52,211,153,0.15)}
.icon-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 10px;border-radius:999px;color:var(--link);
  font-weight:600;font-size:13px;transition:all .15s}
.icon-btn:hover{background:var(--surface2);transform:scale(1.05)}
.icon-btn.only{padding:8px;color:var(--muted)}.icon-btn.only:hover{color:var(--ink);background:var(--surface2)}
.bar .icon-btn.only{color:var(--ink)}
main{flex:1;overflow:auto;padding:14px 16px 8px}
.section{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.section>span{color:var(--muted);font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
.card{display:flex;align-items:center;gap:14px;padding:13px 15px;margin-bottom:10px;border-radius:18px;
  background:linear-gradient(135deg,#13223b 0%,#0e192c 100%);border:1px solid var(--border);cursor:pointer;
  transition:all .18s cubic-bezier(.16,1,.3,1);box-shadow:0 3px 12px rgba(0,0,0,0.25)}
.card:hover{box-shadow:0 8px 24px rgba(0,0,0,0.4);transform:translateY(-2px);border-color:var(--border-hover)}
.card.sel{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent),0 8px 22px rgba(59,130,246,0.25)}
.card.active{border-left:3px solid var(--good)}
.avatar{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:16px;
  background:linear-gradient(135deg,#2563eb,#1d4ed8);color:#fff;box-shadow:0 3px 10px rgba(37,99,235,0.3);flex:none}
.card.active .avatar{background:linear-gradient(135deg,#10b981,#059669);box-shadow:0 3px 10px rgba(16,185,129,0.3)}
.who{flex:1;min-width:0}
.who>b{display:block;font-size:15px;color:var(--ink);margin-bottom:2px}
.who small{display:block;color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meter{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.mini-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;white-space:nowrap}
.tag{padding:3px 9px;border-radius:999px;background:var(--chip);color:var(--good);font-size:11px;font-weight:800;letter-spacing:.04em;white-space:nowrap;border:1px solid rgba(52,211,153,0.3);box-shadow:0 0 8px rgba(52,211,153,0.15)}
.empty{text-align:center;color:var(--muted);padding:40px 10px;line-height:1.7}
footer{padding:8px 16px 14px;display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--border);background:linear-gradient(180deg,#0b1326 0%,#080e1c 100%)}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;padding:12px;border-radius:999px;font-weight:600;
  transition:all .18s cubic-bezier(.16,1,.3,1)}
.filled{background:linear-gradient(135deg,#3b82f6 0%,#2563eb 100%);color:#fff;font-size:15px;box-shadow:0 4px 14px rgba(37,99,235,0.35)}
.filled:hover{background:linear-gradient(135deg,#60a5fa 0%,#3b82f6 100%);box-shadow:0 6px 20px rgba(37,99,235,0.45);transform:translateY(-1px)}
.tonal{background:var(--surface2);border:1px solid var(--border)}
.tonal:hover{background:var(--surface3);border-color:rgba(255,255,255,0.14);transform:translateY(-1px)}
.row{display:flex;gap:8px}.row>*{flex:1}
.switch{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:13px;cursor:pointer}
.switch i{width:36px;height:20px;border-radius:999px;background:var(--surface3);position:relative;transition:background .2s;flex:none}
.switch i::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;
  background:var(--muted);transition:transform .2s,background .2s}
.switch.on i{background:var(--accent)}.switch.on i::after{transform:translateX(16px);background:#fff}
.note{color:var(--muted);font-size:12px}
.banner{margin:12px 16px 0;padding:12px 14px;border-radius:14px;background:var(--surface2);font-size:13px;border:1px solid var(--border)}
.cmd{display:flex;align-items:center;gap:8px;margin-top:8px;padding:6px 6px 6px 12px;border-radius:8px;background:var(--bg)}
.cmd code{flex:1;word-break:break-all;font:12px/1.5 ui-monospace,"DejaVu Sans Mono",monospace;user-select:text;-webkit-user-select:text}
.cmd button{padding:6px 14px;border-radius:999px;background:var(--accent);color:#fff;font-weight:600;font-size:12px}
.sheet{position:fixed;inset:0;background:linear-gradient(180deg,#0c1529 0%,#070d1a 100%);display:flex;flex-direction:column;transform:translateY(100%);
  transition:transform .28s cubic-bezier(.16,1,.3,1);z-index:5}
.sheet.open{transform:none}
.ubody{flex:1;overflow:auto;padding:16px 18px 24px}
.ucard{background:linear-gradient(145deg,#13223b 0%,#0e192c 100%);border-radius:20px;padding:16px 18px;margin-bottom:14px;
  border:1px solid var(--border);box-shadow:0 8px 24px rgba(0,0,0,0.35);transition:all .18s ease}
.ucard:hover{box-shadow:0 12px 30px rgba(0,0,0,0.45);transform:translateY(-1px);border-color:var(--border-hover)}
.ucard.active{border-left:3px solid var(--good)}
.uhead{display:flex;align-items:center;gap:12px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.06)}
.uhead-avatar{width:38px;height:38px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:15px;
  background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;box-shadow:0 3px 10px rgba(37,99,235,0.35);flex:none}
.ucard.active .uhead-avatar{background:linear-gradient(135deg,#10b981,#059669);box-shadow:0 3px 10px rgba(16,185,129,0.35)}
.uinfo{flex:1;min-width:0}
.uinfo b{font-size:16px;color:var(--ink);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.uinfo small{color:var(--muted);font-size:12px;display:flex;align-items:center;gap:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lim{padding:8px 0;font-size:13px}
.lim-top{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}
.lim-label{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:var(--ink)}
.lim-label svg{width:15px;height:15px;fill:var(--link);opacity:.9}
.lim-right{display:inline-flex;align-items:center;gap:8px}
.reset-pill{font-size:11px;color:var(--muted);background:rgba(255,255,255,0.05);padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,0.06)}
.pct-badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:800;padding:3px 9px;border-radius:999px}
.track{height:10px;border-radius:999px;background:rgba(0,0,0,0.35);overflow:hidden;box-shadow:inset 0 1px 3px rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.04)}
.fill{height:100%;width:0;border-radius:999px;transition:width .7s cubic-bezier(.16,1,.3,1)}
.unote{margin-top:12px;padding:9px 13px;border-radius:12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.06);color:var(--muted);font-size:12px;display:flex;align-items:flex-start;gap:8px}
.unote.warn{background:rgba(249,115,22,0.1);border-color:rgba(249,115,22,0.25);color:#fdba74}
.scrim{position:fixed;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;z-index:9}
.scrim.open{display:flex}
.dialog{width:min(350px,90vw);background:linear-gradient(145deg,#152541,#0e1a2f);border-radius:24px;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,0.6);border:1px solid var(--border)}
.dialog h2{font-size:18px;margin-bottom:8px}
.dialog p{color:var(--muted);font-size:14px;margin-bottom:14px;white-space:pre-line}
.dialog input{width:100%;padding:12px 14px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--ink);
  font:inherit;outline:none;user-select:text;-webkit-user-select:text}
.dialog input:focus{border-color:var(--link);box-shadow:0 0 0 2px rgba(96,165,250,0.2)}
.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
.actions button{padding:10px 18px;border-radius:999px;font-weight:600;color:var(--link);transition:background .15s}
.actions button:hover{background:var(--surface2)}
.actions .danger{color:var(--warn)}
.pick{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:11px 13px;margin-bottom:8px;
  border-radius:14px;background:var(--surface2);border:1px solid var(--border);transition:all .15s}
.pick:hover{background:var(--surface3);border-color:var(--border-hover)}
.pick small{flex:1;min-width:0;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag.warn{background:#3a2a17;color:#ffd166;border-color:rgba(255,209,102,0.3)}
.snack{position:fixed;left:50%;bottom:16px;transform:translate(-50%,calc(100% + 24px));width:max-content;max-width:90%;
  background:var(--ink);color:var(--bg);padding:12px 18px;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,0.5);
  font-weight:600;transition:transform .25s,visibility .25s;visibility:hidden;z-index:10;font-size:13px}
.snack.show{transform:translate(-50%,0);visibility:visible}
body.mini .bar{padding:10px 12px}
body.mini main{padding:8px 10px}
body.mini footer{padding:8px 10px 12px}
.mrow{display:flex;align-items:center;gap:10px;padding:9px 11px;margin-bottom:4px;border-radius:12px;cursor:pointer;transition:all .15s}
.mrow:hover{background:var(--surface2)}.mrow.active{background:linear-gradient(135deg,#13223b,#0e192c);border:1px solid var(--border)}
.dot{width:10px;height:10px;border-radius:50%;border:2px solid var(--muted);flex:none}
.mrow.active .dot{background:var(--good);border-color:var(--good);box-shadow:0 0 6px var(--good)}
.mrow b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mrow .meter{flex:none;max-width:65%;margin-top:0}
.mini-actions{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}
.mini-actions .btn{padding:8px 4px;font-size:12px;flex-direction:column;gap:3px;border-radius:12px}
::-webkit-scrollbar{width:8px}::-webkit-scrollbar-thumb{background:var(--surface3);border-radius:4px}
</style></head>
<body class="__MODE__">
<div id="root"><div class="empty">Đang tải…</div></div>
<section class="sheet" id="sheet"></section>
<div class="snack" id="snack"></div>
<div class="scrim" id="scrim"><div class="dialog" id="dialog"></div></div>
<script>
const MODE = "__MODE__";
const I = {
  swap: "M6.99 11L3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z",
  add: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
  folder: "M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z",
  save: "M17 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z",
  del: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  chart: "M5 9.2h3V19H5zM10.6 5h2.8v14h-2.8zm5.6 8H19v6h-2.8z",
  min: "M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z",
  close: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  back: "M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z",
  refresh: "M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z",
  open: "M19 19H5V5h7V3H5a2 2 0 00-2 2v14a2 2 0 002 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z",
  download: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
  info: "M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z",
  time: "M12 2a10 10 0 100 20 10 10 0 000-20zm.5 10.8l3.6 2.1-.8 1.3-4.3-2.6V6h1.5v6.8z",
  cal: "M19 4h-1V2h-2v2H8V2H6v2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V9h14v11z",
  model: "M12 2a2 2 0 012 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 017 7h1a1 1 0 011 1v3a1 1 0 01-1 1h-1v1a2 2 0 01-2 2H5a2 2 0 01-2-2v-1H2a1 1 0 01-1-1v-3a1 1 0 011-1h1a7 7 0 017-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 012-2M7.5 13A2.5 2.5 0 005 15.5 2.5 2.5 0 007.5 18 2.5 2.5 0 0010 15.5 2.5 2.5 0 007.5 13m9 0a2.5 2.5 0 00-2.5 2.5 2.5 2.5 0 002.5 2.5 2.5 2.5 0 002.5-2.5 2.5 2.5 0 00-2.5-2.5z",
};
const NOTE = "Không cần khởi động lại session — Claude nhận token mới ở lần kiểm tra đăng nhập kế tiếp. Gõ /status trong Claude để chắc chắn.";
const svg = k => `<svg viewBox="0 0 24 24"><path d="${I[k]}"/></svg>`;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const $ = id => document.getElementById(id);
const api = () => window.pywebview.api;
let S = null, sel = null, usage = {}, lastJson = "";

function toast(msg) {
  const el = $("snack"); el.textContent = msg; el.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove("show"), 3800);
}
async function call(name, ...args) {
  try {
    const r = await api()[name](...args);
    if (r && r.error) { toast(r.error); return null; }
    return r;
  } catch (e) { toast("Lỗi: " + (e && e.message || e)); return null; }
}
function dialog({title, text = "", input = null, ok = "OK", danger = false}) {
  return new Promise(resolve => {
    const sc = $("scrim");
    $("dialog").innerHTML = `<h2>${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ""}` +
      (input !== null ? `<input id="dlg-in" value="${esc(input)}" maxlength="64" spellcheck="false" placeholder="ví dụ: work">` : "") +
      `<div class="actions"><button id="dlg-no">Huỷ</button><button id="dlg-ok" class="${danger ? "danger" : ""}">${esc(ok)}</button></div>`;
    sc.classList.add("open");
    const inp = $("dlg-in"); if (inp) { inp.focus(); inp.select(); }
    const value = () => inp ? inp.value.trim() : true;
    const done = v => { sc.classList.remove("open"); document.removeEventListener("keydown", key); resolve(v); };
    const key = e => { if (e.key === "Escape") done(null); if (e.key === "Enter") done(value()); };
    document.addEventListener("keydown", key);
    $("dlg-no").onclick = () => done(null);
    $("dlg-ok").onclick = () => done(value());
    sc.onclick = e => { if (e.target === sc) done(null); };
  });
}

async function refresh() {
  const s = await api().state();
  const j = JSON.stringify(s);
  if (j === lastJson) return;  // nothing changed → no re-render, no flicker
  lastJson = j; S = s;
  if (!S.profiles.some(p => p.name === sel)) sel = S.current || (S.profiles[0] || {}).name || null;
  render();
}
function getGradient(pct) {
  if (pct < 50) return "linear-gradient(90deg, #10b981 0%, #34d399 100%)";
  if (pct < 80) return "linear-gradient(90deg, #eab308 0%, #facc15 100%)";
  if (pct < 95) return "linear-gradient(90deg, #f97316 0%, #fb923c 100%)";
  return "linear-gradient(90deg, #ef4444 0%, #f87171 100%)";
}
function getBadgeBg(pct) {
  if (pct < 50) return "rgba(16, 185, 129, 0.14)";
  if (pct < 80) return "rgba(234, 179, 8, 0.14)";
  if (pct < 95) return "rgba(249, 115, 22, 0.16)";
  return "rgba(239, 68, 68, 0.2)";
}
function getIconForLabel(label) {
  if (label.includes("5 giờ")) return svg("time");
  if (label.includes("7 ngày") && !label.includes("Opus") && !label.includes("Sonnet")) return svg("cal");
  return svg("model");
}
function getStatusEmoji(pct) {
  if (pct < 50) return "🟢";
  if (pct < 80) return "🟡";
  if (pct < 95) return "🟠";
  return "🔴";
}
const shortLabel = l => ({"5 giờ": "5h", "7 ngày": "7d"}[l] || l.replace(/^7 ngày /, ""));
const level = l => {
  const ico = l.icon || getStatusEmoji(l.pct);
  return `<span class="mini-badge" style="color:${l.text}; background:${getBadgeBg(l.pct)}; border:1px solid ${l.color}35;" title="${esc(l.label)}${l.reset ? " · reset " + esc(l.reset) : ""}">` +
    `${ico} ${esc(shortLabel(l.label))} <b>${Math.floor(l.pct)}%</b>${l.warn ? " ⚠" : ""}</span>`;
};
const meter = (n, max = 9) => {
  const u = usage[n]; if (!u) return "";
  return `<span class="meter">${u.limits.length ? u.limits.slice(0, max).map(level).join("") : `<span class="mini-badge" style="background:rgba(255,255,255,0.06);color:var(--muted)">${esc(u.summary)}</span>`}</span>`;
};
const chip = () => `<span class="chip ${S.current ? "on" : ""}">${S.current ? "● " + esc(S.current) : "○ chưa chọn"}</span>`;
function render() { if (S) (MODE === "mini" ? renderMini : renderMain)(); }

function renderMain() {
  const list = S.profiles.length ? S.profiles.map(p => `
    <div class="card ${p.active ? "active" : ""} ${p.name === sel ? "sel" : ""}" data-name="${esc(p.name)}">
      <div class="avatar">${esc(p.name[0].toUpperCase())}</div>
      <div class="who"><b>${esc(p.name)}</b><small>👤 ${esc(p.email || "—")}</small>${meter(p.name)}</div>
      ${p.active ? '<span class="tag">🟢 ACTIVE</span>' : ""}
    </div>`).join("")
    : `<div class="empty">Chưa có profile nào.<br>Đăng nhập Claude CLI rồi bấm “Lưu hiện tại”,<br>hoặc “Nhập…” từ thư mục khác.</div>`;
  const banner = S.missing.length ? `<div class="banner">Cài thêm <b>${esc(S.missing.join(", "))}</b> để thu nhỏ xuống thanh trên cùng:` +
    S.commands.map(c => `<div class="cmd"><code>${esc(c)}</code><button data-copy="${esc(c)}">Copy</button></div>`).join("") + `</div>` : "";
  $("root").innerHTML = `
    <header class="bar"><div class="grow"><h1>Claude Profiles</h1><small>Đổi tài khoản không cần tắt session</small></div>
      ${chip()}
      <button class="icon-btn only" id="info" title="${esc(NOTE)}" aria-label="Thông tin">${svg("info")}</button>
      <button class="icon-btn only" id="hide" title="Thu nhỏ" aria-label="Thu nhỏ">${svg("min")}</button></header>
    ${banner}
    <main><div class="section"><span>PROFILE</span><div>
      <button class="icon-btn only" id="import" title="Nhập profile từ thư mục…" aria-label="Nhập profile">${svg("download")}</button>
      <button class="icon-btn only" id="folder" title="Mở thư mục lưu profile" aria-label="Mở thư mục">${svg("folder")}</button></div></div>${list}</main>
    <footer>
      <button class="btn filled" id="swap">${svg("swap")}Chuyển profile</button>
      <div class="row"><button class="btn tonal" id="save" title="Lưu tài khoản đang đăng nhập thành profile">${svg("save")}Lưu</button>
        <button class="btn tonal" id="del" title="Xoá profile đang chọn">${svg("del")}Xoá</button>
        <button class="btn tonal" id="usage" title="Xem quota các profile">${svg("chart")}Usage</button></div>
      <div class="switch ${S.autostart ? "on" : ""}" id="auto" title="${S.tray ? "Tự chạy nền ở thanh trên cùng khi đăng nhập máy" : "Tự mở app khi đăng nhập máy"}"><i></i>Khởi động cùng máy</div>
    </footer>`;
}
function renderMini() {
  $("root").innerHTML = `
    <header class="bar"><div class="grow"><h1 style="font-size:16px">Claude Profiles</h1></div>${chip()}
      <button class="icon-btn" id="m-close" title="Đóng">${svg("close")}</button></header>
    <main>${S.profiles.length ? S.profiles.map(p => `<div class="mrow ${p.active ? "active" : ""}" data-swap="${esc(p.name)}">
      <span class="dot"></span><b title="${esc(p.email)}">${p.active ? '🟢 ' : '⚪ '}${esc(p.name)}</b>${meter(p.name, 2)}</div>`).join("") : '<div class="empty">Chưa có profile nào.</div>'}</main>
    <footer><div class="mini-actions">
      <button class="btn tonal" id="m-save" title="Lưu tài khoản đang đăng nhập">${svg("save")}Lưu</button>
      <button class="btn tonal" id="m-usage" title="Xem quota">${svg("chart")}Usage</button>
      <button class="btn tonal" id="m-import" title="Nhập profile từ thư mục…">${svg("download")}Nhập</button>
      <button class="btn tonal" id="m-open" title="Mở cửa sổ chính">${svg("open")}Mở app</button></div>
      <div class="switch ${S.autostart ? "on" : ""}" id="auto"><i></i>Khởi động cùng máy</div></footer>`;
}

async function swapTo(name) {
  if (await call("swap", name)) {
    sel = name; await refresh(); loadUsage();
    toast(`Đã chuyển sang “${name}”. Gõ /status trong Claude để xác nhận.`);
  }
}
async function saveCurrent() {
  const name = await dialog({title: "Lưu profile hiện tại", text: "Lưu tài khoản Claude đang đăng nhập thành một profile.", input: "", ok: "Lưu"});
  if (!name) return;
  let r = await call("save", name, false); if (!r) return;
  if (r.exists) {
    if (!await dialog({title: "Ghi đè?", text: `Profile “${name}” đã tồn tại. Ghi đè bằng tài khoản đang đăng nhập?`, ok: "Ghi đè", danger: true})) return;
    if (!await call("save", name, true)) return;
  }
  sel = name; await refresh(); toast(`Đã lưu profile “${name}”.`);
}
async function deleteSelected() {
  if (!sel) return toast("Hãy chọn một profile.");
  const name = sel;
  if (!await dialog({title: "Xoá profile?", text: `Xoá “${name}” khỏi máy? Không ảnh hưởng tài khoản Claude.`, ok: "Xoá", danger: true})) return;
  if (await call("delete", name)) { sel = null; await refresh(); toast(`Đã xoá “${name}”.`); }
}
function pickCandidate(cands) {  // "" = browse, null = cancel, else a folder path
  return new Promise(resolve => {
    const sc = $("scrim");
    $("dialog").innerHTML = `<h2>Nhập profile</h2><p>Thư mục Claude của tài khoản khác tìm thấy trên máy:</p>` +
      cands.map((c, i) => `<button class="pick" data-i="${i}" title="${esc(c.path)}"><b>${esc(c.name)}</b>
        <small>${esc(c.email || c.path)}</small>${c.exists ? '<span class="tag warn">đã có</span>' : ""}</button>`).join("") +
      `<div class="actions"><button id="dlg-no">Huỷ</button><button id="dlg-browse">Chọn thư mục khác…</button></div>`;
    sc.classList.add("open");
    const done = v => { sc.classList.remove("open"); document.removeEventListener("keydown", key); resolve(v); };
    const key = e => { if (e.key === "Escape") done(null); };
    document.addEventListener("keydown", key);
    $("dialog").querySelectorAll(".pick").forEach(b => b.onclick = () => done(cands[b.dataset.i].path));
    $("dlg-no").onclick = () => done(null);
    $("dlg-browse").onclick = () => done("");
    sc.onclick = e => { if (e.target === sc) done(null); };
  });
}
async function importFolder() {
  const cands = await call("import_candidates") || [];
  let folder = null;
  if (cands.length) {
    folder = await pickCandidate(cands);
    if (folder === null) return;
  }
  const r = await call("import_folder", folder || null, false);
  if (!r || r.cancelled) return;
  if (r.exists.length && await dialog({title: "Trùng tên", text: `Đã có: ${r.exists.join(", ")}.\nGhi đè bằng bản trong thư mục?`, ok: "Ghi đè", danger: true})) {
    const r2 = await call("import_folder", r.folder, true);
    if (r2) r.added = [...new Set([...r.added, ...r2.added])];
  }
  if (r.added.length) sel = r.added[0];
  lastJson = ""; await refresh();
  if (r.added.length) toast(`Đã nhập ${r.added.length} profile: ${r.added.join(", ")}.`);
  else if (!r.exists.length) toast("Không thấy profile trong thư mục này. Chọn thư mục cấu hình Claude (có .credentials.json) hoặc thư mục chứa file profile *.json của app.");
  else toast("Không nhập profile nào.");
}
async function openFolder() { const r = await call("open_folder"); if (r) toast(`Đã mở ${r.path}. Thả file profile vào, app tự cập nhật.`); }
async function toggleAuto() {
  const r = await call("set_autostart", !S.autostart);
  if (r) { await refresh(); toast(r.on ? "Đã bật khởi động cùng máy." : "Đã tắt khởi động cùng máy."); }
}
async function copy(text, btn) {
  let ok = false;
  try { ok = await api().copy(text); } catch (e) {}
  if (!ok) {  // no system clipboard tool: copy through the page
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta);
    ta.select(); document.execCommand("copy"); ta.remove();
  }
  btn.textContent = "Đã copy ✓"; setTimeout(() => btn.textContent = "Copy", 1500);
}

async function loadUsage(force = false) {
  const body = document.querySelector("#sheet.open .ubody");
  if (body && force) body.innerHTML = '<div class="empty">Đang tải usage…</div>';
  let rows;
  try { rows = await api().usage(force); } catch (e) { toast("Không tải được usage."); return; }
  usage = Object.fromEntries(rows.map(r => [r.name, r]));
  render(); renderUsage(rows);
}
function renderUsage(rows) {
  const b = document.querySelector("#sheet .ubody"); if (!b) return;
  b.innerHTML = rows.length ? rows.map(r => `
    <div class="ucard ${r.active ? 'active' : ''}">
      <div class="uhead">
        <div class="uhead-avatar">${esc(r.name[0].toUpperCase())}</div>
        <div class="uinfo">
          <b>${esc(r.name)}</b>
          <small>👤 ${esc(r.email || "—")}</small>
        </div>
        ${r.active ? '<span class="tag">● ACTIVE</span>' : ""}
      </div>
      ${r.limits.map(l => `
        <div class="lim">
          <div class="lim-top">
            <span class="lim-label">${getIconForLabel(l.label)} ${esc(l.label)}</span>
            <div class="lim-right">
              ${l.reset ? `<span class="reset-pill" title="Thời điểm quota được làm mới">⏳ reset ${esc(l.reset)}</span>` : ""}
              <span class="pct-badge" style="background:${getBadgeBg(l.pct)}; color:${l.text}; border:1px solid ${l.color}40;">
                ${l.icon || getStatusEmoji(l.pct)} ${Math.floor(l.pct)}%${l.warn ? " ⚠️" : ""}
              </span>
            </div>
          </div>
          <div class="track">
            <div class="fill" style="background:${getGradient(l.pct)}" data-w="${l.pct > 0 ? Math.max(3, Math.min(l.pct, 100)) : 0}"></div>
          </div>
        </div>`).join("")}
      ${r.note ? `<div class="unote ${r.note.includes('429') ? 'warn' : ''}">
        <span>${r.note.includes('429') ? '⏳' : r.note.includes('hết hạn') ? '⚠️' : 'ℹ️'}</span>
        <span>${esc(r.note)}</span>
      </div>` : ""}
    </div>`).join("")
    : '<div class="empty">Chưa có profile nào.</div>';
  requestAnimationFrame(() => requestAnimationFrame(() => b.querySelectorAll(".fill").forEach(f => f.style.width = f.dataset.w + "%")));
}
function openUsage() {
  const s = $("sheet");
  s.innerHTML = `<header class="bar"><button class="icon-btn" id="u-close" title="Quay lại">${svg("back")}</button>
    <div class="grow"><h1>Usage</h1><small>5 giờ · 7 ngày · theo model</small></div>
    <button class="icon-btn only" id="u-refresh" title="Làm mới" aria-label="Làm mới">${svg("refresh")}</button></header>
    <main class="ubody"><div class="empty">Đang tải usage…</div></main>`;
  s.classList.add("open"); loadUsage(false);
}

const ACTIONS = {
  hide: () => call("hide_main"), info: () => toast(NOTE), import: importFolder, folder: openFolder, save: saveCurrent, del: deleteSelected,
  swap: () => sel ? swapTo(sel) : toast("Hãy chọn một profile."), usage: openUsage, auto: toggleAuto,
  "u-close": () => $("sheet").classList.remove("open"), "u-refresh": () => loadUsage(true),
  "m-close": () => call("hide_mini"), "m-save": () => call("show_main", "save"), "m-usage": () => call("show_main", "usage"),
  "m-import": () => call("show_main", "import"), "m-open": () => call("show_main", ""),
};
document.addEventListener("click", e => {
  const t = e.target.closest("[data-copy],[data-swap],[data-name],button[id],.switch");
  if (!t) return;
  if (t.dataset.copy) return copy(t.dataset.copy, t);
  if (t.dataset.swap) return swapTo(t.dataset.swap);
  if (t.dataset.name) {
    sel = t.dataset.name;
    document.querySelectorAll(".card").forEach(c => c.classList.toggle("sel", c.dataset.name === sel));
    return;
  }
  (ACTIONS[t.id] || (() => {}))();
});
document.addEventListener("dblclick", e => { const c = e.target.closest(".card"); if (c) swapTo(c.dataset.name); });
window.addEventListener("focus", () => S && refresh());
window.addEventListener("blur", () => {
  if (MODE === "mini") setTimeout(() => { if (!document.hasFocus()) call("hide_mini"); }, 200);
});

window.app = {
  refresh: () => refresh(),
  open: v => ({usage: openUsage, save: saveCurrent, import: importFolder}[v] || (() => {}))(),
  shown: () => { refresh(); loadUsage(); },
};
let started = false;
async function start() {
  if (started) return; started = true;
  await refresh(); loadUsage();
  // no polling: Python pushes app.refresh() after every change; outside edits (CLI, files) show on focus
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
}
window.addEventListener("pywebviewready", start);
if (window.pywebview && window.pywebview.api) start();
</script>
</body></html>
"""


def main() -> int:
    home = Path.home()
    args = sys.argv[1:]
    if args and not set(args) <= {"--tray", "--foreground"}:
        return run_cli(args, home)
    return run_gui(home, start_hidden="--tray" in args, foreground="--foreground" in args)


if __name__ == "__main__":
    sys.exit(main())
