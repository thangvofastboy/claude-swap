import json
import stat
import sys

import pytest

import claude_swap as cs


def login(home, account, token, extra=None):
    data = {"oauthAccount": {"emailAddress": f"{account}@example.com"},
            "projects": {"/p": {"history": [1, 2]}}, "numStartups": 7}
    data.update(extra or {})
    (home / ".claude.json").write_text(json.dumps(data))
    cred = home / ".claude" / ".credentials.json"
    cred.parent.mkdir(exist_ok=True)
    cred.write_text(json.dumps({"claudeAiOauth": {"accessToken": token}}))


def read(home):
    return json.loads((home / ".claude.json").read_text())


def token(home):
    return json.loads((home / ".claude" / ".credentials.json").read_text())["claudeAiOauth"]["accessToken"]


def test_missing_claude_json_errors(tmp_path):
    with pytest.raises(cs.SwapError, match="login"):
        cs.save_profile(tmp_path, "a")
    assert (tmp_path / ".config" / "claude-cli-profiles").is_dir()


def test_save_stores_only_auth_and_marks_active(tmp_path):
    login(tmp_path, "a", "tok-a")
    p = cs.save_profile(tmp_path, "work")
    saved = json.loads(p.read_text())
    assert saved["claude_json"] == {"oauthAccount": {"emailAddress": "a@example.com"}}
    assert json.loads(saved["credentials"])["claudeAiOauth"]["accessToken"] == "tok-a"
    assert cs.current_profile(tmp_path) == "work"
    if sys.platform != "win32":
        assert stat.S_IMODE(p.stat().st_mode) == 0o600


def test_save_existing_requires_force(tmp_path):
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "work")
    with pytest.raises(cs.ProfileExists):
        cs.save_profile(tmp_path, "work")
    login(tmp_path, "b", "tok-b")
    cs.save_profile(tmp_path, "work", force=True)
    assert "tok-b" in json.loads((tmp_path / ".config/claude-cli-profiles/work.json").read_text())["credentials"]


def test_swap_switches_auth_keeps_state_and_backs_up(tmp_path):
    login(tmp_path, "a", "tok-a", {"primaryApiKey": "sk-a"})
    cs.save_profile(tmp_path, "A")
    login(tmp_path, "b", "tok-b")
    cs.save_profile(tmp_path, "B")

    # session keeps writing state after B was saved
    d = read(tmp_path)
    d["numStartups"] = 99
    (tmp_path / ".claude.json").write_text(json.dumps(d))

    cs.swap_profile(tmp_path, "A")
    d = read(tmp_path)
    assert d["oauthAccount"]["emailAddress"] == "a@example.com"
    assert d["primaryApiKey"] == "sk-a"
    assert d["numStartups"] == 99 and d["projects"] == {"/p": {"history": [1, 2]}}
    assert token(tmp_path) == "tok-a"
    assert cs.current_profile(tmp_path) == "A"
    assert json.loads((tmp_path / ".claude.json.bak").read_text())["oauthAccount"]["emailAddress"] == "b@example.com"
    assert "tok-b" in (tmp_path / ".claude" / ".credentials.json.bak").read_text()

    cs.swap_profile(tmp_path, "B")
    assert "primaryApiKey" not in read(tmp_path)  # auth key absent in B is removed
    assert token(tmp_path) == "tok-b"


def test_swap_resaves_refreshed_token_of_active_profile(tmp_path):
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "A")
    login(tmp_path, "b", "tok-b")
    cs.save_profile(tmp_path, "B")
    cs.swap_profile(tmp_path, "A")

    login(tmp_path, "a", "tok-a2")  # CLI refreshed A's token
    cs.swap_profile(tmp_path, "B")
    cs.swap_profile(tmp_path, "A")
    assert token(tmp_path) == "tok-a2"

    login(tmp_path, "c", "tok-c")  # manual /login to another account while A active
    cs.swap_profile(tmp_path, "B")
    assert "tok-a2" in (tmp_path / ".config/claude-cli-profiles/A.json").read_text()


def test_swap_unknown_or_corrupt_profile(tmp_path):
    login(tmp_path, "a", "tok-a")
    with pytest.raises(cs.SwapError):
        cs.swap_profile(tmp_path, "nope")
    (tmp_path / ".config/claude-cli-profiles/bad.json").write_text("{not json")
    with pytest.raises(cs.SwapError, match="hỏng"):
        cs.swap_profile(tmp_path, "bad")
    assert read(tmp_path)["oauthAccount"]["emailAddress"] == "a@example.com"


