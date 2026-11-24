import assert from 'node:assert/strict';

// Mirrors server/server.py: dedupe by id, seq cursor, paging, server_id,
// head, per-event rejects. test/integration.test.js runs the real one.
/** @typedef {import('../../../app/core/events.js').PwaEvent} PwaEvent */

/** @param {{ pageSize?: number, serverId?: string, rejectIds?: string[], appId?: string | null }} [opts] */
export function fakeServer({ pageSize = 500, serverId = 'srv-1', rejectIds = [], appId = null } = {}) {
  /** @type {PwaEvent[]} */
  const rows = [];
  const ids = new Set();
  const srv = {
    serverId,
    rows,
    down: false,
    posts: 0,
    /** @param {string} newId */
    reset(newId) { rows.length = 0; ids.clear(); srv.serverId = newId; },
    // Roll back to the first n rows, keeping the server id (a restored backup).
    /** @param {number} n */
    restore(n) { for (const e of rows.splice(n)) ids.delete(e.id); },
    /** @type {import('../../../app/core/sync.js').FetchLike} */
    async fetch(url, opts = {}) {
      if (srv.down) throw new TypeError('Failed to fetch');
      const u = new URL(url, 'http://x');
      /** @param {number} status @param {unknown} body */
      const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
      const claimed = u.searchParams.get('app');
      if (u.pathname === '/api/events' && claimed && appId && claimed !== appId) {
        return reply(409, { error: `this server is for app '${appId}', not '${claimed}'`, app_id: appId });
      }
      if (opts.method === 'POST' && u.pathname === '/api/events') {
        assert.equal(/** @type {Record<string, string>} */ (opts.headers)['Content-Type'], 'application/json');
        srv.posts++;
        const body = String(opts.body);
        /** @type {{ events: PwaEvent[] }} */
        const { events } = JSON.parse(body);
        if (events.length > 1000 || body.length > 2 * 1024 * 1024) return reply(413, { error: 'too large' });
        let inserted = 0;
        /** @type {{ index: number, id: string, reason: string }[]} */
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
        const after = Number(u.searchParams.get('after'));
        const limit = Math.min(Number(u.searchParams.get('limit')) || pageSize, pageSize);
        const slice = rows.slice(after, after + limit);
        return reply(200, {
          events: structuredClone(slice),
          next: after + slice.length,
          more: after + slice.length < rows.length,
          server_id: srv.serverId,
          app_id: appId,
          head: rows.length,
        });
      }
      return reply(404, { error: 'not found' });
    },
  };
  return srv;
}
