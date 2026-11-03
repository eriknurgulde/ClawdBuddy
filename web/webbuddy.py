#!/usr/bin/env python3
"""ClawdBuddy on your screen: the desk mascot in a small always-on-top window.

    python webbuddy.py                    start server + window in the screen corner
    python webbuddy.py --no-window        only the server (open http://127.0.0.1:8787)
    python webbuddy.py --install-startup  start automatically when you log in (Windows)
    python webbuddy.py --uninstall-startup

It receives the same /usage and /event messages as the ESP32 (pc/deskbuddy.py
sends to both) and streams them to the page. Closing the window stops it.
Standard library only.
"""
import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORT = int(os.environ.get("CLAWDBUDDY_WEB_PORT", "8787"))
TITLE = "ClawdBuddy"
APP_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "ClawdBuddy"
STATIC = {"/": "index.html", "/index.html": "index.html", "/buddy.js": "buddy.js", "/font.js": "font.js"}
DEFAULT_CONFIG = {
    "place": "Almaty", "latitude": 43.2295, "longitude": 76.8374,
    "night_start": 23, "night_end": 7,
    "scale": 3,                 # window size = 128x64 OLED pixels * scale
    "corner": "bottom-right",   # bottom-right | bottom-left | top-right | top-left
    "margin": 12,               # gap to the screen edge (in 100%-scale pixels)
    "margin_top": None,         # gap at the top edge; default = margin
}


def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        cfg.update(json.loads((HERE / "config.json").read_text(encoding="utf-8")))
    except (OSError, ValueError):
        pass
    return cfg


