"""Start this app's sync server: python3 server/server.py [--port N] [--db FILE]

The server itself is the core, vendored in pwacore/ (never edit it here).
This file only names what belongs to the app.
"""

from pwacore.server import main

APP_VERSION = "0.1.0"  # matches APP_VERSION in app/js/config.js (a test checks)
PORT = 8765  # new-app sets it: the lowest port no other app claims. The tailnet HTTPS port uses the same number
DB_NAME = "events.db"  # data/<DB_NAME>; keep it once there is data
APP_ID = "pwacore-demo"  # matches APP_ID in app/js/config.js (a test checks); the database keeps it

if __name__ == "__main__":
    main(db_name=DB_NAME, app_version=APP_VERSION, app_id=APP_ID, port=PORT, description="PWA Core Demo sync server")
