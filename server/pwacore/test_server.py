import concurrent.futures
import json
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from pwacore import server


def ev(i, **extra):
    e = {
        "id": f"id-{i:04d}",
        "v": 1,
        "type": "note.added",
        "scope_id": "s1",
        "ts": 1000 + i,
        "device_id": "dev",
        "data": {"text": "x"},
    }
    e.update(extra)
    return e


class EventStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = server.EventStore(Path(self.tmp.name) / "sub" / "events.db")

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_insert_and_read_back_unchanged(self):
        e = ev(1, data={"count": 1, "note": "unicode ok: café"})
        self.assertEqual(self.store.insert([e]), 1)
        page = self.store.read_after(0, 100)
        self.assertEqual(page["events"], [e])
        self.assertFalse(page["more"])

    def test_duplicate_ids_are_ignored(self):
        self.assertEqual(self.store.insert([ev(1), ev(2)]), 2)
        self.assertEqual(self.store.insert([ev(2), ev(3), ev(3)]), 1)
        self.assertEqual(len(self.store.read_after(0, 100)["events"]), 3)

    def test_first_copy_of_an_id_wins(self):
        self.store.insert([ev(1, ts=1)])
        self.store.insert([ev(1, ts=999)])
        self.assertEqual(self.store.read_after(0, 10)["events"][0]["ts"], 1)

    def test_read_after_pages_by_cursor(self):
        self.store.insert([ev(i) for i in range(5)])
        first = self.store.read_after(0, 2)
        self.assertEqual([e["id"] for e in first["events"]], ["id-0000", "id-0001"])
        self.assertTrue(first["more"])
        second = self.store.read_after(first["next"], 2)
        self.assertEqual([e["id"] for e in second["events"]], ["id-0002", "id-0003"])
        third = self.store.read_after(second["next"], 2)
        self.assertEqual([e["id"] for e in third["events"]], ["id-0004"])
        self.assertFalse(third["more"])
        empty = self.store.read_after(third["next"], 2)
        self.assertEqual(
            empty,
            {
                "events": [],
                "next": third["next"],
                "more": False,
                "server_id": self.store.server_id,
                "app_id": None,
                "head": third["next"],
                "after_id": "id-0004",
            },
        )

    def test_read_after_names_the_event_at_the_cursor(self):
        """So a device can tell this database from an older copy of it (a
        backup restored without --new-server-id) whose cursor numbers now
        belong to other events."""
        self.store.insert([ev(1), ev(2), ev(3)])
        self.assertIsNone(self.store.read_after(0, 10)["after_id"])
        self.assertEqual(self.store.read_after(2, 10)["after_id"], "id-0002")
        self.assertEqual(self.store.read_after(3, 10)["after_id"], "id-0003")
        self.assertIsNone(self.store.read_after(99, 10)["after_id"], "past head: nothing there")

    def test_persists_across_reopen(self):
        self.store.insert([ev(1)])
        server_id = self.store.server_id
        self.store.close()
        self.store = server.EventStore(Path(self.tmp.name) / "sub" / "events.db")
        self.assertEqual(len(self.store.read_after(0, 10)["events"]), 1)
        self.assertEqual(self.store.server_id, server_id)

    def test_new_server_id_after_restore(self):
        old = self.store.server_id
        self.store.new_server_id()
        self.assertNotEqual(self.store.server_id, old)
        self.store.close()
        self.store = server.EventStore(Path(self.tmp.name) / "sub" / "events.db")
        self.assertNotEqual(self.store.server_id, old)

    def test_new_database_gets_a_new_server_id(self):
        other = server.EventStore(Path(self.tmp.name) / "other.db")
        self.assertTrue(self.store.server_id)
        self.assertNotEqual(other.server_id, self.store.server_id)
        other.close()


class TailnetNameTest(unittest.TestCase):
    """The server asks Tailscale for this machine's name so the phone can reach it."""

    def fake_run(self, stdout="", error=None):
        def run(cmd, **kwargs):
            self.assertEqual(cmd[:3], ["tailscale", "status", "--json"])
            if error:
                raise error
            return subprocess.CompletedProcess(cmd, 0, stdout=stdout)

        return run

    def test_reads_this_machines_name(self):
        out = json.dumps({"Self": {"DNSName": "Laptop.tail1234.ts.net."}})
        self.assertEqual(server.tailnet_name(self.fake_run(out)), "laptop.tail1234.ts.net")

    def test_none_when_tailscale_is_missing_or_unhappy(self):
        cases = {
            "not installed": self.fake_run(error=FileNotFoundError()),
            "hangs": self.fake_run(error=subprocess.TimeoutExpired("tailscale", 3)),
            "fails": self.fake_run(error=subprocess.CalledProcessError(1, "tailscale")),
            "garbage": self.fake_run("not json"),
            "logged out": self.fake_run(json.dumps({"Self": {"DNSName": ""}})),
            "no self": self.fake_run(json.dumps({})),
        }
        for name, run in cases.items():
            with self.subTest(name):
                self.assertIsNone(server.tailnet_name(run))


