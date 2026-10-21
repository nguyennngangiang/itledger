#!/usr/bin/env python3
"""Host-side `claude -p` runner for the Scan screen (be/scan.py).

The API runs in Docker; the Claude Code CLI and its login (the Claude
subscription of the `ubuntu` user) live on the host. Rather than copy a
credential into the container, this small service runs on the host as `ubuntu`,
and the container reaches it over a unix socket bind-mounted into it — no TCP
port, nothing reachable from the network.

    GET  /health   {"ok": true, "version": "..."} — is the CLI there and logged in
    POST /run      {"system", "content": [blocks], "schema", "model", "effort"}
                   -> {"ok": true, "output": <object matching schema>}
                   |  {"ok": false, "error": "..."}

Each run is one isolated `claude -p`: no tools at all (`--tools ""`), so a
document that says "ignore your instructions and run X" has nothing to run
with; no session saved; no user/project settings, hooks, MCP servers or skills
loaded; an empty working directory. Content blocks (base64 image / PDF) go in
through `--input-format stream-json`, exactly as a Messages API user turn.

Stdlib only, so the host needs nothing installed beyond python3 and claude.
Installed as deploy/vps/itledger-claude-runner.service.
"""
import json
import os
import shutil
import socketserver
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler

SOCKET = os.environ.get("RUNNER_SOCKET", "/run/itledger-claude/claude.sock")
CLAUDE = os.environ.get("CLAUDE_BIN") or shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")
TIMEOUT = int(os.environ.get("RUNNER_TIMEOUT", "280"))
# A phone camera read and a PDF read can overlap; more than this at once is
# someone hammering the button, and each run is a whole CLI process.
SLOTS = threading.BoundedSemaphore(int(os.environ.get("RUNNER_CONCURRENCY", "2")))
MAX_BODY = 32 * 1024 * 1024
WORKDIR = tempfile.mkdtemp(prefix="itledger-claude-")

_LOGIN_HINTS = ("login", "/login", "not logged in", "authentication", "oauth", "unauthorized", "401")


def run(req: dict) -> tuple[int, dict]:
    cmd = [
        CLAUDE, "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json", "--verbose",
        "--json-schema", json.dumps(req["schema"]),
        "--tools", "",
        "--no-session-persistence",
        "--setting-sources", "",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--system-prompt", req.get("system", ""),
    ]
    if req.get("model"):
        cmd += ["--model", req["model"]]
    if req.get("effort"):
        cmd += ["--effort", req["effort"]]
    message = {"type": "user", "message": {"role": "user", "content": req["content"]}}

    if not SLOTS.acquire(timeout=30):
        return 429, {"ok": False, "error": "Claude đang bận đọc tệp khác, thử lại sau ít giây."}
    try:
        proc = subprocess.run(
            cmd, input=json.dumps(message) + "\n", capture_output=True, text=True,
            timeout=TIMEOUT, cwd=WORKDIR,
        )
    except subprocess.TimeoutExpired:
        return 504, {"ok": False, "error": f"Claude đọc quá {TIMEOUT} giây."}
    finally:
        SLOTS.release()

    result = None
    for line in proc.stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if ev.get("type") == "result":
            result = ev
    if result is None:
        text = (proc.stderr or proc.stdout or "").strip()[-500:]
        if any(h in text.lower() for h in _LOGIN_HINTS):
            return 503, {"ok": False, "error": "Claude trên máy chủ chưa đăng nhập. Chạy `claude` bằng user ubuntu rồi /login."}
        return 502, {"ok": False, "error": f"claude -p không trả kết quả: {text or proc.returncode}"}
    if result.get("is_error") or result.get("subtype") != "success":
        text = str(result.get("result") or result.get("subtype"))
        if any(h in text.lower() for h in _LOGIN_HINTS):
            return 503, {"ok": False, "error": "Claude trên máy chủ chưa đăng nhập hoặc phiên đã hết hạn (chạy `claude` rồi /login)."}
        return 502, {"ok": False, "error": text[:500]}
    output = result.get("structured_output")
    if output is None:
        try:
            output = json.loads(result.get("result") or "")
        except ValueError:
            return 502, {"ok": False, "error": "Claude không trả JSON đúng mẫu."}
    return 200, {"ok": True, "output": output, "duration_ms": result.get("duration_ms")}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/health":
            return self._send(404, {"ok": False})
        try:
            v = subprocess.run([CLAUDE, "--version"], capture_output=True, text=True, timeout=15)
            self._send(200, {"ok": v.returncode == 0, "version": v.stdout.strip()})
        except (OSError, subprocess.TimeoutExpired) as e:
            self._send(200, {"ok": False, "error": str(e)})

    def do_POST(self):
        if self.path != "/run":
            return self._send(404, {"ok": False})
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._send(413, {"ok": False, "error": "Tệp quá lớn."})
        try:
            req = json.loads(self.rfile.read(length))
            assert isinstance(req.get("content"), list) and isinstance(req.get("schema"), dict)
        except (ValueError, AssertionError):
            return self._send(400, {"ok": False, "error": "Yêu cầu không hợp lệ."})
        status, body = run(req)
        self._send(status, body)

    def log_message(self, fmt, *args):
        # journald gets one line per request, without the request body.
        print(f"{self.command} {self.path} -> " + (args[1] if len(args) > 1 else ""), flush=True)

    # A unix socket has no client address; http.server expects a tuple.
    def address_string(self):
        return "unix"


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    os.makedirs(os.path.dirname(SOCKET), exist_ok=True)
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    with Server(SOCKET, Handler) as srv:
        os.chmod(SOCKET, 0o660)
        print(f"claude runner on {SOCKET} using {CLAUDE}", flush=True)
        srv.serve_forever()


if __name__ == "__main__":
    main()
