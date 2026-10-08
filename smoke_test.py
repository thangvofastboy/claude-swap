"""Smoke test: chạy CLI thật qua subprocess trong HOME tạm, rồi dựng/huỷ GUI nếu có display.

    python smoke_test.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

APP = Path(__file__).with_name("claude_swap.py")


def run(home, *args):
    env = {**os.environ, "HOME": str(home), "USERPROFILE": str(home)}
    r = subprocess.run([sys.executable, str(APP), *args], env=env, capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


def login(home, account, token):
    (home / ".claude.json").write_text(json.dumps(
        {"oauthAccount": {"emailAddress": f"{account}@example.com"}, "projects": {"/p": {}}}))
    (home / ".claude").mkdir(exist_ok=True)
    (home / ".claude" / ".credentials.json").write_text(
        json.dumps({"claudeAiOauth": {"accessToken": token}}))


def main():
    with tempfile.TemporaryDirectory() as d:
        home = Path(d)
        code, out = run(home, "save", "A")
        assert code == 1 and "login" in out, out

        login(home, "a", "tok-a")
        assert run(home, "save", "A")[0] == 0
        login(home, "b", "tok-b")
        assert run(home, "save", "B")[0] == 0
        assert run(home, "save", "B")[0] == 1

        code, out = run(home, "swap", "A")
        assert code == 0, out
        assert json.loads((home / ".claude.json").read_text())["oauthAccount"]["emailAddress"] == "a@example.com"
        assert "tok-a" in (home / ".claude" / ".credentials.json").read_text()
        assert (home / ".claude.json.bak").exists()
        list_out = run(home, "list")[1]
        assert "🟢" in list_out and "A (Active)" in list_out and "⚪" in list_out and "B" in list_out

        assert run(home, "delete", "A")[0] == 0
        assert run(home, "current")[1].strip() == ""
        assert run(home, "delete", "B")[0] == 0
        assert "Chưa có profile" in run(home, "usage")[1]
        print("CLI smoke: OK")

        if sys.platform.startswith("linux") and not os.environ.get("DISPLAY") \
                and not os.environ.get("WAYLAND_DISPLAY"):
            print("GUI smoke: SKIP (không có display)")
            return
        sys.path.insert(0, str(APP.parent))
        import claude_swap
        setup_window_smoke(claude_swap)
        try:
            import webview
        except ImportError:
            print("Web GUI smoke: SKIP (Python này chưa có pywebview)")
            return
        web_gui_smoke(claude_swap, webview, home)
        if sys.platform != "win32":
            detach_and_single_instance_smoke()


def detach_and_single_instance_smoke():
    """Launch from a (pseudo) terminal: the app must detach into its own session and survive the
    terminal; a second launch must not open a duplicate but wake the running one."""
    import pty
    import signal
    home = Path(tempfile.mkdtemp(dir="/tmp", prefix="cs"))  # short: AF_UNIX path limit
    env = {**os.environ, "HOME": str(home)}
    env.pop("CLAUDE_SWAP_DETACHED", None)
    _, tty = pty.openpty()
    first = subprocess.run([sys.executable, str(APP)], stdin=tty, env=env, capture_output=True, text=True, timeout=30)
    os.close(tty)
    assert first.returncode == 0 and "chạy nền (pid" in first.stdout, first.stdout + first.stderr
    pid = int(first.stdout.split("pid ")[1].split(")")[0])
    try:
        assert os.getsid(pid) != os.getsid(0), "detached app still shares the terminal's session"
        sock = home / ".config" / "claude-cli-profiles" / ".gui.sock"
        for _ in range(100):
            if sock.exists():
                break
            time.sleep(0.2)
        assert sock.exists(), (home / ".config/claude-cli-profiles/.gui.log").read_text()
        second = subprocess.run([sys.executable, str(APP)], env=env, capture_output=True, text=True, timeout=30)
        assert second.returncode == 0 and "đang chạy rồi — đã đưa cửa sổ" in second.stdout, second.stdout + second.stderr
        os.kill(pid, 0)  # the first app is still the only one, still alive
    finally:
        os.kill(pid, signal.SIGTERM)
    for _ in range(50):
        try:
            os.kill(pid, 0)
            time.sleep(0.1)
        except ProcessLookupError:
            break
    print("Detach + single-instance smoke: OK")


def setup_window_smoke(cs):
    """Missing-library window: lists the commands and its Copy button works."""
    missing = [dict(zip(("module", "name", "why", "required", "apt", "pip"), cs.DEPS[0]))]
    copied = []
    real_copy, cs.copy_text = cs.copy_text, lambda text: copied.append(text) or True  # keep the user's clipboard
    root = cs.build_setup_window(missing, ["sudo apt install python3-webview"])
    root.update()

    def walk(w):
        yield w
        for c in w.winfo_children():
            yield from walk(c)
    texts = [w.cget("text") for w in walk(root) if "text" in w.keys()]
    assert "sudo apt install python3-webview" in texts and "Kiểm tra lại" in texts, texts
    copy_btn = next(w for w in walk(root) if "text" in w.keys() and w.cget("text") == "Copy")
    copy_btn.invoke()
    root.update()
    assert copy_btn.cget("text") == "Đã copy ✓" and copied == ["sudo apt install python3-webview"]
    root.destroy()
    cs.copy_text = real_copy
    print("Setup window smoke: OK")


def web_gui_smoke(cs, webview, home):
    """Real pywebview window: cards render, Save dialog opens, Usage sheet draws bars."""
    login(home, "a", "tok-a")
    cs.save_profile(home, "work")
    login(home, "b", "tok-b")
    cs.save_profile(home, "personal")
    work_dir = home / ".claude-work"  # another account's CLAUDE_CONFIG_DIR, a hidden folder
    work_dir.mkdir()
    (work_dir / ".credentials.json").write_text('{"claudeAiOauth":{"accessToken":"tok-w"}}')
    api = cs.build_windows(home, missing=[], tray=False)
    api._fetch = lambda token: {"five_hour": {"utilization": 37, "resets_at": None},
                                "limits": [{"kind": "weekly_scoped", "percent": 91,
                                            "scope": {"model": {"display_name": "Fable"}}}]}
    seen = {}

    def wait_for(js, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            value = api._main.evaluate_js(js)
            if value:
                return value
            time.sleep(0.2)
        return None

    def probe():
        try:
            seen["cards"] = wait_for("document.querySelectorAll('.card').length")
            seen["active"] = api._main.evaluate_js("document.querySelector('.card.active b').textContent")
            api._main.evaluate_js("document.getElementById('save').click()")
            seen["dialog"] = wait_for("document.getElementById('scrim').classList.contains('open')")
            api._main.evaluate_js("document.getElementById('dlg-no').click()")
            api._main.evaluate_js("document.getElementById('usage').click()")
            seen["ucards"] = wait_for("document.querySelectorAll('.ucard').length === 2 && 2")
            seen["fable"] = wait_for("document.querySelector('#sheet').textContent.includes('7 ngày Fable')")
            api._main.evaluate_js("document.getElementById('u-close').click()")
            api._main.evaluate_js("document.getElementById('import').click()")
            seen["picks"] = wait_for("document.querySelectorAll('.pick').length")  # ~/.claude-work offered
            api._main.evaluate_js("document.querySelector('.pick').click()")
            seen["imported"] = wait_for("document.querySelectorAll('.card').length === 3 && 3")
        finally:
            api.quit()

    webview.start(probe)
    assert seen == {"cards": 2, "active": "personal", "dialog": True, "ucards": 2, "fable": True,
                    "picks": 1, "imported": 3}, seen
    print("Web GUI smoke: OK")


if __name__ == "__main__":
    main()