class DamagedDatabaseTest(unittest.TestCase):
    """A damaged file must stop the server at startup, not surface later as sync errors."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "events.db"

    def test_not_a_database(self):
        self.path.write_bytes(b"this is not sqlite" * 200)
        with self.assertRaises(server.DatabaseProblem):
            server.EventStore(self.path)

    def test_damaged_pages(self):
        store = server.EventStore(self.path)
        store.insert([ev(i, data={"count": 1, "pad": "x" * 500}) for i in range(400)])
        store.close()
        raw = bytearray(self.path.read_bytes())
        page = 4096
        self.assertGreater(len(raw), 20 * page)
        for p in range(3, len(raw) // page, 2):  # scribble over every other page past the schema
            raw[p * page + 8 : p * page + 64] = b"\xff" * 56
        self.path.write_bytes(bytes(raw))
        with self.assertRaises(server.DatabaseProblem):
            server.EventStore(self.path)

    def test_main_explains_and_exits(self):
        self.path.write_bytes(b"this is not sqlite" * 200)
        with self.assertRaises(SystemExit) as cm:
            server.main(["--db", str(self.path), "--port", "0"])
        self.assertIn("data-and-recovery", str(cm.exception.code))


class AppSettingsTest(unittest.TestCase):
    """The core server is vendored into each app under server/pwacore/; the app's
    own server/server.py names its database and passes it in."""

    def test_app_root_is_two_folders_above_the_package(self):
        self.assertEqual(server.ROOT, Path(server.__file__).resolve().parent.parent.parent)

    def test_default_db_comes_from_the_app(self):
        args = server.parse_args([], db_name="mandalart.db")
        self.assertEqual(args.db, server.ROOT / "data" / "mandalart.db")
        self.assertEqual(server.parse_args([]).db, server.ROOT / "data" / "events.db")

    def test_health_reports_the_app_version_and_the_core_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            httpd = server.make_server("127.0.0.1", 0, Path(tmp) / "e.db", Path(tmp), quiet=True, app_version="9.9.9")
            t = threading.Thread(target=httpd.serve_forever, daemon=True)
            t.start()
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{httpd.server_address[1]}/api/health") as r:
                    body = json.loads(r.read())
            finally:
                httpd.shutdown()
                httpd.server_close()
                httpd.store.close()
        self.assertEqual(body["version"], "9.9.9")
        self.assertEqual(body["core_version"], server.VERSION)

    def test_port_comes_from_the_app_and_defaults_to_8765(self):
        self.assertEqual(server.parse_args([]).port, 8765)
        self.assertEqual(server.parse_args([], port=8766).port, 8766)
        self.assertEqual(server.parse_args(["--port", "9000"], port=8766).port, 9000)

    def test_main_takes_the_apps_port(self):
        seen = {}

        def fake_make_server(host, port, *args, **kwargs):
            seen["port"] = port
            raise server.WrongApp("stop here")

        real = server.make_server
        server.make_server = fake_make_server
        try:
            with self.assertRaises(SystemExit):
                server.main([], port=8766)
        finally:
            server.make_server = real
        self.assertEqual(seen["port"], 8766)

    def test_serve_hint_uses_the_same_number_for_the_tailnet_https_port(self):
        hint = server.serve_hint(8766, "m.t.ts.net")
        self.assertIn("tailscale serve --bg --https=8766 8766", hint)
        self.assertIn("https://m.t.ts.net:8766", hint)

    def test_the_launcher_runs_the_core(self):
        launcher = (Path(__file__).parent.parent / "server.py").read_text()  # the app's server/server.py
        self.assertIn("from pwacore.server import main", launcher)


class AppIdTest(unittest.TestCase):
    """Each app has its own server. The database remembers which app it is for,
    so a second app's client pointed at the wrong server can't mix its events
    in (union merge would keep them for good)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "e.db"

    def open(self, app_id=None):
        store = server.EventStore(self.path, app_id=app_id)
        self.addCleanup(store.close)
        return store

    def test_the_database_keeps_the_app_id_and_refuses_another_app(self):
        self.open("trips").close()
        self.assertEqual(self.open("trips").app_id, "trips")
        self.assertEqual(self.open().app_id, "trips", "opening without an id keeps the stored one")
        with self.assertRaises(server.WrongApp) as caught:
            self.open("notes")
        self.assertIn("trips", str(caught.exception))
        self.assertIn("notes", str(caught.exception))

    def test_a_database_from_before_app_ids_takes_the_app_id(self):
        self.open().close()
        self.assertIsNone(self.open().app_id)
        self.assertEqual(self.open("mandalart").app_id, "mandalart")

    def serve(self, app_id):
        httpd = server.make_server("127.0.0.1", 0, self.path, Path(self.tmp.name), quiet=True, app_id=app_id)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()

        def stop():
            httpd.shutdown()
            httpd.server_close()
            httpd.store.close()

        self.addCleanup(stop)
        base = f"http://127.0.0.1:{httpd.server_address[1]}"

        def request(method, path, body=None):
            data = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(base + path, data=data, method=method)
            if data is not None:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as err:
                return err.code, json.loads(err.read())

        return request

    def test_a_client_of_another_app_is_refused(self):
        request = self.serve("trips")
        status, body = request("POST", "/api/events?app=notes", {"events": [ev(1)]})
        self.assertEqual(status, 409)
        self.assertIn("trips", body["error"])
        status, body = request("GET", "/api/events?after=0&app=notes")
        self.assertEqual(status, 409)
        status, body = request("GET", "/api/events?after=0&app=trips")
        self.assertEqual((status, body["events"], body["app_id"]), (200, [], "trips"), "nothing got in")

    def test_the_right_app_and_older_clients_get_through(self):
        request = self.serve("trips")
        self.assertEqual(request("POST", "/api/events?app=trips", {"events": [ev(1)]})[1]["inserted"], 1)
        self.assertEqual(request("POST", "/api/events", {"events": [ev(2)]})[1]["inserted"], 1, "no app: older client")
        status, body = request("GET", "/api/events?after=0")
        self.assertEqual((status, len(body["events"])), (200, 2))
        self.assertEqual(request("GET", "/api/health")[1]["app_id"], "trips")


