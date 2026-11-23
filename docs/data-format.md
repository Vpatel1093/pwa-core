# Data format

How a core app stores data, and the rules every device follows so all copies agree. Tests cover each rule: `test/events.test.js`, `test/lww.test.js`, `test/sync.test.js` and `server/test_server.py`.

## Why an event log

The app runs on several devices, often offline, and syncs through a small server you run. The data must survive app updates, device moves and a rebuilt server.

So the only stored data is an append-only list of events. Each device builds the current state from the log. The server stores events and returns them. It never reads them beyond a few checks.

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

Limits, enforced by both the app and the server: ids up to 100 characters, an event up to 64KB of JSON, `ts` a safe integer, no NaN or Infinity, no lone UTF-16 surrogates.

Ids inside `data` (a note, a stop) come from `randomId(prefix)`. Never make an id from a label: ids are copied into every event that names the thing, and events are never rewritten.

## Two checks

- `validateEnvelope` decides what is kept. Sync and import keep every event that passes it, even one whose body this version can't read. A later version may read it, and dropping it would move the pull cursor past it for good.
- The app's `validateEvent` (from `createEventChecks`) decides what state uses. It also passes unknown types and events with a newer `v`, so state code must ignore what it doesn't know.

## How edits merge

The app picks, per kind of fact, either "append" (every event counts, such as a note added) or "newest wins" (one value per key, such as a note's done flag).

For newest wins, `isNewer` orders events by `ts`, then `device_id`, then `id`. The order is total, so every device reaches the same answer in any arrival order. `keepNewest(map, key, event, value)` applies it.

An edit passes `after` (the winning event's `ts`) to `makeEvent`. The new event is then stamped past it, so an edit made on top of what you see wins, even if the old event came from a device whose clock ran days ahead.

## Sync

`POST /api/events` takes `{"events": [...]}` (up to 1000 events, 2MB). It stores every acceptable event, ignores ids it already has, and lists the rest in `rejected`. Retrying a rejected event won't help, so the device drops it from its outbox and lists it in diagnostics.

`GET /api/events?after=<cursor>&limit=<n>` pages through events in the order the server stored them. Each page has `next`, `more`, `server_id` and `head`.

If `server_id` changes (a new database) or the cursor is past `head` (a restored backup), the device resets its cursor and pushes everything it has again. See [data-and-recovery.md](data-and-recovery.md).

## Changing a body shape

Never migrate stored events. Bump `EVENT_VERSION`, and teach the state code to read both shapes. Old exports keep importing.
