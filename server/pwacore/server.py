"""Sync server: stores events and hands them back. Python stdlib only.

It never looks inside events beyond a few envelope checks and never computes
state; all app logic lives in the browser. It also serves the static app.

    python3 server/server.py              # http://127.0.0.1:<PORT> (the app's PORT, default 8765)

This file is the core. Apps get a copy in server/pwacore/ (never edit it
there); the app's own server/server.py names its database and version and
calls main().
    tailscale serve --bg --https=<PORT> <PORT>   # HTTPS on your tailnet, same port number

API
    GET  /api/health
    POST /api/events        {"events": [...]}  -> {"received": n, "inserted": n, "rejected": [{"index", "id", "reason"}]}
    GET  /api/events?after=<cursor>&limit=<n>  -> {"events": [...], "next": cursor, "more": bool,
                                                    "server_id": id, "head": highest cursor,
                                                    "after_id": id of the event at the cursor}

An app adds its own routes under /api/app/ and CSP sources: main(routes=, csp=),
see make_server and README "App routes and CSP".

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
import queue
import re
import sqlite3
import subprocess
import sys
import threading
import traceback
import uuid
from dataclasses import dataclass
from decimal import Decimal
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, NamedTuple
from urllib.parse import parse_qs, urlsplit

VERSION = "0.1.5"  # core version; matches app/core/version.js (a test checks)
ROOT = Path(__file__).resolve().parent.parent.parent  # the app: <root>/server/pwacore/server.py
DEFAULT_DB_NAME = "events.db"
DEFAULT_PORT = 8765  # an app's launcher passes its own PORT; one without that line runs here
DEFAULT_STATIC = ROOT / "app"

MAX_BATCH = 1000
MAX_EVENT_BYTES = 64 * 1024  # matches app/core/events.js
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_ID_LEN = 100
MAX_TS = 2**53 - 1  # largest integer JavaScript represents exactly
MAX_DEPTH = 32  # objects and arrays deep, the event itself is 1; matches app/core/events.js
MAX_CURSOR = 2**63 - 1  # SQLite INTEGER range
DEFAULT_PAGE = 500
MAX_CONNECTIONS = 64  # open at once; each holds a thread (a browser opens about 6)
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}

# The base CSP, in order. An app may add sources to the fetch directives in
# CSP_EXTENDABLE (one it doesn't have yet starts from 'self'); the rest are locked.
BASE_CSP = (
    ("default-src", ("'self'",)),
    ("img-src", ("'self'", "data:", "blob:")),
    ("object-src", ("'none'",)),
    ("base-uri", ("'none'",)),
    ("form-action", ("'none'",)),
    ("frame-ancestors", ("'none'",)),
)
# No script-src (a script from elsewhere can do anything the app can) and no
# worker-src (workers must be same-origin anyway). Loosen only with a reason.
CSP_EXTENDABLE = ("img-src", "connect-src", "font-src", "media-src", "style-src", "frame-src")
# An https origin, optionally with a leading *. and a port: nothing that could
# end the directive (; or a space) or widen it (a keyword, a bare scheme, *).
CSP_SOURCE_RE = re.compile(
    r"https://(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?"
)


class BadHooks(ValueError):
    """The app's routes or CSP extras break a rule. Raised at startup."""


def build_csp(extra=None):
    """The Content-Security-Policy header: the base, plus the app's extra sources."""
    extra = {} if extra is None else extra
    if not isinstance(extra, dict):
        raise BadHooks("csp must be a dict of directive -> list of sources")
    for directive, sources in extra.items():
        if directive not in CSP_EXTENDABLE:
            raise BadHooks(f"csp: {directive!r} can't be changed (allowed: {', '.join(CSP_EXTENDABLE)})")
        if not isinstance(sources, (list, tuple)) or not sources:
            raise BadHooks(f"csp: {directive} needs a non-empty list of sources")
        for src in sources:
            if not isinstance(src, str) or not CSP_SOURCE_RE.fullmatch(src):
                raise BadHooks(f"csp: {src!r} in {directive} is not an https origin such as https://img.example")
    policy = [(d, list(srcs)) for d, srcs in BASE_CSP]
    for directive in CSP_EXTENDABLE:
        if directive not in extra:
            continue
        found = next((srcs for d, srcs in policy if d == directive), None)
        if found is None:
            found = ["'self'"]
            policy.insert(len(policy) - 4, (directive, found))  # before the locked object-src ... frame-ancestors
        for src in extra[directive]:
            if src not in found:
                found.append(src)
    return "; ".join(f"{d} {' '.join(srcs)}" for d, srcs in policy)


SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": build_csp(),  # each server sends its own (the app's extras added)
}

CORE_PATHS = frozenset({"/api/events", "/api/health"})
NO_BODY = frozenset({204, 205, 304})  # statuses that can't carry the JSON body every reply has
APP_ROUTE_METHODS = ("GET", "POST")
APP_PATH_RE = re.compile(r"/api/app(/[a-z0-9][a-z0-9_-]*)+")


class Route(NamedTuple):
    """An app route: method "GET" or "POST", an exact path under /api/app/, and
    fn(request) -> (status, JSON-able object)."""

    method: str
    path: str
    fn: Callable[["AppRequest"], Any]


@dataclass(frozen=True)
class AppContext:
    """What the app's routes factory gets, once at startup."""

    data_dir: Path  # the event database's folder: keep the app's own SQLite file here
    app_id: Any  # str, or None for an app that doesn't name one


@dataclass(frozen=True)
class AppRequest:
    """What an app route's fn gets."""

    method: str
    path: str
    query: dict  # name -> list of values, as parse_qs gives
    body: Any  # the parsed JSON for a POST; None for a GET


def build_routes(routes, ctx):
    """Call the app's factory and check what it returns: {path: {method: fn}}."""
    if routes is None:
        return {}
    if not callable(routes):
        raise BadHooks("routes must be a function routes(ctx) -> list of Route, called once at startup")
    made = routes(ctx)
    if not isinstance(made, list):
        raise BadHooks("routes(ctx) must return a list of Route")
    table = {}
    for r in made:
        if not isinstance(r, Route):
            raise BadHooks(f"routes: {r!r} is not a Route(method, path, fn)")
        if r.method not in APP_ROUTE_METHODS:
            raise BadHooks(f"routes: {r.method!r} on {r.path}: only GET and POST")
        if not isinstance(r.path, str) or r.path in CORE_PATHS or not APP_PATH_RE.fullmatch(r.path):
            raise BadHooks(
                f"routes: {r.path!r} must be an exact path under /api/app/ (lower case letters, digits, - and _)"
            )
        if not callable(r.fn):
            raise BadHooks(f"routes: {r.method} {r.path} needs a function")
        methods = table.setdefault(r.path, {})
        if r.method in methods:
            raise BadHooks(f"routes: {r.method} {r.path} is listed twice")
        methods[r.method] = r.fn
    return table


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
            at = self._db.execute("SELECT id FROM events WHERE seq = ?", (after,)).fetchone()
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
            # The id of the event at the cursor. A device that remembers another
            # id there is talking to an older copy restored without
            # --new-server-id whose cursor numbers now name other events.
            "after_id": at[0] if at else None,
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