def log(*args):
    try:
        APP_DIR.mkdir(parents=True, exist_ok=True)
        with open(APP_DIR / "webbuddy.log", "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + " ".join(map(str, args)) + "\n")
    except OSError:
        pass


# ---------------------------------------------------------------- server
class Hub:
    """Keeps the latest usage + event and fans messages out to open pages."""

    def __init__(self):
        self.lock = threading.Lock()
        self.clients = []
        self.usage = {}
        self.last_event = None  # (time, data)

    def publish(self, kind, data):
        with self.lock:
            if kind == "usage":
                for k in ("five_hour", "seven_day"):
                    if isinstance(data.get(k), dict):
                        self.usage[k] = data[k]
            else:
                self.last_event = (time.time(), data)
            msg = json.dumps({"kind": kind, "data": data})
            for q in self.clients:
                q.put(msg)

    def subscribe(self):
        q = queue.Queue()
        with self.lock:
            self.clients.append(q)
            if self.usage:
                q.put(json.dumps({"kind": "usage", "data": self.usage}))
            # replay the current activity so a freshly opened page catches up
            if self.last_event and still_relevant(self.last_event[1]):
                q.put(json.dumps({"kind": "event", "data": self.last_event[1]}))
        return q

    def unsubscribe(self, q):
        with self.lock:
            if q in self.clients:
                self.clients.remove(q)


def still_relevant(ev):
    """Is a saved event still worth showing? (age from its own timestamp)"""
    age = time.time() - ev.get("ts", 0) / 1000
    if ev.get("type") == "done":
        return age < 8            # the celebration lasts 8 s
    if ev.get("type") == "idle":
        return False
    return age < 10 * 60          # working/waiting: the page times these out after 10 min


def load_snapshots(hub):
    """Catch up on what Claude Code did while no buddy was running."""
    tmp = tempfile.gettempdir()
    try:
        with open(os.path.join(tmp, "deskbuddy_last_usage.json"), encoding="utf-8") as f:
            usage = json.load(f)
        if isinstance(usage, dict):
            hub.usage.update({k: v for k, v in usage.items() if k in ("five_hour", "seven_day")})
    except (OSError, ValueError):
        pass
    try:
        with open(os.path.join(tmp, "deskbuddy_last_event.json"), encoding="utf-8") as f:
            ev = json.load(f)
        if isinstance(ev, dict):
            hub.last_event = (ev.get("ts", 0) / 1000, ev)
    except (OSError, ValueError):
        pass


HUB = Hub()
VIEWPORT = {"event": threading.Event(), "data": None}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in STATIC:
            name = STATIC[path]
            ctype = "text/html; charset=utf-8" if name.endswith(".html") else "text/javascript"
            self._send(200, (HERE / name).read_bytes(), ctype)
        elif path == "/config":
            self._send(200, json.dumps(load_config()))
        elif path == "/state":
            with HUB.lock:
                ev = HUB.last_event[1] if HUB.last_event else None
                self._send(200, json.dumps({"usage": HUB.usage, "last_event": ev, "pages": len(HUB.clients)}))
        elif path == "/events":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            q = HUB.subscribe()
            try:
                while True:
                    try:
                        msg = q.get(timeout=15)
                        self.wfile.write(f"data: {msg}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                HUB.unsubscribe(q)
        else:
            self._send(404, '{"error":"not found"}')

    def do_POST(self):
        path = self.path.split("?")[0]
        if path not in ("/usage", "/event", "/viewport"):
            self._send(404, '{"error":"not found"}')
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
            if not isinstance(data, dict):
                raise ValueError
        except ValueError:
            self._send(400, '{"error":"bad json"}')
            return
        if path == "/viewport":
            VIEWPORT["data"] = data
            VIEWPORT["event"].set()
        elif path == "/usage":
            HUB.publish("usage", data.get("rate_limits", data))
        else:
            HUB.publish("event", data)
        self._send(200, '{"ok":true}')


class Server(ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second copy bind the same port, so
    # "already running" would go unnoticed. Claim the port exclusively.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        import socket
        if os.name == "nt":
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def start_server():
    srv = Server(("127.0.0.1", PORT), Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ---------------------------------------------------------------- window (Windows)
def find_browser():
    candidates = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return shutil.which("msedge") or shutil.which("chrome") or shutil.which("google-chrome")


def run_window(cfg):
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)   # work in real pixels
    except (AttributeError, OSError):
        pass

    browser = find_browser()
    if not browser:
        import webbrowser
        log("no Edge/Chrome found, opening default browser")
        webbrowser.open(f"http://127.0.0.1:{PORT}/")
        while True:
            time.sleep(3600)

    EnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def find_windows():
        found = []

        def cb(hwnd, _):
            if user32.IsWindowVisible(hwnd):
                buf = ctypes.create_unicode_buffer(256)
                user32.GetWindowTextW(hwnd, buf, 256)
                if buf.value == TITLE:
                    found.append(hwnd)
            return True

        user32.EnumWindows(EnumProc(cb), 0)
        return found

    # A window left over from an earlier run (its launcher was stopped) is
    # adopted: the page reconnects to this server by itself. Extra copies close.
    existing = find_windows()
    for extra in existing[1:]:
        user32.PostMessageW(extra, 0x0010, 0, 0)          # WM_CLOSE
    if existing:
        hwnd = existing[0]
        log("adopted existing window")             # it re-reports its size on reconnect
    else:
        # Uses your normal browser profile: a fresh profile would show first-run popups.
        subprocess.Popen([browser, f"--app=http://127.0.0.1:{PORT}/", "--window-size=420,250"])
        hwnd = None
        for _ in range(150):                  # wait up to 15 s for the window
            found = find_windows()
            if found:
                hwnd = found[0]
                break
            time.sleep(0.1)
    if not hwnd:
        log("window never appeared")
        return

    HWND_TOPMOST = wintypes.HWND(-1)
    SWP_NOSIZE, SWP_NOMOVE, SWP_NOACTIVATE, SWP_SHOWWINDOW = 0x1, 0x2, 0x10, 0x40
    work = wintypes.RECT()
    user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(work), 0)   # SPI_GETWORKAREA

    def place():
        """Size the window so the page is exactly 128x64 * scale, then snap to the corner.
        The browser draws its own title bar, so the page reports its real size."""
        dpi = user32.GetDpiForWindow(hwnd) or 96
        want_w = round(128 * cfg["scale"] * dpi / 96)
        want_h = round(64 * cfg["scale"] * dpi / 96)
        wr = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(wr))
        cur_w, cur_h = wr.right - wr.left, wr.bottom - wr.top
        vp = VIEWPORT["data"]
        if vp:
            inner_w = round(vp["w"] * vp["dpr"])
            inner_h = round(vp["h"] * vp["dpr"])
        else:
            cr = wintypes.RECT()
            user32.GetClientRect(hwnd, ctypes.byref(cr))
            inner_w, inner_h = cr.right - cr.left, cr.bottom - cr.top
        w = want_w + cur_w - inner_w
        h = want_h + cur_h - inner_h
        m = round(cfg["margin"] * dpi / 96)
        mt = m if cfg.get("margin_top") is None else round(cfg["margin_top"] * dpi / 96)
        corner = cfg["corner"]
        x = work.left + m if "left" in corner else work.right - w - m
        y = work.top + mt if "top" in corner else work.bottom - h - m
        user32.SetWindowPos(hwnd, HWND_TOPMOST, x, y, w, h, SWP_SHOWWINDOW | SWP_NOACTIVATE)
        log(f"window placed at {x},{y} size {w}x{h} (dpi {dpi}, page {inner_w}x{inner_h})")

    VIEWPORT["event"].wait(10)            # page reports its size once loaded
    VIEWPORT["event"].clear()
    place()
    if VIEWPORT["event"].wait(3):         # re-measure after our resize
        VIEWPORT["event"].clear()
        place()

    # stay on top (some apps steal it); exit when the user closes the window
    while user32.IsWindow(hwnd):
        user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
        time.sleep(2)
    log("window closed, exiting")


# ---------------------------------------------------------------- autostart (Windows)
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


def startup(install):
    import winreg
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        if install:
            pyw = Path(sys.executable).with_name("pythonw.exe")
            exe = pyw if pyw.exists() else Path(sys.executable)
            winreg.SetValueEx(k, TITLE, 0, winreg.REG_SZ, f'"{exe}" "{Path(__file__).resolve()}"')
            print("ClawdBuddy will start when you log in.")
        else:
            try:
                winreg.DeleteValue(k, TITLE)
            except FileNotFoundError:
                pass
            print("ClawdBuddy removed from startup.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-window", action="store_true")
    ap.add_argument("--install-startup", action="store_true")
    ap.add_argument("--uninstall-startup", action="store_true")
    a = ap.parse_args()

    if a.install_startup or a.uninstall_startup:
        startup(a.install_startup)
        return

    try:
        start_server()
    except OSError:
        log(f"port {PORT} busy - is ClawdBuddy already running?")
        sys.exit(f"Port {PORT} is busy - ClawdBuddy is probably already running.")
    load_snapshots(HUB)
    log(f"server on http://127.0.0.1:{PORT} (caught up: usage={bool(HUB.usage)}, "
        f"event={HUB.last_event[1].get('type') + '/' + str(HUB.last_event[1].get('task')) if HUB.last_event else None})")

    if a.no_window or os.name != "nt":
        print(f"ClawdBuddy running at http://127.0.0.1:{PORT}/  (Ctrl+C to stop)")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            return
    run_window(load_config())


if __name__ == "__main__":
    main()