def test_delete_active_clears_current(tmp_path):
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "A")
    cs.save_profile(tmp_path, "B")
    cs.delete_profile(tmp_path, "A")
    assert cs.current_profile(tmp_path) == "B"
    cs.delete_profile(tmp_path, "B")
    assert cs.list_profiles(tmp_path) == []
    assert not (tmp_path / ".config/claude-cli-profiles/.current").exists()


@pytest.mark.parametrize("bad", ["", "../x", "a/b", ".hidden", "x" * 65, "có dấu"])
def test_rejects_bad_names(tmp_path, bad):
    login(tmp_path, "a", "tok-a")
    with pytest.raises(cs.SwapError, match="không hợp lệ"):
        cs.save_profile(tmp_path, bad)


def test_cli(tmp_path, capsys):
    login(tmp_path, "a", "tok-a")
    assert cs.run_cli(["save", "A"], tmp_path) == 0
    assert cs.run_cli(["save", "A"], tmp_path) == 1
    assert cs.run_cli(["new", "B"], tmp_path) == 0
    assert cs.run_cli(["swap", "A"], tmp_path) == 0
    capsys.readouterr()
    cs.run_cli(["list"], tmp_path)
    out = capsys.readouterr().out
    assert "🟢 A (Active)" in out and "⚪ B" in out


def test_usage_report_uses_live_token_for_active_and_flags_expired(tmp_path):
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "A")
    login(tmp_path, "b", "tok-b")
    cs.save_profile(tmp_path, "B")  # B active, live creds = tok-b
    cred = tmp_path / ".claude" / ".credentials.json"
    cred.write_text(json.dumps({"claudeAiOauth": {"accessToken": "tok-b-live"}}))
    p = tmp_path / ".config/claude-cli-profiles/A.json"
    d = json.loads(p.read_text())
    d["credentials"] = json.dumps({"claudeAiOauth": {"accessToken": "old", "expiresAt": 1000}})
    p.write_text(json.dumps(d))

    seen = []

    def fake(token):
        seen.append(token)
        return {"five_hour": {"utilization": 37.6, "resets_at": "2026-10-08T08:00:00+00:00"},
                "seven_day": {"utilization": 12, "resets_at": None}, "seven_day_opus": None}

    out = cs.usage_report(tmp_path, fake)
    assert seen == ["tok-b-live"]
    assert "A  a@example.com\n  token đã hết hạn" in out
    assert "B (Active)  b@example.com" in out
    assert "  🟢 5 giờ       " + "█" * 8 + "░" * 12 + "  37%  reset " in out
    assert "  🟢 7 ngày      " + "█" * 2 + "░" * 18 + "  12%" in out and "Opus" not in out


def test_parse_limits_includes_model_scoped_fable():
    data = {
        "five_hour": {"utilization": 91, "resets_at": None},
        "seven_day_opus": None,
        "limits": [
            {"kind": "weekly_scoped", "scope": {"model": {"display_name": "Fable"}},
             "percent": 64.2, "resets_at": "2026-10-10T00:00:00Z"},
            {"kind": "weekly_scoped", "scope": {"model": {}}, "percent": 5},
            {"kind": "something_else", "percent": 99},
            "junk",
        ],
    }
    limits = cs.parse_limits(data)
    assert [(lbl, pct) for lbl, pct, _ in limits] == [("5 giờ", 91.0), ("7 ngày Fable", 64.2)]
    assert limits[1][2]  # reset formatted


def test_bar_and_status_color_clamp():
    assert cs.bar(0) == "░" * 20 and cs.bar(150) == "█" * 20
    assert cs.status_color(10) == "#0ca30c"
    assert cs.status_color(80) == "#ec835a"
    assert cs.status_color(100) == "#d03b3b"


def test_usage_report_handles_http_errors_and_api_key(tmp_path):
    import urllib.error
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "A")
    (tmp_path / ".claude" / ".credentials.json").unlink()
    (tmp_path / ".claude.json").write_text(json.dumps({"primaryApiKey": "sk-x"}))
    cs.save_profile(tmp_path, "K")

    def fake(token):
        raise urllib.error.HTTPError("u", 401, "x", {}, None)

    cs.swap_profile(tmp_path, "A")
    out = cs.usage_report(tmp_path, fake)
    assert "lỗi HTTP 401" in out
    assert "K\n  không có token OAuth" in out


