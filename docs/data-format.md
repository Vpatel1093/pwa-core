# Data format

How a core app stores data, and the rules every device follows so all copies agree. Tests cover each rule: `test/pwacore/events.test.js`, `test/pwacore/lww.test.js`, `test/pwacore/sync.test.js` and `server/pwacore/test_server.py`.

## Why an event log

The app runs on several devices, often offline, and syncs through a small server you run. The data must survive app updates, device moves and a rebuilt server.

So the only stored data is an append-only list of events. Each device builds the current state from the log. The server stores events and returns them. It never reads them beyond a few checks.

## What the core stores, and what it leaves to the app

The core sets the event envelope (below) and its own stores. It never sets the shape of an app's data.

| where | store | holds |
|---|---|---|
| browser, IndexedDB database named `APP_ID` | `events` | the full log |
| | `outbox` | ids of local events not pushed yet |
| | `meta` | the core's own keys (`deviceId`, `clockLast`, `serverId`, `pullCursor`, `pullCursorId`, `lastSyncAt`, `lastExportAt`, `rejected`); a newer core may add more |
| server, `data/<DB_NAME>` (SQLite) | `events` | the log, in the order the server stored it; each row keeps the body as sent and `received_by`, who pushed it (the app's `authorize` hook; NULL without one, and for rows from before the column) |
| | `meta` | `server_id`, `app_id` |

These belong to the core. An app does not add stores, tables or `meta` keys to them, and does not read them except through the core's functions. A newer core may change them.

App data that is not events goes in the app's own place:

- In the browser: its own IndexedDB database, with a name other than `APP_ID` (for example `<APP_ID>-cache`).
- On the server: its own SQLite file in `data/`, next to the event database, never a new table inside it. The event database can then be checked, backed up, restored or rebuilt by devices without touching app data, and the reverse.

Data kept that way does not sync, is not in exports, is not rebuilt after a reset, and the recovery steps in [data-and-recovery.md](data-and-recovery.md) ("devices refill it") do not cover it. So it must only be data the app can lose or get again: caches (place lookups, a map tile), or a server inbox whose rows turn into events once a device takes them. Anything the user would miss belongs in events.

## Event envelope

| field         | notes |
|---------------|-------|
| `id`          | UUIDv7. The dedupe key on every device and on the server. |
| `v`           | The app's event body version (`EVENT_VERSION` in `app/js/config.js`). Old versions are read as they are, never rewritten. |
| `type`        | Set by the app, such as `note.added`. A type this version doesn't know still syncs, imports and stays in the log. |
| `scope_id`    | Optional. The thing the event belongs to (a trip, a chart), when the app has one. Leave it out rather than invent one. |
| `ts`          | Hybrid clock ms: `max(device clock, newest ts seen + 1)`. An integer up to 2^53-1. |
| `tz`          | IANA zone, for debugging. |
| `device_id`   | Random per device (UUIDv7), made on first start. |
| `app_version` | For debugging. |
| `data`        | The body. The app owns its shape and checks it with `createEventChecks`. |

Limits, enforced by both the app and the server with the same rules: `id`, `scope_id` and `device_id` up to 100 characters (UTF-16 units, as JavaScript counts: an emoji is 2), `v` and `ts` safe integers, `data` an object, at most 32 objects and arrays deep, an event up to 64KB of JSON as `JSON.stringify` writes it, no NaN or Infinity, no lone UTF-16 surrogates. The server stores only events every device keeps, so a pull never skips one for good; `test/pwacore/envelope-cases.json` holds the cases both checks must judge alike.

Ids inside `data` (a note, a stop) come from `randomId(prefix)`. Never make an id from a label: ids are copied into every event that names the thing, and events are never rewritten.

## Two checks

- `validateEnvelope` decides what is kept. Sync and import keep every event that passes it, even one whose body this version can't read. A later version may read it, and dropping it would move the pull cursor past it for good.
- The app's `validateEvent` (from `createEventChecks`) decides what state uses. It also passes unknown types and events with a newer `v`, so state code must ignore what it doesn't know.

## How edits merge

The app picks, per kind of fact, either "append" (every event counts, such as a note added) or "newest wins" (one value per key, such as a note's done flag).

For newest wins, `isNewer` orders events by `ts`, then `device_id`, then `id`. The order is total, so every device reaches the same answer in any arrival order. `keepNewest(map, key, event, value)` applies it.

An edit passes `after` (the winning event's `ts`) to `makeEvent`. The new event is then stamped past it, so an edit made on top of what you see wins, even if the old event came from a device whose clock ran days ahead.

## Sync

`POST /api/events` takes `{"events": [...]}` (up to 1000 events, 2MB). It stores every acceptable event, ignores ids it already has, and lists the rest in `rejected`. Sending a rejected event again won't help, so it leaves the outbox (it can't block the events behind it) but is kept: the device lists it, with its core version, in meta `rejected` (diagnostics shows it). A newer core sends it again, and a server that still refuses it puts it back on the list. The event itself stays on the device either way.

`GET /api/events?after=<cursor>&limit=<n>` pages through events in the order the server stored them. Each page has `next`, `more`, `server_id`, `app_id`, `head` and `after_id` (the id of the event at the cursor). A server with an `authorize` hook adds `received_by`: who pushed each event, one entry per event in the order of `events` (README "Who is asking"). It is beside the events, never inside one, so devices store, export and push back each event exactly as it was sent.

Both take `app=<APP_ID>`. The database keeps the app id it was first started with (`APP_ID` in `server/server.py`), and a request that names another app gets a 409, so two apps' events never mix. A request with no `app` (an older client) is let through.

If `server_id` changes (a new database), the cursor is past `head`, or `after_id` is not the id of the last event the device pulled (both: a restored backup), the device resets its cursor and pushes everything it has again. See [data-and-recovery.md](data-and-recovery.md).

## Changing a body shape

Never migrate stored events. Old exports keep importing.

- A new field: make it optional, and have the state code read events without it.
- A new shape: give it a new type name (`note.moved2`, or a better name), and have the state code read both types.
- `EVENT_VERSION` (the envelope's `v`) is app-wide, not per type. A device that is behind keeps events with a higher `v` but doesn't fold any of them, so a bump hides every new event from an older copy of the app until it updates. Bump it only for a change that every event shares, never for one type's body.
