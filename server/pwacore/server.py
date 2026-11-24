"""Sync server: stores events and hands them back. Python stdlib only.

It never looks inside events beyond a few envelope checks and never computes
state; all app logic lives in the browser. It also serves the static app.

    python3 server/server.py              # http://127.0.0.1:8765

This file is the core. Apps get a copy in server/pwacore/ (never edit it
there); the app's own server/server.py names its database and version and
calls main().
    tailscale serve --bg 8765             # HTTPS on your tailnet

API
    GET  /api/health
    POST /api/events        {"events": [...]}  -> {"received": n, "inserted": n, "rejected": [{"index", "id", "reason"}]}
    GET  /api/events?after=<cursor>&limit=<n>  -> {"events": [...], "next": cursor, "more": bool,
                                                    "server_id": id, "head": highest cursor}

Events are deduplicated by id; the first copy of an id is kept. A push stores
every acceptable event and lists the rest in "rejected" (retrying won't help
them), so one bad event can't block a device's sync.

Restoring the database from a backup: stop the server, copy the backup in,
delete any <db>-wal / -shm files next to it, and start once with
--new-server-id so every device pushes its events again (the backup is
missing whatever came after it). See docs/data-and-recovery.md.

There is no login: whoever can reach the port can read and write everything.
Keep it on 127.0.0.1 and reach it only through your own tailnet. Requests must
name a loopback host or this machine's Tailscale name, asked of the tailscale
CLI at startup (blocks DNS rebinding from a web page), and POSTs from another
origin are refused.
"""

import argparse
import json
import sqlite3
import subprocess
import sys
import threading
import traceback
import uuid
from decimal import Decimal
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

VERSION = "0.1.3"  # core version; matches app/core/version.js (a test checks)
ROOT = Path(__file__).resolve().parent.parent.parent  # the app: <root>/server/pwacore/server.py
DEFAULT_DB_NAME = "events.db"
DEFAULT_STATIC = ROOT / "app"

MAX_BATCH = 1000
MAX_EVENT_BYTES = 64 * 1024  # matches app/core/events.js
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_ID_LEN = 100
MAX_TS = 2**53 - 1  # largest integer JavaScript represents exactly
MAX_DEPTH = 32  # objects and arrays deep, the event itself is 1; matches app/core/events.js
MAX_CURSOR = 2**63 - 1  # SQLite INTEGER range
DEFAULT_PAGE = 500
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    ),
}


class DatabaseProblem(Exception):
    """The database file is damaged or isn't a database."""


class WrongApp(Exception):
    """The database belongs to another app."""


class EventStore:
    """Append-only event table. `seq` is a local cursor for paging; `id` is the event's own id."""

    def __init__(self, path, app_id=None):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        try:
            # Check before anything writes to it. quick_check skips index
            # contents but reads every page; fast at this size.
            problems = [row[0] for row in self._db.execute("PRAGMA quick_check")]
            if problems != ["ok"]:
                raise DatabaseProblem("; ".join(problems[:5]))
            self._db.execute("PRAGMA journal_mode=WAL")
        except sqlite3.DatabaseError as err:
            self._db.close()
            raise DatabaseProblem(str(err)) from err
        except DatabaseProblem:
            self._db.close()
            raise
        self._db.execute(
            """CREATE TABLE IF NOT EXISTS events (
                   seq  INTEGER PRIMARY KEY AUTOINCREMENT,
                   id   TEXT NOT NULL UNIQUE,
                   body TEXT NOT NULL,
                   received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
               )"""
        )
        self._db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        self._db.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('server_id', ?)", (str(uuid.uuid4()),))
        self._db.commit()
        # Identifies this database. If it changes (restored or recreated), clients
        # restart their pull cursor and push everything they have again.
        self.server_id = self._db.execute("SELECT value FROM meta WHERE key = 'server_id'").fetchone()[0]
        # Which app this database is for. A database from before app ids takes
        # the first one it is opened with.
        if app_id is not None:
            self._db.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('app_id', ?)", (app_id,))
            self._db.commit()
        row = self._db.execute("SELECT value FROM meta WHERE key = 'app_id'").fetchone()
        self.app_id = row[0] if row else None
        if app_id is not None and self.app_id != app_id:
            self._db.close()
            raise WrongApp(f"{path} holds the events of app '{self.app_id}', not '{app_id}'")

    def insert(self, events):
        with self._lock, self._db:
            before = self._db.total_changes
            self._db.executemany(
                "INSERT OR IGNORE INTO events (id, body) VALUES (?, ?)",
                [(e["id"], to_json(e)) for e in events],
            )
            return self._db.total_changes - before

    def new_server_id(self):
        with self._lock, self._db:
            self.server_id = str(uuid.uuid4())
            self._db.execute("UPDATE meta SET value = ? WHERE key = 'server_id'", (self.server_id,))

    def read_after(self, after, limit):
        with self._lock:
            rows = self._db.execute(
                "SELECT seq, body FROM events WHERE seq > ? ORDER BY seq LIMIT ?", (after, limit + 1)
            ).fetchall()
            head = self._db.execute("SELECT COALESCE(MAX(seq), 0) FROM events").fetchone()[0]
        more = len(rows) > limit
        rows = rows[:limit]
        return {
            "events": [json.loads(body) for _, body in rows],
            "next": rows[-1][0] if rows else after,
            "more": more,
            "server_id": self.server_id,
            "app_id": self.app_id,
            # A client whose cursor is past head is talking to an older copy
            # of this database (restored from backup) and starts over.
            "head": head,
        }

    def close(self):
        with self._lock:
            self._db.close()


