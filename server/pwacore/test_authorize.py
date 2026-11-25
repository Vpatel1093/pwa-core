"""The "who is asking" hook: main(authorize=fn) / make_server(authorize=fn).

tailscale serve proxies each request from 127.0.0.1. It sets X-Forwarded-For
on every request, and Tailscale-User-Login for a tailnet user (it drops any
copy the client sent). A tagged device or a funnel request gets no login. So
the tests fake serve by sending those headers from loopback.
"""

import http.client
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from pwacore import server
from pwacore import test_server as base

TAILNET = "laptop.tail1234.ts.net"
PEOPLE = {"alice@example.com": "alice", "bob@example.com": "bob"}


def via_serve(login=None, host=TAILNET):
    """The headers a request has after tailscale serve proxied it."""
    headers = {"Host": host, "X-Forwarded-For": "100.64.0.7", "X-Forwarded-Proto": "https"}
    if login is not None:
        headers["Tailscale-User-Login"] = login
    return headers


class HeadersTest(unittest.TestCase):
    def make(self, pairs):
        msg = http.client.HTTPMessage()
        for k, v in pairs:
            msg[k] = v
        return server.Headers.from_message(msg)

    def test_names_are_case_insensitive(self):
        h = self.make([("Tailscale-User-Login", "alice@example.com")])
        self.assertEqual(h.get("tailscale-user-login"), "alice@example.com")
        self.assertEqual(h["TAILSCALE-USER-LOGIN"], "alice@example.com")
        self.assertIn("Tailscale-User-Login", h)
        self.assertIsNone(h.get("X-Other"))
        self.assertEqual(len(h), 1)
        self.assertEqual(dict(h), {"tailscale-user-login": "alice@example.com"})

    def test_a_repeated_header_reads_as_one_comma_joined_value(self):
        # As HTTP defines it. Two logins never match a known one, so it fails closed.
        h = self.make([("Tailscale-User-Login", "alice@example.com"), ("tailscale-user-login", "bob@example.com")])
        self.assertEqual(h["Tailscale-User-Login"], "alice@example.com, bob@example.com")

    def test_they_cant_be_changed(self):
        h = self.make([("A", "1")])
        with self.assertRaises(TypeError):
            h["A"] = "2"  # type: ignore[index]
        with self.assertRaises(AttributeError):
            h.update({"A": "2"})  # type: ignore[attr-defined]


class IsLocalTest(unittest.TestCase):
    """A local client (the CLI, a test, curl on this machine) connects from
    loopback, names a loopback host and carries no proxy header. A request
    through tailscale serve also comes from loopback, but always carries
    X-Forwarded-For (and its Host is the tailnet name)."""

    def headers(self, **kv):
        return server.Headers({k.replace("_", "-").lower(): v for k, v in kv.items()})

    def test_loopback_with_no_proxy_headers_is_local(self):
        for peer in ["127.0.0.1", "127.5.0.1", "::1", "::ffff:127.0.0.1"]:
            for host in ["127.0.0.1:8765", "localhost:8765", "[::1]:8765", "localhost"]:
                with self.subTest(peer=peer, host=host):
                    self.assertTrue(server.is_local(peer, self.headers(Host=host)))

    def test_another_peer_is_never_local(self):
        for peer in ["100.64.0.7", "192.168.1.5", "fd7a:115c:a1e0::1", "::ffff:192.168.1.5", "", "not an ip"]:
            with self.subTest(peer):
                self.assertFalse(server.is_local(peer, self.headers(Host="127.0.0.1:8765")))

    def test_a_proxied_request_is_never_local(self):
        cases = {
            "a tagged device through serve": self.headers(Host=TAILNET, X_Forwarded_For="100.64.0.7"),
            "serve with a forged loopback Host": self.headers(Host="localhost:8765", X_Forwarded_For="100.64.0.7"),
            "a user through serve": self.headers(Host=TAILNET, X_Forwarded_For="1", Tailscale_User_Login="a@b"),
            "a login header alone": self.headers(Host="127.0.0.1", Tailscale_User_Login="a@b"),
            "an empty login header": self.headers(Host="127.0.0.1", Tailscale_User_Login=""),
            "another proxy (Forwarded)": self.headers(Host="127.0.0.1", Forwarded="for=100.64.0.7"),
            "the tailnet name with no proxy header": self.headers(Host=f"{TAILNET}:8765"),
            "no Host": self.headers(),
        }
        for label, headers in cases.items():
            with self.subTest(label):
                self.assertFalse(server.is_local("127.0.0.1", headers))