REPLIED = object()  # read_json_body already sent the reply (an error)


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

    def __init__(
        self,
        *args,
        store,
        allowed_hosts=(),
        quiet=False,
        app_version=VERSION,
        app_routes=None,
        csp=SECURITY_HEADERS["Content-Security-Policy"],
        **kwargs,
    ):
        self.store = store
        self.app_version = app_version
        self.allowed_hosts = allowed_hosts
        self.quiet = quiet
        self.app_routes = app_routes or {}
        self.csp = csp
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
            if self.command == "POST":
                self.close_connection = True  # the body is unread
            self.send_json(HTTPStatus.MISDIRECTED_REQUEST, {"error": "unknown host"})
            return True
        origin = self.headers.get("Origin")
        if (
            self.command == "POST"
            and origin
            and urlsplit(origin).netloc.lower() != self.headers["Host"].strip().lower()
        ):
            self.close_connection = True  # the body is unread
            self.send_json(HTTPStatus.FORBIDDEN, {"error": "cross-origin request"})
            return True
        return False

    def refuse_cross_site(self):
        """App routes only: refuse a request a page on another site made. An
        <img> or link sends no Origin, and a GET route may have a cost (a paid
        lookup). Other apps on this machine are same-site, so refused too. A
        client with no fetch metadata (an iOS Shortcut, curl) is let through."""
        site = (self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if site in ("", "same-origin", "none"):
            return False
        self.close_connection = True  # a POST's body is unread
        self.send_json(HTTPStatus.FORBIDDEN, {"error": "cross-site request"})
        return True

    def serve_app_route(self, url):
        """Run an app route, or reply 404/405. Every core check comes first."""
        methods = self.app_routes.get(url.path)
        if methods is None:
            if self.command == "POST":
                self.close_connection = True  # the body is unread
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        fn = methods.get(self.command)
        if fn is None:
            if self.command == "POST":
                self.close_connection = True
            self._extra_headers = {"Allow": ", ".join(m for m in APP_ROUTE_METHODS if m in methods)}
            return self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method not allowed"})
        if self.refuse_cross_site():
            return None
        if self.command == "POST":
            body = self.read_json_body(url)  # also the ?app= check
            if body is REPLIED:
                return None
        else:
            if self.refuse_other_app(url.query):
                return None
            body = None
        req = AppRequest(self.command, url.path, parse_qs(url.query), body)
        result = fn(req)
        if not (isinstance(result, tuple) and len(result) == 2):
            raise TypeError(f"{self.command} {url.path} returned {type(result).__name__}, not (status, object)")
        status, obj = result
        if isinstance(status, bool) or not isinstance(status, int) or not 200 <= status <= 599 or status in NO_BODY:
            raise ValueError(f"{self.command} {url.path} returned status {status!r}")
        return self.send_json(status, obj)

    def end_headers(self):
        for k, v in SECURITY_HEADERS.items():
            self.send_header(k, self.csp if k == "Content-Security-Policy" else v)
        for k, v in getattr(self, "_extra_headers", {}).items():
            self.send_header(k, v)
        self._extra_headers = {}
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

    def read_json_body(self, url):
        """Read a POST's JSON body, or send the error and return REPLIED. The
        body is read before any refusal is sent, so the connection stays usable."""
        header = self.headers.get("Content-Length")
        if header is None:
            self.close_connection = True
            self.send_json(HTTPStatus.LENGTH_REQUIRED, {"error": "Content-Length required"})
            return REPLIED
        if not (header.strip().isascii() and header.strip().isdigit()):
            self.close_connection = True
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "bad Content-Length"})
            return REPLIED
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
            self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "body too large"})
            return REPLIED
        raw = self.rfile.read(length)
        if self.refuse_other_app(url.query):
            return REPLIED
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":
            self.send_json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "use application/json"})
            return REPLIED
        try:
            return parse_json(raw)
        except ValueError:
            self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
            return REPLIED

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
        if url.path.startswith("/api/app/"):
            return self.serve_app_route(url)
        return self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_HEAD(self):
        if self.refuse_foreign():
            return
        return super().do_HEAD()

    def do_POST(self):
        if self.refuse_foreign():
            return
        url = urlsplit(self.path)
        if url.path.startswith("/api/app/"):
            return self.serve_app_route(url)
        if url.path != "/api/events":
            self.close_connection = True  # the body is unread
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
        body = self.read_json_body(url)
        if body is REPLIED:
            return
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


BUSY_BODY = b'{"error":"server busy"}'
BUSY_REPLY = (
    b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json; charset=utf-8\r\n"
    b"Content-Length: %d\r\nRetry-After: 5\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n%s"
) % (len(BUSY_BODY), BUSY_BODY)


