# pwa-core

The base for small local-first web apps that you run for yourself. It holds the parts that Mandalart proved out and every new app needs again:

- **An event log** as the only stored data, with a hybrid clock and newest-wins merging, so devices agree without conflicts.
- **Storage in the browser** (IndexedDB, with a memory fallback), offline first.
- **Sync** through a small server you run (Python stdlib and SQLite), reached over your tailnet.
- **An offline shell**: a service worker, a web app manifest, an update banner.
- **Export and import** of the full log, and a diagnostics text that leaks no content.
- **Guard tests** that keep versions, names and the offline file list in step.

It has no runtime dependencies and no bundler. The app is plain ES modules.

A small example app (a shared list of notes) shows the whole loop and proves sync works. A new app replaces it.

## Start a new app

```sh
npm run new-app -- ../trips --id trips --name "Trips" --git   # [--port N]
cd ../trips
npm install
npm test
```

This copies the core into `../trips` and sets the name and storage id in every file that holds them. `--git` runs `git init`, excludes `TASK.md`, `CLAUDE.local.md` and `.local/`, and copies this repo's commit email (a GitHub noreply address). It does not commit.

- **`--id`** is the storage id. It names the IndexedDB database, the cache, the tab channel and the backup format. Pick it once: a new id means an empty database for everyone who has the app.
- **`--name`** is the display name. You can change it any time in `app/js/config.js` (the guard tests list the other places).

Then make it your app:

1. Write your events and state in place of `app/js/notes.js` and `test/notes.test.js`. Use `createEventChecks` for body checks, `keepNewest` for values that change, and `randomId` for ids. Start with the tests.
2. Change `app/js/main.js`. Keep the startup shape (open the store, start the runtime, fold events into state, render) and replace the notes UI.
3. Replace the example section at the end of `app/css/app.css`. Change the icon colors in `tools/make_icons.py` and run it.
4. List new files under `app/` in `ASSETS` in `app/sw.js`. `npm test` and `npm run build` both say what is missing.

## Layout

| path | what it is | who edits it |
|------|------------|--------------|
| `app/core/` | Event envelope, clock, LWW, stores, sync, runtime, backup, diagnostics, browser shell helpers | The core. Change it here, then copy it to apps. |
| `app/js/config.js` | App name, storage id, app version, event version | The app |
| `app/js/main.js`, `app/js/notes.js` | The example app | The app replaces them |
| `app/sw.js`, `app/manifest.webmanifest`, `app/index.html`, `app/css/` | Offline shell and page | The app, keeping the shell parts |
| `server/pwacore/` | Sync server and static file server | The core |
| `server/server.py` | Starts the server with the app's database name and version | The app |
| `tools/pwacore/` | `build`, `check`, `lint`, the vendored-copy lock check | The core |
| `tools/new-app.mjs`, `tools/install.mjs` | Start an app; install the core into one. A new app leaves them (and their tests and scripts) out | The core only |
| `test/pwacore/` | The core's own tests (and `core-lock.test.js`: in an app, fails if the vendored core doesn't match `core.lock.json`) | The app gets them, vendored |
| `tsconfig.json`, `tsconfig.sw.json` | The type check (see Checks). A new app gets them | The app |
| `eslint.config.js`, `ruff.toml`, `.githooks/` | Lint and the git hooks (see Checks). A new app gets them | The app |
| `core.lock.json` | In an app: the core version and source, and a sha256 per vendored file | Written by `install.mjs` |
| `docs/` | [Data format](docs/data-format.md), [data and recovery](docs/data-and-recovery.md) | The core |

`app/core/runtime.js` is the wiring between the store, the clock, sync and other tabs. An app calls `startRuntime({ store, appVersion, onEvents, onStatus })`, then `rt.record(event)` for each change. `onEvents(events, source)` hands it every event to fold into state: at load, from this tab, from other tabs, from sync and from import.

## Run it