def case_event(base, c):
    """Builds a case of test/pwacore/envelope-cases.json, as events.test.js does."""
    if c.get("whole"):
        return c["event"]
    e = {**base, **c["event"]}
    for f in c.get("drop", []):
        del e[f]
    if c.get("nest"):
        x = {}
        for _ in range(c["nest"] - 2):
            x = {"n": x}
        e["data"] = x
    if c.get("pad"):
        e["pad"] = "x" * c["pad"]
    return e


class ValidationTest(unittest.TestCase):
    def test_judges_the_shared_cases_as_the_client_does(self):
        """An event the server stores must never be one a device skips, or that
        device loses it for good when its pull cursor moves past it."""
        path = Path(__file__).resolve().parent.parent.parent / "test" / "pwacore" / "envelope-cases.json"
        cases = json.loads(path.read_text(encoding="utf-8"))
        self.assertGreater(len(cases["cases"]), 40)
        for c in cases["cases"]:
            with self.subTest(case=c["name"]):
                expected = c.get("server_ok", c["ok"])
                self.assertEqual(server.check_event(case_event(cases["base"], c)) is None, expected)

    def test_js_number_writes_numbers_as_json_stringify_does(self):
        # Expected values from node: JSON.stringify(JSON.parse(text)).
        table = {
            "0": "0",
            "-0.0": "0",
            "5.0": "5",
            "0.1": "0.1",
            "1e-7": "1e-7",
            "0.000001": "0.000001",
            "1e16": "10000000000000000",
            "1e21": "1e+21",
            "99999999999999999999": "100000000000000000000",
            "9007199254740993": "9007199254740992",
            "1.7976931348623157e308": "1.7976931348623157e+308",
            "5e-324": "5e-324",
            "-2.5e-10": "-2.5e-10",
            "123456789.125": "123456789.125",
            "1e400": "null",
            "12345678901234567890123": "1.2345678901234568e+22",
        }
        for text, js in table.items():
            with self.subTest(text=text):
                value = json.loads(text) if text != "1e400" else 10**400
                self.assertEqual(server.js_number(value), js)

    def test_rejects_an_event_nested_too_deep(self):
        def nested(depth):
            inner = {}
            for i in range(2, depth):
                inner = [inner] if i < depth - 1 and i % 2 else {"x": inner}
            return dict(ev(1), data=inner)

        self.assertIsNone(server.check_event(nested(server.MAX_DEPTH)))
        self.assertEqual(server.check_event(nested(server.MAX_DEPTH + 1)), "nested too deep")
        self.assertEqual(server.check_event(nested(20000)), "nested too deep")

    def test_accepts_a_good_batch(self):
        self.assertIsNone(server.check_batch({"events": [ev(1), ev(2)]}))
        self.assertIsNone(server.check_event(ev(1)))

    def test_rejects_bad_batch_shapes(self):
        cases = [[], {"events": "nope"}, {"nope": []}, {"events": [ev(i) for i in range(server.MAX_BATCH + 1)]}]
        for body in cases:
            with self.subTest(body=str(body)[:60]):
                self.assertIsNotNone(server.check_batch(body))

    def test_rejects_bad_events(self):
        cases = [
            "str",
            ev(1, id=""),
            ev(1, id=5),
            ev(1, id="x" * 200),
            ev(1, type=""),
            ev(1, data={"blob": "x" * (server.MAX_EVENT_BYTES + 1)}),
            ev(1, ts="1"),
            ev(1, ts=1.5),
            ev(1, ts=-1),
            ev(1, ts=2**53),
            ev(1, ts=True),
            ev(1, data={"n": float("nan")}),
            ev(1, data={"n": float("inf")}),
            ev(1, data={"label": "\ud800"}),  # lone surrogate: JS can send it, UTF-8 can't store it
        ]
        for e in cases:
            with self.subTest(event=str(e)[:60]):
                self.assertIsNotNone(server.check_event(e))


class HttpTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        static = Path(cls.tmp.name) / "app"
        static.mkdir()
        cls.static = static
        (static / "index.html").write_text("<!doctype html><title>t</title>")
        (static / "sw.js").write_text("// sw")
        cls.httpd = server.make_server(
            "127.0.0.1", 0, Path(cls.tmp.name) / "e.db", static, allowed_hosts=["Laptop.tail1234.ts.net"], quiet=True
        )
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.httpd.store.close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, content_type="application/json", headers=None):
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None and content_type:
            req.add_header("Content-Type", content_type)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers), err.read()

    def test_health(self):
        status, _, body = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["ok"])

    def test_push_then_pull(self):
        status, _, body = self.request("POST", "/api/events", {"events": [ev(100), ev(101)]})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"received": 2, "inserted": 2, "rejected": []})
        status, _, body = self.request("POST", "/api/events", {"events": [ev(101)]})
        self.assertEqual(json.loads(body)["inserted"], 0)
        status, headers, body = self.request("GET", "/api/events?after=0&limit=1000")
        self.assertEqual(status, 200)
        self.assertIn("no-store", headers["Cache-Control"])
        ids = [e["id"] for e in json.loads(body)["events"]]
        self.assertIn("id-0100", ids)
        self.assertEqual(ids.count("id-0101"), 1)

    def test_post_requires_json_content_type(self):
        # A cross-site HTML form can only send simple content types, so this
        # blocks CSRF-style writes without any CORS setup.
        status, _, _ = self.request("POST", "/api/events", {"events": [ev(200)]}, content_type="text/plain")
        self.assertEqual(status, 415)

    def test_post_rejects_bad_json_and_bad_batches(self):
        status, _, _ = self.request("POST", "/api/events", b"{not json")
        self.assertEqual(status, 400)
        status, _, body = self.request("POST", "/api/events", {"events": "nope"})
        self.assertEqual(status, 400)
        self.assertIn("error", json.loads(body))

    def test_bad_events_are_rejected_one_by_one(self):
        # One bad event must not block the good ones (or the device's sync).
        body = (
            b'{"events": ['
            + json.dumps(ev(400)).encode()
            + b', {"id": "bad", "type": "x", "ts": "no"}, '
            + b'{"id": "sur", "type": "x", "ts": 1, "data": {"s": "\\ud800"}}]}'
        )
        status, _, reply = self.request("POST", "/api/events", body)
        self.assertEqual(status, 200)
        reply = json.loads(reply)
        self.assertEqual(reply["inserted"], 1)
        self.assertEqual([(r["index"], r["id"]) for r in reply["rejected"]], [(1, "bad"), (2, "sur")])

    def test_pull_reports_head(self):
        self.request("POST", "/api/events", {"events": [ev(500)]})
        _, _, body = self.request("GET", "/api/events?after=0&limit=1")
        page = json.loads(body)
        self.assertGreaterEqual(page["head"], page["next"])
        self.assertEqual(page["head"], self.httpd.store.read_after(0, 1000)["next"])

    def test_post_rejects_oversized_body(self):
        big = b'{"events": [], "pad": "' + b"x" * (server.MAX_BODY_BYTES + 10) + b'"}'
        status, _, _ = self.request("POST", "/api/events", big)
        self.assertEqual(status, 413)

    def test_bad_cursor(self):
        status, _, _ = self.request("GET", "/api/events?after=abc")
        self.assertEqual(status, 400)

    def test_unknown_api_path(self):
        status, _, _ = self.request("GET", "/api/nope")
        self.assertEqual(status, 404)

    def test_serves_static_app_with_security_headers(self):
        status, headers, body = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"<title>t</title>", body)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])

    def test_service_worker_is_never_cached(self):
        status, headers, _ = self.request("GET", "/sw.js")
        self.assertEqual(status, 200)
        self.assertIn("no-cache", headers["Cache-Control"])

    def test_no_path_traversal(self):
        status, _, body = self.request("GET", "/../e.db")
        self.assertNotEqual(body[:15], b"SQLite format 3")
        status, _, body = self.request("GET", "/%2e%2e/e.db")
        self.assertNotEqual(body[:15], b"SQLite format 3")

    def raw(self, request_bytes):
        """Send hand-written HTTP; return the status code (0 if the connection just closed)."""
        with socket.create_connection(("127.0.0.1", self.httpd.server_address[1]), timeout=5) as sock:
            sock.sendall(request_bytes)
            sock.shutdown(socket.SHUT_WR)
            reply = b""
            while chunk := sock.recv(65536):
                reply += chunk
        return int(reply.split(b" ", 2)[1]) if reply.startswith(b"HTTP/") else 0

    def test_nan_is_refused_so_it_can_never_break_pulls(self):
        # Browsers can't parse NaN in JSON; one stored NaN would block every
        # device's pull at that row forever.
        body = b'{"events": [{"id": "nan-1", "type": "x", "ts": NaN}]}'
        status, _, _ = self.request("POST", "/api/events", body)
        self.assertEqual(status, 400)
        _, _, page = self.request("GET", "/api/events?after=0&limit=1000")
        self.assertNotIn(b"NaN", page)

    def test_deeply_nested_json_is_a_400_not_a_crash(self):
        status, _, _ = self.request("POST", "/api/events", b"[" * 100000)
        self.assertEqual(status, 400)

    def test_huge_cursor_is_handled(self):
        status, _, body = self.request("GET", "/api/events?after=99999999999999999999")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["events"], [])
        status, _, _ = self.request("GET", "/api/events?after=-5")
        self.assertEqual(status, 200)

    def test_content_length_must_be_sane(self):
        head = "POST /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
        self.assertEqual(self.raw((head + "Content-Length: -1\r\n\r\n{}").encode()), 400)
        self.assertEqual(self.raw((head + "Content-Length: abc\r\n\r\n{}").encode()), 400)
        self.assertEqual(self.raw((head + "\r\n").encode()), 411)

    def test_rejects_foreign_host_header(self):
        # DNS rebinding: a hostile page whose name now points at 127.0.0.1.
        for host in ["evil.example", "evil.example:8765", "127.0.0.1.evil.example"]:
            with self.subTest(host=host):
                status, _, _ = self.request("GET", "/api/events?after=0", headers={"Host": host})
                self.assertEqual(status, 421)
                status, _, _ = self.request("POST", "/api/events", {"events": [ev(300)]}, headers={"Host": host})
                self.assertEqual(status, 421)

    def test_allows_loopback_and_this_machines_tailnet_name(self):
        port = self.httpd.server_address[1]
        for host in [f"127.0.0.1:{port}", f"localhost:{port}", "laptop.tail1234.ts.net", "LAPTOP.tail1234.ts.net:443"]:
            with self.subTest(host=host):
                status, _, _ = self.request("GET", "/api/health", headers={"Host": host})
                self.assertEqual(status, 200)

    def test_refuses_other_tailnet_names(self):
        # Any *.ts.net name used to pass; only this machine's name should.
        for host in ["other.tail1234.ts.net", "laptop.tail9999.ts.net", "evil.ts.net"]:
            with self.subTest(host=host):
                status, _, _ = self.request("GET", "/api/health", headers={"Host": host})
                self.assertEqual(status, 421)

    def test_post_from_another_origin_is_refused(self):
        status, _, _ = self.request(
            "POST", "/api/events", {"events": [ev(301)]}, headers={"Origin": "https://evil.example"}
        )
        self.assertEqual(status, 403)
        port = self.httpd.server_address[1]
        status, _, _ = self.request(
            "POST", "/api/events", {"events": [ev(302)]}, headers={"Origin": f"http://127.0.0.1:{port}"}
        )
        self.assertEqual(status, 200)

    def test_no_directory_listing_and_no_version_banner(self):
        (self.static / "sub").mkdir(exist_ok=True)
        status, _, _ = self.request("GET", "/sub/")
        self.assertEqual(status, 404)
        _, headers, _ = self.request("GET", "/")
        self.assertNotIn("Python", headers.get("Server", ""))

    def test_does_not_follow_symlinks_out_of_the_app_folder(self):
        secret = Path(self.tmp.name) / "secret.txt"
        secret.write_text("private")
        link = self.static / "leak.txt"
        link.symlink_to(secret)
        status, _, body = self.request("GET", "/leak.txt")
        self.assertEqual(status, 404)
        self.assertNotIn(b"private", body)

    def test_unexpected_errors_become_a_500_and_the_server_keeps_going(self):
        original = self.httpd.store.read_after
        self.httpd.store.read_after = lambda *a: 1 / 0
        try:
            status, _, body = self.request("GET", "/api/events?after=0")
        finally:
            self.httpd.store.read_after = original
        self.assertEqual(status, 500)
        self.assertEqual(json.loads(body), {"error": "server error"})
        status, _, _ = self.request("GET", "/api/health")
        self.assertEqual(status, 200)

    def test_a_rejected_event_with_an_unencodable_id_does_not_fail_the_push(self):
        body = json.dumps({"events": [ev(410), {"id": "\ud800", "ts": -1}]}).encode()
        status, _, reply = self.request("POST", "/api/events", body)
        self.assertEqual(status, 200)
        reply = json.loads(reply)
        self.assertEqual(reply["inserted"], 1)
        self.assertEqual(reply["rejected"][0]["id"], None)

    def test_malformed_requests_get_a_reply(self):
        self.assertEqual(self.raw(b"GET /" + b"a" * 70000 + b" HTTP/1.1\r\n\r\n"), 414)
        head = "POST /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n"
        self.assertEqual(self.raw((head + "Content-Length: \u00b2\r\n\r\n{}").encode()), 400)

    def test_head_checks_the_host_too(self):
        status, _, _ = self.request("HEAD", "/index.html", headers={"Host": "evil.example"})
        self.assertEqual(status, 421)
        status, _, _ = self.request("HEAD", "/index.html")
        self.assertEqual(status, 200)

    def test_dotfiles_are_not_served(self):
        (self.static / ".DS_Store").write_text("finder junk")
        (self.static / ".git").mkdir(exist_ok=True)
        (self.static / ".git" / "config").write_text("x")
        for path in ["/.DS_Store", "/.git/config", "/%2eDS_Store"]:
            with self.subTest(path=path):
                status, _, _ = self.request("GET", path)
                self.assertEqual(status, 404)

    def test_idle_connections_time_out(self):
        self.assertLessEqual(server.Handler.timeout, 60)