class CappedServer(ThreadingHTTPServer):
    """A thread per connection, up to max_connections at once. Past that a
    connection is handed to one helper thread that reads its request, replies
    503 and closes it, so idle or slow clients (each may sit for
    Handler.timeout) can't pile up threads without end. (Closing it unread
    would reset it, and the client would lose the reply.)"""

    BUSY_QUEUE = 16  # past this many waiting for their 503, a connection is just closed
    # The kernel's listen queue: connections that arrive faster than the accept
    # loop takes them wait here. Python's default is 5, and a page load through
    # tailscale serve opens one connection per module, so most were refused.
    # The cap above, not the kernel, should decide who waits. (macOS limits it to 128.)
    request_queue_size = 128

    def __init__(self, address, handler, max_connections=MAX_CONNECTIONS):
        self._slots = threading.BoundedSemaphore(max_connections)
        self._busy = queue.Queue(self.BUSY_QUEUE)
        super().__init__(address, handler)
        threading.Thread(target=self._reply_busy, daemon=True).start()

    def process_request(self, request, client_address):
        if not self._slots.acquire(blocking=False):
            try:
                self._busy.put_nowait(request)
            except queue.Full:
                self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()  # no thread started, so none will release it
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def _reply_busy(self):
        while (request := self._busy.get()) is not None:
            try:
                request.settimeout(1)
                head = b""
                while b"\r\n\r\n" not in head and len(head) < 16384 and (chunk := request.recv(4096)):
                    head += chunk
                request.sendall(BUSY_REPLY)
            except OSError:
                pass
            self.shutdown_request(request)

    def server_close(self):
        super().server_close()
        try:
            self._busy.put_nowait(None)
        except queue.Full:
            pass  # a daemon thread: it ends with the process


def make_server(
    host,
    port,
    db_path,
    static_dir,
    allowed_hosts=(),
    quiet=False,
    app_version=VERSION,
    app_id=None,
    max_connections=MAX_CONNECTIONS,
    routes=None,
    csp=None,
):
    """routes: the app's factory routes(ctx) -> [Route, ...], called once here
    with an AppContext. csp: {directive: [https origins]} added to the base CSP.
    Both are checked before anything opens: a mistake raises BadHooks."""
    policy = build_csp(csp)
    db_path = Path(db_path)
    # The store first: it makes data/ and refuses another app's database, so the
    # app's factory only ever runs beside this app's own.
    store = EventStore(db_path, app_id=app_id)
    try:
        app_routes = build_routes(routes, AppContext(data_dir=db_path.parent, app_id=app_id))
    except BaseException:
        store.close()
        raise
    extra = frozenset(h.strip().lower() for h in allowed_hosts)
    handler = partial(
        Handler,
        store=store,
        allowed_hosts=extra,
        quiet=quiet,
        app_version=app_version,
        app_routes=app_routes,
        csp=policy,
        directory=str(static_dir),
    )
    httpd = CappedServer((host, port), handler, max_connections=max_connections)
    httpd.store = store
    return httpd


def parse_args(argv=None, *, db_name=DEFAULT_DB_NAME, description="Local-first app sync server", port=DEFAULT_PORT):
    p = argparse.ArgumentParser(description=description)
    p.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=port, help=f"default {port}, the app's PORT")
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


def serve_hint(port, tailnet):
    """How to put the app on the tailnet. The HTTPS port uses the same number as
    the app's port, so each app is its own origin, with its own browser storage."""
    return (
        f"Phone access over Tailscale: tailscale serve --bg --https={port} {port}, then https://{tailnet}:{port}\n"
        "(An app already on the tailnet keeps the address it has: the phone's data belongs to that address.)"
    )


# db_name, app_version, app_id, port, routes and csp come from the app's
# server/server.py. See make_server for routes and csp.
def main(
    argv=None,
    *,
    db_name=DEFAULT_DB_NAME,
    app_version=VERSION,
    app_id=None,
    description="Local-first app sync server",
    port=DEFAULT_PORT,
    routes=None,
    csp=None,
):
    args = parse_args(argv, db_name=db_name, description=description, port=port)
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
            routes=routes,
            csp=csp,
        )
    except BadHooks as err:
        sys.exit(f"server/server.py: {err}")
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
        print(serve_hint(httpd.server_address[1], tailnet), file=sys.stderr)
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