It needs Python 3.9+ and nothing else.

```sh
python3 server/server.py            # http://127.0.0.1:<PORT>
```

The port is the `PORT =` line in `server/server.py` (8765 here, and for an app without that line). Data goes to `data/events.db` (gitignored). Options: `--port`, `--db <file>`, `--host` (keep it on 127.0.0.1), `--allow-host <name>`, `--new-server-id`.

There is no login of its own. Without an `authorize` hook (see [Who is asking](#who-is-asking)), anyone who can reach the server can read and change everything. The server only answers requests for a loopback name or this machine's Tailscale name, which it gets from the `tailscale` command at startup. That stops web pages from reaching it through DNS tricks.

To use it on your phone, put it on your tailnet with HTTPS:

```sh
tailscale serve --bg --https=<PORT> <PORT>
```

Open `https://<machine>.<tailnet>.ts.net:<PORT>` and use Add to Home Screen. HTTPS is required for offline use and install. Use `tailscale serve`, never `tailscale funnel` (that would put it on the public internet). The HTTPS port uses the same number as the app's port, so each app is its own origin with its own browser storage. An app already on the tailnet keeps the address it has: the phone's data belongs to that address. Each app's database keeps its app id and refuses another app's client.

`npm run new-app` gives each new app its own port: `--port N`, or else the lowest port from 8765 up that no other app claims. Claims are each sibling app's `PORT =` line (an app is a folder with `core.lock.json`; one without the line claims 8765) and every port `tailscale serve status` uses. It never looks at what is listening now, because apps are not always running.

## App routes and CSP

The core serves `/api/events`, `/api/health` and the app's files. An app adds its own server routes and CSP sources in its `server/server.py`:

```python
from pwacore.server import Route, main


def routes(ctx):  # called once at startup; ctx.data_dir, ctx.app_id
    inbox = Inbox(ctx.data_dir / "inbox.db")  # the app's own SQLite file, opened once
    return [
        Route("POST", "/api/app/inbox", inbox.add),  # fn(req) -> (status, JSON-able object)
        Route("GET", "/api/app/inbox", inbox.list),
    ]


CSP = {"img-src": ["https://img.example"]}  # added to the base policy

if __name__ == "__main__":
    main(..., routes=routes, csp=CSP)
```

- **Paths** are exact and live under `/api/app/` (lower case letters, digits, `-`, `_`), so a later core route can't collide with one. Use query parameters, not path parameters. GET and POST only. HEAD never runs an app route; GET or POST on a path that only has the other gets a 405, and any other method a 501.
- **Checks.** An app route gets every check a core route gets, before `fn` runs: the Host check, the Origin check on POST, `?app=` (so the query name `app` is the core's), and for a POST the Content-Length, 2MB, `application/json` and JSON rules. It also refuses a request that a page on another site made (`Sec-Fetch-Site` `cross-site` or `same-site`: another app on this machine is same-site), because an `<img>` or a link sends no Origin and a GET may have a cost. A client that sends no fetch metadata, such as an iOS Shortcut or curl, is let through; it must send JSON. Browsers send fetch metadata only to HTTPS or loopback addresses, and Safari only from 16.4, so over plain HTTP (an `--allow-host` LAN name) or on an older iPhone a cross-site GET gets through. Keep a GET free of side effects and cost where you can; a POST also has the Origin check.
- **The request** (`req.method`, `req.path`, `req.query` as lists of values, `req.body`, parsed JSON or None, `req.principal`, `req.headers`; see [Who is asking](#who-is-asking)): its fields can't be reassigned, and `fn` should not change them. Replies are JSON with the core's headers and `no-store`, so 204, 205 and 304 are refused. An exception, a bad status or a value JSON can't hold becomes a plain 500; the details go to the server log only. Never put an upstream error or an API key in a reply.
- **Threads.** Each connection has its own thread, so `fn` runs on many at once. Guard shared state with a lock, as the core's `EventStore` does, or open SQLite with WAL and a busy timeout.
- **CSP.** `csp` adds https origins (optionally `https://*.example.com`, with a port) to `img-src`, `connect-src`, `font-src`, `media-src`, `style-src` or `frame-src`. A directive the base lacks starts from `'self'`. `script-src`, `default-src`, `worker-src` and the locked directives can't change, and anything else is refused. The service worker serves the cached page with its old headers, so a CSP change shows only after a new app version.
- A mistake in `routes` or `csp` stops the server at startup. Test them in the app (a `server/test_*.py` that calls `make_server` with them), so the deploy tests catch it, not the server start.
- A route goes into the core only when every app needs it. What the app stores itself, and what that means for backups: [docs/data-format.md](docs/data-format.md).

## Who is asking

`tailscale serve` tells the server who sent a request: it adds `Tailscale-User-Login` (the tailnet user's login) and drops any copy the client sent. An app that shares its server with other people passes an `authorize` hook:

```python
PEOPLE = {"alice@example.com": "alice", "bob@example.com": "bob"}  # login -> person


def authorize(headers):  # called on every request
    return PEOPLE.get(headers.get("Tailscale-User-Login"))  # a principal, or None


if __name__ == "__main__":
    main(..., authorize=authorize)
```

- **Every route.** The core asks the hook on every request: the app's files, `/api/events`, `/api/health` and app routes, after the Host and Origin checks and before anything else. `headers` is read-only, and names are case-insensitive (a header sent twice reads as one value joined with `, `).
- **The answer** is a principal (a printable string of 1 to 100 characters) or None. A principal lets the request in. None gets a 403 `{"error": "not allowed"}`, unless the request is local (below). Anything else, or an exception, is a plain 500.
- **Local requests** are `local` when the hook names no one, so the CLI, scripts and tests on this machine need no login. Local means all of: the connection is from loopback, the Host is a loopback name (`127.0.0.1`, `localhost`, `[::1]`), and there is no `Tailscale-User-Login`, `X-Forwarded-For` or `Forwarded` header. `tailscale serve` also connects from loopback, but it adds `X-Forwarded-For` to every request it passes on, and its Host is the tailnet name. So a request through serve with no login (a tagged device, or `tailscale funnel`) is never local: the hook must name it, or it gets a 403. The hook's answer comes first, so an app can name a local request too; `local` is only the fallback.
- **Trust.** The login is only as good as the path it came by. Through `tailscale serve` it is Tailscale's. A program on this machine can send any header it likes, but it can also read the database file. Keep `--host` on 127.0.0.1: a request from another address is never local, and its headers came from that client.
- **In app routes**, `req.principal` is the hook's answer (or `local`) and `req.headers` the same read-only headers. With no hook, `req.principal` is None.
- **Who sent each event.** The server stores the principal of each push beside each event it stores (a `received_by` column; the body is stored as sent). With a hook, a pull page has `"received_by"`: one entry per event, in the order of `"events"`, None for events stored before the hook or the column. It is never a field inside an event: an event's own fields are what a client wrote, and devices keep, export and push back every one of them. Devices don't keep `received_by` yet; an app that needs it reads it from the pull reply.
- **No hook** keeps the old behavior: everyone who passes the Host check gets in, `req.principal` is None, a pull page has no `received_by`, and stored events get NULL.
- **Not covered:** a 403 is JSON, also for a page load; there is no friendlier page yet. An event pushed again (after a restore, see [docs/data-and-recovery.md](docs/data-and-recovery.md)) is stored with the principal of the device that pushed it again.

## Checks

```sh
npm test          # node:test for app logic and tools, unittest for the server
npm run check     # static check: JS parses, Python compiles, JSON parses; then lint and typecheck
npm run lint      # ESLint on the JS, ruff (lint and format check) on the Python
npm run typecheck # tsc on the JSDoc types, strict
npm run build     # import graph and offline file list, then a copy in dist/
npm run hooks     # turn on the git hooks (once per clone)
```

Tests need Node 20+ (`npm install` once for TypeScript, ESLint and the test-only IndexedDB fake) and Python 3.9+. Lint also needs [uv](https://docs.astral.sh/uv/): ruff runs as `uvx ruff@<version>`, pinned in `tools/pwacore/lint.mjs`. `build` is only needed to host the app somewhere other than the Python server.

**Types.** The code stays plain JS with no build step. Types are JSDoc comments, and TypeScript only checks them (`checkJs`, `noEmit`, `strict`). `tsconfig.json` covers `app/`, `tools/` and `test/` with the DOM and Node types; `tsconfig.sw.json` covers `app/sw.js` with the WebWorker types, since a page and a worker can't share one global. The shared types (`PwaEvent`, `Store`, `Runtime`, `SyncStatus`) are typedefs in `app/core/`, so an app gets them with the vendored core: `/** @type {import('../core/events.js').PwaEvent} */`. A `@ts-expect-error` carries a one-line reason.

**Lint.** ESLint's recommended rules plus some that catch real bugs (`eqeqeq`, unused variables, promise executor returns, shadowing and others: `eslint.config.js`). ruff checks `server/` and `tools/` for likely bugs (pyflakes, bugbear) and that they are formatted (`ruff format`). Fix a finding in the code; a disable comment carries a reason (`// eslint-disable-next-line rule -- why`). ESLint can't see a promise that is never awaited in JSDoc JS here (that needs typescript-eslint, which doesn't run on TypeScript 7).

**Git hooks.** `npm run hooks` sets `core.hooksPath` to `.githooks/` (`new-app --git` does it for you). `pre-commit` lints the staged files and type-checks if JS is staged, on a copy of what is staged (not on disk): a few seconds. `pre-merge-commit` runs the same for a merge that commits on its own. `pre-push` runs `npm run check` and `npm test` on an exported copy of each commit being pushed. Each unsets git's repo variables (`GIT_DIR`, `GIT_INDEX_FILE` and the rest) first, so a test that runs git can't write into this repo. `--no-verify` skips them once.

**Releasing a change:** bump `APP_VERSION` in `app/js/config.js`, `VERSION` in `app/sw.js` and `APP_VERSION` in `server/server.py` (a test checks they match). Installed copies keep the old code until you bump, then show a "new version" banner. A change to `app/core/` or `server/` also bumps `CORE_VERSION` in `app/core/version.js` and `VERSION` in `server/pwacore/server.py`.

## Updating an app's core

An app holds a vendored copy of the core in `app/core/`, `server/pwacore/`, `test/pwacore/` and `tools/pwacore/`, and a `core.lock.json` with a sha256 per file. The core's tests travel with it, so `npm test` in the app runs them against the app's copy. Its `test/pwacore/core-lock.test.js` runs the lock check (`checkLock` from `tools/pwacore/lock.mjs`), so a hand edit fails the suite. A fix the core needs is made here, with its tests, then installed again:

```sh
npm run install-into -- ../<app>     # copies the three folders, removes dropped files, writes the lock
cd ../<app> && npm test
```

It refuses to overwrite a copy that was edited by hand, or files in those folders that the lock doesn't list (`--force` overrides). The lock names this repo's commit, or `null` with `uncommitted: true` before the first commit; `tree_sha256` identifies the copy either way. It refuses to install uncommitted changes to the vendored folders unless you pass `--uncommitted`, since the commit in the lock wouldn't hold that copy. `CORE_VERSION` says which core an app has.

## Where it came from

The core modules come from the Mandalart tracker (v0.2.2). The changes from there: `chart_id` became an optional `scope_id`, the per-type checks moved to the app (`createEventChecks`), storage names come from the app's id, and the startup wiring moved from Mandalart's `main.js` into `runtime.js` and `shell.js`.
