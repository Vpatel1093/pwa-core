import assert from 'node:assert/strict';

// Mirrors server/server.py: dedupe by id, seq cursor, paging, server_id,
// head, per-event rejects. test/integration.test.js runs the real one.
export function fakeServer({ pageSize = 500, serverId = 'srv-1', rejectIds = [] } = {}) {
  const rows = [];
  const ids = new Set();
  const srv = {
    serverId,
    rows,
    down: false,
    posts: 0,
    reset(newId) { rows.length = 0; ids.clear(); srv.serverId = newId; },
    // Roll back to the first n rows, keeping the server id (a restored backup).
    restore(n) { for (const e of rows.splice(n)) ids.delete(e.id); },
    async fetch(url, opts = {}) {
      if (srv.down) throw new TypeError('Failed to fetch');
      const u = new URL(url, 'http://x');
      const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
      if (opts.method === 'POST' && u.pathname === '/api/events') {
        assert.equal(opts.headers['Content-Type'], 'application/json');
        srv.posts++;
        const { events } = JSON.parse(opts.body);
        if (events.length > 1000 || opts.body.length > 2 * 1024 * 1024) return reply(413, { error: 'too large' });
        let inserted = 0;
        const rejected = [];
        for (const [index, e] of events.entries()) {
          if (rejectIds.includes(e.id)) { rejected.push({ index, id: e.id, reason: 'bad' }); continue; }
          if (ids.has(e.id)) continue;
          ids.add(e.id);
          rows.push(structuredClone(e));
          inserted++;
        }
        return reply(200, { received: events.length, inserted, rejected });
      }
      if (u.pathname === '/api/events') {
        const after = +u.searchParams.get('after');
        const limit = Math.min(+u.searchParams.get('limit') || pageSize, pageSize);
        const slice = rows.slice(after, after + limit);
        return reply(200, {
          events: structuredClone(slice),
          next: after + slice.length,
          more: after + slice.length < rows.length,
          server_id: srv.serverId,
          head: rows.length,
        });
      }
      return reply(404, { error: 'not found' });
    },
  };
  return srv;
}
