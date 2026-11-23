# Your data: where it lives and how to get it back

This covers where your data lives and how it moves between copies. It also lists what can go wrong and how to recover from each problem, and what the app doesn't protect yet.

## Where it lives

Everything the app knows is events in one log (see [the data format](data-format.md)). Full copies of that log can exist in three places:

- **Each device's browser storage** (IndexedDB). The app works from this copy, including offline.
- **The server's database** (`data/events.db`, SQLite). This is the shared copy that devices sync through.
- **Export files** (`<app-id>-backup-YYYY-MM-DD.json`, from Settings). These are snapshots you keep yourself.

Merging two copies is a union: nothing is ever overwritten or deleted. That makes recovery simple, because any surviving copy can refill the others.

## How sync works

When the app opens, when you make a change, when you return to it, and every minute while it's open, it:

1. sends the server the events it hasn't sent yet, then
2. asks for the events it hasn't seen.

If the server can't be reached, changes wait on the device. The header shows "3 not synced · can't reach server" (3 changes saved on this device that the server doesn't have yet), and a small dot appears next to it if changes are waiting and the device hasn't synced in over a day (or ever). Until then those changes exist only on this device. Settings says how many are waiting.

The server labels its database with a random id. If a device sees a different id, or sees that the server is behind where the device had already read up to (an older copy), it sends its whole log again. That's how a replaced or restored server gets refilled without anyone doing anything.

## When something goes wrong

| What happened | What you lose | What to do |
|---|---|---|
| Server is off or unreachable | Nothing | Keep using the app. It syncs when the server is back. |
| The browser cleared the app's storage (iOS can do this to sites you haven't opened in a while; less likely once added to the Home Screen) | Changes that hadn't synced yet | Open the app. It pulls everything back from the server. |
| A device is lost or broken | Changes that hadn't synced yet | Set up the new device; it pulls everything. |
| Server database lost, or you start a new one | Nothing, if your devices synced recently | Start the server. Each device notices the new database and sends its full log. |
| Server database restored from a backup | Nothing, if the devices that made changes since the backup still have them | Stop the server, put the backup in place (delete any `events.db-wal` / `-shm` files next to it), and start it once with `--new-server-id`. Devices then resend what the backup is missing. |
| Server database corrupt (the server checks at startup and refuses to start, saying the file is damaged; damage that happens while it runs shows as errors in its log and "Sync problem" in the app) | Nothing, if devices synced recently | Stop the server and move the file aside. Start the server with no database (devices refill it) or restore a backup as above. `sqlite3 data/events.db "PRAGMA integrity_check"` tells you whether a file is sound. |
| The computer running the server dies | Anything that existed only on that computer | Other devices still have full copies. Set up the server on another machine and they refill it. |
| Imported the wrong file | See below | See below |
| A device's clock is wrong | Nothing | Edits still land correctly. A change made while the clock was wrong can be changed again from any device. |
| The browser won't let the app store anything (some private modes) | Everything on that device when the tab closes | A red banner says so. Changes still sync to the server while the tab is open. Use a normal window. |

### Importing the wrong file

Imports add events, and events are never deleted, so an import can't be undone.

- **A backup** merges its history into yours. Where the app uses newest-wins (see the data format), a backup never erases a later change. But anything that only exists in the backup will appear.

To truly start over from a known-good export (this throws away everything logged after that export, so export what you have now first and keep it):

1. Close the app everywhere: every tab, and the Home Screen app.
2. Stop the server and move `data/events.db` aside.
3. Clear the app's data on every device that has used it. In a desktop browser, clear the site data for the app's address. On an iPhone, delete the Home Screen app (clearing Safari's website data doesn't reach it), and also clear Safari's data for the site if you used it there.
4. Start the server, open the app on one device, and import the good export.
5. Open the app on the other devices.

Any device you miss will push the old events back the next time it syncs.

## Backing up

Your data is safest with copies on at least two machines. If the computer that runs the server is also where you use the app, one failure takes out two copies at once and only your phone's copy remains. Export now and then and keep the file somewhere other than that computer. The diagnostics show when you last exported.

To back up the server, don't copy `events.db` while the server is running. The database keeps recent writes in a side file, so a plain copy (including one made by Time Machine) can miss them or be inconsistent. Take a consistent copy instead:

```sh
sqlite3 data/events.db ".backup events-backup.db"
```

## What isn't protected yet

- **No login.** Anyone who can reach the server can read and change everything. Keep it on localhost and reach it only over your own tailnet (see the README).
- **No encryption at rest.** The server database, the browser's storage, and export files are plain text. Tailscale encrypts traffic between your devices and the server, but on disk your data is protected only by the device's own encryption (FileVault, an iPhone passcode), if it's on. Treat export files like a private journal.
- **Labels are permanent.** Text an app puts in an event stays in the log for good. Use random ids (`randomId` in `app/core/uuid.js`) to point at things, so only the event that names a thing carries its label.
- **No way to delete** events or remove imported events yet. An app that needs erasure has to add it.
