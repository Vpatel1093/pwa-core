import json
import socket
import subprocess
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from pwacore import server


def ev(i, **extra):
    e = {"id": f"id-{i:04d}", "v": 1, "type": "note.added", "scope_id": "s1", "ts": 1000 + i,
         "device_id": "dev", "data": {"text": "x"}}
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
        self.assertEqual(empty, {"events": [], "next": third["next"], "more": False,
                                 "server_id": self.store.server_id, "head": third["next"]})

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
            raw[p * page + 8:p * page + 64] = b"\xff" * 56
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

    def test_the_launcher_runs_the_core(self):
        launcher = (Path(__file__).parent / "server.py").read_text()
        self.assertIn("from pwacore.server import main", launcher)


class ValidationTest(unittest.TestCase):
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
        body = b'{"events": [' + json.dumps(ev(400)).encode() + b', {"id": "bad", "type": "x", "ts": "no"}, ' \
            + b'{"id": "sur", "type": "x", "ts": 1, "data": {"s": "\\ud800"}}]}'
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
        status, _, _ = self.request("POST", "/api/events", {"events": [ev(301)]}, headers={"Origin": "https://evil.example"})
        self.assertEqual(status, 403)
        port = self.httpd.server_address[1]
        status, _, _ = self.request("POST", "/api/events", {"events": [ev(302)]}, headers={"Origin": f"http://127.0.0.1:{port}"})
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


if __name__ == "__main__":
    unittest.main()