class ConnectionCapTest(unittest.TestCase):
    """Each connection holds a thread; past the cap a new one gets a 503 at once
    instead of another thread, so idle or slow clients can't pile threads up."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.httpd = server.make_server(
            "127.0.0.1", 0, Path(self.tmp.name) / "e.db", Path(self.tmp.name), quiet=True, max_connections=2
        )
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.socks = []

    def tearDown(self):
        for s in self.socks:
            s.close()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.httpd.store.close()
        self.tmp.cleanup()

    def idle(self):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.socks.append(s)
        return s

    def health(self):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        try:
            s.sendall(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
            out = b""
            while chunk := s.recv(65536):
                out += chunk
            return out
        finally:
            s.close()

    def test_past_the_cap_a_connection_gets_a_503_and_a_freed_slot_is_reused(self):
        self.assertEqual(server.MAX_CONNECTIONS, 64)
        self.assertTrue(self.health().startswith(b"HTTP/1.0 200") or self.health().startswith(b"HTTP/1.1 200"))
        first, _second = self.idle(), self.idle()
        time.sleep(0.2)  # both are being served (waiting for a request line)
        busy = self.health()
        self.assertTrue(busy.startswith(b"HTTP/1.1 503"), busy[:60])
        self.assertIn(b"server busy", busy)
        first.close()
        deadline = time.time() + 5
        while time.time() < deadline:
            if b" 200 " in self.health()[:20]:
                break
            time.sleep(0.05)
        else:
            self.fail("the freed slot was not reused")


class ListenQueueTest(unittest.TestCase):
    """A page load opens many connections at once (a proxy such as tailscale
    serve opens one per module). The kernel holds each in the listen queue
    until the accept loop takes it; past the queue it is dropped or refused,
    and the page never loads. Python's default queue is 5."""

    BURST = 40

    def test_the_queue_holds_every_connection_the_server_can_take(self):
        self.assertGreaterEqual(
            server.CappedServer.request_queue_size, server.MAX_CONNECTIONS + server.CappedServer.BUSY_QUEUE
        )

    def test_a_burst_waits_in_the_queue_and_every_request_is_served(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        httpd = server.make_server("127.0.0.1", 0, Path(tmp.name) / "e.db", Path(tmp.name), quiet=True)
        self.addCleanup(httpd.store.close)
        self.addCleanup(httpd.server_close)
        port = httpd.server_address[1]

        def connect(_):
            try:
                return socket.create_connection(("127.0.0.1", port), timeout=2)
            except OSError:
                return None

        # The accept loop has not started, so every connection must wait in the queue.
        with concurrent.futures.ThreadPoolExecutor(self.BURST) as pool:
            socks = list(pool.map(connect, range(self.BURST)))
        for s in socks:
            if s is not None:
                self.addCleanup(s.close)
        lost = sum(s is None for s in socks)
        self.assertEqual(lost, 0, f"{lost} of {self.BURST} connections did not fit in the listen queue")

        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        for s in socks:
            s.sendall(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        for s in socks:
            head = b""
            while b"\r\n" not in head and (chunk := s.recv(64)):
                head += chunk
            self.assertRegex(head, rb"^HTTP/1\.[01] 200 ")


BASE_CSP = (
    "default-src 'self'; img-src 'self' data: blob:; object-src 'none'; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)


class AppHooksValidationTest(unittest.TestCase):
    """An app passes its own routes (a factory called once at startup) and extra
    CSP sources. Anything off is refused at startup, not on the first request."""

    def make(self, routes=None, csp=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        httpd = server.make_server(
            "127.0.0.1", 0, Path(tmp.name) / "data" / "e.db", Path(tmp.name), quiet=True, routes=routes, csp=csp
        )
        self.addCleanup(httpd.store.close)
        self.addCleanup(httpd.server_close)
        return httpd

    def test_bad_routes_are_refused_at_startup(self):
        def fn(req):
            return 200, {}

        cases = {
            "PUT": [server.Route("PUT", "/api/app/x", fn)],
            "HEAD": [server.Route("HEAD", "/api/app/x", fn)],
            "outside /api/app/": [server.Route("GET", "/api/x", fn)],
            "core events": [server.Route("POST", "/api/events", fn)],
            "core health": [server.Route("GET", "/api/health", fn)],
            "static": [server.Route("GET", "/index.html", fn)],
            "bare prefix": [server.Route("GET", "/api/app/", fn)],
            "trailing slash": [server.Route("GET", "/api/app/x/", fn)],
            "query": [server.Route("GET", "/api/app/x?y=1", fn)],
            "percent": [server.Route("GET", "/api/app/%2e%2e", fn)],
            "dot dot": [server.Route("GET", "/api/app/../events", fn)],
            "upper case": [server.Route("GET", "/api/app/Inbox", fn)],
            "duplicate": [server.Route("GET", "/api/app/x", fn), server.Route("GET", "/api/app/x", fn)],
            "not callable": [server.Route("GET", "/api/app/x", "fn")],
            "not a route": [("GET", "/api/app/x", fn, "extra")],
            "not a list": server.Route("GET", "/api/app/x", fn),
        }
        for label, routes in cases.items():
            with self.subTest(label):
                with self.assertRaises(server.BadHooks):
                    self.make(routes=lambda ctx, r=routes: r)
        with self.assertRaises(server.BadHooks):
            self.make(routes=[server.Route("GET", "/api/app/x", fn)])  # a list, not a factory

    def test_get_and_post_on_one_path_and_nested_paths_are_fine(self):
        def fn(req):
            return 200, {}

        routes = [
            server.Route("GET", "/api/app/inbox", fn),
            server.Route("POST", "/api/app/inbox", fn),
            server.Route("GET", "/api/app/places/search", fn),
            server.Route("GET", "/api/app/a_b-2", fn),
        ]
        self.make(routes=lambda ctx: routes)

    def test_the_factory_gets_the_data_folder_and_app_id_once(self):
        seen = []

        def routes(ctx):
            seen.append(ctx)
            return []

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = Path(tmp.name) / "data" / "e.db"
        httpd = server.make_server("127.0.0.1", 0, db, Path(tmp.name), quiet=True, app_id="demo", routes=routes)
        self.addCleanup(httpd.store.close)
        self.addCleanup(httpd.server_close)
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0].data_dir, db.parent)
        self.assertEqual(seen[0].app_id, "demo")

    def test_the_factory_can_open_its_own_sqlite_file_in_a_fresh_data_folder(self):
        import sqlite3

        def routes(ctx):
            conn = sqlite3.connect(ctx.data_dir / "inbox.db", check_same_thread=False)
            self.addCleanup(conn.close)
            return []

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = Path(tmp.name) / "data" / "e.db"  # data/ doesn't exist yet, as in a new app
        httpd = server.make_server("127.0.0.1", 0, db, Path(tmp.name), quiet=True, routes=routes)
        self.addCleanup(httpd.store.close)
        self.addCleanup(httpd.server_close)
        self.assertTrue((db.parent / "inbox.db").exists())

    def test_the_factory_never_runs_against_another_apps_database(self):
        calls = []
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = Path(tmp.name) / "e.db"
        server.EventStore(db, app_id="first").close()
        with self.assertRaises(server.WrongApp):
            server.make_server("127.0.0.1", 0, db, Path(tmp.name), quiet=True, app_id="second", routes=calls.append)
        self.assertEqual(calls, [])

    def test_a_failing_factory_closes_the_store(self):
        def routes(ctx):
            raise RuntimeError("cannot open")

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        closed = []
        real = server.EventStore.close
        server.EventStore.close = lambda store: (closed.append(store), real(store))
        try:
            with self.assertRaises(RuntimeError):
                server.make_server("127.0.0.1", 0, Path(tmp.name) / "e.db", Path(tmp.name), quiet=True, routes=routes)
        finally:
            server.EventStore.close = real
        self.assertEqual(len(closed), 1)

    def test_bad_csp_extras_are_refused_at_startup(self):
        cases = {
            "script-src": {"script-src": ["https://x.example"]},
            "default-src": {"default-src": ["https://x.example"]},
            "worker-src": {"worker-src": ["https://x.example"]},
            "object-src": {"object-src": ["https://x.example"]},
            "frame-ancestors": {"frame-ancestors": ["https://x.example"]},
            "unknown": {"x-src": ["https://x.example"]},
            "semicolon": {"img-src": ["https://x.example; script-src *"]},
            "space": {"img-src": ["https://x.example https://y.example"]},
            "quote": {"img-src": ["'unsafe-inline'"]},
            "keyword": {"img-src": ["'self'"]},
            "star": {"img-src": ["*"]},
            "http": {"img-src": ["http://x.example"]},
            "scheme only": {"img-src": ["https:"]},
            "data": {"connect-src": ["data:"]},
            "path": {"img-src": ["https://x.example/path"]},
            "no dot": {"img-src": ["https://localhost"]},
            "star in the middle": {"img-src": ["https://a.*.example"]},
            "upper case": {"img-src": ["https://X.example"]},
            "a string, not a list": {"img-src": "https://x.example"},
            "empty list": {"img-src": []},
            "not a dict": [("img-src", ["https://x.example"])],
        }
        for label, csp in cases.items():
            with self.subTest(label):
                with self.assertRaises(server.BadHooks):
                    self.make(csp=csp)

    def test_csp_output(self):
        self.assertEqual(server.build_csp(None), BASE_CSP)
        self.assertEqual(server.build_csp({}), BASE_CSP)
        self.assertEqual(server.SECURITY_HEADERS["Content-Security-Policy"], BASE_CSP)
        csp = server.build_csp(
            {
                "img-src": ["https://*.maps.example", "https://photos.example:8443"],
                "connect-src": ["https://api.example", "https://api.example"],
            }
        )
        self.assertIn("img-src 'self' data: blob: https://*.maps.example https://photos.example:8443;", csp)
        self.assertIn("connect-src 'self' https://api.example;", csp)  # a new directive keeps 'self'; no repeats
        self.assertEqual(csp.count("connect-src"), 1)
        for locked in ["default-src 'self';", "object-src 'none';", "base-uri 'none';", "form-action 'none';"]:
            self.assertIn(locked, csp)
        self.assertTrue(csp.endswith("frame-ancestors 'none'"))


class AppRoutesHttpTest(unittest.TestCase):
    """App routes get every check core routes get, plus a cross-site guard (an
    <img> or link from another site sends no Origin, yet a GET route may have
    a cost, such as a paid API lookup)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        static = Path(cls.tmp.name) / "app"
        static.mkdir()
        (static / "index.html").write_text("<!doctype html><title>t</title>")
        cls.calls = []

        def echo(req):
            cls.calls.append(req)
            return 200, {"method": req.method, "path": req.path, "query": req.query, "body": req.body}

        def made(req):
            cls.calls.append(req)
            return 201, {"ok": True}

        def boom(req):
            cls.calls.append(req)
            raise RuntimeError("secret upstream detail key=abc123")

        def nan(req):
            cls.calls.append(req)
            return 200, {"n": float("nan")}

        def bad_status(req):
            cls.calls.append(req)
            return 99, {}

        def no_content(req):
            cls.calls.append(req)
            return 204, None  # a 204 can't carry the JSON body every reply has

        def not_a_tuple(req):
            cls.calls.append(req)
            return {"ok": True}

        def routes(ctx):
            return [
                server.Route("GET", "/api/app/echo", echo),
                server.Route("POST", "/api/app/echo", echo),
                server.Route("POST", "/api/app/made", made),
                server.Route("GET", "/api/app/boom", boom),
                server.Route("GET", "/api/app/nan", nan),
                server.Route("GET", "/api/app/bad-status", bad_status),
                server.Route("GET", "/api/app/no-content", no_content),
                server.Route("GET", "/api/app/not-a-tuple", not_a_tuple),
            ]

        cls.httpd = server.make_server(
            "127.0.0.1",
            0,
            Path(cls.tmp.name) / "e.db",
            static,
            allowed_hosts=["laptop.tail1234.ts.net"],
            quiet=True,
            app_id="demo",
            routes=routes,
            csp={"img-src": ["https://img.example"]},
        )
        cls.port = cls.httpd.server_address[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.httpd.store.close()
        cls.tmp.cleanup()

    def setUp(self):
        self.calls.clear()

    request = HttpTest.request

    def test_get_and_post_reach_the_app_with_the_query_and_the_parsed_body(self):
        status, headers, body = self.request("GET", "/api/app/echo?q=caf%C3%A9&q=2&app=demo")
        self.assertEqual(status, 200)
        self.assertEqual(
            json.loads(body),
            {"method": "GET", "path": "/api/app/echo", "query": {"q": ["café", "2"], "app": ["demo"]}, "body": None},
        )
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        self.assertIn("no-store", headers["Cache-Control"])
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Content-Security-Policy"], server.build_csp({"img-src": ["https://img.example"]}))
        status, _, body = self.request("POST", "/api/app/echo", {"text": "hi", "n": [1, 2]})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["body"], {"text": "hi", "n": [1, 2]})
        status, _, body = self.request("POST", "/api/app/made", {})
        self.assertEqual((status, json.loads(body)), (201, {"ok": True}))
        self.assertEqual(len(self.calls), 3)

    def test_the_request_fields_cant_be_reassigned(self):
        self.request("GET", "/api/app/echo")
        with self.assertRaises(AttributeError):
            self.calls[0].path = "/x"

    def test_the_apps_csp_is_on_every_reply_and_another_server_keeps_the_base(self):
        _, headers, _ = self.request("GET", "/")
        self.assertIn("img-src 'self' data: blob: https://img.example;", headers["Content-Security-Policy"])
        _, headers, _ = self.request("GET", "/api/health")
        self.assertIn("https://img.example", headers["Content-Security-Policy"])
        with tempfile.TemporaryDirectory() as tmp:
            other = server.make_server("127.0.0.1", 0, Path(tmp) / "e.db", Path(tmp), quiet=True)
            t = threading.Thread(target=other.serve_forever, daemon=True)
            t.start()
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{other.server_address[1]}/api/health") as r:
                    self.assertEqual(r.headers["Content-Security-Policy"], BASE_CSP)
            finally:
                other.shutdown()
                other.server_close()
                other.store.close()

    def test_every_refusal_stops_before_the_app(self):
        tailnet = f"laptop.tail1234.ts.net:{self.port}"
        cases = [
            ("foreign host", "GET", "/api/app/echo", None, {"Host": "evil.example"}, 421),
            ("other tailnet name", "GET", "/api/app/echo", None, {"Host": "other.tail1234.ts.net"}, 421),
            ("other app", "GET", "/api/app/echo?app=other", None, {}, 409),
            ("cross-site GET", "GET", "/api/app/echo", None, {"Sec-Fetch-Site": "cross-site"}, 403),
            (
                "same-site GET (another app on this machine)",
                "GET",
                "/api/app/echo",
                None,
                {"Sec-Fetch-Site": "same-site"},
                403,
            ),
            ("foreign host POST", "POST", "/api/app/echo", {}, {"Host": "evil.example"}, 421),
            ("cross-origin POST", "POST", "/api/app/echo", {}, {"Origin": "https://evil.example"}, 403),
            (
                "other port POST",
                "POST",
                "/api/app/echo",
                {},
                {"Host": tailnet, "Origin": "https://laptop.tail1234.ts.net:8765"},
                403,
            ),
            ("cross-site POST", "POST", "/api/app/echo", {}, {"Sec-Fetch-Site": "cross-site"}, 403),
            ("other app POST", "POST", "/api/app/echo?app=other", {}, {}, 409),
            ("wrong method", "POST", "/api/app/boom", {}, {}, 405),
            ("unknown app path", "GET", "/api/app/nope", None, {}, 404),
            ("unknown app path POST", "POST", "/api/app/nope", {}, {}, 404),
        ]
        for label, method, path, body, headers, want in cases:
            with self.subTest(label):
                status, _, _ = self.request(method, path, body, headers=headers)
                self.assertEqual(status, want)
                self.assertEqual(self.calls, [], "the app was not called")

    def test_post_body_rules_stop_before_the_app(self):
        status, _, _ = self.request("POST", "/api/app/echo", b'{"a":1}', content_type="text/plain")
        self.assertEqual(status, 415)
        status, _, _ = self.request("POST", "/api/app/echo", b"{not json")
        self.assertEqual(status, 400)
        status, _, _ = self.request("POST", "/api/app/echo", b"x" * (server.MAX_BODY_BYTES + 1))
        self.assertEqual(status, 413)
        for header in ["abc", "-1"]:
            with self.subTest(header):
                with socket.create_connection(("127.0.0.1", self.port)) as sock:
                    sock.sendall(
                        f"POST /api/app/echo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {header}\r\n\r\n".encode()
                    )
                    self.assertIn(b" 400 ", sock.recv(4096).split(b"\r\n")[0] + b" ")
        with socket.create_connection(("127.0.0.1", self.port)) as sock:
            sock.sendall(b"POST /api/app/echo HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n\r\n")
            self.assertIn(b" 411 ", sock.recv(4096).split(b"\r\n")[0] + b" ")
        self.assertEqual(self.calls, [])

    def test_a_request_without_fetch_metadata_or_from_this_origin_is_let_through(self):
        # An iOS Shortcut sends no Sec-Fetch-Site; the app's own pages send same-origin;
        # a typed address or bookmark sends none.
        for value in [None, "same-origin", "none"]:
            with self.subTest(value):
                headers = {} if value is None else {"Sec-Fetch-Site": value}
                status, _, _ = self.request("POST", "/api/app/echo", {"t": 1}, headers=headers)
                self.assertEqual(status, 200)
        port = self.port
        status, _, _ = self.request("POST", "/api/app/echo", {"t": 2}, headers={"Origin": f"http://127.0.0.1:{port}"})
        self.assertEqual(status, 200)
        self.assertEqual(len(self.calls), 4)

    def test_wrong_method_says_which_are_allowed(self):
        status, headers, _ = self.request("POST", "/api/app/boom", {})
        self.assertEqual(status, 405)
        self.assertEqual(headers["Allow"], "GET")
        status, headers, _ = self.request("PUT", "/api/app/echo", {})
        self.assertEqual(status, 501)  # http.server has no do_PUT
        self.assertEqual(self.calls, [])

    def test_head_never_runs_an_app_route(self):
        status, _, _ = self.request("HEAD", "/api/app/echo")
        self.assertEqual(status, 404)
        self.assertEqual(self.calls, [])

    def test_app_errors_become_a_plain_500_and_the_server_keeps_going(self):
        for path in [
            "/api/app/boom",
            "/api/app/nan",
            "/api/app/bad-status",
            "/api/app/no-content",
            "/api/app/not-a-tuple",
        ]:
            with self.subTest(path):
                status, _, body = self.request("GET", path)
                self.assertEqual(status, 500)
                self.assertEqual(json.loads(body), {"error": "server error"})
                self.assertNotIn(b"secret", body)
        status, _, _ = self.request("GET", "/api/health")
        self.assertEqual(status, 200)

    def test_core_routes_are_unchanged_beside_app_routes(self):
        status, _, body = self.request("POST", "/api/events", {"events": [ev(900)]})
        self.assertEqual((status, json.loads(body)["inserted"]), (200, 1))
        status, _, body = self.request("GET", "/api/events?after=0")
        self.assertEqual(status, 200)
        self.assertEqual([e["id"] for e in json.loads(body)["events"]], ["id-0900"])
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