def to_json(obj):
    # allow_nan=False: NaN/Infinity aren't JSON and browsers can't parse them.
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _refuse_constant(name):
    raise ValueError(f"{name} is not valid JSON")


def parse_json(raw):
    """json.loads that refuses NaN/Infinity. Raises ValueError on anything bad."""
    try:
        return json.loads(raw, parse_constant=_refuse_constant)
    except (UnicodeDecodeError, RecursionError) as err:
        raise ValueError(str(err)) from err


def tailnet_name(run=subprocess.run):
    """This machine's Tailscale name (for `tailscale serve`), or None if Tailscale can't say."""
    try:
        out = run(["tailscale", "status", "--json"], capture_output=True, text=True, timeout=3, check=True).stdout
        name = json.loads(out)["Self"]["DNSName"]
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        return None
    name = name.strip().rstrip(".").lower() if isinstance(name, str) else ""
    return name or None


def host_allowed(host, extra=()):
    """Loopback names, or hosts the server was told about (its Tailscale name, --allow-host)."""
    name = (host or "").strip().lower()
    if not name:
        return False
    if name.startswith("["):  # [::1]:8765
        name = name[: name.find("]") + 1]
    else:
        name = name.rsplit(":", 1)[0]
    return name in LOOPBACK_HOSTS or name in extra


def check_batch(body):
    """Return None if the push body has the right shape, else a short reason."""
    if not isinstance(body, dict) or not isinstance(body.get("events"), list):
        return 'body must be {"events": [...]}'
    if len(body["events"]) > MAX_BATCH:
        return f"at most {MAX_BATCH} events per push"
    return None


def _walk(root):
    """(too_deep, extra): too_deep if root nests more than MAX_DEPTH objects and
    arrays deep; extra is how many more bytes JavaScript's JSON.stringify writes
    for its numbers than json.dumps does. A loop, not recursion, so any depth
    gets an answer."""
    todo = [(root, 1)]
    extra = 0
    while todo:
        v, depth = todo.pop()
        if isinstance(v, (dict, list)):
            if depth > MAX_DEPTH:
                return True, extra
            todo.extend((x, depth + 1) for x in (v.values() if isinstance(v, dict) else v))
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            extra += len(js_number(v)) - len(repr(v) if isinstance(v, float) else str(v))
    return False, extra


def js_number(x):
    """How JSON.stringify writes this number once a browser has parsed it
    (ECMAScript Number::toString), so the server measures an event's size as
    the client does."""
    if isinstance(x, int):
        if -MAX_TS <= x <= MAX_TS:
            return str(x)
        try:
            x = float(x)
        except OverflowError:
            return "null"  # past the largest double: JS reads Infinity
    if x != x or x in (float("inf"), float("-inf")):
        return "null"
    if x == 0:
        return "0"  # -0 too
    sign = "-" if x < 0 else ""
    # repr gives the shortest digits that read back as x, as JS does.
    t = Decimal(repr(abs(x))).as_tuple()
    digits = "".join(map(str, t.digits))
    stripped = digits.rstrip("0")
    exp = t.exponent + len(digits) - len(stripped)
    digits = stripped
    k, n = len(digits), len(digits) + exp  # x = 0.digits * 10^n
    if k <= n <= 21:
        out = digits + "0" * (n - k)
    elif 0 < n <= 21:
        out = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        out = "0." + "0" * -n + digits
    else:
        e = n - 1
        out = digits[0] + ("." + digits[1:] if k > 1 else "") + "e" + ("+" if e >= 0 else "-") + str(abs(e))
    return sign + out


def is_id(v):
    """A non-empty string of at most MAX_ID_LEN UTF-16 units: JavaScript's
    length, which is what the client counts (an emoji is 2)."""
    return isinstance(v, str) and 0 < len(v.encode("utf-16-le", "surrogatepass")) // 2 <= MAX_ID_LEN