@pytest.mark.skipif(sys.platform in ("win32", "darwin"), reason="linux .desktop autostart")
def test_autostart_desktop_file_roundtrip(tmp_path):
    assert not cs.autostart_enabled(tmp_path)
    cs.set_autostart(tmp_path, True)
    f = tmp_path / ".config/autostart/claude-swap.desktop"
    text = f.read_text()
    assert cs.autostart_enabled(tmp_path)
    assert "Exec=" in text and text.splitlines()[3].endswith("--tray")
    cs.set_autostart(tmp_path, False)
    assert not f.exists() and not cs.autostart_enabled(tmp_path)


def test_desktop_quote_escapes_spaces_and_specials():
    assert cs._desktop_quote("/usr/bin/python3") == "/usr/bin/python3"
    assert cs._desktop_quote("/home/a b/x$.py") == '"/home/a b/x\\$.py"'


def test_open_profiles_folder_uses_platform_opener(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(cs.subprocess, "Popen", lambda argv, **kw: calls.append(argv))
    monkeypatch.setattr(cs.sys, "platform", "linux")
    d = cs.open_profiles_folder(tmp_path)
    assert calls == [["xdg-open", str(d)]] and d.is_dir()


def test_usage_summary_short_labels():
    row = {"limits": [("5 giờ", 37.9, ""), ("7 ngày", 85, ""), ("7 ngày Fable", 10, "")], "note": ""}
    assert cs.usage_summary(row) == "5h 37% · 7d 85% ⚠"
    assert cs.usage_summary({"limits": [], "note": "token đã hết hạn — ..."}) == "hết hạn"


def test_import_profiles_from_folder(tmp_path):
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "A")
    src = tmp_path / "from other machine"
    src.mkdir()
    good = {"claude_json": {"oauthAccount": {"emailAddress": "x@example.com"}}, "credentials": "{}"}
    (src / "work.json").write_text(json.dumps(good))
    (src / "A.json").write_text(json.dumps(good))
    (src / "notes.json").write_text('{"hello": 1}')
    (src / "bad name!.json").write_text(json.dumps(good))
    (src / "broken.json").write_text("{nope")

    r = cs.import_profiles(tmp_path, src)
    assert r == {"added": ["work"], "exists": ["A"], "invalid": ["bad name!.json", "broken.json", "notes.json"]}
    assert cs.profile_email(tmp_path, "work") == "x@example.com"
    assert cs.profile_email(tmp_path, "A") == "a@example.com"

    r = cs.import_profiles(tmp_path, src, overwrite=True)
    assert sorted(r["added"]) == ["A", "work"] and cs.profile_email(tmp_path, "A") == "x@example.com"
    assert cs.import_profiles(tmp_path, cs.profiles_dir(tmp_path))["added"] == []
    with pytest.raises(cs.SwapError):
        cs.import_profiles(tmp_path, src / "missing")


def test_cli_import(tmp_path, capsys):
    src = tmp_path / "src"
    src.mkdir()
    (src / "w.json").write_text(json.dumps({"claude_json": {}}))
    assert cs.run_cli(["import", str(src)], tmp_path) == 0
    assert "Đã nhập: w" in capsys.readouterr().out
    assert cs.list_profiles(tmp_path) == ["w"]