class AuthorizeValidationTest(unittest.TestCase):
    def test_a_hook_that_isnt_a_function_is_refused_at_startup(self):
        with tempfile.TemporaryDirectory() as tmp:
            for bad in ["alice", {"a": "b"}, 1]:
                with self.subTest(bad), self.assertRaisesRegex(server.BadHooks, "authorize"):
                    server.make_server("127.0.0.1", 0, Path(tmp) / "e.db", Path(tmp), quiet=True, authorize=bad)

    def test_main_passes_the_hook_on(self):
        seen = {}

        def fake_make_server(*args, **kwargs):
            seen.update(kwargs)
            raise server.BadHooks("stop here")

        original, server.make_server = server.make_server, fake_make_server
        try:
            with self.assertRaises(SystemExit):
                server.main([], authorize=len)
        finally:
            server.make_server = original
        self.assertIs(seen["authorize"], len)

    def test_an_app_request_made_by_hand_needs_no_principal_or_headers(self):
        # An app's own tests build AppRequest with the four fields it had before.
        req = server.AppRequest("GET", "/api/app/x", {}, None)
        self.assertIsNone(req.principal)
        self.assertEqual(dict(req.headers), {})


class AuthorizeHttpTest(unittest.TestCase):
    """The hook runs on every route, after the Host and Origin checks."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        static = Path(cls.tmp.name) / "app"
        static.mkdir()
        (static / "index.html").write_text("<!doctype html><title>t</title>")
        cls.asked = []
        cls.calls = []
        cls.answer = None  # set by a test to make the hook return something odd

        def authorize(headers):
            cls.asked.append(headers)
            if cls.answer is not None:
                return cls.answer()
            return PEOPLE.get(headers.get("Tailscale-User-Login"))

        def whoami(req):
            cls.calls.append(req)
            return 200, {"principal": req.principal, "login": req.headers.get("tailscale-user-login")}

        def routes(ctx):
            return [server.Route("GET", "/api/app/whoami", whoami), server.Route("POST", "/api/app/whoami", whoami)]

        cls.httpd = server.make_server(
            "127.0.0.1",
            0,
            Path(cls.tmp.name) / "e.db",
            static,
            allowed_hosts=[TAILNET],
            quiet=True,
            routes=routes,
            authorize=authorize,
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
        self.asked.clear()
        self.calls.clear()
        type(self).answer = None

    request = base.HttpTest.request

    ROUTES = [
        ("GET", "/", None),
        ("HEAD", "/", None),
        ("GET", "/index.html", None),
        ("GET", "/api/health", None),
        ("GET", "/api/events?after=0", None),
        ("POST", "/api/events", {"events": []}),
        ("GET", "/api/app/whoami", None),
        ("POST", "/api/app/whoami", {}),
        ("GET", "/api/nope", None),
        ("GET", "/missing.js", None),
    ]

    def test_a_known_login_gets_every_route_and_the_hook_sees_its_headers(self):
        for method, path, body in self.ROUTES:
            with self.subTest(f"{method} {path}"):
                self.asked.clear()
                status, _, _ = self.request(method, path, body, headers=via_serve("alice@example.com"))
                self.assertIn(status, (200, 404) if "nope" in path or "missing" in path else (200,))
                self.assertEqual(len(self.asked), 1, "asked once per request")
                self.assertEqual(self.asked[0].get("tailscale-user-login"), "alice@example.com")
                self.assertEqual(self.asked[0]["X-Forwarded-For"], "100.64.0.7")

    def test_an_unknown_login_is_refused_on_every_route_before_anything_runs(self):
        for method, path, body in self.ROUTES:
            with self.subTest(f"{method} {path}"):
                status, headers, reply = self.request(method, path, body, headers=via_serve("eve@example.com"))
                self.assertEqual(status, 403)
                if method != "HEAD":
                    self.assertEqual(json.loads(reply), {"error": "not allowed"})
                self.assertIn("no-store", headers["Cache-Control"])
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(self.calls, [])
        status, _, reply = self.request("POST", "/api/events", {"events": [base.ev(1)]}, headers=via_serve("eve@x"))
        self.assertEqual(status, 403)
        self.assertEqual(self.httpd.store.read_after(0, 10)["events"], [], "nothing got in")

    def test_no_login_through_serve_is_refused(self):
        # A tagged device or a funnel request: serve adds no login. It still
        # comes from loopback, so this is the case "loopback is local" must not let in.
        for host in [TAILNET, f"{TAILNET}:{self.port}", f"127.0.0.1:{self.port}"]:
            with self.subTest(host):
                status, _, _ = self.request("GET", "/api/events?after=0", headers=via_serve(None, host=host))
                self.assertEqual(status, 403)

    def test_a_local_client_is_local(self):
        for host in [f"127.0.0.1:{self.port}", f"localhost:{self.port}"]:
            with self.subTest(host):
                status, _, reply = self.request("GET", "/api/app/whoami", headers={"Host": host})
                self.assertEqual((status, json.loads(reply)), (200, {"principal": "local", "login": None}))
        self.assertEqual(self.request("GET", "/api/events?after=0")[0], 200)
        self.assertEqual(self.request("POST", "/api/events", {"events": []})[0], 200)
        self.assertEqual(len(self.asked), 4, "the hook is asked for local requests too")

    def test_the_hooks_answer_comes_first_and_local_is_only_the_fallback(self):
        status, _, reply = self.request("GET", "/api/app/whoami", headers={"Tailscale-User-Login": "bob@example.com"})
        self.assertEqual(json.loads(reply)["principal"], "bob")
        type(self).answer = staticmethod(lambda: "owner")
        status, _, reply = self.request("GET", "/api/app/whoami")
        self.assertEqual((status, json.loads(reply)["principal"]), (200, "owner"))

    def test_the_app_route_gets_the_principal_and_read_only_headers(self):
        status, _, reply = self.request("GET", "/api/app/whoami", headers=via_serve("alice@example.com"))
        self.assertEqual((status, json.loads(reply)), (200, {"principal": "alice", "login": "alice@example.com"}))
        req = self.calls[0]
        with self.assertRaises(AttributeError):
            req.principal = "bob"
        with self.assertRaises(AttributeError):
            req.headers = {}
        with self.assertRaises(TypeError):
            req.headers["tailscale-user-login"] = "bob@example.com"

    def test_a_refused_post_closes_the_connection_since_its_body_is_unread(self):
        with socket.create_connection(("127.0.0.1", self.port)) as sock:
            body = b'{"events": []}'
            sock.sendall(
                f"POST /api/events HTTP/1.1\r\nHost: {TAILNET}\r\nX-Forwarded-For: 1\r\nContent-Type: application/json"
                f"\r\nContent-Length: {len(body)}\r\n\r\n".encode()
                + body
            )
            reply = b""
            while chunk := sock.recv(4096):
                reply += chunk
        self.assertIn(b" 403 ", reply.split(b"\r\n")[0] + b" ")  # and the read above ended: closed

    def test_the_host_check_still_comes_first(self):
        status, _, _ = self.request("GET", "/api/health", headers={"Host": "evil.example"})
        self.assertEqual(status, 421)
        self.assertEqual(self.asked, [])

    def test_a_bad_answer_or_a_failing_hook_is_a_500_and_the_server_keeps_going(self):
        def boom():
            raise RuntimeError("hook broke")

        for label, answer in {
            "empty": lambda: "",
            "too long": lambda: "x" * 101,
            "not text": lambda: 7,
            "a bool": lambda: True,
            "a control character": lambda: "al\nice",
            "raises": boom,
        }.items():
            with self.subTest(label):
                type(self).answer = staticmethod(answer)
                status, _, reply = self.request("GET", "/api/health")
                self.assertEqual((status, json.loads(reply)), (500, {"error": "server error"}))
        type(self).answer = None
        self.assertEqual(self.request("GET", "/api/health")[0], 200)
        self.assertEqual(self.calls, [])


class NoHookTest(unittest.TestCase):
    """No hook: today's behavior. Anyone who passes the Host check gets in."""

    def test_every_request_gets_in_and_an_app_route_sees_no_principal(self):
        calls = []

        def whoami(req):
            calls.append(req)
            return 200, {}

        with tempfile.TemporaryDirectory() as tmp:
            httpd = server.make_server(
                "127.0.0.1",
                0,
                Path(tmp) / "e.db",
                Path(tmp),
                allowed_hosts=[TAILNET],
                quiet=True,
                routes=lambda ctx: [server.Route("GET", "/api/app/whoami", whoami)],
            )
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            try:
                t = type("T", (), {"base": f"http://127.0.0.1:{httpd.server_address[1]}"})()
                for headers in [{}, via_serve("eve@example.com"), via_serve(None)]:
                    self.assertEqual(base.HttpTest.request(t, "GET", "/api/app/whoami", headers=headers)[0], 200)
                    self.assertEqual(base.HttpTest.request(t, "GET", "/api/events?after=0", headers=headers)[0], 200)
            finally:
                httpd.shutdown()
                httpd.server_close()
                httpd.store.close()
        self.assertEqual([c.principal for c in calls], [None, None, None])
        self.assertEqual(calls[1].headers.get("tailscale-user-login"), "eve@example.com")


if __name__ == "__main__":
    unittest.main()