def is_js_int(v, low):
    """An integer from low to 2^53-1 (JS Number.isSafeInteger). A float like
    5.0 is refused: JSON.stringify never writes one, only another writer can."""
    return type(v) is int and low <= v <= MAX_TS


def check_event(e):
    """Return None if the event can be stored, else a short reason. The same
    rules as the client's validateEnvelope (app/core/events.js), so every event
    stored here is one every device keeps; test/pwacore/envelope-cases.json
    holds the cases both sides must judge alike."""
    if not isinstance(e, dict):
        return "not an object"
    if not is_id(e.get("id")):
        return "bad id"
    if not is_js_int(e.get("v"), 1):
        return "v must be an integer from 1 to 2^53-1"
    if not isinstance(e.get("type"), str) or not e["type"]:
        return "bad type"
    if "scope_id" in e and not is_id(e["scope_id"]):
        return "bad scope_id"
    if not is_js_int(e.get("ts"), 0):
        return "ts must be an integer from 0 to 2^53-1"
    if not is_id(e.get("device_id")):
        return "bad device_id"
    if not isinstance(e.get("data"), dict):
        return "data must be an object"
    # Clients skip deeper events (app/core/events.js MAX_DEPTH), so storing
    # one would only waste it; and json.dumps below recurses.
    deep, extra = _walk(e)
    if deep:
        return "nested too deep"
    try:
        size = len(to_json(e).encode()) + extra
    except ValueError:
        return "NaN and Infinity aren't allowed"
    except UnicodeEncodeError:
        return "invalid text (lone surrogate)"
    if size > MAX_EVENT_BYTES:
        return "too large"
    return None


class Handler(SimpleHTTPRequestHandler):
    server_version = "pwa-core"
    sys_version = ""
    timeout = 30  # seconds a connection may sit idle (slow clients can't hog threads)
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, store, allowed_hosts=(), quiet=False, app_version=VERSION, **kwargs):
        self.store = store
        self.app_version = app_version
        self.allowed_hosts = allowed_hosts
        self.quiet = quiet
        super().__init__(*args, **kwargs)

    def log_message(self, format, *args):
        if not self.quiet:
            super().log_message(format, *args)

    def list_directory(self, path):
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def translate_path(self, path):
        # Refuse anything that resolves outside the app folder (e.g. a
        # symlink), and dotfiles (.DS_Store, editor swap files, .git).
        full = Path(super().translate_path(path))
        root = Path(self.directory).resolve()
        hidden = any(part.startswith(".") for part in full.relative_to(self.directory).parts)
        if hidden or (full.exists() and not full.resolve().is_relative_to(root)):
            return str(root / "__not_found__")
        return str(full)

    def refuse_foreign(self):
        """Send an error and return True if the request's Host/Origin isn't ours."""
        if not host_allowed(self.headers.get("Host"), self.allowed_hosts):
            self.send_json(HTTPStatus.MISDIRECTED_REQUEST, {"error": "unknown host"})
            return True
        origin = self.headers.get("Origin")
        if (
            self.command == "POST"
            and origin
            and urlsplit(origin).netloc.lower() != self.headers["Host"].strip().lower()
        ):
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "cross-origin request"})
            return True
        return False

    def end_headers(self):
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, v)
        # No self.path yet when the request line itself was unreadable.
        if not getattr(self, "path", "").startswith("/api/"):
            # Revalidate every time; the service worker does the offline caching.
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, status, obj):
        data = to_json(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def handle_one_request(self):
        # Any unexpected error becomes a 500 reply instead of a dropped
        # connection; the server keeps running either way.
        try:
            super().handle_one_request()
        except Exception:
            self.log_error("unhandled error:\n%s", traceback.format_exc())
            if not getattr(self, "_headers_buffer", None) and not self.wfile.closed:
                try:
                    self.send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "server error"})
                except OSError:
                    pass
            self.close_connection = True

    def refuse_other_app(self, query):
        """A client names its app (?app=<id>); one of another app is refused, so
        its events can't mix into this app's for good. Older clients don't name it."""
        claimed = parse_qs(query).get("app", [None])[0]
        if claimed is None or self.store.app_id is None or claimed == self.store.app_id:
            return False
        self.send_json(
            HTTPStatus.CONFLICT,
            {"error": f"this server is for app '{self.store.app_id}', not '{claimed}'", "app_id": self.store.app_id},
        )
        return True

    def do_GET(self):
        if self.refuse_foreign():
            return
        url = urlsplit(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        if url.path == "/api/health":
            return self.send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "version": self.app_version,
                    "core_version": VERSION,
                    "server_id": self.store.server_id,
                    "app_id": self.store.app_id,
                },
            )
        if url.path == "/api/events":
            if self.refuse_other_app(url.query):
                return
            q = parse_qs(url.query)
            try:
                after = min(max(int(q.get("after", ["0"])[0]), 0), MAX_CURSOR)
                limit = min(max(int(q.get("limit", [str(DEFAULT_PAGE)])[0]), 1), MAX_BATCH)
            except ValueError:
                return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "after and limit must be integers"})
            return self.send_json(HTTPStatus.OK, self.store.read_after(after, limit))
        return self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_HEAD(self):
        if self.refuse_foreign():
            return
        return super().do_HEAD()

    def do_POST(self):
        if self.refuse_foreign():
            return
        url = urlsplit(self.path)
        if url.path != "/api/events":
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        header = self.headers.get("Content-Length")
        if header is None:
            self.close_connection = True
            return self.send_json(HTTPStatus.LENGTH_REQUIRED, {"error": "Content-Length required"})
        if not (header.strip().isascii() and header.strip().isdigit()):
            self.close_connection = True
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "bad Content-Length"})
        length = int(header)
        if length > MAX_BODY_BYTES:
            # Drain a bounded amount so the client sees the 413, not a reset.
            remaining = min(length, 8 * MAX_BODY_BYTES)
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    break
                remaining -= len(chunk)
            self.close_connection = True
            return self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "body too large"})
        raw = self.rfile.read(length)
        if self.refuse_other_app(url.query):
            return
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            return self.send_json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "use application/json"})
        try:
            body = parse_json(raw)
        except ValueError:
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
        problem = check_batch(body)
        if problem:
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": problem})
        good, rejected = [], []
        for i, e in enumerate(body["events"]):
            reason = check_event(e)
            if reason is None:
                good.append(e)
            else:
                event_id = e.get("id") if isinstance(e, dict) else None
                if not isinstance(event_id, str) or check_event(
                    {"id": event_id, "v": 1, "type": "x", "ts": 0, "device_id": "x", "data": {}}
                ):
                    event_id = None  # not echoed back if it isn't a sound id (it might not even encode)
                rejected.append({"index": i, "id": event_id, "reason": reason})
        inserted = self.store.insert(good)
        return self.send_json(
            HTTPStatus.OK, {"received": len(body["events"]), "inserted": inserted, "rejected": rejected}
        )