def test_import_raw_claude_config_dir(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    cfg = tmp_path / ".claude-work"  # CLAUDE_CONFIG_DIR of another account
    cfg.mkdir()
    (cfg / ".credentials.json").write_text(json.dumps({"claudeAiOauth": {"accessToken": "tok-w"}}))
    (cfg / ".claude.json").write_text(json.dumps({"oauthAccount": {"emailAddress": "w@example.com"},
                                                   "projects": {"/x": {}}}))
    assert cs.import_profiles(home, cfg) == {"added": ["claude-work"], "exists": [], "invalid": []}
    saved = json.loads((cs.profiles_dir(home) / "claude-work.json").read_text())
    assert saved["claude_json"] == {"oauthAccount": {"emailAddress": "w@example.com"}}
    assert "tok-w" in saved["credentials"]
    assert cs.import_profiles(home, cfg)["exists"] == ["claude-work"]

    other_home = tmp_path / "laptop home"  # a whole home dir: .claude.json + .claude/.credentials.json
    (other_home / ".claude").mkdir(parents=True)
    (other_home / ".claude" / ".credentials.json").write_text('{"claudeAiOauth":{"accessToken":"t"}}')
    assert cs.import_profiles(home, other_home)["added"] == ["laptop-home"]
    empty = tmp_path / "empty"
    empty.mkdir()
    assert cs.import_profiles(home, empty) == {"added": [], "exists": [], "invalid": []}


def test_api_profile_actions_and_errors(tmp_path):
    login(tmp_path, "a", "tok-a")
    api = cs.Api(tmp_path, fetch=lambda t: {"five_hour": {"utilization": 85, "resets_at": None}})
    assert api.save("A") == {"ok": True}
    assert api.save("A") == {"exists": True}
    assert api.save("A", True) == {"ok": True}
    login(tmp_path, "b", "tok-b")
    api.save("B")
    st = api.state()
    assert [(p["name"], p["active"]) for p in st["profiles"]] == [("A", False), ("B", True)]
    assert st["current"] == "B" and st["tray"] is False and st["missing"] == []
    assert api.swap("A") == {"ok": True} and token(tmp_path) == "tok-a"
    assert "error" in api.swap("nope")
    assert "không hợp lệ" in api.save("../x")["error"]
    rows = api.usage()
    a = next(r for r in rows if r["name"] == "A")
    assert a["limits"][0] == {"label": "5 giờ", "pct": 85.0, "reset": "", "color": "#ec835a",
                              "text": "#ffab70", "icon": "🟠", "warn": True}
    assert [cs.status_text_color(p) for p in (10, 60, 90, 100)] == ["#7ee787", "#ffd166", "#ffab70", "#ff8a80"]
    assert a["summary"] == "5h 85% ⚠"
    assert api.delete("B") == {"ok": True} and "error" in api.delete("B")


def test_api_import_folder_with_path(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "w.json").write_text(json.dumps({"claude_json": {}}))
    r = cs.Api(tmp_path).import_folder(str(src))
    assert r["added"] == ["w"] and r["folder"] == str(src)


def test_missing_deps_and_install_commands(monkeypatch):
    import importlib.util
    monkeypatch.setattr(importlib.util, "find_spec", lambda m: None if m in ("webview", "PIL") else object())
    missing = cs.missing_deps()
    assert [d["name"] for d in missing] == ["pywebview", "Pillow"]
    assert missing[0]["required"] and not missing[1]["required"]

    monkeypatch.setattr(cs.sys, "platform", "linux")
    monkeypatch.setattr(cs.sys, "executable", "/usr/bin/python3")
    monkeypatch.setattr(cs.shutil, "which", lambda name: "/usr/bin/apt" if name == "apt" else None)
    assert cs.install_commands(missing) == ["sudo apt install python3-webview python3-pil"]

    monkeypatch.setattr(cs.sys, "executable", "/home/linuxbrew/.linuxbrew/bin/python3")
    assert cs.install_commands(missing) == ["/home/linuxbrew/.linuxbrew/bin/python3 -m pip install pywebview pillow"]
    monkeypatch.setattr(cs.sys, "executable", r"C:\Program Files\Python\python.exe")
    monkeypatch.setattr(cs.sys, "platform", "win32")
    assert cs.install_commands(missing[1:]) == [r'"C:\Program Files\Python\python.exe" -m pip install pillow']
    assert cs.install_commands([]) == []


def test_swap_to_active_profile_keeps_refreshed_token(tmp_path):
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "A")
    login(tmp_path, "a", "tok-a2")  # CLI rotated the token
    cs.swap_profile(tmp_path, "A")
    assert token(tmp_path) == "tok-a2"
    assert "tok-a2" in (tmp_path / ".config/claude-cli-profiles/A.json").read_text()


def test_swap_refresh_ignores_mutated_oauth_fields(tmp_path):
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "A")
    login(tmp_path, "b", "tok-b")
    cs.save_profile(tmp_path, "B")
    cs.swap_profile(tmp_path, "A")
    login(tmp_path, "a", "tok-a2", {"oauthAccount": {"emailAddress": "a@example.com", "billingType": "x"}})
    cs.swap_profile(tmp_path, "B")
    assert "tok-a2" in (tmp_path / ".config/claude-cli-profiles/A.json").read_text()


def test_swap_to_api_key_profile_clears_oauth_and_works_logged_out(tmp_path):
    (tmp_path / ".claude.json").write_text(json.dumps({"primaryApiKey": "sk-k"}))
    cs.save_profile(tmp_path, "K")
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "A")
    cs.swap_profile(tmp_path, "K")
    assert not (tmp_path / ".claude" / ".credentials.json").exists()
    assert read(tmp_path)["primaryApiKey"] == "sk-k" and "oauthAccount" not in read(tmp_path)
    (tmp_path / ".claude.json").write_text("{}")  # /logout while K active
    cs.swap_profile(tmp_path, "A")
    assert token(tmp_path) == "tok-a"


