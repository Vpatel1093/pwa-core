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
npm run new-app -- ../trips --id trips --name "Trips" --git
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
| `tools/pwacore/` | `build`, `check`, the vendored-copy lock check | The core |
| `tools/new-app.mjs`, `tools/install.mjs` | Start an app; install the core into one (core only) | The core |
| `core.lock.json` | In an app: the core version and source, and a sha256 per vendored file | Written by `install.mjs` |
| `docs/` | [Data format](docs/data-format.md), [data and recovery](docs/data-and-recovery.md) | The core |

`app/core/runtime.js` is the wiring between the store, the clock, sync and other tabs. An app calls `startRuntime({ store, appVersion, onEvents, onStatus })`, then `rt.record(event)` for each change. `onEvents(events, source)` hands it every event to fold into state: at load, from this tab, from other tabs, from sync and from import.

## Run it

It needs Python 3.9+ and nothing else.

```sh
python3 server/server.py            # http://127.0.0.1:8765
```

Data goes to `data/events.db` (gitignored). Options: `--port`, `--db <file>`, `--host` (keep it on 127.0.0.1), `--allow-host <name>`, `--new-server-id`.

There is no login. Anyone who can reach the server can read and change everything. The server only answers requests for a loopback name or this machine's Tailscale name, which it gets from the `tailscale` command at startup. That stops web pages from reaching it through DNS tricks.

To use it on your phone, put it on your tailnet with HTTPS:

```sh
tailscale serve --bg 8765
```

Open the `https://<machine>.<tailnet>.ts.net` address and use Add to Home Screen. HTTPS is required for offline use and install. Use `tailscale serve`, never `tailscale funnel` (that would put it on the public internet). Give each app its own port.

## Checks

```sh
npm test          # node:test for app logic and tools, unittest for the server
npm run check     # static check: JS parses, Python compiles, JSON parses
npm run build     # import graph and offline file list, then a copy in dist/
```

Tests need Node 20+ (`npm install` once for the test-only IndexedDB fake) and Python 3.9+. `check` is a syntax check, not a type check: there is no TypeScript. `build` is only needed to host the app somewhere other than the Python server.

**Releasing a change:** bump `APP_VERSION` in `app/js/config.js`, `VERSION` in `app/sw.js` and `APP_VERSION` in `server/server.py` (a test checks they match). Installed copies keep the old code until you bump, then show a "new version" banner. A change to `app/core/` or `server/` also bumps `CORE_VERSION` in `app/core/version.js` and `VERSION` in `server/pwacore/server.py`.

## Updating an app's core

An app holds a vendored copy of the core in `app/core/`, `server/pwacore/` and `tools/pwacore/`, and a `core.lock.json` with a sha256 per file. Its tests run the lock check (`checkLock` from `tools/pwacore/lock.mjs`), so a hand edit fails the suite. A fix the core needs is made here, with its tests, then installed again:

```sh
npm run install-into -- ../<app>     # copies the three folders, removes dropped files, writes the lock
cd ../<app> && npm test
```

It refuses to overwrite a copy that was edited by hand, or files in those folders that the lock doesn't list (`--force` overrides). The lock names this repo's commit, or `null` with `uncommitted: true` before the first commit; `tree_sha256` identifies the copy either way. `CORE_VERSION` says which core an app has.

## Where it came from

The core modules come from the Mandalart tracker (v0.2.2). The changes from there: `chart_id` became an optional `scope_id`, the per-type checks moved to the app (`createEventChecks`), storage names come from the app's id, and the startup wiring moved from Mandalart's `main.js` into `runtime.js` and `shell.js`.