def make_server(host, port, db_path, static_dir, allowed_hosts=(), quiet=False, app_version=VERSION, app_id=None):
    store = EventStore(db_path, app_id=app_id)
    extra = frozenset(h.strip().lower() for h in allowed_hosts)
    handler = partial(
        Handler, store=store, allowed_hosts=extra, quiet=quiet, app_version=app_version, directory=str(static_dir)
    )
    httpd = ThreadingHTTPServer((host, port), handler)
    httpd.store = store
    return httpd


def parse_args(argv=None, *, db_name=DEFAULT_DB_NAME, description="Local-first app sync server"):
    p = argparse.ArgumentParser(description=description)
    p.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--db", type=Path, default=ROOT / "data" / db_name, help=f"SQLite file (default data/{db_name})")
    p.add_argument(
        "--allow-host",
        action="append",
        default=[],
        metavar="NAME",
        help="extra hostname to accept besides loopback and this machine's Tailscale name (repeatable)",
    )
    p.add_argument(
        "--new-server-id",
        action="store_true",
        help="after restoring the database from a backup: make every device push its events again",
    )
    return p.parse_args(argv)


# db_name, app_version and app_id come from the app's server/server.py.
def main(
    argv=None, *, db_name=DEFAULT_DB_NAME, app_version=VERSION, app_id=None, description="Local-first app sync server"
):
    args = parse_args(argv, db_name=db_name, description=description)
    try:
        tailnet = tailnet_name()
        httpd = make_server(
            args.host,
            args.port,
            args.db,
            DEFAULT_STATIC,
            args.allow_host + ([tailnet] if tailnet else []),
            app_version=app_version,
            app_id=app_id,
        )
    except WrongApp as err:
        sys.exit(f"{err}. Give each app its own database (--db) and port.")
    except DatabaseProblem as err:
        sys.exit(
            f"{args.db} is damaged ({err}).\n"
            "Nothing was changed. Move it aside and start again: devices refill a new database,\n"
            "or restore a backup. See docs/data-and-recovery.md."
        )
    if args.new_server_id:
        httpd.store.new_server_id()
        print("New server id: devices will push their events again on next sync.", file=sys.stderr)
    print(f"Serving on http://{args.host}:{httpd.server_address[1]}  (db: {args.db})", file=sys.stderr)
    if tailnet:
        print(
            f"Phone access over Tailscale: tailscale serve --bg {httpd.server_address[1]}, then https://{tailnet}",
            file=sys.stderr,
        )
    else:
        print(
            "Tailscale name not found, so only this computer can use the app. Start Tailscale and restart,"
            " or pass --allow-host <machine>.<tailnet>.ts.net",
            file=sys.stderr,
        )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        httpd.store.close()