def test_odd_files_in_profile_dir_do_not_break_usage(tmp_path):
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "A")
    (cs.profiles_dir(tmp_path) / "copy of A.json").write_text("{}")
    assert cs.list_profiles(tmp_path) == ["A"]

    def reset(token):
        raise ConnectionResetError("peer reset")
    assert "lỗi mạng" in cs.usage_report(tmp_path, reset)


def test_import_rejects_non_string_credentials(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    (src / "w.json").write_text(json.dumps({"claude_json": {}, "credentials": {"claudeAiOauth": {}}}))
    assert cs.import_profiles(tmp_path, src)["invalid"] == ["w.json"]


def test_install_commands_pip_for_usr_local(monkeypatch):
    monkeypatch.setattr(cs.sys, "platform", "linux")
    monkeypatch.setattr(cs.sys, "executable", "/usr/local/bin/python3.14")
    monkeypatch.setattr(cs.shutil, "which", lambda name: "/usr/bin/apt")
    dep = [dict(zip(cs.DEP_KEYS, cs.DEPS[2]))]
    assert cs.install_commands(dep) == ["/usr/local/bin/python3.14 -m pip install pillow"]


def test_find_claude_dirs_and_import_candidates(tmp_path):
    login(tmp_path, "me", "tok-me")  # ~/.claude is the live login: never offered
    for d in (tmp_path / ".claude-work", tmp_path / ".config" / "claude-client"):
        d.mkdir(parents=True)
        (d / ".credentials.json").write_text('{"claudeAiOauth":{"accessToken":"t"}}')
    (tmp_path / ".claude-work" / ".claude.json").write_text(json.dumps({"oauthAccount": {"emailAddress": "w@example.com"}}))
    (tmp_path / ".claude-empty").mkdir()  # no credentials: not a login
    (tmp_path / "claude-notes").mkdir()
    assert cs.find_claude_dirs(tmp_path) == [tmp_path / ".claude-work", tmp_path / ".config" / "claude-client"]
    cands = cs.Api(tmp_path).import_candidates()
    assert [(c["name"], c["email"], c["exists"]) for c in cands] == [("claude-work", "w@example.com", False),
                                                                     ("claude-client", "", False)]
    assert cs.Api(tmp_path).import_folder(cands[0]["path"])["added"] == ["claude-work"]
    assert cs.Api(tmp_path).import_candidates()[0]["exists"] is True


def test_usage_cache_ttl_and_429_backoff(tmp_path, monkeypatch):
    import urllib.error
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "A")
    calls = []
    clock = [1_000_000.0]
    monkeypatch.setattr(cs.time, "time", lambda: clock[0])

    def ok(token):
        calls.append(token)
        return {"five_hour": {"utilization": 40, "resets_at": None}}

    def limited(token):
        calls.append(token)
        raise urllib.error.HTTPError("u", 429, "Too Many Requests", {"Retry-After": "120"}, None)

    assert cs.usage_rows(tmp_path, ok)[0]["limits"] == [("5 giờ", 40.0, "")]
    assert cs.usage_rows(tmp_path, ok)[0]["limits"] == [("5 giờ", 40.0, "")]
    assert len(calls) == 1  # second read came from the on-disk cache
    assert not (cs.profiles_dir(tmp_path) / ".usage-cache.json").name in cs.list_profiles(tmp_path)

    clock[0] += cs.USAGE_TTL + 1  # stale → asks again, gets 429: keeps showing the last reading
    row = cs.usage_rows(tmp_path, limited)[0]
    assert len(calls) == 2 and row["limits"] == [("5 giờ", 40.0, "")]
    assert "429" in row["note"] and "đang hiện số liệu lúc" in row["note"]
    assert cs.usage_summary({**row, "limits": []}) == "bị giới hạn"

    clock[0] += 60  # inside Retry-After: even force must not hit the server
    assert "429" in cs.usage_rows(tmp_path, ok, force=True)[0]["note"] and len(calls) == 2
    clock[0] += 61  # window over → fetches again
    assert cs.usage_rows(tmp_path, ok, force=True)[0]["note"] == "" and len(calls) == 3


def test_usage_429_without_cache_or_retry_after(tmp_path):
    import urllib.error
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "A")

    def limited(token):
        raise urllib.error.HTTPError("u", 429, "x", {}, None)
    row = cs.usage_rows(tmp_path, limited)[0]
    assert row["limits"] == [] and "thử lại sau" in row["note"] and "số liệu lúc" not in row["note"]
    cache = json.loads((cs.profiles_dir(tmp_path) / ".usage-cache.json").read_text())
    assert next(iter(cache.values()))["retry_at"] > cs.time.time() + cs.USAGE_BACKOFF - 5


def _short_home():  # AF_UNIX paths are capped at ~104 chars; pytest's tmp_path can exceed that
    import tempfile
    from pathlib import Path
    return Path(tempfile.mkdtemp(dir="/tmp", prefix="cs"))


@pytest.mark.skipif(sys.platform == "win32", reason="AF_UNIX + flock path")
def test_single_instance_lock_and_wakeup():
    home = _short_home()
    first, second = cs.Instance(home), cs.Instance(home)
    assert first.acquire() and not second.acquire()
    got = []
    first.serve(got.append)
    assert second.notify("show") and got == ["show"]
    first.release()
    assert not (cs.profiles_dir(home) / ".gui.sock").exists()
    assert not second.notify("show", attempts=1)  # nobody listening any more
    assert second.acquire()  # lock freed for the next launch
    second.release()


@pytest.mark.skipif(sys.platform == "win32", reason="AF_UNIX + flock path")
def test_stale_socket_from_crashed_run_is_replaced():
    home = _short_home()
    (cs.profiles_dir(home) / ".gui.sock").write_text("left by a crash")
    inst = cs.Instance(home)
    assert inst.acquire()
    inst.serve(lambda m: None)
    assert cs.Instance(home).notify("ping", attempts=1)
    inst.release()


def test_detach_command_starts_new_session(monkeypatch, tmp_path):
    monkeypatch.setattr(cs.sys, "argv", ["claude_swap.py", "--tray"])
    cmd, kw = cs.detach_command(tmp_path)
    kw["stdout"].close()
    assert cmd[0] == cs.sys.executable and cmd[1].endswith("claude_swap.py") and cmd[2:] == ["--tray"]
    assert kw["env"][cs.DETACH_ENV] == "1" and kw["stdin"] is cs.subprocess.DEVNULL
    assert kw.get("start_new_session") or kw.get("creationflags")
    assert (cs.profiles_dir(tmp_path) / ".gui.log").exists()
    monkeypatch.setenv(cs.DETACH_ENV, "1")
    assert not cs.started_from_terminal()  # the detached child never detaches again


def test_main_routes_gui_flags(monkeypatch):
    seen = []
    monkeypatch.setattr(cs, "run_gui", lambda home, start_hidden, foreground: seen.append((start_hidden, foreground)) or 0)
    for argv in ([], ["--tray"], ["--foreground"], ["--tray", "--foreground"]):
        monkeypatch.setattr(cs.sys, "argv", ["x", *argv])
        cs.main()
    assert seen == [(False, False), (True, False), (False, True), (True, True)]


def test_chart_bar_and_format_limit_chart():
    assert cs._chart_bar(0, width=8, color=False) == "[░░░░░░░░]"
    assert cs._chart_bar(50, width=8, color=False) == "[████░░░░]"
    assert cs._chart_bar(100, width=8, color=False) == "[████████]"
    # Colored output
    colored = cs._chart_bar(85, width=8, color=True)
    assert "█" in colored and "░" in colored and "\033[" in colored

    fmt_plain = cs._format_limit_chart("5 giờ", 37.5, color=False)
    assert "5h [███░░░░░] 38%" in fmt_plain
    fmt_warn = cs._format_limit_chart("7 ngày", 85.0, color=False)
    assert "7d [███████░] 85% ⚠" in fmt_warn


def test_profile_list_report_with_cached_limits(tmp_path):
    login(tmp_path, "a", "tok-a")
    cs.save_profile(tmp_path, "A", force=True)
    cs.swap_profile(tmp_path, "A")
    cache = {
        "A|a@example.com": {
            "limits": [
                ["5 giờ", 25.0, "15:00"],
                ["7 ngày", 90.0, "13/10 09:00"],
            ]
        }
    }
    (cs.profiles_dir(tmp_path) / ".usage-cache.json").write_text(json.dumps(cache))
    out = cs.profile_list_report(tmp_path, color=False)
    assert "🟢 A (Active)" in out
    assert "5h [██░░░░░░] 25%" in out
    assert "7d [███████░] 90% ⚠" in out

